import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HARD_MAX_CHARS } from '../../src/ado/bounded.js';
import { AdoError, DisambiguationRequired } from '../../src/ado/errors.js';
import type { AuditEvent } from '../../src/audit.js';
import { loadConfig } from '../../src/config/env.js';
import { SessionMemory } from '../../src/context/session-memory.js';
import { createDeps, type AppDeps } from '../../src/deps.js';
import { contextTools } from '../../src/tools/context-tools.js';
import { workItemTools } from '../../src/tools/workitem-tools.js';
import { defineTool, quoted, registerTools, rootName, runTool, selectTools, type AnyTool, type ToolExtra } from '../../src/tools/registry.js';
import { quoted as sharedQuoted } from '../../src/util/quoted.js';

const env = {
  ADO_MCP_TRANSPORT: 'stdio',
  ADO_DEFAULT_SERVER_URL: 'https://tfs.example.com/tfs',
  ADO_PAT: 'secret-pat-value',
  ADO_COLLECTIONS: 'DemoCollection',
  ADO_MCP_AUDIT_LOG: 'false',
};
let writeCalls = 0;

const contextTool = defineTool({ name: 'ctx_tool', toolset: 'context', title: 'Ctx', description: 'c', readOnly: true, input: {}, handler: async () => ({ ok: true }) });
const readTool = defineTool({
  name: 'read_tool', toolset: 'workitems', title: 'Read', description: 'r', readOnly: true,
  input: { value: z.string() },
  handler: async (args) => ({ echoed: args.value }),
});
const writeTool = defineTool({
  name: 'write_tool', toolset: 'pullrequests', title: 'Write', description: 'w', readOnly: false, destructive: true,
  input: { id: z.number().int().optional() },
  handler: async (_args, { confirm }) => {
    await confirm('Abandon pull request !7 "Fix login" (feature/login → develop).');
    writeCalls++;
    return { ok: true };
  },
});
const sneakyTool = defineTool({
  name: 'sneaky_tool', toolset: 'builds', title: 'Sneaky', description: 's', readOnly: false, destructive: true, input: {},
  handler: async (_args, { client }) => client.post({ collection: 'DemoCollection', path: '_apis/anything', area: 'core', apiVersion: '6.0', body: {} }),
});
const FOREIGN_REMOTE = 'http://otherhost:8080/tfs/DemoCollection/DemoProject/_git/ado-server-mcp';
const remoteReadTool = defineTool({
  name: 'remote_read_tool', toolset: 'repositories', title: 'Remote read', description: 'rr', readOnly: true, input: {},
  handler: async (_args, { resolver }) => {
    await resolver.resolve({ gitRemoteUrl: FOREIGN_REMOTE }, { repository: true });
    return { ok: true };
  },
});
const remoteWriteTool = defineTool({
  name: 'remote_write_tool', toolset: 'repositories', title: 'Remote write', description: 'rw', readOnly: false, input: {},
  handler: async (_args, { resolver }) => {
    await resolver.resolve({ gitRemoteUrl: FOREIGN_REMOTE }, { repository: true });
    return { ok: true };
  },
});
const failingTool = defineTool({
  name: 'failing_tool', toolset: 'builds', title: 'Fail', description: 'f', readOnly: true, input: {},
  handler: async () => { throw new AdoError('permission', "TF401027: You need the Git 'GenericContribute' permission."); },
});
const leakyTool = defineTool({
  name: 'leaky_tool', toolset: 'builds', title: 'Leak', description: 'l', readOnly: true, input: {},
  handler: async () => { throw new Error('boom secret-pat-value'); },
});
const askingTool = defineTool({
  name: 'asking_tool', toolset: 'builds', title: 'Ask', description: 'a', readOnly: true, input: {},
  handler: async () => {
    throw new DisambiguationRequired({ status: 'disambiguation_required', missing: 'collection', message: 'Which?', options: [{ collection: 'A' }, { collection: 'B' }] });
  },
});
const bigTool = defineTool({
  name: 'big_tool', toolset: 'builds', title: 'Big', description: 'b', readOnly: true, input: {},
  handler: async () => ({ count: 5000, value: Array.from({ length: 5000 }, (_, id) => ({ id, text: 'x'.repeat(100) })) }),
});
const bigNestedTool = defineTool({
  name: 'big_nested_tool', toolset: 'releases', title: 'Big nested', description: 'bn', readOnly: true, input: {},
  handler: async () => ({ release: { id: 1, environments: Array.from({ length: 5000 }, (_, id) => ({ id, text: 'x'.repeat(100) })) } }),
});
const bigGroupedTool = defineTool({
  name: 'big_grouped_tool', toolset: 'projects', title: 'Big grouped', description: 'bg', readOnly: true, input: {},
  handler: async () => ({
    collections: ['A', 'B'].map((collection) => ({ collection, projects: Array.from({ length: 3000 }, (_, id) => ({ id, text: 'x'.repeat(100) })) })),
  }),
});
const slowTool = defineTool({
  name: 'slow_tool', toolset: 'builds', title: 'Slow', description: 'sl', readOnly: false, destructive: true,
  input: { loadMs: z.number().int() },
  handler: async (args, { client, confirm }) => {
    await new Promise((resolve) => setTimeout(resolve, args.loadMs));
    await confirm('Queue pipeline "Slow".');
    return client.post({ collection: 'DemoCollection', path: '_apis/build/builds', area: 'core', apiVersion: '6.0', body: {} });
  },
});
const ALL = [contextTool, readTool, writeTool, sneakyTool, remoteReadTool, remoteWriteTool, failingTool, leakyTool, askingTool, bigTool, bigNestedTool, bigGroupedTool, slowTool];

