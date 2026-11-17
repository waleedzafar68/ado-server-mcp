import { afterEach, describe, expect, it } from 'vitest';
import { AdoError } from '../../src/ado/errors.js';
import { profileFromOptions, VersionNegotiator, type FetchFn } from '../../src/ado/version-negotiator.js';
import { MockAdoServer, type Flavor } from '../fixtures/mock-ado-server.js';

describe('VersionNegotiator', () => {
  let mock: MockAdoServer;
  afterEach(async () => { await mock.stop(); });

  async function start(flavor: Flavor, optionsBlocked = false) {
    mock = new MockAdoServer({ flavor, optionsBlocked });
    await mock.start();
    return new VersionNegotiator(fetch, { timeoutMs: 5000 });
  }

  it.each([
    ['2020', '6.0', '6.0-preview.3', '6.0-preview'],
    ['25H2', '7.2', '7.2-preview.4', '7.2-preview'],
  ] as const)('negotiates Azure DevOps Server %s through OPTIONS', async (flavor, ga, comments, policy) => {
    const negotiator = await start(flavor);
    const profile = await negotiator.getProfile(`${mock.serverUrl}/DemoCollection`, 'pat-demo');
    expect(profile.source).toBe('options');
    expect(profile.serverVersion).toBe(ga);
    expect(profile.versions).toMatchObject({ core: ga, wit: ga, git: ga, build: ga, release: ga, wiki: ga, tfvc: ga, work: ga, witComments: comments, policy });
  });

  it('reports a forbidden probe as permission without trying further versions', async () => {
    mock = new MockAdoServer({ flavor: '25H2', optionsBlocked: true });
    mock.on('GET', /\/_apis\/projects$/, () => ({ status: 403, json: { message: 'Access denied' } }));
    await mock.start();
    const negotiator = new VersionNegotiator(fetch, { timeoutMs: 5000 });
    await expect(negotiator.getProfile(`${mock.serverUrl}/DemoCollection`, 'pat-demo')).rejects.toMatchObject({ kind: 'permission' });
    expect(mock.requestsTo(/\/_apis\/projects$/, 'GET')).toHaveLength(1);
  });

  it('reports a server error from a probe as server, not version', async () => {
    mock = new MockAdoServer({ flavor: '25H2', optionsBlocked: true });
    mock.on('GET', /\/_apis\/projects$/, () => ({ status: 500, json: { message: 'boom' } }));
    await mock.start();
    const negotiator = new VersionNegotiator(fetch, { timeoutMs: 5000 });
    await expect(negotiator.getProfile(`${mock.serverUrl}/DemoCollection`, 'pat-demo')).rejects.toMatchObject({ kind: 'server' });
  });

  it('steps through all probe versions when each returns bad request', async () => {
    mock = new MockAdoServer({ flavor: '2020', optionsBlocked: true });
    mock.on('GET', /\/_apis\/projects$/, () => ({ status: 400, json: { message: 'Bad api-version' } }));
    await mock.start();
    const negotiator = new VersionNegotiator(fetch, { timeoutMs: 5000 });
    await expect(negotiator.getProfile(`${mock.serverUrl}/DemoCollection`, 'pat-demo')).rejects.toMatchObject({ kind: 'version' });
    expect(mock.requestsTo(/\/_apis\/projects$/, 'GET')).toHaveLength(4);
  });

  it('falls back to probing when a proxy blocks OPTIONS', async () => {
    const negotiator = await start('2020', true);
    const profile = await negotiator.getProfile(`${mock.serverUrl}/DemoCollection`, 'pat-demo');
    expect(profile).toMatchObject({ source: 'probe', serverVersion: '6.0' });
    expect(profile.versions.witComments).toBe('6.0-preview.3');
    expect(mock.requestsTo(/\/_apis\/projects$/).map((r) => r.apiVersion)).toEqual(['7.2', '7.1', '7.0', '6.0']);
  });

  it('falls back to probing when the OPTIONS document is too large to read', async () => {
    mock = new MockAdoServer({ flavor: '2020' });
    await mock.start();
    const oversized: FetchFn = async (url, init) =>
      init?.method === 'OPTIONS'
        ? new Response('x'.repeat(5 * 1024 * 1024), { status: 200, headers: { 'content-type': 'application/json' } })
        : fetch(url, init);
    const profile = await new VersionNegotiator(oversized, { timeoutMs: 5000 }).getProfile(`${mock.serverUrl}/DemoCollection`, 'pat-demo');
    expect(profile).toMatchObject({ source: 'probe', serverVersion: '6.0' });
  });

  it('reports TFS 203 sign-in responses as auth errors and does not cache them', async () => {
    const negotiator = await start('2020');
    await expect(negotiator.getProfile(`${mock.serverUrl}/DemoCollection`, 'pat-2017')).rejects.toMatchObject({ kind: 'auth' });
    await expect(negotiator.getProfile(`${mock.serverUrl}/DemoCollection`, 'pat-demo')).resolves.toMatchObject({ serverVersion: '6.0' });
  });

  it('reports an unknown collection as not found', async () => {
    const negotiator = await start('2020');
    const error = await negotiator.getProfile(`${mock.serverUrl}/Nope`, 'pat-demo').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdoError);
    expect((error as AdoError).kind).toBe('not_found');
  });

  it('caches per collection and applies updateArea', async () => {
    const negotiator = await start('2020');
    const url = `${mock.serverUrl}/DemoCollection`;
    await negotiator.getProfile(url, 'pat-demo');
    negotiator.updateArea(url, 'release', '6.0-preview');
    const again = await negotiator.getProfile(url, 'pat-demo');
    expect(again.versions.release).toBe('6.0-preview');
    expect(mock.requests.filter((r) => r.method === 'OPTIONS')).toHaveLength(1);
  });

  it('honours a forced version without calling the server', async () => {
    mock = new MockAdoServer({ flavor: '2020' });
    await mock.start();
    const negotiator = new VersionNegotiator(fetch, { timeoutMs: 5000, forceApiVersion: '6.0' });
    expect(await negotiator.getProfile(`${mock.serverUrl}/DemoCollection`, 'any')).toMatchObject({ source: 'forced', serverVersion: '6.0' });
    expect(mock.requests).toHaveLength(0);
  });
});

describe('profileFromOptions', () => {
  it('caps future server versions at 7.2', () => {
    expect(profileFromOptions([{ area: 'core', maxVersion: '7.3', releasedVersion: '7.3' }]).versions.core).toBe('7.2');
  });
  it('prefers the released version when a newer one is still in preview', () => {
    expect(profileFromOptions([{ area: 'git', maxVersion: '6.1', releasedVersion: '6.0' }]).versions.git).toBe('6.0');
  });
});