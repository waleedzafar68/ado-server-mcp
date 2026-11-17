import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../src/audit.js';
import { loadConfig } from '../../src/config/env.js';
import { createDeps } from '../../src/deps.js';
import { createHttpApp } from '../../src/http/app.js';
import { MockAdoServer, userIdFor } from '../fixtures/mock-ado-server.js';

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
};
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

const DEMO = { Authorization: 'Bearer pat-demo', 'X-ADO-Collections': 'DemoCollection' };
const ALL = { Authorization: 'Bearer pat-all', 'X-ADO-Collections': 'DemoCollection,LegacyCollection' };

interface Running {
  mock: MockAdoServer;
  url: string;
  events: AuditEvent[];
  sessions(): number;
  shutdown(): Promise<void>;
  close(): Promise<void>;
}

async function startHttp(env: Record<string, string> = {}): Promise<Running> {
  const mock = new MockAdoServer({ flavor: '2020' });
  await mock.start();
  const config = loadConfig({ ADO_DEFAULT_SERVER_URL: mock.serverUrl, ADO_ALLOW_INSECURE_HTTP: 'true', ...env });
  const events: AuditEvent[] = [];
  const http = createHttpApp(createDeps(config, fetch, (event) => events.push(event)));
  const listener: Server = http.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', () => resolve()));
  return {
    mock,
    url: `http://127.0.0.1:${(listener.address() as AddressInfo).port}${config.path}`,
    events,
    sessions: () => http.sessionCount(),
    shutdown: () => http.close(),
    async close() {
      await http.close();
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await mock.stop();
    },
  };
}

async function connect(url: string, headers: Record<string, string>, elicit?: (values: string[]) => string) {
  const client = new Client({ name: 'e2e', version: '1.0.0' }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const params = request.params as { requestedSchema: { properties: Record<string, { enum?: string[] }> } };
      const [field, schema] = Object.entries(params.requestedSchema.properties)[0] ?? ['value', {}];
      return { action: 'accept' as const, content: { [field]: elicit(schema.enum ?? []) } };
    });
  }
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    return { isError: result.isError === true, text, json: JSON.parse(text) as Record<string, any> };
  };
  return { client, transport, call };
}

