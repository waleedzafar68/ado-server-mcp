import { afterEach, describe, expect, it } from 'vitest';
import { pullRequestTools } from '../../src/tools/pullrequest-tools.js';
import { userIdFor, type Flavor } from '../fixtures/mock-ado-server.js';
import { startHarness, type Harness, type HarnessOptions } from '../helpers/harness.js';

const REVIEWER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const PR = {
  pullRequestId: 101,
  title: 'Add MCP server',
  description: 'Implements the plan',
  status: 'active',
  isDraft: false,
  createdBy: { displayName: 'Jordan Example', uniqueName: 'CORPTEST\\demo.user' },
  creationDate: '2026-11-16T00:00:00Z',
  sourceRefName: 'refs/heads/feature/ado-server-mcp',
  targetRefName: 'refs/heads/develop',
  mergeStatus: 'succeeded',
  repository: { id: 'r-mcp', name: 'ado-server-mcp', project: { id: 'p-devsecops', name: 'DemoProject' } },
  reviewers: [{ id: REVIEWER_ID, displayName: 'Reviewer', uniqueName: 'CORPTEST\\rev', vote: 5, isRequired: true }],
  lastMergeSourceCommit: { commitId: 'abc123' },
};
const SUB = /\/tfs\/DemoCollection\/DemoProject\/_apis\/git\/repositories\/r-mcp\/pullRequests\/101/;

