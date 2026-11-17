import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { AdoClient, nextApiVersion, type AdoClientOptions } from '../../src/ado/ado-client.js';
import { AdoError } from '../../src/ado/errors.js';
import { VersionNegotiator } from '../../src/ado/version-negotiator.js';
import { buildStdioCallerContext } from '../../src/context/caller-context.js';
import { MockAdoServer } from '../fixtures/mock-ado-server.js';

function clientFor(serverUrl: string, env: Record<string, string> = {}, options: Partial<AdoClientOptions> = {}): AdoClient {
  const config = loadConfig({
    ADO_MCP_TRANSPORT: 'stdio',
    ADO_DEFAULT_SERVER_URL: serverUrl,
    ADO_ALLOW_INSECURE_HTTP: 'true',
    ADO_PAT: 'pat-demo',
    ADO_COLLECTIONS: 'DemoCollection',
    ...env,
  });
  return new AdoClient(buildStdioCallerContext(config), new VersionNegotiator(fetch, { timeoutMs: 5000 }), { timeoutMs: 5000, ...options });
}

async function adoError(promise: Promise<unknown>): Promise<AdoError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  if (!(error instanceof AdoError)) throw new Error(`expected AdoError, got ${String(error)}`);
  return error;
}

describe('nextApiVersion', () => {
  it('reads the server maximum from out-of-range errors', () => {
    expect(nextApiVersion('7.2', 'The requested REST API version of 7.2 is out of range for this server. The latest REST API version this server supports is 6.0.'))
      .toEqual({ version: '6.0', reason: 'range' });
  });
  it('adds -preview when the resource is in preview', () => {
    expect(nextApiVersion('6.0', 'The requested version "6.0" of the resource is under preview. The -preview flag must be supplied'))
      .toEqual({ version: '6.0-preview', reason: 'preview' });
    expect(nextApiVersion('6.0-preview', 'is under preview')).toBeUndefined();
  });
});

