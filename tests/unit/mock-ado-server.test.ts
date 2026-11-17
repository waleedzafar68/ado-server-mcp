import { afterEach, describe, expect, it } from 'vitest';
import { MockAdoServer, userIdFor } from '../fixtures/mock-ado-server.js';

const auth = (pat: string) => ({ Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}` });

describe('MockAdoServer', () => {
  let mock: MockAdoServer | undefined;
  afterEach(async () => { await mock?.stop(); });

  it('acts like Azure DevOps Server 2020', async () => {
    mock = new MockAdoServer({ flavor: '2020' });
    await mock.start();
    const signIn = await fetch(`${mock.serverUrl}/DemoCollection/_apis/projects?api-version=6.0`, { headers: auth('wrong') });
    expect(signIn.status).toBe(203);
    const tooNew = await fetch(`${mock.serverUrl}/DemoCollection/_apis/projects?api-version=7.2`, { headers: auth('pat-demo') });
    expect(tooNew.status).toBe(400);
    expect(await tooNew.text()).toMatch(/supports is 6\.0/);
    const ok = await fetch(`${mock.serverUrl}/DemoCollection/_apis/projects?api-version=6.0`, { headers: auth('pat-demo') });
    expect(((await ok.json()) as { count: number }).count).toBe(3);
    const otherCollection = await fetch(`${mock.serverUrl}/LegacyCollection/_apis/projects?api-version=6.0`, { headers: auth('pat-demo') });
    expect(otherCollection.status).toBe(203);
  });

  it('acts like Azure DevOps Server 25H2', async () => {
    mock = new MockAdoServer({ flavor: '25H2' });
    await mock.start();
    expect((await fetch(`${mock.serverUrl}/DemoCollection/_apis/projects?api-version=7.2`, { headers: auth('wrong') })).status).toBe(401);
    expect((await fetch(`${mock.serverUrl}/DemoCollection/_apis/projects?api-version=7.2`, { headers: auth('pat-demo') })).status).toBe(200);
  });

  it('supports custom routes that override built-ins', async () => {
    mock = new MockAdoServer({ flavor: '2020' });
    await mock.start();
    mock.on('GET', /\/_apis\/projects$/, () => ({ json: { count: 0, value: [] } }));
    const response = await fetch(`${mock.serverUrl}/DemoCollection/_apis/projects?api-version=6.0`, { headers: auth('pat-demo') });
    expect(await response.json()).toEqual({ count: 0, value: [] });
    expect(mock.requestsTo(/\/_apis\/projects$/)[0]?.pat).toBe('pat-demo');
  });

  it('later on() registrations win over earlier ones', async () => {
    mock = new MockAdoServer({ flavor: '2020' });
    await mock.start();
    const pattern = /\/_apis\/connectionData$/;
    mock.on('GET', pattern, () => ({ json: { first: true } }));
    mock.on('GET', pattern, () => ({ json: { second: true } }));
    const response = await fetch(`${mock.serverUrl}/DemoCollection/_apis/connectionData?api-version=6.0-preview`, { headers: auth('pat-demo') });
    expect(await response.json()).toEqual({ second: true });
  });

  it('on() normalises method case for matching', async () => {
    mock = new MockAdoServer({ flavor: '2020' });
    await mock.start();
    mock.on('get', /\/_apis\/connectionData$/, () => ({ json: { matched: true } }));
    const response = await fetch(`${mock.serverUrl}/DemoCollection/_apis/connectionData?api-version=6.0-preview`, { headers: auth('pat-demo') });
    expect(await response.json()).toEqual({ matched: true });
    expect(mock.requestsTo(/\/_apis\/connectionData$/, 'get')[0]?.method).toBe('GET');
  });

  it('rejects Basic credentials without a colon (25H2)', async () => {
    mock = new MockAdoServer({ flavor: '25H2' });
    await mock.start();
    const response = await fetch(`${mock.serverUrl}/DemoCollection/_apis/projects?api-version=7.2`, {
      headers: { Authorization: `Basic ${Buffer.from('pat-demo').toString('base64')}` },
    });
    expect(response.status).toBe(401);
  });

  it('project repository routes require a valid project', async () => {
    mock = new MockAdoServer({ flavor: '2020' });
    await mock.start();
    const unknown = await fetch(`${mock.serverUrl}/DemoCollection/NoSuchProject/_apis/git/repositories?api-version=6.0`, { headers: auth('pat-demo') });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { message: string }).message).toMatch(/TF200016.*NoSuchProject/);
    const byId = await fetch(`${mock.serverUrl}/DemoCollection/p-service/_apis/git/repositories?api-version=6.0`, { headers: auth('pat-demo') });
    const body = (await byId.json()) as { count: number; value: Array<{ name: string }> };
    expect(body.count).toBe(2);
    expect(body.value.map((r) => r.name).sort()).toEqual(['demoservice-api', 'shared-lib']);
  });
});

describe('userIdFor', () => {
  it('is a non-reversible GUID-shaped identity', () => {
    const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const demo = userIdFor('pat-demo');
    const p2017 = userIdFor('pat-2017');
    expect(demo).toMatch(guid);
    expect(p2017).toMatch(guid);
    expect(demo).not.toBe(p2017);
    expect(demo).not.toContain('pat-demo');
    expect(demo).not.toContain('61742d737369');
  });
});