import { execFile } from 'node:child_process';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../src/audit.js';
import { loadConfig } from '../../src/config/env.js';
import { createDeps } from '../../src/deps.js';
import { createHttpApp } from '../../src/http/app.js';
import { MockAdoServer } from '../fixtures/mock-ado-server.js';

const execute = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const conflict = (): CallToolResult => ({ isError: true, content: [{ type: 'text', text: '[conflict] expected smoke conflict' }] });
const writeEnv = {
  ADO_SMOKE_WRITE_PROJECT: 'scratch', ADO_SMOKE_WRITE_WIKI: 'scratch.wiki',
  ADO_SMOKE_WRITE_REPOSITORY: 'scratch-repo', ADO_SMOKE_WRITE_BRANCH: 'feature/smoke',
};
type Call = { name: string; args: Record<string, unknown> };

async function run(env: Record<string, string> = {}) {
  // Never inherit real smoke credentials or write targets from the developer's session.
  const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ADO_')));
  try {
    const result = await execute(process.execPath, ['scripts/smoke.mjs'], {
      env: { ...safeEnv, ADO_SMOKE_PAT: 'pat-demo', ...env }, timeout: 15_000,
    });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { code: result.code, output: result.stdout + result.stderr };
  }
}

async function listen(app: express.Express) {
  const listener: HttpServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  cleanups.push(async () => {
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  });
  return `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`;
}

