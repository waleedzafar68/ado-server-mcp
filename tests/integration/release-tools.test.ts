import { afterEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness, type HarnessOptions } from '../helpers/harness.js';

const RELEASE = {
  id: 55,
  name: 'Release-55',
  status: 'active',
  createdOn: '2026-11-16T09:00:00Z',
  createdBy: { displayName: 'Jordan Example', uniqueName: 'CORPTEST\\demo.user' },
  releaseDefinition: { id: 3, name: 'ado-server-mcp-deploy' },
  artifacts: [{ alias: '_ci', type: 'Build', definitionReference: { version: { id: '900', name: '20261116.1' } } }],
  environments: [{ id: 501, name: 'Dev', status: 'succeeded', preDeployApprovals: [] }, { id: 502, name: 'Prod', status: 'notStarted', preDeployApprovals: [{ id: 77, status: 'pending', approver: { displayName: 'Release Managers' } }] }],
};

describe('release tools', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function start(options: HarnessOptions = {}): Promise<Harness> {
    h = await startHarness({ ...options, env: { ADO_DEFAULT_PROJECT: 'DemoProject', ...options.env } });
    const mock = h.mock;
    mock.on('GET', /\/DemoProject\/_apis\/release\/definitions$/, () => ({ json: { value: [{ id: 3, name: 'ado-server-mcp-deploy', path: '\\' }] } }));
    mock.on('GET', /\/DemoProject\/_apis\/release\/definitions\/3$/, () => ({ json: { id: 3, name: 'ado-server-mcp-deploy' } }));
    mock.on('GET', /\/DemoProject\/_apis\/release\/approvals\/77$/, () => ({
      json: { id: 77, status: 'pending', approvalType: 'preDeploy', approver: { displayName: 'Release Managers' }, release: { id: 55, name: 'Release-55' }, releaseEnvironment: { id: 502, name: 'Prod' } },
    }));
    mock.on('GET', /\/DemoProject\/_apis\/release\/releases$/, () => ({ json: { value: [RELEASE] } }));
    mock.on('GET', /\/DemoProject\/_apis\/release\/releases\/55$/, () => ({ json: RELEASE }));
    mock.on('POST', /\/DemoProject\/_apis\/release\/releases$/, () => ({ json: { ...RELEASE, id: 56, name: 'Release-56' } }));
    mock.on('GET', /\/DemoProject\/_apis\/release\/approvals$/, () => ({
      json: { value: [{ id: 77, status: 'pending', approvalType: 'preDeploy', approver: { displayName: 'Release Managers' }, release: { id: 55, name: 'Release-55' }, releaseEnvironment: { id: 502, name: 'Prod' }, createdOn: '2026-11-16T09:30:00Z' }] },
    }));
    mock.on('PATCH', /\/DemoProject\/_apis\/release\/approvals\/77$/, (r) => ({ json: { id: 77, ...(r.body as object) } }));
    mock.on('PATCH', /\/DemoProject\/_apis\/release\/releases\/55\/environments\/502$/, () => ({ json: { id: 502, name: 'Prod', status: 'queued' } }));
    return h;
  }

  it('uses the collection URL for Release Management (never vsrm)', async () => {
    const harness = await start();
    const { json } = await harness.call('list_release_definitions');
    expect(json.definitions).toEqual([{ id: 3, name: 'ado-server-mcp-deploy', path: '\\' }]);
    const request = harness.mock.requestsTo(/release\/definitions$/).at(-1);
    expect(request?.path).toBe('/tfs/DemoCollection/DemoProject/_apis/release/definitions');
    expect(request?.apiVersion).toBe('6.0');
  });

  it('lists and gets releases with environment and approval status', async () => {
    const harness = await start();
    const list = await harness.call('list_releases', { definitionId: 3 });
    expect(list.json.releases[0]).toMatchObject({ id: 55, definition: 'ado-server-mcp-deploy', environments: [{ id: 501, name: 'Dev', status: 'succeeded' }, { id: 502, name: 'Prod', status: 'notStarted' }] });
    expect(harness.mock.requestsTo(/release\/releases$/, 'GET').at(-1)?.query.get('$expand')).toBe('environments');
    const release = await harness.call('get_release', { releaseId: 55 });
    expect(release.json.artifacts).toEqual([{ alias: '_ci', type: 'Build', version: '20261116.1' }]);
    expect(release.json.environments[1].approvals).toEqual([{ id: 77, status: 'pending', approver: 'Release Managers' }]);
  });

  it('creates a release from a definition', async () => {
    const harness = await start();
    const { json } = await harness.call('create_release', { definitionId: 3, description: 'Hotfix', artifacts: [{ alias: '_ci', versionId: '900' }] });
    expect(json).toMatchObject({ created: true, id: 56 });
    expect(harness.mock.requestsTo(/release\/releases$/, 'POST').at(-1)?.body).toEqual({
      definitionId: 3,
      description: 'Hotfix',
      isDraft: false,
      artifacts: [{ alias: '_ci', instanceReference: { id: '900' } }],
    });
  });

  it('lists my pending approvals and approves one', async () => {
    const harness = await start();
    const approvals = await harness.call('list_release_approvals');
    expect(approvals.json.approvals[0]).toMatchObject({ id: 77, release: 'Release-55', environment: 'Prod', approver: 'Release Managers' });
    const query = harness.mock.requestsTo(/release\/approvals$/).at(-1)?.query;
    expect([query?.get('statusFilter'), query?.get('assignedToFilter'), query?.get('includeMyGroupApprovals'), query?.get('top')]).toEqual(['pending', 'CORPTEST\\demo.user', 'true', '51']);
    expect(query?.has('$top')).toBe(false);
    const updated = await harness.call('update_release_approval', { approvalId: 77, status: 'approved', comments: 'LGTM' });
    expect(updated.json).toEqual({ id: 77, status: 'approved' });
    expect(harness.mock.requestsTo(/approvals\/77$/, 'PATCH').at(-1)?.body).toEqual({ status: 'approved', comments: 'LGTM' });
  });

  it('deploys an environment with the preview API and is marked destructive', async () => {
    const harness = await start();
    const { json } = await harness.call('deploy_release_environment', { releaseId: 55, environmentId: 502, comment: 'Go' });
    expect(json).toEqual({ releaseId: 55, environmentId: 502, name: 'Prod', status: 'queued' });
    const request = harness.mock.requestsTo(/environments\/502$/, 'PATCH').at(-1);
    expect(request?.apiVersion).toBe('6.0-preview');
    expect(request?.body).toEqual({ status: 'inProgress', comment: 'Go' });
    const tools = (await harness.client.listTools()).tools;
    expect(tools.map((tool) => tool.name).filter((name) => name.includes('release'))).toEqual([
      'list_release_definitions', 'list_releases', 'get_release', 'create_release',
      'list_release_approvals', 'update_release_approval', 'deploy_release_environment',
    ]);
    expect(tools.find((t) => t.name === 'deploy_release_environment')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'update_release_approval')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'create_release')?.annotations?.destructiveHint).toBe(true);
  });

  it('asks about the actual release, stage and approval before changing anything', async () => {
    const harness = await start({ env: { ADO_ALLOW_DESTRUCTIVE: 'false' }, elicit: (field) => (field === 'confirm' ? 'false' : undefined) });
    expect((await harness.call('create_release', { definitionId: 3, artifacts: [{ alias: '_ci', versionId: '900', versionName: '20261116.1' }] })).text).toMatch(/^\[declined\]/);
    expect((await harness.call('update_release_approval', { approvalId: 77, status: 'approved' })).text).toMatch(/^\[declined\]/);
    expect((await harness.call('deploy_release_environment', { releaseId: 55, environmentId: 502 })).text).toMatch(/^\[declined\]/);
    expect(harness.elicitations.map((e) => e.message.split('\n')[0])).toEqual([
      'Create a release of "ado-server-mcp-deploy" in "DemoProject" with artifacts "_ci@20261116.1". Stages with automatic triggers start deploying straight away.',
      'Approve the pre-deployment approval for "Release-55" → "Prod" in "DemoProject" (assigned to "Release Managers").',
      'Deploy "Release-55" of "ado-server-mcp-deploy" to "Prod" (currently notStarted) in "DemoProject".',
    ]);

    harness.mock.on('GET', /\/DemoProject\/_apis\/release\/approvals\/78$/, () => ({ json: { id: 78, status: 'approved', approvalType: 'preDeploy' } }));
    expect((await harness.call('update_release_approval', { approvalId: 78, status: 'rejected' })).text).toMatch(/^\[bad_request\] Approval 78 is already approved/);
    expect(harness.elicitations).toHaveLength(3);
    expect(harness.mock.requests.filter((r) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method))).toHaveLength(0);
  });
  it('caps release lists locally and reports whether each response is complete', async () => {
    const harness = await start();
    const definition = (id: number) => ({ id, name: `Pipeline-${id}` });
    const release = (id: number) => ({ ...RELEASE, id, name: `Release-${id}` });
    const approval = (id: number) => ({ id, status: 'pending', release: { id, name: `Release-${id}` }, releaseEnvironment: { id: 502, name: 'Prod' } });

    harness.mock.on('GET', /\/DemoProject\/_apis\/release\/definitions$/, (request) => ({ json: { value: [definition(1), definition(2), ...(request.query.get('$top') === '3' ? [definition(3)] : [])] } }));
    harness.mock.on('GET', /\/DemoProject\/_apis\/release\/releases$/, (request) => ({ json: { value: [release(1), release(2), ...(request.query.get('$top') === '3' ? [release(3)] : [])] } }));
    harness.mock.on('GET', /\/DemoProject\/_apis\/release\/approvals$/, (request) => ({ json: { value: [approval(1), approval(2), ...(request.query.get('top') === '3' ? [approval(3)] : [])] } }));

    const definitions = await harness.call('list_release_definitions', { top: 2 });
    expect(definitions.json).toMatchObject({ count: 2, truncated: true });
    expect(definitions.json.definitions).toHaveLength(2);
    expect(harness.mock.requestsTo(/release\/definitions$/, 'GET').at(-1)?.query.get('$top')).toBe('3');

    const releases = await harness.call('list_releases', { top: 2 });
    expect(releases.json).toMatchObject({ count: 2, truncated: true });
    expect(releases.json.releases).toHaveLength(2);
    expect(harness.mock.requestsTo(/release\/releases$/, 'GET').at(-1)?.query.get('$top')).toBe('3');

    const approvals = await harness.call('list_release_approvals', { top: 2 });
    expect(approvals.json).toMatchObject({ count: 2, truncated: true });
    expect(approvals.json.approvals).toHaveLength(2);
    expect(harness.mock.requestsTo(/release\/approvals$/, 'GET').at(-1)?.query.get('top')).toBe('3');

    harness.mock.on('GET', /\/DemoProject\/_apis\/release\/definitions$/, () => ({ json: { value: [definition(1), definition(2)] } }));
    harness.mock.on('GET', /\/DemoProject\/_apis\/release\/releases$/, () => ({ json: { value: [release(1), release(2)] } }));
    harness.mock.on('GET', /\/DemoProject\/_apis\/release\/approvals$/, () => ({ json: { value: [approval(1), approval(2)] } }));
    expect((await harness.call('list_release_definitions', { top: 2 })).json).toMatchObject({ count: 2, truncated: false });
    expect((await harness.call('list_releases', { top: 2 })).json).toMatchObject({ count: 2, truncated: false });
    expect((await harness.call('list_release_approvals', { top: 2 })).json).toMatchObject({ count: 2, truncated: false });
  });

  it('includes group approvals when listing without an assignee filter', async () => {
    const harness = await start();
    await harness.call('list_release_approvals', { assignedToMe: false });
    const query = harness.mock.requestsTo(/release\/approvals$/, 'GET').at(-1)?.query;
    expect(query?.get('includeMyGroupApprovals')).toBe('true');
    expect(query?.has('assignedToFilter')).toBe(false);
  });
  it('only updates a pending approval', async () => {
    const harness = await start();
    harness.mock.on('GET', /\/DemoProject\/_apis\/release\/approvals\/79$/, () => ({ json: { id: 79, status: 'rejected' } }));
    const result = await harness.call('update_release_approval', { approvalId: 79, status: 'approved' });
    expect(result.text).toMatch(/^\[bad_request\] Approval 79 is already rejected/);
    expect(harness.mock.requestsTo(/approvals\/79$/, 'PATCH')).toHaveLength(0);
  });
});