describe('pull request tools', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function start(flavor: Flavor = '2020', options: HarnessOptions = {}): Promise<Harness> {
    h = await startHarness({ flavor, ...options, env: { ADO_DEFAULT_PROJECT: 'DemoProject', ...options.env } });
    const mock = h.mock;
    mock.on('GET', /\/tfs\/DemoCollection\/_apis\/git\/pullrequests\/101$/, () => ({ json: PR }));
    mock.on('GET', /\/repositories\/ado-server-mcp\/pullrequests$/, () => ({ json: { value: [PR] } }));
    mock.on('GET', /\/DemoProject\/_apis\/git\/pullrequests$/, () => ({ json: { value: [PR] } }));
    mock.on('POST', /\/repositories\/ado-server-mcp\/pullrequests$/, (r) => ({ json: { ...PR, pullRequestId: 102, ...(r.body as object) } }));
    mock.on('PATCH', /\/pullRequests\/101$/, (r) => ({ json: { ...PR, ...(r.body as object) } }));
    mock.on('GET', /\/pullRequests\/101\/iterations$/, () => ({ json: { value: [{ id: 1 }, { id: 2 }] } }));
    mock.on('GET', /\/pullRequests\/101\/iterations\/2\/changes$/, () => ({ json: { changeEntries: [{ item: { path: '/src/index.ts' }, changeType: 'edit' }] } }));
    mock.on('GET', /\/_apis\/policy\/evaluations$/, () => ({
      json: {
        value: [
          { evaluationId: 'e1', status: 'approved', configuration: { isBlocking: true, type: { displayName: 'Minimum number of reviewers' } } },
          { evaluationId: 'e2', status: 'rejected', configuration: { isBlocking: true, type: { displayName: 'Build' }, settings: { displayName: 'CI build' } } },
          { evaluationId: 'e3', status: 'running', configuration: { isBlocking: false, type: { displayName: 'Comment requirements' } } },
        ],
      },
    }));
    mock.on('GET', /\/pullRequests\/101\/workitems$/, () => ({ json: { value: [{ id: '5', url: 'x' }] } }));
    mock.on('GET', /\/_apis\/wit\/workitems$/i, (r) => ({ json: { value: (r.query.get('ids') ?? '').split(',').map((id) => ({ id: Number(id), rev: 1, fields: { 'System.Title': `Item ${id}` } })) } }));
    mock.on('PATCH', /\/_apis\/wit\/workitems\/5$/i, () => ({ json: { id: 5, rev: 2 } }));
    mock.on('GET', /\/pullRequests\/101\/threads$/, () => ({
      json: {
        value: [
          { id: 7, status: 'active', threadContext: { filePath: '/src/index.ts', rightFileStart: { line: 12 } }, comments: [{ id: 1, author: { displayName: 'Reviewer', uniqueName: 'CORPTEST\\rev' }, content: 'Rename this', commentType: 'text', publishedDate: '2026-11-16T01:00:00Z' }] },
          { id: 8, status: 'closed', comments: [{ id: 1, content: 'Policy check completed', commentType: 'system' }] },
          { id: 9, status: 'active', isDeleted: true, comments: [] },
        ],
      },
    }));
    mock.on('POST', /\/pullRequests\/101\/threads$/, () => ({ json: { id: 10, comments: [{ id: 1 }] } }));
    mock.on('POST', /\/pullRequests\/101\/threads\/7\/comments$/, () => ({ json: { id: 2 } }));
    mock.on('PATCH', /\/pullRequests\/101\/threads\/7$/, (r) => ({ json: { id: 7, ...(r.body as object) } }));
    mock.on('PUT', /\/pullRequests\/101\/reviewers\/([^/]+)$/, (r, m) => ({ json: { id: m[1], displayName: 'Someone', ...(r.body as object) } }));
    mock.on('DELETE', /\/pullRequests\/101\/reviewers\/([^/]+)$/, () => ({ status: 204 }));
    mock.on('GET', /\/tfs\/DemoCollection\/_apis\/identities$/, (r) => ({ json: { value: r.query.get('filterValue') === 'CORPTEST\\rev' ? [{ id: REVIEWER_ID }] : [] } }));
    return h;
  }

  it('exposes exactly the specified pull request toolset', () => {
    expect(pullRequestTools.map((tool) => tool.name)).toEqual([
      'list_pull_requests',
      'list_my_pull_requests',
      'get_pull_request',
      'create_pull_request',
      'update_pull_request',
      'update_pull_request_status',
      'get_pull_request_changes',
      'get_pull_request_policies',
      'list_pull_request_work_items',
      'link_pull_request_to_work_item',
      'list_pull_request_threads',
      'add_pull_request_comment',
      'reply_to_pull_request_thread',
      'set_pull_request_thread_status',
      'vote_on_pull_request',
      'manage_pull_request_reviewers',
    ]);
  });

  it('lists pull requests in the repository behind a git remote', async () => {
    const harness = await start();
    const { json } = await harness.call('list_pull_requests', { gitRemoteUrl: `${harness.mock.serverUrl}/DemoCollection/DemoProject/_git/ado-server-mcp`, targetBranch: 'develop' });
    expect(json.pullRequests[0]).toMatchObject({ id: 101, sourceBranch: 'feature/ado-server-mcp', targetBranch: 'develop' });
    expect(json.pullRequests[0].reviewers[0]).toMatchObject({ displayName: 'Reviewer', vote: 5, voteLabel: 'approved with suggestions', isRequired: true });
    const query = harness.mock.requestsTo(/\/repositories\/ado-server-mcp\/pullrequests$/).at(-1)?.query;
    expect(query?.get('searchCriteria.status')).toBe('active');
    expect(query?.get('searchCriteria.targetRefName')).toBe('refs/heads/develop');
  });

  it('lists my pull requests using my connectionData id', async () => {
    const harness = await start();
    const { json } = await harness.call('list_my_pull_requests');
    expect(json.created).toHaveLength(1);
    expect(json.reviewing).toHaveLength(1);
    const queries = harness.mock.requestsTo(/\/DemoProject\/_apis\/git\/pullrequests$/).map((r) => r.query);
    expect(queries.map((q) => q.get('searchCriteria.creatorId') ?? q.get('searchCriteria.reviewerId'))).toEqual([userIdFor('pat-demo'), userIdFor('pat-demo')]);
  });

  it('caps each requested role independently and reports role and aggregate truncation', async () => {
    const harness = await start();
    harness.mock.on('GET', /\/DemoProject\/_apis\/git\/pullrequests$/, (request) => ({
      json: { value: [PR, { ...PR, pullRequestId: request.query.get('searchCriteria.creatorId') ? 102 : 103 }] },
    }));
    const { json } = await harness.call('list_my_pull_requests', { role: 'both', top: 1 });
    expect(json).toMatchObject({
      created: [{ id: 101 }],
      reviewing: [{ id: 101 }],
      createdTruncated: true,
      reviewingTruncated: true,
      truncated: true,
    });
    const requests = harness.mock.requestsTo(/\/DemoProject\/_apis\/git\/pullrequests$/);
    expect(requests.map((request) => request.query.get('$top'))).toEqual(['2', '2']);
  });

  it('gets a pull request by id without knowing the project', async () => {
    const harness = await start();
    const { json } = await harness.call('get_pull_request', { pullRequestId: 101 });
    expect(json).toMatchObject({ id: 101, project: 'DemoProject', description: 'Implements the plan', lastMergeSourceCommit: 'abc123' });
    expect(json.webUrl).toBe(`${harness.mock.serverUrl}/DemoCollection/DemoProject/_git/ado-server-mcp/pullrequest/101`);
  });

  it('creates a pull request against the default branch with resolved reviewers', async () => {
    const harness = await start();
    const { json } = await harness.call('create_pull_request', {
      repository: 'ado-server-mcp',
      sourceBranch: 'feature/ado-server-mcp',
      title: 'Add MCP server',
      reviewers: ['CORPTEST\\rev'],
      workItemIds: [5],
      isDraft: true,
    });
    expect(json).toMatchObject({ created: true, id: 102 });
    expect(harness.mock.requestsTo(/\/pullrequests$/, 'POST').at(-1)?.body).toEqual({
      sourceRefName: 'refs/heads/feature/ado-server-mcp',
      targetRefName: 'refs/heads/develop',
      title: 'Add MCP server',
      isDraft: true,
      reviewers: [{ id: REVIEWER_ID }],
      workItemRefs: [{ id: '5' }],
    });
  });

  it('completes with the last merge source commit and refuses empty updates', async () => {
    const harness = await start();
    const { json } = await harness.call('update_pull_request_status', { pullRequestId: 101, action: 'complete', mergeStrategy: 'squash', deleteSourceBranch: true });
    expect(json).toMatchObject({ action: 'complete', status: 'completed' });
    expect(harness.mock.requestsTo(SUB, 'PATCH').at(-1)?.body).toEqual({
      status: 'completed',
      lastMergeSourceCommit: { commitId: 'abc123' },
      completionOptions: { mergeStrategy: 'squash', deleteSourceBranch: true, transitionWorkItems: true },
    });
    expect((await harness.call('update_pull_request', { pullRequestId: 101 })).text).toMatch(/^\[bad_request\]/);
  });

  it('asks about the actual pull request before changing it', async () => {
    const harness = await start('2020', { env: { ADO_ALLOW_DESTRUCTIVE: 'false' }, elicit: (field) => (field === 'confirm' ? 'false' : undefined) });
    const result = await harness.call('update_pull_request_status', { pullRequestId: 101, action: 'abandon' });
    expect(result.text).toMatch(/^\[declined\]/);
    expect(harness.elicitations[0]?.message).toMatch(/^Abandon pull request !101 "Add MCP server" \("feature\/ado-server-mcp" â†’ "develop"\) in "ado-server-mcp"\./);
    expect(harness.mock.requestsTo(SUB, 'PATCH')).toHaveLength(0);
  });

  it('lists changes of the latest iteration', async () => {
    const harness = await start();
    const { json } = await harness.call('get_pull_request_changes', { pullRequestId: 101 });
    expect(json).toMatchObject({ iterationId: 2, count: 1, changes: [{ path: '/src/index.ts', changeType: 'edit' }] });
  });

  it('reports changes truncation from a top-plus-one fetch', async () => {
    const harness = await start();
    harness.mock.on('GET', /\/pullRequests\/101\/iterations\/2\/changes$/, () => ({
      json: { changeEntries: Array.from({ length: 3 }, (_, index) => ({ item: { path: `/file-${index}.ts` }, changeType: 'edit' })) },
    }));
    const { json } = await harness.call('get_pull_request_changes', { pullRequestId: 101, top: 2 });
    expect(json).toMatchObject({ count: 2, truncated: true, changes: [{ path: '/file-0.ts' }, { path: '/file-1.ts' }] });
    expect(harness.mock.requestsTo(/\/iterations\/2\/changes$/).at(-1)?.query.get('$top')).toBe('3');
  });

  it.each([
    ['2020', '6.0-preview.1'],
    ['25H2', '7.2-preview.1'],
  ] as const)('evaluates policies on Server %s with %s', async (flavor, version) => {
    const harness = await start(flavor);
    const { json } = await harness.call('get_pull_request_policies', { pullRequestId: 101 });
    expect(json.canComplete).toBe(false);
    expect(json.blocking).toEqual([{ policy: 'CI build', status: 'rejected', isBlocking: true }]);
    const request = harness.mock.requestsTo(/\/_apis\/policy\/evaluations$/).at(-1);
    expect(request?.apiVersion).toBe(version);
    expect(request?.query.get('artifactId')).toBe('vstfs:///CodeReview/CodeReviewId/p-devsecops/101');
  });

  it('keeps blockers outside the policy display cap in canComplete', async () => {
    const harness = await start();
    harness.mock.on('GET', /\/_apis\/policy\/evaluations$/, () => ({ json: { value: [
      { status: 'approved', configuration: { isBlocking: true, type: { displayName: 'Reviewers' } } },
      { status: 'rejected', configuration: { isBlocking: true, type: { displayName: 'Build' } } },
      { status: 'running', configuration: { isBlocking: false, type: { displayName: 'Optional' } } },
    ] } }));
    const { json } = await harness.call('get_pull_request_policies', { pullRequestId: 101, top: 1 });
    expect(json).toMatchObject({
      canComplete: false,
      count: 1,
      truncated: true,
      policies: [{ policy: 'Reviewers' }],
      blocking: [{ policy: 'Build', status: 'rejected', isBlocking: true }],
    });
  });

  it('lists and links work items', async () => {
    const harness = await start();
    expect((await harness.call('list_pull_request_work_items', { pullRequestId: 101 })).json).toMatchObject({ ids: [5], workItems: [{ id: 5, fields: { 'System.Title': 'Item 5' } }] });
    const { json } = await harness.call('link_pull_request_to_work_item', { pullRequestId: 101, workItemId: 5 });
    expect(json.artifactUrl).toBe('vstfs:///Git/PullRequestId/p-devsecops%2Fr-mcp%2F101');
    expect((harness.mock.requestsTo(/\/_apis\/wit\/workitems\/5$/i, 'PATCH').at(-1)?.body as Array<{ value: unknown }>)[0]?.value).toEqual({
      rel: 'ArtifactLink',
      url: 'vstfs:///Git/PullRequestId/p-devsecops%2Fr-mcp%2F101',
      attributes: { name: 'Pull Request' },
    });
  });

  it('caps pull request work item ids and hydrated items with truncation metadata', async () => {
    const harness = await start();
    harness.mock.on('GET', /\/pullRequests\/101\/workitems$/, () => ({ json: { value: [{ id: '5' }, { id: '6' }, { id: '7' }] } }));
    const { json } = await harness.call('list_pull_request_work_items', { pullRequestId: 101, top: 2 });
    expect(json).toMatchObject({ count: 2, truncated: true, ids: [5, 6], workItems: [{ id: 5 }, { id: 6 }] });
  });

  it('reads threads without system noise and writes comments', async () => {
    const harness = await start();
    const threads = await harness.call('list_pull_request_threads', { pullRequestId: 101 });
    expect(threads.json.threads).toEqual([
      { id: 7, status: 'active', filePath: '/src/index.ts', line: 12, commentsTruncated: false, comments: [{ id: 1, author: 'Reviewer <CORPTEST\\rev>', content: 'Rename this', publishedDate: '2026-11-16T01:00:00Z' }] },
    ]);
    expect((await harness.call('add_pull_request_comment', { pullRequestId: 101, content: 'Fixed', filePath: '/src/index.ts', line: 12 })).json).toEqual({ threadId: 10, commentId: 1 });
    expect(harness.mock.requestsTo(/\/threads$/, 'POST').at(-1)?.body).toEqual({
      comments: [{ parentCommentId: 0, content: 'Fixed', commentType: 'text' }],
      status: 'active',
      threadContext: { filePath: '/src/index.ts', rightFileStart: { line: 12, offset: 1 }, rightFileEnd: { line: 12, offset: 1 } },
    });
    expect((await harness.call('reply_to_pull_request_thread', { pullRequestId: 101, threadId: 7, content: 'Done' })).json).toEqual({ threadId: 7, commentId: 2 });
    expect((await harness.call('set_pull_request_thread_status', { pullRequestId: 101, threadId: 7, status: 'fixed' })).json).toEqual({ threadId: 7, status: 'fixed' });
  });

  it('applies thread caps after filtering and reports omitted comments', async () => {
    const harness = await start();
    harness.mock.on('GET', /\/pullRequests\/101\/threads$/, () => ({ json: { value: [
      { id: 20, status: 'closed', comments: [{ id: 1, commentType: 'text', content: 'filtered by status' }] },
      { id: 21, status: 'active', comments: Array.from({ length: 22 }, (_, index) => ({ id: index + 1, commentType: 'text', content: `Comment ${index + 1}` })) },
      { id: 22, status: 'active', comments: [{ id: 1, commentType: 'system', content: 'hidden system thread' }] },
      { id: 23, status: 'active', comments: [{ id: 1, commentType: 'text', content: 'second visible thread' }] },
    ] } }));
    const { json } = await harness.call('list_pull_request_threads', { pullRequestId: 101, status: 'active', top: 1 });
    expect(json).toMatchObject({ count: 1, truncated: true, threads: [{ id: 21, commentsTruncated: true }] });
    expect(json.threads[0].comments).toHaveLength(20);
  });

  it('votes as the caller', async () => {
    const harness = await start();
    const { json } = await harness.call('vote_on_pull_request', { pullRequestId: 101, vote: 'approve' });
    expect(json).toMatchObject({ voted: true, vote: 'approve', value: 10 });
    const request = harness.mock.requestsTo(/\/reviewers\//, 'PUT').at(-1);
    expect(request?.path).toBe(`/tfs/DemoCollection/DemoProject/_apis/git/repositories/r-mcp/pullRequests/101/reviewers/${userIdFor('pat-demo')}`);
    expect(request?.body).toEqual({ vote: 10 });
  });

  it('adds and removes reviewers', async () => {
    const harness = await start();
    const { json } = await harness.call('manage_pull_request_reviewers', { pullRequestId: 101, add: ['CORPTEST\\rev'], remove: ['bbbbbbbb-0000-4000-8000-000000000002'], required: true });
    expect(json).toEqual({ added: [REVIEWER_ID], removed: ['bbbbbbbb-0000-4000-8000-000000000002'] });
    expect(harness.mock.requestsTo(/\/reviewers\//, 'PUT').at(-1)?.body).toEqual({ vote: 0, isRequired: true });
    expect(harness.mock.requestsTo(/\/reviewers\//, 'DELETE')).toHaveLength(1);
    expect((await harness.call('manage_pull_request_reviewers', { pullRequestId: 101, add: ['nobody'] })).text).toMatch(/^\[not_found\]/);
  });
});