type Answer = boolean | undefined;

async function connect(
  deps: AppDeps,
  tools: AnyTool[],
  confirm?: (message: string) => Answer | Promise<Answer>,
  capabilities: Record<string, unknown> = confirm ? { elicitation: { form: {} } } : {},
  memory?: SessionMemory,
) {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerTools(server, tools, deps, memory);
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities });
  if (confirm) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const answer = await confirm(request.params.message);
      return answer === undefined ? { action: 'cancel' as const } : { action: 'accept' as const, content: { confirm: answer } };
    });
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, text: (result.content as Array<{ text: string }>)[0]?.text ?? '' };
  };
  return { client, call, close: async () => { await client.close(); await server.close(); } };
}

describe('outbound credential boundary', () => {
  const pat = 'tiny';
  const collectionPat = 'tiny-extended';
  const escapedPat = 'quote"slash\\end';
  const gateway = 'tiny-gateway-012345678901234567890123';
  const secretText = `${collectionPat} ${pat} ${escapedPat} ${gateway}`;
  const config = () => loadConfig({ ...env, ADO_PAT: pat, ADO_COLLECTION_PATS: JSON.stringify({ Other: collectionPat, Escaped: escapedPat }), ADO_MCP_HTTP_TOKEN: gateway, ADO_FORCE_API_VERSION: '6.0' });

  it('scrubs successful real work-item fields before JSON serialization, including encoded credentials', async () => {
    const events: AuditEvent[] = [];
    const harness = await connect(createDeps(config(), async () => Response.json({ id: 7, fields: { 'System.Description': `${secretText} ${encodeURIComponent(escapedPat)} ${Buffer.from(`:${pat}`).toString('base64')}` } }), (event) => events.push(event)), workItemTools);
    try {
      const result = await harness.call('get_work_item', { collection: 'DemoCollection', id: 7, fields: ['System.Description'] });
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text)).toEqual({ id: 7, fields: { 'System.Description': '*** *** *** *** *** ***' } });
      expect(result.text.length).toBeLessThanOrEqual(HARD_MAX_CHARS);
      for (const secret of [pat, collectionPat, escapedPat, gateway]) expect(JSON.stringify(events)).not.toContain(secret);
    } finally { await harness.close(); }
  });

  it('scrubs upstream errors with overlapping PAT and gateway credentials in one pass', async () => {
    const harness = await connect(createDeps(config(), async () => Response.json({ message: secretText }, { status: 403 })), workItemTools);
    try {
      const result = await harness.call('get_work_item', { collection: 'DemoCollection', id: 7 });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('*** *** *** ***');
      expect(result.text).not.toContain('-extended');
      expect(result.text).not.toContain('-gateway-');
    } finally { await harness.close(); }
  });

  it('scrubs disambiguation objects and their keys without breaking JSON', async () => {
    const tool = defineTool({ name: 'choose_secret', toolset: 'context', title: 'Choose', description: 'Choose', readOnly: true, input: {}, handler: async () => {
      throw new DisambiguationRequired({ status: 'disambiguation_required', missing: 'collection', message: secretText, options: [{ collection: collectionPat, project: escapedPat }] });
    } });
    const harness = await connect(createDeps(config()), [tool]);
    try {
      expect(JSON.parse((await harness.call(tool.name)).text)).toMatchObject({ message: '*** *** *** ***', options: [{ collection: '***', project: '***' }] });
    } finally { await harness.close(); }
  });

  it('scrubs confirmation messages and declined errors before the SDK client receives them', async () => {
    const prompts: string[] = [];
    const tool = defineTool({ name: 'confirm_secret', toolset: 'context', title: 'Confirm', description: 'Confirm', readOnly: false, destructive: true, input: {}, handler: async (_args, { confirm }) => {
      await confirm(secretText);
      throw new Error('A declined confirmation must stop the handler');
    } });
    const harness = await connect(createDeps(config()), [tool], (message) => { prompts.push(message); return false; });
    try {
      const result = await harness.call(tool.name);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('*** *** *** ***');
      expect(result.isError).toBe(true);
      expect(result.text).toContain('*** *** *** ***');
    } finally { await harness.close(); }
  });

  it('redacts before fitting large JSON and preserves non-secret fields', async () => {
    const tool = defineTool({ name: 'large_secret', toolset: 'context', title: 'Large', description: 'Large', readOnly: true, input: {}, handler: async () => ({ [escapedPat]: escapedPat, items: Array.from({ length: 15000 }, () => ({ text: 'xy' })) }) });
    const deps = createDeps(loadConfig({ ...env, ADO_PAT: 'xy', ADO_COLLECTION_PATS: JSON.stringify({ Other: escapedPat }) }));
    const harness = await connect(deps, [tool]);
    try {
      const result = await harness.call(tool.name);
      expect(result.text.length).toBeLessThanOrEqual(HARD_MAX_CHARS);
      const parsed = JSON.parse(result.text);
      expect(parsed).toMatchObject({ '***': '***', truncated: true });
      expect(parsed.items[0]).toEqual({ text: '***' });
    } finally { await harness.close(); }
  });

  it('keeps redacted elicitation choices distinct and resolves the original selected collection', async () => {
    const choiceConfig = loadConfig({ ...env, ADO_PAT: pat, ADO_COLLECTIONS: `${pat},${collectionPat}`, ADO_COLLECTION_PATS: JSON.stringify({ [collectionPat]: collectionPat }), ADO_FORCE_API_VERSION: '6.0' });
    const tool = defineTool({ name: 'secret_choice', toolset: 'context', title: 'Choose', description: 'Choose', readOnly: true, input: {}, handler: async (_args, { resolver }) => {
      const scope = await resolver.resolve({});
      return { selectedOriginal: scope.collection === collectionPat };
    } });
    const harness = await connect(createDeps(choiceConfig, async () => Response.json({ value: [] })), [tool], () => undefined);
    const prompts: unknown[] = [];
    harness.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(request.params);
      if (!('requestedSchema' in request.params)) throw new Error('Expected a form prompt');
      const property = request.params.requestedSchema.properties.collection;
      if (!('enum' in property)) throw new Error('Expected enum choices');
      const options = property.enum;
      expect(options).toEqual(['1. ***', '2. ***']);
      return { action: 'accept', content: { collection: options[1] } };
    });
    try {
      const result = await harness.call(tool.name);
      expect(JSON.parse(result.text)).toMatchObject({ selectedOriginal: true });
      expect(prompts).toHaveLength(1);
      expect(JSON.stringify(prompts)).not.toContain(pat);
    } finally { await harness.close(); }
  });

  it('keeps expanding short-secret redaction inside the text output limit', async () => {
    const tool = defineTool({ name: 'secret_text', toolset: 'context', title: 'Text', description: 'Text', readOnly: true, input: {}, handler: async () => 'xy'.repeat(60000) });
    const harness = await connect(createDeps(loadConfig({ ...env, ADO_PAT: 'xy' })), [tool]);
    try {
      const result = await harness.call(tool.name);
      expect(result.text).not.toContain('xy');
      expect(result.text.length).toBeLessThanOrEqual(HARD_MAX_CHARS);
      expect(result.text).toContain('truncated');
    } finally { await harness.close(); }
  });
});

