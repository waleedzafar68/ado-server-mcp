import { describe, expect, it } from 'vitest';
import { createRecordingFetch, downloadLogHead, serializeFixture } from '../../scripts/record-contracts.js';
import { contractEnv, replay, requestKey, Scrubber, type ContractFixture, type Exchange } from '../contracts/contract-format.js';
import { loadConfig } from '../../src/config/env.js';
import { createDeps } from '../../src/deps.js';
import { createMcpServer } from '../../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const serverUrl = 'https://internal.example/tfs';
const fixture = (exchanges: Exchange[] = []): ContractFixture => ({
  flavor: 'server-2020', recordedAt: '', serverUrl: 'https://ado.example/tfs', collections: ['DemoCollection'], calls: [], facts: {}, exchanges,
});
const options = (fetchFn: typeof fetch, exchanges: Exchange[] = [], maxResponseBytes = 1024, timeoutMs = 100) => ({
  fetchFn, exchanges, serverUrl, scrubber: new Scrubber('internal.example', ['test-pat']), maxResponseBytes, timeoutMs,
});

describe('contract recorder', () => {
  it('keeps uppercase path segments when scrubbing accounts from a known Windows domain', () => {
    const scrubber = new Scrubber('internal.example', []);
    scrubber.text('CORPTEST\\someone');
    expect(scrubber.text('D:\\agent\\CORPTEST\\x /tmp/CORPTEST\\x corptest\\someone')).toBe('D:\\agent\\CORPTEST\\x /tmp/CORPTEST\\x DOMAIN\\user');
  });

  it('records scrubbed request keys and only safe response headers while preserving the caller response', async () => {
    const exchanges: Exchange[] = [];
    const headers = {
      'content-type': 'application/json', 'x-ms-continuationtoken': 'next-test-pat', 'retry-after': '0', etag: 'test-pat',
      location: 'https://internal.example/tfs/test-pat', authorization: 'Bearer private', 'set-cookie': 'session=private', 'www-authenticate': 'private',
    };
    const record = createRecordingFetch(options(async () => new Response('{"displayName":"Someone","token":"test-pat"}', { headers }), exchanges));
    const response = await record(new Request(`${serverUrl}/DemoCollection/test-pat?z=test-pat&x=a@internal.example`, { method: 'OPTIONS' }));
    expect(await response.text()).toBe('{"displayName":"Someone","token":"test-pat"}');
    expect(response.headers.get('set-cookie')).toBe('session=private');
    expect(exchanges).toEqual([{
      method: 'OPTIONS', path: '/DemoCollection/***', query: 'x=user%40example.invalid&z=***', status: 200, contentType: 'application/json',
      location: 'https://ado.example/tfs/***', headers: { 'x-ms-continuationtoken': 'next-***', 'retry-after': '0', etag: '***' },
      body: '{"displayName":"User 1","token":"***"}',
    }]);
    const recorded = replay(fixture(exchanges));
    const replayed = await recorded.fetch('https://ado.example/tfs/DemoCollection/***?z=***&x=user@example.invalid', { method: 'OPTIONS' });
    expect(replayed.headers.get('x-ms-continuationtoken')).toBe('next-***');
    expect(replayed.headers.get('retry-after')).toBe('0');
    expect(replayed.headers.get('etag')).toBe('***');
    expect(replayed.headers.get('set-cookie')).toBeNull();
    expect(replayed.headers.get('authorization')).toBeNull();
  });

  it('caps streamed responses before they are recorded, without awaiting a stalled cancellation', async () => {
    let cancelled = false;
    const exchanges: Exchange[] = [];
    const fetchFn: typeof fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1025)); },
      cancel() { cancelled = true; return new Promise(() => undefined); },
    }));
    await expect(createRecordingFetch(options(fetchFn, exchanges))(`${serverUrl}/x`)).rejects.toThrow(/ADO_MAX_RESPONSE_BYTES/);
    expect(cancelled).toBe(true);
    expect(exchanges).toEqual([]);
  });

  it('scrubs decoded private query names and values before encoding, and replays requests built from scrubbed arguments', async () => {
    const exchanges: Exchange[] = [];
    const record = createRecordingFetch(options(async () => new Response('ok'), exchanges));
    const args = { email: 'alice@internal.example', account: 'CORPTEST\\someone', token: 'test-pat', 'alice@internal.example': 'CORPTEST\\someone' };
    await record(`${serverUrl}/DemoCollection/x?${new URLSearchParams(args)}`);
    expect(exchanges[0]!.query).toBe('account=DOMAIN%5Cuser&email=user%40example.invalid&token=***&user%40example.invalid=DOMAIN%5Cuser');
    const input = fixture(exchanges);
    input.calls = [{ label: 'private-query', tool: 'tool', args }];
    const persisted = JSON.parse(serializeFixture(input, options(fetch).scrubber, 'test-pat')) as ContractFixture;
    const recorded = replay(persisted);
    const replayArgs = persisted.calls[0]!.args as Record<string, string>;
    expect(await (await recorded.fetch(`https://ado.example/tfs/DemoCollection/x?${new URLSearchParams(replayArgs)}`)).text()).toBe('ok');
    expect(recorded.misses).toEqual([]);
  });

  it('learns domains across a query before encoding earlier lowercase accounts and preserves path segments', async () => {
    const exchanges: Exchange[] = [];
    const config = options(async () => new Response('ok'), exchanges);
    const args = { first: 'corptest\\someone', later: 'CORPTEST\\someone', path: 'D:\\agent\\corptest\\x' };
    await createRecordingFetch(config)(`${serverUrl}/DemoCollection/x?${new URLSearchParams(args)}`);
    expect(exchanges[0]!.query).toBe('first=DOMAIN%5Cuser&later=DOMAIN%5Cuser&path=D%3A%5Cagent%5Ccorptest%5Cx');
    const input = fixture(exchanges);
    input.calls = [{ label: 'same-query-domain', tool: 'tool', args }];
    const persisted = JSON.parse(serializeFixture(input, config.scrubber, 'test-pat')) as ContractFixture;
    const recorded = replay(persisted);
    const replayArgs = persisted.calls[0]!.args as Record<string, string>;
    expect(await (await recorded.fetch(`https://ado.example/tfs/DemoCollection/x?${new URLSearchParams(replayArgs)}`)).text()).toBe('ok');
    expect(recorded.misses).toEqual([]);
  });

  it.each(['query', 'body', 'arguments'] as const)('re-scrubs earlier persisted query keys after domain discovery in a later %s', async (source) => {
    const exchanges: Exchange[] = [];
    const config = options(async (input) => new Response(String(input).includes('/later') && source === 'body'
      ? JSON.stringify({ identity: { uniqueName: 'CORPTEST\\someone' } }) : '{"ok":true}', { headers: { 'content-type': 'application/json' } }), exchanges);
    const record = createRecordingFetch(config);
    const args = { first: 'corptest\\someone' };
    await record(`${serverUrl}/DemoCollection/early?${new URLSearchParams(args)}`);
    await record(`${serverUrl}/DemoCollection/later${source === 'query' ? '?later=CORPTEST%5Csomeone' : ''}`);
    const input = fixture(exchanges);
    input.calls = [{ label: 'early', tool: 'tool', args }, { label: 'later', tool: 'tool', args: source === 'arguments' ? { account: 'CORPTEST\\someone' } : {} }];
    const out = serializeFixture(input, config.scrubber, 'test-pat');
    expect(out.toLowerCase()).not.toContain('corptest');
    expect(out).not.toContain('someone');
    const persisted = JSON.parse(out) as ContractFixture;
    expect(persisted.exchanges[0]!.query).toBe('first=DOMAIN%5Cuser');
    expect(persisted.calls[0]!.args.first).toBe('DOMAIN\\user');
    const recorded = replay(persisted);
    const replayArgs = persisted.calls[0]!.args as Record<string, string>;
    expect(await (await recorded.fetch(`https://ado.example/tfs/DemoCollection/early?${new URLSearchParams(replayArgs)}`)).json()).toEqual({ ok: true });
    expect(recorded.misses).toEqual([]);
  });

  it.each(['application/json', 'text/plain'])('re-scrubs earlier %s bodies after later domain discovery without changing identity aliases or paths', async (contentType) => {
    const exchanges: Exchange[] = [];
    const early = contentType === 'application/json'
      ? JSON.stringify({ createdBy: { displayName: 'Someone' }, log: 'corptest\\someone', path: 'D:\\agent\\corptest\\x' })
      : 'corptest\\someone on D:\\agent\\corptest\\x';
    const later = contentType === 'application/json' ? JSON.stringify({ identity: { uniqueName: 'CORPTEST\\someone' } }) : 'CORPTEST\\someone';
    const config = options(async (input) => new Response(String(input).includes('/early') ? early : later, { headers: { 'content-type': contentType } }), exchanges);
    const record = createRecordingFetch(config);
    await record(`${serverUrl}/DemoCollection/early`);
    await record(`${serverUrl}/DemoCollection/later`);
    const persisted = JSON.parse(serializeFixture(fixture(exchanges), config.scrubber, 'test-pat')) as ContractFixture;
    const body = persisted.exchanges[0]!.body;
    if (contentType === 'application/json') {
      expect(JSON.parse(body)).toEqual({ createdBy: { displayName: 'User 1' }, log: 'DOMAIN\\user', path: 'D:\\agent\\corptest\\x' });
      expect(JSON.parse(persisted.exchanges[1]!.body)).toEqual({ identity: { uniqueName: 'User 2' } });
    } else expect(body).toBe('DOMAIN\\user on D:\\agent\\corptest\\x');
    expect(await (await replay(persisted).fetch('https://ado.example/tfs/DemoCollection/early')).text()).toBe(body);
  });

  it('bounds body reads by timeout even after the response headers arrive', async () => {
    let cancelled = false;
    const fetchFn: typeof fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    await expect(createRecordingFetch(options(fetchFn))(`${serverUrl}/x`)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(cancelled).toBe(true);
  });

  it('preserves caller aborts and passes them upstream instead of replacing the signal', async () => {
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    let upstream: AbortSignal | undefined;
    const fetchFn: typeof fetch = async (_input, init) => {
      upstream = init?.signal ?? undefined;
      return new Response(new ReadableStream());
    };
    const pending = createRecordingFetch(options(fetchFn))(new Request(`${serverUrl}/x`, { signal: controller.signal }));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(upstream?.aborted).toBe(true);
  });

  it('cancels a late response if the upstream fetch ignores the deadline', async () => {
    let deliver!: (response: Response) => void;
    let cancelled = false;
    const fetchFn: typeof fetch = () => new Promise((resolve) => { deliver = resolve; });
    await expect(createRecordingFetch(options(fetchFn))(`${serverUrl}/x`)).rejects.toMatchObject({ name: 'TimeoutError' });
    deliver(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await new Promise((resolve) => setImmediate(resolve));
    expect(cancelled).toBe(true);
  });

  it('preserves binary bytes and bodyless responses for the client', async () => {
    const record = createRecordingFetch(options(async () => new Response(new Uint8Array([0, 255, 42]))));
    expect(new Uint8Array(await (await record(`${serverUrl}/x`)).arrayBuffer())).toEqual(new Uint8Array([0, 255, 42]));
    const empty = createRecordingFetch(options(async () => new Response(null, { status: 204 })));
    expect((await empty(`${serverUrl}/x`)).body).toBeNull();
  });

  it('independently downloads full log ground truth using negotiated version and the same cap', async () => {
    const observed: string[] = [];
    const config = options(async (input) => { observed.push(String(input)); return new Response('one\r\ntwo\r\nthree\r\nfour\n'); });
    expect(await downloadLogHead({ ...config, collection: 'DemoCollection', project: 'Project', buildId: 5, logId: 7, apiVersion: '7.2', pat: 'test-pat' })).toEqual(['one', 'two', 'three']);
    expect(observed).toEqual(['https://internal.example/tfs/DemoCollection/Project/_apis/build/builds/5/logs/7?api-version=7.2']);
    const oversized = options(async () => new Response('x'.repeat(1025)));
    await expect(downloadLogHead({ ...oversized, collection: 'DemoCollection', project: 'Project', buildId: 5, logId: 7, apiVersion: '6.0', pat: 'test-pat' })).rejects.toThrow(/ADO_MAX_RESPONSE_BYTES/);
    const stalled = options(async () => new Response(new ReadableStream()));
    await expect(downloadLogHead({ ...stalled, collection: 'DemoCollection', project: 'Project', buildId: 5, logId: 7, apiVersion: '6.0', pat: 'test-pat' })).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('scrubs all persisted strings, including call arguments and object keys, then refuses any surviving PAT', () => {
    const input = fixture();
    input.calls = [{ label: 'test-pat', tool: 'tool', args: { 'test-pat': ['test-pat', 'a@internal.example', 'https://internal.example/tfs'] } }];
    const scrubber = new Scrubber('internal.example', ['test-pat']);
    const out = serializeFixture(input, scrubber, 'test-pat');
    expect(JSON.parse(out).calls).toEqual([{ label: '***', tool: 'tool', args: { '***': ['***', 'user@example.invalid', 'https://ado.example/tfs'] } }]);
    expect(() => serializeFixture(input, new Scrubber('internal.example', []), 'test-pat')).toThrow(/Refusing/);
    input.calls[0]!.args = { token: 'a"b\\c' };
    expect(() => serializeFixture(input, new Scrubber('internal.example', []), 'a"b\\c')).toThrow(/Refusing/);
  });
});

describe('contract replay safety', () => {
  it('keeps encoded query delimiters distinct from separate parameters and misses the unseen shape', async () => {
    const single = new URL('https://ado.example/tfs/x?a=1%26b%3D2');
    const separate = new URL('https://ado.example/tfs/x?a=1&b=2');
    const key = requestKey(single, 'https://ado.example/tfs');
    expect(key).toEqual({ path: '/x', query: 'a=1%26b%3D2' });
    expect(requestKey(separate, 'https://ado.example/tfs')).toEqual({ path: '/x', query: 'a=1&b=2' });
    const recorded = replay(fixture([{ method: 'GET', ...key, status: 200, contentType: 'text/plain', body: 'recorded' }]));
    expect(await (await recorded.fetch(single)).text()).toBe('recorded');
    await expect(recorded.fetch(separate)).rejects.toThrow(/no recorded response/);
    expect(recorded.misses).toEqual(['GET /x?a=1&b=2']);
  });

  it('honors Request methods, base-path boundaries, sorted duplicate query values and excludes unsafe fixture headers', async () => {
    expect(requestKey(new URL('https://ado.example/tfs-other/x?b=2&a=2&a=1'), 'https://ado.example/tfs')).toEqual({ path: '/tfs-other/x', query: 'a=1&a=2&b=2' });
    const data = fixture([{ method: 'HEAD', path: '/DemoCollection/x', query: '', status: 200, contentType: 'text/plain', body: 'ignored', headers: { etag: 'v1', 'set-cookie': 'private', authorization: 'private' } }]);
    const response = await replay(data).fetch(new Request('https://ado.example/tfs/DemoCollection/x', { method: 'HEAD' }));
    expect(response.body).toBeNull();
    expect(response.headers.get('etag')).toBe('v1');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('authorization')).toBeNull();
  });

  it('replays bodyless HTTP 205 responses without constructing an invalid Response', async () => {
    const recorded = replay(fixture([{ method: 'GET', path: '/DemoCollection/x', query: '', status: 205, contentType: '', body: '' }]));
    expect((await recorded.fetch('https://ado.example/tfs/DemoCollection/x')).body).toBeNull();
  });

  it('uses the shared read-only configuration to hide and reject write tools without network access', async () => {
    const recorded = replay(fixture());
    const deps = createDeps(loadConfig(contractEnv('https://ado.example/tfs', ['DemoCollection'], 'replay-pat')), recorded.fetch);
    const server = createMcpServer(deps, { ctx: deps.contextFor() });
    const client = new Client({ name: 'contract-safety', version: '1.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
      expect(tools.some((tool) => tool.name === 'queue_build')).toBe(false);
      const result = await client.callTool({ name: 'queue_build', arguments: { collection: 'DemoCollection', project: 'Project', definitionId: 1 } });
      expect(result.isError).toBe(true);
      expect(recorded.misses).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