describe('Streamable HTTP server', () => {
  let running: Running | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('serves /healthz without credentials', async () => {
    running = await startHttp();
    const response = await fetch(running.url.replace(/\/mcp$/, '/healthz'));
    expect(await response.json()).toMatchObject({ status: 'ok', name: 'ado-server-mcp' });
  });

  it('rejects callers without a PAT', async () => {
    running = await startHttp();
    const response = await fetch(running.url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(INIT) });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(JSON.stringify(await response.json())).toMatch(/Authorization: Bearer/);
  });

  it.each([
    ['Bearer', 'pairs'], ['Basic', 'json'], ['Bearer', 'base64'],
  ])('keeps pre-context diagnostics non-reflective with %s authorization and %s collection PATs', async (auth, format) => {
    const pat = 'tiny';
    const collectionPat = 'tiny-extended';
    const gateway = 'gateway-secret-01234567890123456789';
    const collectionJson = JSON.stringify({ Other: collectionPat });
    running = await startHttp({ ADO_MCP_HTTP_TOKEN: gateway });
    const credentials = {
      authorization: auth === 'Basic' ? `Basic ${Buffer.from(`:${pat}`).toString('base64')}` : `Bearer ${pat}`,
      'x-ado-collection-pats': format === 'pairs' ? `Other=${collectionPat}` : format === 'json' ? collectionJson : Buffer.from(collectionJson).toString('base64'),
      'x-ado-mcp-token': gateway,
    };
    for (const [header, value, status] of [
      ['x-ado-server-url', pat, 400],
      ['x-ado-server-url', `https://${collectionPat}.example/tfs`, 403],
      ['x-ado-server-url', `ftp://${gateway}.example/tfs`, 403],
      ['origin', `https://${gateway}.example`, 403],
    ] as const) {
      const response = await fetch(running.url, { method: 'POST', headers: { ...JSON_HEADERS, ...credentials, [header]: value }, body: JSON.stringify(INIT) });
      expect(response.status).toBe(status);
      expect(response.headers.get('www-authenticate')).toBeNull();
      const payload = JSON.stringify(await response.json());
      for (const secret of [pat, collectionPat, gateway]) expect(payload).not.toContain(secret);
    }
    expect(running.mock.requests).toHaveLength(0);
  });

  it('does not reflect credentials in collection admission failures', async () => {
    running = await startHttp();
    const response = await fetch(running.url, { method: 'POST', headers: { ...JSON_HEADERS, authorization: 'Bearer pat-demo', 'x-ado-collections': 'pat-demo' }, body: JSON.stringify(INIT) });
    expect([400, 401]).toContain(response.status);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(JSON.stringify(await response.json())).not.toContain('pat-demo');
  });

  it('rejects a server URL outside the allowlist', async () => {
    running = await startHttp();
    const response = await fetch(running.url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: 'Bearer pat-demo', 'x-ado-server-url': 'https://evil.example.com/tfs' },
      body: JSON.stringify(INIT),
    });
    expect(response.status).toBe(403);
  });

  it('rejects a repeated Authorization header without echoing either value', async () => {
    running = await startHttp();
    // Flat raw headers keep duplicate Authorization fields separate on the wire.
    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        running!.url,
        { method: 'POST', headers: [...Object.entries(JSON_HEADERS).flat(), 'Host', new URL(running!.url).host, 'Content-Length', String(Buffer.byteLength(JSON.stringify(INIT))), 'Authorization', 'Bearer pat-demo', 'Authorization', 'Bearer pat-2017'] },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (text += chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify(INIT));
    });
    expect(status).toBe(400);
    expect(body).toMatch(/authorization header only once/);
    expect(body).not.toMatch(/pat-demo|pat-2017/);
    expect(running.events).toContainEqual(expect.objectContaining({ event: 'admission_denied', reason: 'caller_headers', status: 400 }));
  });

  it.each(['bogus', 'pat-demo'])('rejects unknown toolset %s without echoing its value', async (toolset) => {
    running = await startHttp();
    const response = await fetch(running.url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: 'Bearer pat-demo', 'x-ado-toolsets': toolset },
      body: JSON.stringify(INIT),
    });
    expect(response.status).toBe(400);
    const payload = await response.json() as { error: { message: string } };
    expect(payload.error.message).toMatch(/Unknown toolset.*X-ADO-Toolsets.*Valid toolsets: projects/);
    expect(JSON.stringify(payload)).not.toContain(toolset);
    expect(JSON.stringify(running.events)).not.toContain('pat-demo');
  });

  it('checks the PAT at initialize', async () => {
    running = await startHttp();
    const response = await fetch(running.url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: 'Bearer pat-2017', 'x-ado-collections': 'DemoCollection' },
      body: JSON.stringify(INIT),
    });
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).toMatch(/PAT was rejected/);
    expect(running.sessions()).toBe(0);
    expect(running.events).toContainEqual(expect.objectContaining({ event: 'admission_denied', reason: 'pat_check', status: 401 }));
  });

  it('checks the PAT even when no collection is named', async () => {
    running = await startHttp();
    const init = (authorization: string) => fetch(running!.url, { method: 'POST', headers: { ...JSON_HEADERS, authorization }, body: JSON.stringify(INIT) });
    const scoped = await init('Bearer pat-demo');
    expect(scoped.status).toBe(401);
    expect(JSON.stringify(await scoped.json())).toMatch(/X-ADO-Collections/);
    expect((await init('Bearer not-a-pat')).status).toBe(401);
    expect(running.sessions()).toBe(0);
    const { client } = await connect(running.url, { Authorization: 'Bearer pat-all' });
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    expect(running.sessions()).toBe(1);
    expect(running.mock.requestsTo(/\/_apis\/connectionData$/).at(-1)?.path).toBe('/tfs/DemoCollection/_apis/connectionData');
    await client.close();
  });

  it('tries the next listed collection when the PAT is not accepted in the first', async () => {
    running = await startHttp();
    running.mock.on('GET', /\/DemoCollection\/_apis\/connectionData$/, () => ({ status: 401, text: 'TF400813: not authorized to access this resource.' }));
    const { client } = await connect(running.url, { Authorization: 'Bearer pat-all' });
    expect(running.sessions()).toBe(1);
    expect(running.mock.requestsTo(/\/_apis\/connectionData$/).map((request) => request.path)).toEqual([
      '/tfs/DemoCollection/_apis/connectionData',
      '/tfs/LegacyCollection/_apis/connectionData',
    ]);
    const choices = await client.callTool({ name: 'resolve_repo_context', arguments: {} });
    expect(JSON.stringify(choices.content)).toMatch(/LegacyCollection/);
    expect(JSON.stringify(choices.content)).not.toMatch(/DemoCollection/);
    await client.close();
  });

  it('enforces the gateway token in X-ADO-MCP-Token', async () => {
    const token = 'g'.repeat(40);
    running = await startHttp({ ADO_MCP_HTTP_TOKEN: token });
    const denied = await fetch(running.url, { method: 'POST', headers: { ...JSON_HEADERS, authorization: 'Bearer pat-demo' }, body: JSON.stringify(INIT) });
    expect(denied.status).toBe(401);
    const { client } = await connect(running.url, { ...DEMO, 'X-ADO-MCP-Token': token });
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
  });

  it('rate-limits failures per caller, with a higher ceiling per address', async () => {
    running = await startHttp({ ADO_MCP_AUTH_FAILURE_LIMIT: '2' });
    const init = (headers: Record<string, string>) => fetch(running!.url, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(INIT) });
    const wrong = { authorization: 'Bearer pat-2017', 'x-ado-collections': 'DemoCollection' };
    const good = { authorization: 'Bearer pat-demo', 'x-ado-collections': 'DemoCollection' };
    expect((await init(wrong)).status).toBe(401);
    expect((await init(wrong)).status).toBe(401);
    const blocked = await init(wrong);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('300');

    const colleague = await init(good);
    expect(colleague.status).toBe(200);
    await colleague.body?.cancel();

    for (let guess = 0; guess < 18; guess++) await init({ authorization: `Bearer guess-${guess}`, 'x-ado-collections': 'DemoCollection' });
    expect((await init(good)).status).toBe(429);
  });

  it('reserves session slots before connecting, so concurrent initializes cannot pass the cap', async () => {
    running = await startHttp({ ADO_MCP_MAX_SESSIONS: '1' });
    const init = (headers: Record<string, string>) => fetch(running!.url, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(INIT) });
    const together = async (headers: Record<string, string>[], scope: 'server' | 'user') => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const original = StreamableHTTPServerTransport.prototype.start;
      const starting = vi.spyOn(StreamableHTTPServerTransport.prototype, 'start').mockImplementation(async function (this: StreamableHTTPServerTransport) {
        await gate;
        await original.call(this);
      });
      const responses = Promise.all(headers.map(init));
      try {
        await vi.waitFor(() => expect(running!.events).toContainEqual(expect.objectContaining({ event: 'admission_denied', reason: 'capacity', scope })));
      } finally {
        release();
        // Drain the real requests before restoring the transport and tearing down the listener.
        try {
          await responses;
        } finally {
          starting.mockRestore();
        }
      }
      return responses;
    };
    const responses = await together([
      { authorization: 'Bearer pat-demo', 'x-ado-collections': 'DemoCollection' },
      { authorization: 'Bearer pat-2017', 'x-ado-collections': 'LegacyCollection' },
    ], 'server');
    expect(responses.map((response) => response.status).sort()).toEqual([200, 503]);
    expect(running.sessions()).toBe(1);
    expect(running.events).toContainEqual(expect.objectContaining({ event: 'admission_denied', reason: 'capacity', scope: 'server' }));
    await Promise.all(responses.map((response) => response.body?.cancel()));
    await running.close();

    running = await startHttp({ ADO_MCP_MAX_SESSIONS_PER_USER: '1' });
    const same = await together([0, 1].map(() => ({ authorization: 'Bearer pat-demo', 'x-ado-collections': 'DemoCollection' })), 'user');
    const refused = same.find((response) => response.status === 503);
    expect(await refused?.json()).toMatchObject({ error: { message: expect.stringMatching(/You already have 1 MCP sessions still connecting/) } });
    expect(running.events).toContainEqual(expect.objectContaining({ event: 'admission_denied', reason: 'capacity', scope: 'user' }));
    await Promise.all(same.filter((response) => !response.bodyUsed).map((response) => response.body?.cancel()));
  });

  it('answers oversized bodies with 413', async () => {
    running = await startHttp();
    const response = await fetch(running.url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: 'Bearer pat-demo' },
      body: JSON.stringify({ ...INIT, padding: 'x'.repeat(6 * 1024 * 1024) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32600 } });
  });

  it.each(['false', 'true'])('stays closed when admission completes after shutdown (stateless=%s)', async (stateless) => {
    running = await startHttp({ ADO_MCP_STATELESS: stateless });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    running.mock.on('GET', /\/DemoCollection\/_apis\/connectionData$/, async () => {
      await gate;
      return { json: { authenticatedUser: { id: userIdFor('pat-demo'), providerDisplayName: 'Alice' } } };
    });
    const initialize = () => fetch(running!.url, { method: 'POST', headers: { ...JSON_HEADERS, ...DEMO }, body: JSON.stringify(INIT) });
    const response = initialize();
    try {
      await vi.waitFor(() => expect(running!.mock.requestsTo(/\/_apis\/connectionData$/)).toHaveLength(1));
      let closed = false;
      const closing = running.shutdown().then(() => { closed = true; });
      await vi.waitFor(() => expect(closed).toBe(true));
      expect(running.sessions()).toBe(0);
      release();
      const admitted = await response;
      expect(admitted.status).toBe(503);
      expect(admitted.headers.get('mcp-session-id')).toBeNull();
      await admitted.body?.cancel();
      expect(running.sessions()).toBe(0);
      expect(running.events.some((event) => event.event === 'session_open')).toBe(false);
      const later = await initialize();
      expect(later.status).toBe(503);
      await later.body?.cancel();
      expect(running.mock.requestsTo(/\/_apis\/connectionData$/)).toHaveLength(1);
      await closing;
    } finally {
      release();
      const pending = await response;
      if (!pending.bodyUsed) await pending.body?.cancel();
    }
  });

  it.each(['false', 'true'])('cleans a connecting transport during shutdown (stateless=%s)', async (stateless) => {
    running = await startHttp({ ADO_MCP_STATELESS: stateless });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    let closedTransport = false;
    const original = StreamableHTTPServerTransport.prototype.start;
    const starting = vi.spyOn(StreamableHTTPServerTransport.prototype, 'start').mockImplementation(async function (this: StreamableHTTPServerTransport) {
      const onclose = this.onclose;
      this.onclose = () => { closedTransport = true; onclose?.(); };
      entered = true;
      await gate;
      await original.call(this);
    });
    const response = fetch(running.url, { method: 'POST', headers: { ...JSON_HEADERS, ...DEMO }, body: JSON.stringify(INIT) });
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      let closed = false;
      const closing = running.shutdown().then(() => { closed = true; });
      await vi.waitFor(() => expect(closed).toBe(true));
      expect(closedTransport).toBe(true);
      release();
      const connected = await response;
      expect(connected.status).toBe(503);
      expect(connected.headers.get('mcp-session-id')).toBeNull();
      await connected.body?.cancel();
      expect(running.sessions()).toBe(0);
      expect(running.events.some((event) => event.event === 'session_open')).toBe(false);
      await closing;
    } finally {
      release();
      try {
        const pending = await response;
        if (!pending.bodyUsed) await pending.body?.cancel();
      } finally {
        starting.mockRestore();
      }
    }
  });

  it('caps sessions per user and overall', async () => {
    running = await startHttp({ ADO_MCP_MAX_SESSIONS: '2', ADO_MCP_MAX_SESSIONS_PER_USER: '1' });
    const first = await connect(running.url, DEMO);
    const second = await connect(running.url, DEMO);
    await expect(first.client.listTools()).rejects.toThrow();
    expect((await second.client.listTools()).tools.length).toBeGreaterThan(0);
    const bob = await connect(running.url, { Authorization: 'Bearer pat-2017', 'X-ADO-Collections': 'LegacyCollection' });
    expect(running.sessions()).toBe(2);
    const full = await fetch(running.url, { method: 'POST', headers: { ...JSON_HEADERS, authorization: 'Bearer pat-all', 'x-ado-collections': 'DemoCollection' }, body: JSON.stringify(INIT) });
    expect(full.status).toBe(503);
    expect(running.events).toContainEqual(expect.objectContaining({ event: 'session_close', reason: 'evicted' }));
    await Promise.all([first.client.close(), second.client.close(), bob.client.close()]);
  });

  it('writes session and tool audit events without secrets', async () => {
    running = await startHttp();
    const alice = await connect(running.url, DEMO);
    await alice.call('whoami_and_collections');
    await alice.transport.terminateSession();
    await alice.client.close();
    const kinds = running.events.map((event) => event.event);
    expect(kinds).toEqual(expect.arrayContaining(['session_open', 'tool_call', 'session_close']));
    expect(running.events.find((event) => event.event === 'tool_call')).toMatchObject({ tool: 'whoami_and_collections', user: 'CORPTEST\\demo.user', outcome: 'ok' });
    expect(running.events.find((event) => event.event === 'session_close')).toMatchObject({ reason: 'client' });
    expect(JSON.stringify(running.events)).not.toContain('pat-demo');
  });

  it.each(['account', 'displayName', 'request-token'] as const)('redacts known credentials from the upstream %s in results and session audits', async (field) => {
    const gatewayToken = 'gateway-secret-01234567890123456789';
    const collectionPat = 'pat-demo-extended';
    running = await startHttp(field === 'request-token' ? {} : { ADO_MCP_HTTP_TOKEN: gatewayToken });
    const label = `user ${collectionPat} pat-demo ${gatewayToken}`;
    running.mock.on('GET', /\/DemoCollection\/_apis\/connectionData$/, () => ({
      json: {
        authenticatedUser: {
          id: userIdFor('pat-demo'),
          providerDisplayName: label,
          ...(field === 'account' ? { properties: { Account: { $value: label } } } : {}),
        },
      },
    }));
    const user = await connect(running.url, {
      ...DEMO,
      'X-ADO-MCP-Token': gatewayToken,
      'X-ADO-Collection-PATs': JSON.stringify({ Other: collectionPat }),
    });
    try {
      const result = await user.call('whoami_and_collections');
      for (const secret of ['pat-demo', collectionPat, gatewayToken]) expect(result.text).not.toContain(secret);
      await user.transport.terminateSession();
      for (const event of ['session_open', 'tool_call', 'session_close']) {
        expect(running.events.find((item) => item.event === event)).toMatchObject({ user: 'user *** *** ***' });
      }
      for (const secret of ['pat-demo', collectionPat, gatewayToken]) expect(JSON.stringify(running.events)).not.toContain(secret);
    } finally {
      await user.client.close();
    }
  });

  it('scrubs workflow prompt arguments using request credentials over the real SDK', async () => {
    const gatewayToken = 'request-gateway-01234567890123456789';
    running = await startHttp();
    const user = await connect(running.url, { ...DEMO, 'X-ADO-MCP-Token': gatewayToken });
    try {
      for (const [name, args] of [
        ['review_pull_request', { pullRequestId: gatewayToken, collection: 'pat-demo' }],
        ['diagnose_build_failure', { buildId: '1', collection: 'pat-demo', project: gatewayToken }],
        ['sprint_status', { team: gatewayToken, project: 'pat-demo' }],
      ] as const) {
        const prompt = await user.client.getPrompt({ name, arguments: args });
        const serialized = JSON.stringify(prompt);
        expect(serialized).not.toContain('pat-demo');
        expect(serialized).not.toContain(gatewayToken);
        expect(serialized).toContain('***');
      }
    } finally { await user.client.close(); }
  });

  it('rejects unlisted browser origins', async () => {
    running = await startHttp({ ADO_MCP_ALLOWED_ORIGINS: 'https://chat.example.com' });
    const denied = await fetch(running.url, { method: 'POST', headers: { ...JSON_HEADERS, origin: 'https://evil.example.com', authorization: 'Bearer pat-demo' }, body: '{}' });
    expect(denied.status).toBe(403);
    const allowed = await fetch(running.url, { method: 'POST', headers: { ...JSON_HEADERS, origin: 'https://chat.example.com', authorization: 'Bearer pat-demo' }, body: '{}' });
    expect(allowed.status).toBe(400);
  });

  it('keeps concurrent users isolated', async () => {
    running = await startHttp();
    const alice = await connect(running.url, DEMO);
    const bob = await connect(running.url, { Authorization: 'Bearer pat-2017', 'X-ADO-Collections': 'LegacyCollection' });
    const [a, b] = await Promise.all([alice.call('whoami_and_collections'), bob.call('whoami_and_collections')]);
    expect(a.json.user.id).toBe(userIdFor('pat-demo'));
    expect(b.json.user.id).toBe(userIdFor('pat-2017'));
    expect(a.json.collections[0]).toMatchObject({ collection: 'DemoCollection', status: 'authenticated' });
    expect(b.json.collections[0]).toMatchObject({ collection: 'LegacyCollection', status: 'authenticated' });
    for (const request of running.mock.requests) {
      if (request.path.startsWith('/tfs/DemoCollection/')) expect(request.pat).toBe('pat-demo');
      if (request.path.startsWith('/tfs/LegacyCollection/')) expect(request.pat).toBe('pat-2017');
      expect(request.headers.cookie).toBeUndefined();
    }
    await alice.client.close();
    await bob.client.close();
  });

  it('refuses to let another credential reuse a session', async () => {
    running = await startHttp();
    const alice = await connect(running.url, DEMO);
    const sessionId = alice.transport.sessionId;
    expect(sessionId).toBeTruthy();
    const hijack = await fetch(running.url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'mcp-session-id': sessionId ?? '', authorization: 'Bearer pat-2017', 'x-ado-collections': 'DemoCollection' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
    });
    expect(hijack.status).toBe(403);
    const unknown = await fetch(running.url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'mcp-session-id': 'nope', authorization: 'Bearer pat-demo' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} }),
    });
    expect(unknown.status).toBe(404);
    await alice.client.close();
  });

  it('honours X-ADO-Read-Only per caller', async () => {
    running = await startHttp();
    const reader = await connect(running.url, { ...DEMO, 'X-ADO-Read-Only': 'true' });
    expect((await reader.call('whoami_and_collections')).json.readOnly).toBe(true);
    await reader.client.close();
  });

  it('elicits the collection over HTTP', async () => {
    running = await startHttp();
    const user = await connect(running.url, ALL, () => 'LegacyCollection');
    const { json } = await user.call('resolve_repo_context', { repoOrFolderHint: 'shared-lib' });
    expect(json).toMatchObject({ collection: 'LegacyCollection', project: 'DemoAutomation', repository: 'shared-lib', verified: true });
    await user.client.close();
  });

  it('supports stateless mode without elicitation', async () => {
    running = await startHttp({ ADO_MCP_STATELESS: 'true' });
    const user = await connect(running.url, ALL, () => 'LegacyCollection');
    expect(user.transport.sessionId).toBeUndefined();
    expect((await user.call('whoami_and_collections')).json.collections).toHaveLength(2);
    expect((await user.call('resolve_repo_context', { repoOrFolderHint: 'shared-lib' })).json.status).toBe('disambiguation_required');
    expect((await fetch(running.url, { headers: { authorization: 'Bearer pat-all' } })).status).toBe(405);
    await user.client.close();
  });
});
