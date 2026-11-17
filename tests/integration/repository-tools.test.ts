import { afterEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../helpers/harness.js';

const REPO = /\/tfs\/DemoCollection\/DemoProject\/_apis\/git\/repositories\/ado-server-mcp/;

describe('repository tools', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function start(): Promise<Harness> {
    h = await startHarness({ env: { ADO_DEFAULT_PROJECT: 'DemoProject' } });
    const mock = h.mock;
    mock.on('GET', /\/repositories\/ado-server-mcp\/refs$/, () => ({
      json: { value: [{ name: 'refs/heads/feature/a', objectId: 'c1', creator: { displayName: 'Jordan Example' } }, { name: 'refs/heads/feature/b', objectId: 'c2' }] },
    }));
    mock.on('GET', /\/repositories\/ado-server-mcp\/stats\/branches$/, () => ({
      json: { value: [{ name: 'develop', aheadCount: 0, behindCount: 0, isBaseVersion: true, commit: { commitId: 'c0', comment: 'base' } }, { name: 'feature/a', aheadCount: 2, behindCount: 1, commit: { commitId: 'c1', comment: 'work' } }] },
    }));
    mock.on('GET', /\/repositories\/ado-server-mcp\/items$/, (r) => {
      if (r.query.get('scopePath')) {
        return { json: { value: [{ path: '/', isFolder: true, gitObjectType: 'tree' }, { path: '/README.md', gitObjectType: 'blob', commitId: 'c0', objectId: 'o1' }] } };
      }
      const content = r.query.get('path') === '/logo.png' ? 'PNG\u0000\u0000data' : 'line1\nline2\nline3\nline4\nline5';
      return { json: { path: r.query.get('path'), objectId: 'o1', commitId: 'c0', content, contentMetadata: { isBinary: false } } };
    });
    mock.on('GET', /\/repositories\/ado-server-mcp\/commits$/, () => ({
      json: { value: [{ commitId: 'c1', author: { name: 'Jordan', email: 'demo.user@example.com', date: '2026-11-15T00:00:00Z' }, comment: 'feat: plan', changeCounts: { Edit: 2 } }] },
    }));
    mock.on('GET', /\/repositories\/ado-server-mcp\/commits\/c1$/, () => ({
      json: { commitId: 'c1', parents: ['c0'], author: { name: 'Jordan' }, committer: { name: 'Jordan' }, comment: 'feat: plan', changeCounts: { Edit: 1 }, changes: [{ item: { path: '/src/index.ts' }, changeType: 'edit' }] },
    }));
    mock.on('GET', /\/repositories\/ado-server-mcp\/diffs\/commits$/, () => ({
      json: { aheadCount: 2, behindCount: 1, commonCommit: 'c0', allChangesIncluded: true, changeCounts: { Add: 1 }, changes: [{ item: { path: '/new.ts' }, changeType: 'add' }] },
    }));
    return h;
  }

  it('lists repositories collection-wide or per project', async () => {
    const harness = await start();
    expect((await harness.call('list_repositories', { collection: 'DemoCollection' })).json.count).toBe(4);
    const service = await harness.call('list_repositories', { project: 'DemoService' });
    expect(service.json.repositories.map((r: { name: string }) => r.name)).toEqual(['demoservice-api', 'shared-lib']);
  });

  it('gets the repository behind a git remote', async () => {
    const harness = await start();
    const { json } = await harness.call('get_repository', { gitRemoteUrl: `${harness.mock.serverUrl}/DemoCollection/DemoProject/_git/ado-server-mcp` });
    expect(json).toMatchObject({ id: 'r-mcp', name: 'ado-server-mcp', project: 'DemoProject', defaultBranch: 'develop' });
  });

  it('surfaces the TF401027 permission error when creating a repository', async () => {
    const harness = await start();
    const result = await harness.call('create_repository', { project: 'DemoProject', name: 'new-repo' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[permission\].*TF401027/);
    expect(harness.mock.requestsTo(/\/_apis\/git\/repositories$/, 'POST').at(-1)?.body).toEqual({ name: 'new-repo', project: { id: 'p-devsecops' } });
  });

  it('lists branches by prefix and with ahead/behind counts', async () => {
    const harness = await start();
    const { json } = await harness.call('list_branches', { repository: 'ado-server-mcp', filter: 'feature/' });
    expect(json.branches).toEqual([{ name: 'feature/a', commitId: 'c1', creator: 'Jordan Example' }, { name: 'feature/b', commitId: 'c2', creator: undefined }]);
    expect(harness.mock.requestsTo(/\/refs$/).at(-1)?.query.get('filter')).toBe('heads/feature/');
    const stats = await harness.call('list_branches', { repository: 'ado-server-mcp', filter: 'feature/', includeAheadBehind: true });
    expect(stats.json.branches).toEqual([{ name: 'feature/a', aheadCount: 2, behindCount: 1, isBaseVersion: false, commitId: 'c1', comment: 'work' }]);
  });

  it('lists items at a path', async () => {
    const harness = await start();
    const { json } = await harness.call('list_repository_items', { repository: 'ado-server-mcp', version: 'develop' });
    expect(json.items[1]).toEqual({ path: '/README.md', isFolder: false, gitObjectType: 'blob', commitId: 'c0' });
    const query = harness.mock.requestsTo(/\/items$/).at(-1)?.query;
    expect(query?.get('recursionLevel')).toBe('oneLevel');
    expect(query?.get('versionDescriptor.version')).toBe('develop');
    expect(query?.get('versionDescriptor.versionType')).toBe('branch');
  });

  it('windows file content and detects binary files', async () => {
    const harness = await start();
    const { json } = await harness.call('get_file_content', { repository: 'ado-server-mcp', path: '/src/a.ts', startLine: 2, endLine: 3 });
    expect(json).toMatchObject({ path: '/src/a.ts', text: 'line2\nline3', startLine: 2, endLine: 3, totalLines: 5, truncated: false });
    expect(json.hint).toMatch(/startLine=4/);
    expect(harness.mock.requestsTo(REPO).at(-1)?.query.get('$format')).toBe('json');
    expect((await harness.call('get_file_content', { repository: 'ado-server-mcp', path: '/logo.png' })).json).toMatchObject({ binary: true });
  });

  it('lists and gets commits', async () => {
    const harness = await start();
    const list = await harness.call('list_commits', { repository: 'ado-server-mcp', branch: 'develop', author: 'Jordan', top: 10 });
    expect(list.json.commits[0]).toMatchObject({ commitId: 'c1', author: 'Jordan', comment: 'feat: plan' });
    const query = harness.mock.requestsTo(/\/commits$/).at(-1)?.query;
    expect(query?.get('searchCriteria.itemVersion.version')).toBe('develop');
    expect(query?.get('searchCriteria.author')).toBe('Jordan');
    expect(query?.get('searchCriteria.$top')).toBe('11');
    const commit = await harness.call('get_commit', { repository: 'ado-server-mcp', commitId: 'c1' });
    expect(commit.json).toMatchObject({ commitId: 'c1', parents: ['c0'], changes: [{ path: '/src/index.ts', changeType: 'edit' }] });
  });

  it('diffs two branches', async () => {
    const harness = await start();
    const { json } = await harness.call('diff_branches', { repository: 'ado-server-mcp', baseBranch: 'develop', targetBranch: 'feature/a' });
    expect(json).toMatchObject({ aheadCount: 2, behindCount: 1, commonCommit: 'c0', changes: [{ path: '/new.ts', changeType: 'add' }] });
    const query = harness.mock.requestsTo(/diffs\/commits$/).at(-1)?.query;
    expect([query?.get('baseVersion'), query?.get('targetVersion'), query?.get('baseVersionType')]).toEqual(['develop', 'feature/a', 'branch']);
  });

  it('uses one-item lookahead to report capped commit and diff results', async () => {
    const harness = await start();
    harness.mock.on('GET', /\/repositories\/ado-server-mcp\/commits$/, () => ({
      json: { value: [1, 2, 3].map((n) => ({ commitId: `c${n}`, changeCounts: { Edit: n } })) },
    }));
    harness.mock.on('GET', /\/repositories\/ado-server-mcp\/commits\/c1$/, () => ({
      json: { commitId: 'c1', changeCounts: { Edit: 3 }, changes: [1, 2, 3].map((n) => ({ item: { path: `/f${n}` }, changeType: 'edit' })) },
    }));
    harness.mock.on('GET', /\/repositories\/ado-server-mcp\/diffs\/commits$/, () => ({
      json: { aheadCount: 4, behindCount: 2, commonCommit: 'c0', allChangesIncluded: true, changeCounts: { Edit: 3 }, changes: [1, 2, 3].map((n) => ({ item: { path: `/f${n}` }, changeType: 'edit' })) },
    }));

    const list = await harness.call('list_commits', { repository: 'ado-server-mcp', top: 2 });
    expect(list.json).toMatchObject({ count: 2, truncated: true, commits: [{ commitId: 'c1' }, { commitId: 'c2' }] });
    expect(harness.mock.requestsTo(/\/commits$/).at(-1)?.query.get('searchCriteria.$top')).toBe('3');
    const commit = await harness.call('get_commit', { repository: 'ado-server-mcp', commitId: 'c1', top: 2 });
    expect(commit.json).toMatchObject({ changeCounts: { Edit: 3 }, count: 2, truncated: true, changes: [{ path: '/f1' }, { path: '/f2' }] });
    expect(harness.mock.requestsTo(/\/commits\/c1$/).at(-1)?.query.get('changeCount')).toBe('3');
    const diff = await harness.call('diff_branches', { repository: 'ado-server-mcp', baseBranch: 'develop', targetBranch: 'feature/a', top: 2 });
    expect(diff.json).toMatchObject({ aheadCount: 4, behindCount: 2, commonCommit: 'c0', allChangesIncluded: true, changeCounts: { Edit: 3 }, count: 2, truncated: true, changes: [{ path: '/f1' }, { path: '/f2' }] });
    expect(harness.mock.requestsTo(/diffs\/commits$/).at(-1)?.query.get('$top')).toBe('3');
  });

  it('marks a complete list and incomplete server diff accurately', async () => {
    const harness = await start();
    harness.mock.on('GET', /\/repositories\/ado-server-mcp\/commits$/, () => ({ json: { value: [{ commitId: 'c1' }] } }));
    harness.mock.on('GET', /\/repositories\/ado-server-mcp\/diffs\/commits$/, () => ({
      json: { aheadCount: 2, behindCount: 1, commonCommit: 'c0', allChangesIncluded: false, changeCounts: { Add: 5 }, changes: [{ item: { path: '/new.ts' }, changeType: 'add' }] },
    }));
    expect((await harness.call('list_commits', { repository: 'ado-server-mcp', top: 1 })).json).toMatchObject({ count: 1, truncated: false });
    expect((await harness.call('diff_branches', { repository: 'ado-server-mcp', baseBranch: 'develop', targetBranch: 'feature/a', top: 10 })).json).toMatchObject({
      aheadCount: 2, behindCount: 1, commonCommit: 'c0', allChangesIncluded: false, changeCounts: { Add: 5 }, count: 1, truncated: true,
    });
  });
});