describe('AdoClient against Azure DevOps Server 2020', () => {
  const mock = new MockAdoServer({ flavor: '2020' });
  beforeAll(async () => { await mock.start(); });
  afterAll(async () => { await mock.stop(); });

  it('calls with the negotiated version and the caller PAT', async () => {
    const data = await clientFor(mock.serverUrl).get<{ count: number }>({ collection: 'DemoCollection', path: '_apis/projects', area: 'core' });
    expect(data.count).toBe(3);
    const request = mock.requestsTo(/\/DemoCollection\/_apis\/projects$/).at(-1);
    expect(request).toMatchObject({ apiVersion: '6.0', pat: 'pat-demo' });
    expect(request?.headers.cookie).toBeUndefined();
  });

  it('maps TFS 203 sign-in pages to auth errors', async () => {
    const error = await adoError(clientFor(mock.serverUrl, { ADO_PAT: 'wrong-pat-value' }).get({ collection: 'DemoCollection', path: '_apis/projects', area: 'core' }));
    expect(error.kind).toBe('auth');
    expect(error.message).not.toContain('wrong-pat-value');
  });

  it('surfaces Azure DevOps permission errors with the TF message', async () => {
    const error = await adoError(clientFor(mock.serverUrl).post({ collection: 'DemoCollection', project: 'DemoProject', path: '_apis/git/repositories', area: 'git', body: { name: 'x' } }));
    expect(error.kind).toBe('permission');
    expect(error.message).toMatch(/TF401027/);
  });

  it('retries once with the version the server supports', async () => {
    mock.requests.length = 0;
    await clientFor(mock.serverUrl).get({ collection: 'DemoCollection', path: '_apis/projects', area: 'core', apiVersion: '7.2' });
    expect(mock.requestsTo(/\/_apis\/projects$/, 'GET').map((r) => r.apiVersion)).toEqual(['7.2', '6.0']);
  });

  it('retries with -preview for preview-only resources', async () => {
    mock.on('GET', /\/_apis\/wit\/workItems\/5\/comments$/, () => ({ json: { totalCount: 0, comments: [] } }));
    mock.requests.length = 0;
    await clientFor(mock.serverUrl).get({ collection: 'DemoCollection', project: 'DemoProject', path: '_apis/wit/workItems/5/comments', area: 'wit' });
    expect(mock.requestsTo(/comments$/).map((r) => r.apiVersion)).toEqual(['6.0', '6.0-preview']);
  });

  it('retries idempotent GETs on 503', async () => {
    let calls = 0;
    mock.on('GET', /\/_apis\/flaky$/, () => (++calls === 1 ? { status: 503, text: 'busy', headers: { 'Retry-After': '0' } } : { json: { ok: true } }));
    expect(await clientFor(mock.serverUrl).get({ collection: 'DemoCollection', path: '_apis/flaky', area: 'core' })).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('follows continuation tokens', async () => {
    mock.on('GET', /\/DemoCollection\/_apis\/paged$/, (r) => (r.query.get('continuationToken')
      ? { json: { value: [{ n: 2 }] } }
      : { json: { value: [{ n: 1 }] }, headers: { 'x-ms-continuationtoken': 'next' } }));
    const pages = await clientFor(mock.serverUrl).getAllPages<{ n: number }>({ collection: 'DemoCollection', path: '_apis/paged', area: 'core' });
    expect(pages).toEqual({ items: [{ n: 1 }, { n: 2 }], truncated: false });
  });

  it('lists collections only with an all-collections PAT', async () => {
    expect(await clientFor(mock.serverUrl, { ADO_PAT: 'pat-all' }).listServerCollections()).toEqual(['DemoCollection', 'LegacyCollection']);
    expect((await adoError(clientFor(mock.serverUrl).listServerCollections())).kind).toBe('auth');
  });

  it('refuses server URLs outside the allowlist', async () => {
    await expect(clientFor(mock.serverUrl).get({ serverUrl: 'https://evil.example.com/tfs', collection: 'DemoCollection', path: '_apis/projects', area: 'core' }))
      .rejects.toThrow(/ADO_ALLOWED_HOSTS/);
  });

  it('refuses responses larger than the configured cap', async () => {
    mock.on('GET', /\/_apis\/huge$/, () => ({ text: 'x'.repeat(70_000) }));
    const error = await adoError(clientFor(mock.serverUrl, {}, { maxResponseBytes: 65_536 }).get({ collection: 'DemoCollection', path: '_apis/huge', area: 'core', accept: 'text' }));
    expect(error.kind).toBe('too_large');
  });

  it('does not follow redirects that are not sign-in pages', async () => {
    mock.on('GET', /\/_apis\/moved$/, () => ({ status: 307, text: '', headers: { Location: 'https://lb2.example.com/tfs/DemoCollection/_apis/moved' } }));
    mock.requests.length = 0;
    const error = await adoError(clientFor(mock.serverUrl).get({ collection: 'DemoCollection', path: '_apis/moved', area: 'core' }));
    expect(error.kind).toBe('server');
    expect(error.message).toMatch(/redirected \(HTTP 307\) to lb2\.example\.com/);
    expect(mock.requestsTo(/\/_apis\/moved$/)).toHaveLength(1);
  });

  it('rejects dot segments before calling the server', async () => {
    mock.requests.length = 0;
    const error = await adoError(clientFor(mock.serverUrl).get({ collection: 'DemoCollection', project: '..', path: '_apis/projects', area: 'core' }));
    expect(error.kind).toBe('bad_request');
    expect(mock.requestsTo(/\/_apis\/projects$/)).toHaveLength(0);
  });

  it('rejects dot segments in the request path before calling the server', async () => {
    mock.requests.length = 0;
    const error = await adoError(clientFor(mock.serverUrl).get({ collection: 'DemoCollection', path: '_apis/../../LegacyCollection/_apis/projects', area: 'core' }));
    expect(error.kind).toBe('bad_request');
    expect(mock.requestsTo(/projects$/)).toHaveLength(0);
  });

  it('ignores caller Authorization and sends the resolved PAT', async () => {
    mock.requests.length = 0;
    await clientFor(mock.serverUrl).get({
      collection: 'DemoCollection',
      path: '_apis/projects',
      area: 'core',
      apiVersion: '6.0',
      headers: { Authorization: 'Basic AAAA' },
    });
    expect(mock.requestsTo(/\/DemoCollection\/_apis\/projects$/).at(-1)?.pat).toBe('pat-demo');
  });

  it('maps stalled body reads to network errors', async () => {
    mock.on('GET', /\/_apis\/stallbody$/, () => ({ json: { ok: true } }));
    const hangingBody = () =>
      new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const baseFetch = fetch;
    const error = await adoError(clientFor(mock.serverUrl, {}, {
      timeoutMs: 100,
      fetchFn: async (url, init) => {
        if (String(url).includes('/_apis/stallbody')) return hangingBody();
        return baseFetch(url, init);
      },
    }).get({ collection: 'DemoCollection', path: '_apis/stallbody', area: 'core', apiVersion: '6.0' }));
    expect(error.kind).toBe('network');
  });

  it('cancels mid-body read when the MCP client aborts', async () => {
    mock.on('GET', /\/_apis\/stallbody-cancel$/, () => ({ json: { ok: true } }));
    const hangingBody = () =>
      new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const baseFetch = fetch;
    const controller = new AbortController();
    const pending = adoError(clientFor(mock.serverUrl, {}, {
      timeoutMs: 5000,
      signal: controller.signal,
      fetchFn: async (url, init) => {
        if (String(url).includes('/_apis/stallbody-cancel')) return hangingBody();
        return baseFetch(url, init);
      },
    }).get({ collection: 'DemoCollection', path: '_apis/stallbody-cancel', area: 'core', apiVersion: '6.0' }));
    const abort = setTimeout(() => controller.abort(), 50);
    const error = await pending;
    clearTimeout(abort);
    expect(error.kind).toBe('network');
    expect(error.message).toMatch(/cancelled/);
  });

  it('lets beforeWrite stop writes before anything is sent', async () => {
    mock.requests.length = 0;
    const seen: string[] = [];
    const client = clientFor(mock.serverUrl, {}, {
      beforeWrite: (what) => {
        seen.push(what);
        throw new AdoError('server', 'not confirmed');
      },
    });
    await client.get({ collection: 'DemoCollection', path: '_apis/projects', area: 'core' });
    const error = await adoError(client.post({ collection: 'DemoCollection', project: 'DemoProject', path: '_apis/git/repositories', area: 'git', body: { name: 'x' } }));
    expect(error.message).toBe('not confirmed');
    expect(seen).toEqual(['POST _apis/git/repositories']);
    expect(mock.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('aborts when the MCP client cancels the call', async () => {
    mock.on('GET', /\/_apis\/slow$/, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return { json: { ok: true } };
    });
    const controller = new AbortController();
    const pending = adoError(clientFor(mock.serverUrl, {}, { signal: controller.signal }).get({ collection: 'DemoCollection', path: '_apis/slow', area: 'core', apiVersion: '6.0' }));
    setTimeout(() => controller.abort(), 50);
    const error = await pending;
    expect(error.kind).toBe('network');
    expect(error.message).toMatch(/cancelled/);
  });
});

describe('AdoClient failure modes', () => {
  it('maps 25H2 401 to auth errors', async () => {
    const mock = new MockAdoServer({ flavor: '25H2' });
    await mock.start();
    try {
      expect((await adoError(clientFor(mock.serverUrl, { ADO_PAT: 'pat-2017' }).get({ collection: 'DemoCollection', path: '_apis/projects', area: 'core' }))).kind).toBe('auth');
    } finally {
      await mock.stop();
    }
  });

  it('maps connection failures to network errors', async () => {
    const error = await adoError(clientFor('http://127.0.0.1:1/tfs').get({ collection: 'DemoCollection', path: '_apis/projects', area: 'core' }));
    expect(error.kind).toBe('network');
  });
});