describe('selectTools', () => {
  it('filters by toolset but always keeps context tools', () => {
    const config = loadConfig({ ...env, ADO_MCP_TOOLSETS: 'workitems' });
    expect(selectTools(ALL, config).map((tool) => tool.name)).toEqual(['ctx_tool', 'read_tool']);
  });
  it('drops write tools in read-only mode', () => {
    const config = loadConfig({ ...env, ADO_MCP_READ_ONLY: 'true' });
    expect(selectTools(ALL, config).map((tool) => tool.name)).not.toContain('write_tool');
  });
  it('narrows the list to the caller toolsets and read-only header', () => {
    const config = loadConfig(env);
    expect(selectTools(ALL, config, { toolsets: new Set(['pullrequests'] as const), readOnly: false }).map((tool) => tool.name)).toEqual(['ctx_tool', 'write_tool']);
    expect(selectTools(ALL, config, { toolsets: undefined, readOnly: true }).map((tool) => tool.name)).not.toContain('write_tool');
  });
});

describe('registerTools', () => {
  it('publishes annotations', async () => {
    const harness = await connect(createDeps(loadConfig(env)), ALL);
    const { tools } = await harness.client.listTools();
    expect(tools.find((tool) => tool.name === 'write_tool')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(tools.find((tool) => tool.name === 'read_tool')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    await harness.close();
  });

  it('runs handlers with validated arguments', async () => {
    const harness = await connect(createDeps(loadConfig(env)), ALL);
    expect(await harness.call('read_tool', { value: 'hi' })).toEqual({ isError: false, text: JSON.stringify({ echoed: 'hi' }, null, 2) });
    await harness.close();
  });

  it('blocks write tools for read-only callers', async () => {
    const base = createDeps(loadConfig(env));
    const deps: AppDeps = { ...base, contextFor: (headers) => ({ ...base.contextFor(headers), readOnly: true }) };
    const harness = await connect(deps, ALL);
    const result = await harness.call('write_tool');
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[read_only\]/);
    expect(writeCalls).toBe(0);
    await harness.close();
  });

  it('tags Azure DevOps errors and redacts secrets from unexpected ones', async () => {
    const harness = await connect(createDeps(loadConfig(env)), ALL);
    expect(await harness.call('failing_tool')).toEqual({ isError: true, text: "[permission] TF401027: You need the Git 'GenericContribute' permission." });
    expect(await harness.call('leaky_tool')).toEqual({ isError: true, text: '[server] boom ***' });
    await harness.close();
  });

  it('returns disambiguation as a normal result', async () => {
    const harness = await connect(createDeps(loadConfig(env)), ALL);
    const result = await harness.call('asking_tool');
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ status: 'disambiguation_required', missing: 'collection' });
    await harness.close();
  });

  it('asks before destructive calls and honours the answer', async () => {
    writeCalls = 0;
    const questions: string[] = [];
    let answer: boolean | undefined = false;
    const harness = await connect(createDeps(loadConfig(env)), ALL, (message) => {
      questions.push(message);
      return answer;
    });
    expect((await harness.call('write_tool')).text).toMatch(/^\[declined\]/);
    answer = undefined;
    expect((await harness.call('write_tool')).text).toMatch(/^\[declined\]/);
    expect(writeCalls).toBe(0);
    answer = true;
    expect((await harness.call('write_tool')).isError).toBe(false);
    expect(writeCalls).toBe(1);
    expect(questions[0]).toMatch(/^Abandon pull request !7 "Fix login" \(feature\/login → develop\)\.\n\nGo ahead\?/);
    await harness.close();
  });

  it('blocks writes a destructive tool sends before confirming', async () => {
    const harness = await connect(createDeps(loadConfig(env)), ALL, () => true);
    const result = await harness.call('sneaky_tool');
    expect(result.text).toMatch(/^\[server\] sneaky_tool tried POST _apis\/anything before the user confirmed/);
    await harness.close();
  });

  it('does not write when the client cancels while the user is deciding', async () => {
    writeCalls = 0;
    const controller = new AbortController();
    const harness = await connect(createDeps(loadConfig(env)), ALL, async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return true;
    });
    await expect(harness.client.callTool({ name: 'write_tool', arguments: {} }, undefined, { signal: controller.signal })).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(writeCalls).toBe(0);
    await harness.close();
  });

  it('starts the first write early enough to finish inside the client timeout', async () => {
    let posts = 0;
    const fakeFetch = (async () => {
      posts++;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    // The first write must start within 300 ms of the call; a prompt needs at least 100 ms.
    const timing = { clientTimeoutMs: 400, writeReserveMs: 100, minPromptMs: 100 };
    const prompts: string[] = [];
    const asking = await connect({ ...createDeps(loadConfig(env), fakeFetch), timing }, ALL, (message) => {
      prompts.push(message);
      return true;
    });
    expect((await asking.call('slow_tool', { loadMs: 250 })).text).toMatch(/^\[network\] .*too little time.*Nothing was changed/);
    expect(prompts).toEqual([]);
    expect((await asking.call('slow_tool', { loadMs: 0 })).isError).toBe(false);
    expect([prompts.length, posts]).toEqual([1, 1]);

    const preapproved = await connect({ ...createDeps(loadConfig({ ...env, ADO_ALLOW_DESTRUCTIVE: 'true' }), fakeFetch), timing }, ALL);
    expect((await preapproved.call('slow_tool', { loadMs: 350 })).text).toMatch(/^\[network\] .*too little time/);
    expect(posts).toBe(1);
    await asking.close();
    await preapproved.close();
  });

  it('refuses destructive calls when the client cannot ask', async () => {
    writeCalls = 0;
    const harness = await connect(createDeps(loadConfig(env)), ALL);
    const result = await harness.call('write_tool');
    expect(result.text).toMatch(/^\[confirmation_required\].*X-ADO-Allow-Destructive/);
    const urlOnly = await connect(createDeps(loadConfig(env)), ALL, () => { throw new Error('should not ask'); }, { elicitation: { url: {} } });
    expect((await urlOnly.call('write_tool')).text).toMatch(/^\[confirmation_required\]/);
    expect(writeCalls).toBe(0);
    await harness.close();
    await urlOnly.close();
  });

  it('warns on reads and refuses writes through a remote on a host that is not allowed', async () => {
    const harness = await connect(createDeps(loadConfig(env)), ALL);
    const read = JSON.parse((await harness.call('remote_read_tool')).text) as { ok: boolean; context: { from: string[]; warning: string } };
    expect(read).toMatchObject({ ok: true, context: { from: ['serverUrl:remote-ignored'] } });
    expect(read.context.warning).toMatch(/server this connection does not use/);
    expect((await harness.call('remote_write_tool')).text).toMatch(/^\[bad_request\].*otherhost:8080/);
    await harness.close();
  });

  it('skips the question when destructive calls are allowed', async () => {
    writeCalls = 0;
    const harness = await connect(createDeps(loadConfig({ ...env, ADO_ALLOW_DESTRUCTIVE: 'true' })), ALL, () => {
      throw new Error('should not ask');
    });
    expect((await harness.call('write_tool')).isError).toBe(false);
    expect(writeCalls).toBe(1);
    await harness.close();
  });

  it('audits each call with identifying values only and no secrets', async () => {
    const events: AuditEvent[] = [];
    const sink = (event: AuditEvent) => events.push(event);
    const harness = await connect(createDeps(loadConfig(env), fetch, sink), ALL);
    await harness.call('read_tool', { value: 'hi-there' });
    await harness.call('failing_tool');
    const allowed = await connect(createDeps(loadConfig({ ...env, ADO_ALLOW_DESTRUCTIVE: 'true' }), fetch, sink), ALL);
    await allowed.call('write_tool', { id: 7 });
    expect(events).toMatchObject([
      { event: 'tool_call', tool: 'read_tool', outcome: 'ok', args: ['value'], values: undefined, user: expect.stringMatching(/^fp:[0-9a-f]{12}$/) },
      { event: 'tool_call', tool: 'failing_tool', outcome: 'permission' },
      { event: 'tool_call', tool: 'write_tool', outcome: 'ok', values: { id: 7 }, confirmation: 'preapproved' },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/secret-pat-value|hi-there/);
    await harness.close();
    await allowed.close();
  });

  it.each(['secret-pat-value', 'tiny'])('redacts the caller PAT %s from actual context-tool audit scope', async (pat) => {
    const events: AuditEvent[] = [];
    const config = loadConfig({
      ...env,
      ADO_PAT: pat,
      ADO_COLLECTION_PATS: JSON.stringify({ Other: 'collection-secret' }),
      ADO_FORCE_API_VERSION: '6.0',
    });
    const deps = createDeps(config, async () => new Response('', { status: 401 }), (event) => events.push(event));
    const harness = await connect(deps, contextTools);
    try {
      const result = await harness.call('resolve_repo_context', { collection: pat, project: 'collection-secret', repository: 'r' });
      expect(result.isError).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ tool: 'resolve_repo_context', collection: '***', project: '***', args: ['collection', 'project', 'repository'] });
      expect(JSON.stringify(events)).not.toContain(pat);
      expect(JSON.stringify(events)).not.toContain('collection-secret');
    } finally {
      await harness.close();
    }
  });

  it('redacts every audit string and identifying credentials before truncation', async () => {
    const events: AuditEvent[] = [];
    const longPat = `${env.ADO_PAT}-${'x'.repeat(64)}`;
    const gatewayToken = 'gateway-secret-01234567890123456789';
    const config = loadConfig({
      ...env,
      ADO_COLLECTION_PATS: JSON.stringify({ Other: longPat, Short: 'tiny' }),
      ADO_MCP_HTTP_TOKEN: gatewayToken,
    });
    const memory = new SessionMemory();
    memory.user = `user ${env.ADO_PAT} ${longPat} tiny ${gatewayToken}`;
    const tool = defineTool({
      name: `audit_${env.ADO_PAT}`, toolset: 'context', title: 'Audit', description: 'Audit strings', readOnly: true,
      input: { [env.ADO_PAT]: z.string(), action: z.string(), status: z.string(), id: z.number(), buildId: z.string(), vote: z.string() },
      handler: async () => ({ ok: true }),
    });
    const harness = await connect(createDeps(config, undefined, (event) => events.push(event)), [tool], undefined, {}, memory);
    try {
      expect((await harness.call(tool.name, { [env.ADO_PAT]: 'omitted', action: longPat, status: 'tiny', id: 17, buildId: 'build-17', vote: 'approve' })).isError).toBe(false);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'tool_call', tool: 'audit_***', user: 'user *** *** *** ***', outcome: 'ok', ms: expect.any(Number),
        args: ['action', 'buildId', 'id', '***', 'status', 'vote'],
        values: { action: '***', status: '***', id: 17, buildId: 'build-17', vote: 'approve' },
      });
      for (const secret of [env.ADO_PAT, longPat, 'tiny', gatewayToken]) expect(JSON.stringify(events)).not.toContain(secret);
    } finally {
      await harness.close();
    }
  });

  it('redacts the gateway token supplied in request headers', async () => {
    const events: AuditEvent[] = [];
    const gatewayToken = 'request-gateway-secret-0123456789012345';
    const memory = new SessionMemory();
    memory.user = `user ${gatewayToken}`;
    const extra: ToolExtra = {
      signal: new AbortController().signal,
      requestId: 1,
      sendNotification: async () => undefined,
      sendRequest: async () => { throw new Error('This tool must not send an MCP request.'); },
      requestInfo: { headers: { 'x-ado-mcp-token': gatewayToken } },
    };
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    try {
      const result = await runTool(server, contextTool, {}, extra, createDeps(loadConfig(env), undefined, (event) => events.push(event)), memory);
      expect(result.isError).not.toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event: 'tool_call', tool: 'ctx_tool', user: 'user ***', outcome: 'ok' });
    } finally {
      await server.close();
    }
  });

  it('keeps oversized results valid JSON', async () => {
    const harness = await connect(createDeps(loadConfig(env)), ALL);
    const { text } = await harness.call('big_tool');
    expect(text.length).toBeLessThanOrEqual(HARD_MAX_CHARS);
    const json = JSON.parse(text) as { count: number; value: unknown[]; truncated: boolean; note: string };
    expect(json).toMatchObject({ count: 5000, truncated: true });
    expect(json.value.length).toBeGreaterThan(0);
    expect(json.value.length).toBeLessThan(5000);
    expect(json.note).toMatch(/of 5000 value/);

    const nested = JSON.parse((await harness.call('big_nested_tool')).text) as { release: { id: number; environments: unknown[] }; truncated: boolean; note: string };
    expect(nested).toMatchObject({ release: { id: 1 }, truncated: true });
    expect(nested.release.environments.length).toBeGreaterThan(0);
    expect(nested.release.environments.length).toBeLessThan(5000);
    expect(nested.note).toMatch(/of 5000 release\.environments/);

    const groupedText = (await harness.call('big_grouped_tool')).text;
    expect(groupedText.length).toBeLessThanOrEqual(HARD_MAX_CHARS);
    const grouped = JSON.parse(groupedText) as { collections: Array<{ collection: string; projects: unknown[] }>; note: string };
    expect(grouped.collections.map((entry) => entry.collection)).toEqual(['A', 'B']);
    for (const entry of grouped.collections) expect(entry.projects.length).toBeGreaterThan(0);
    expect(grouped.note).toMatch(/collections\.0\.projects/);
    expect(grouped.note).toMatch(/collections\.1\.projects/);
    await harness.close();
  });
});

describe('rootName', () => {
  it.each([
    ['file:///e%3A/DemoWorkspace/ADO-MCP', 'ADO-MCP'],
    ['file:///home/me/demoservice-api/', 'demoservice-api'],
    ['file:///E:/work/Demo%20Product', 'Demo Product'],
  ])('reads %s as %s', (uri, expected) => {
    expect(rootName(uri)).toBe(expected);
  });
});

describe('quoted', () => {
  it('re-exports the shared helper that tests/unit/quoted.test.ts covers', () => {
    expect(quoted).toBe(sharedQuoted);
  });
});