async function controlledMcp(override?: (call: Call) => CallToolResult | undefined) {
  const calls: Call[] = [];
  const headers: Array<Record<string, unknown>> = [];
  const app = express();
  app.use(express.json());
  app.post('/mcp', async (req, res) => {
    headers.push(req.headers);
    const server = new Server({ name: 'controlled-smoke-target', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const call = { name: request.params.name, args: request.params.arguments ?? {} };
      calls.push(call);
      const result = override?.(call);
      if (result) return result;
      if (call.name === 'create_work_item') return json({ id: 42, rev: 1 });
      if (call.name === 'create_pull_request') return json({ id: 81 });
      if (call.name === 'update_work_item' && call.args.title === 'must not apply') return conflict();
      if (call.name === 'create_or_update_wiki_page') {
        if (String(call.args.content).includes('must not apply')) return conflict();
        return json({ path: call.args.path, created: !call.args.eTag, eTag: '"wiki-rev-1"' });
      }
      return json({ ok: true });
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get('/mcp', (_req, res) => { res.sendStatus(405); });
  return { url: await listen(app), calls, headers };
}

describe('live smoke CLI (offline targets)', () => {
  afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
  });

  it('requires a PAT before attempting a connection', async () => {
    const result = await run({ ADO_SMOKE_PAT: '', ADO_SMOKE_URL: 'invalid' });
    expect(result.code).toBe(2);
    expect(result.output).toContain('Set ADO_SMOKE_PAT');
  });

  it('defaults to six read tools and sends no upstream writes', async () => {
    const mock = new MockAdoServer({ flavor: '2020' });
    await mock.start();
    cleanups.push(() => mock.stop());
    mock.on('GET', /\/_apis\/build\/builds$/, () => ({ json: { value: [] } }));
    mock.on('GET', /\/pullrequests$/i, () => ({ json: { value: [] } }));
    mock.on('GET', /\/refs$/, () => ({ json: { value: [{ name: 'refs/heads/master', objectId: 'abc' }] } }));
    const config = loadConfig({ ADO_DEFAULT_SERVER_URL: mock.serverUrl, ADO_ALLOW_INSECURE_HTTP: 'true' });
    const events: AuditEvent[] = [];
    const http = createHttpApp(createDeps(config, fetch, (event) => events.push(event)));
    const url = await listen(http.app);
    cleanups.push(() => http.close());
    const result = await run({ ADO_SMOKE_URL: url, ADO_SMOKE_REMOTE: `${mock.serverUrl}/DemoCollection/DemoProject/_git/ado-server-mcp` });
    expect(result.output).toContain('SMOKE PASSED');
    expect(result.code).toBe(0);
    expect(events.filter((event) => event.tool).map((event) => event.tool)).toEqual([
      'whoami_and_collections', 'resolve_repo_context', 'list_projects', 'list_branches', 'list_pull_requests', 'list_builds',
    ]);
    expect(mock.requests.length).toBeGreaterThan(0);
    expect(mock.requests.filter((request) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method))).toEqual([]);
  });

  it('ignores optional targets without a write project and gates TFVC separately', async () => {
    const target = await controlledMcp();
    const result = await run({ ...writeEnv, ADO_SMOKE_WRITE_PROJECT: '', ADO_SMOKE_URL: target.url, ADO_SMOKE_TFVC_PATH: '$/Test' });
    expect(result.code).toBe(0);
    expect(target.calls.map((call) => call.name)).toEqual([
      'whoami_and_collections', 'resolve_repo_context', 'list_projects', 'list_branches', 'list_pull_requests', 'list_builds',
      'list_tfvc_items', 'list_changesets',
    ]);
    expect(target.calls.at(-1)?.args).toEqual({ collection: 'Projects', path: '$/Test', top: 3 });
    expect(target.headers.every((header) => header['x-ado-allow-destructive'] === undefined)).toBe(true);
  });

  it('exercises revisions, eTags and published PR votes, then cleans up', async () => {
    const target = await controlledMcp();
    const result = await run({ ...writeEnv, ADO_SMOKE_URL: target.url });
    expect(result.code).toBe(0);
    expect(result.output).toContain('SMOKE PASSED');
    expect(target.headers.every((header) => header['x-ado-allow-destructive'] === 'true')).toBe(true);
    expect(target.calls.filter((call) => call.name === 'update_work_item').map((call) => call.args)).toEqual([
      expect.objectContaining({ id: 42, expectedRevision: 1 }),
      expect.objectContaining({ id: 42, expectedRevision: 1, title: 'must not apply' }),
      { collection: 'DemoCollection', id: 42, state: 'Removed' },
    ]);
    expect(target.calls.filter((call) => call.name === 'create_or_update_wiki_page').map((call) => call.args.eTag)).toEqual([undefined, '"wiki-rev-1"', undefined]);
    expect(target.calls.find((call) => call.name === 'create_pull_request')?.args).toMatchObject({ repository: 'scratch-repo', sourceBranch: 'feature/smoke', isDraft: false });
    expect(target.calls.filter((call) => call.name === 'vote_on_pull_request').map((call) => call.args.vote)).toEqual(['wait_for_author', 'reset']);
    expect(target.calls.find((call) => call.name === 'update_pull_request_status')?.args).toEqual({ collection: 'DemoCollection', pullRequestId: 81, action: 'abandon' });
  });

  it('keeps independent groups and cleanup after a create or noncritical failure', async () => {
    const target = await controlledMcp((call) => {
      if (call.name === 'create_work_item') return { isError: true, content: [{ type: 'text', text: '[permission] denied' }] };
      if (call.name === 'vote_on_pull_request' && call.args.vote === 'wait_for_author') throw new Error('vote failed');
    });
    const result = await run({ ...writeEnv, ADO_SMOKE_URL: target.url });
    expect(result.code).toBe(1);
    expect(target.calls.some((call) => call.name === 'update_work_item' || call.name === 'add_work_item_comment')).toBe(false);
    expect(target.calls.filter((call) => call.name === 'create_or_update_wiki_page')).toHaveLength(3);
    expect(target.calls.filter((call) => call.name === 'vote_on_pull_request')).toHaveLength(2);
    expect(target.calls.at(-1)).toMatchObject({ name: 'update_pull_request_status', args: { pullRequestId: 81, action: 'abandon' } });
  });

  it.each([
    ['work item', 'create_work_item', { id: 0, rev: 1 }],
    ['work item revision', 'create_work_item', { id: 42 }],
    ['wiki eTag', 'create_or_update_wiki_page', { eTag: '' }],
    ['pull request', 'create_pull_request', { id: '81' }],
  ])('fails malformed %s creates and skips dependent writes', async (_label, tool, payload) => {
    const target = await controlledMcp((call) => call.name === tool ? json(payload) : undefined);
    const result = await run({ ...writeEnv, ADO_SMOKE_URL: target.url });
    expect(result.code).toBe(1);
    expect(result.output).toContain('could not read the result');
    if (tool === 'create_work_item') {
      expect(target.calls.some((call) => call.name === 'add_work_item_comment')).toBe(false);
      const updates = target.calls.filter((call) => call.name === 'update_work_item');
      expect(updates).toEqual('id' in payload && payload.id === 42 ? [{ name: 'update_work_item', args: { collection: 'DemoCollection', id: 42, state: 'Removed' } }] : []);
    }
    if (tool === 'create_or_update_wiki_page') expect(target.calls.filter((call) => call.name === tool)).toHaveLength(1);
    if (tool === 'create_pull_request') expect(target.calls.some((call) => call.name === 'vote_on_pull_request' || call.name === 'update_pull_request_status')).toBe(false);
    expect(target.calls.some((call) => call.name === (tool === 'create_pull_request' ? 'create_or_update_wiki_page' : 'create_pull_request'))).toBe(true);
  });

  it('still cleans up created work items after an update fails', async () => {
    const target = await controlledMcp((call) => call.name === 'update_work_item' && call.args.expectedRevision && call.args.title !== 'must not apply'
      ? { isError: true, content: [{ type: 'text', text: '[server] update failed' }] } : undefined);
    const result = await run({ ADO_SMOKE_URL: target.url, ADO_SMOKE_WRITE_PROJECT: 'scratch', ADO_SMOKE_WRITE_DONE_STATE: 'Closed' });
    expect(result.code).toBe(1);
    expect(target.calls.at(-1)).toEqual({ name: 'update_work_item', args: { collection: 'DemoCollection', id: 42, state: 'Closed' } });
  });

  it.each(['tool result', 'tool exception', 'connection error', 'configured URL'])('scrubs plain, URL-encoded and Basic credentials in %s', async (source) => {
    const pat = 'offline/pat?value=42';
    const token = 'offline+gateway/token?';
    const forms = [pat, token, encodeURIComponent(pat), encodeURIComponent(token), Buffer.from(`:${pat}`).toString('base64'), Buffer.from(`:${token}`).toString('base64')];
    const leaked = forms.join(' ');
    let url: string;
    if (source === 'connection error') {
      const app = express();
      app.use((_req, res) => { res.status(401).send(leaked); });
      url = await listen(app);
    } else {
      const target = await controlledMcp((call) => {
        if (call.name !== 'whoami_and_collections') return;
        if (source === 'tool exception') throw new Error(leaked);
        if (source === 'tool result') return { content: [{ type: 'text', text: leaked }] };
      });
      url = source === 'configured URL' ? `${target.url}?pat=${encodeURIComponent(pat)}&token=${encodeURIComponent(token)}` : target.url;
    }
    const result = await run({ ADO_SMOKE_URL: url, ADO_SMOKE_PAT: pat, ADO_MCP_TOKEN: token });
    expect(result.code).toBe(source === 'configured URL' ? 0 : 1);
    for (const form of forms) expect(result.output).not.toContain(form);
    expect(result.output).toContain('***');
  });
});
