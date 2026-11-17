import { afterEach, describe, expect, it } from 'vitest';
import { defaultCollections, type MockCollection } from '../fixtures/mock-ado-server.js';
import { startHarness, type Harness } from '../helpers/harness.js';

const AUTHOR = { displayName: 'Jordan Example', uniqueName: 'CORPTEST\\demo.user' };
const SHELVESET = 'wip;CORPTEST\\demo.user';

function withTfvcCollection(): MockCollection[] {
  return [
    ...defaultCollections(),
    {
      name: 'Projects',
      pats: ['pat-demo'],
      projects: [{ id: 'p-legacy', name: 'Legacy', defaultTeam: 'Legacy Team', sourceControl: 'Tfvc' }],
      repositories: [],
    },
  ];
}

describe('tfvc tools', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function start(): Promise<Harness> {
    h = await startHarness({ collections: withTfvcCollection(), env: { ADO_COLLECTIONS: 'DemoCollection,Projects' } });
    const mock = h.mock;
    mock.on('GET', /\/tfs\/Projects\/_apis\/tfvc\/items$/, (r) => {
      const scopePath = r.query.get('scopePath');
      if (scopePath) {
        return {
          json: {
            count: 3,
            value: [
              { path: scopePath, isFolder: true, version: 120 },
              { path: `${scopePath}/src`, isFolder: true, version: 118, changeDate: '2026-10-01T00:00:00Z' },
              { path: `${scopePath}/README.md`, version: 120, size: 42, changeDate: '2026-10-02T00:00:00Z' },
            ],
          },
        };
      }
      const path = r.query.get('path') ?? '';
      const content = path.endsWith('.png') ? 'PNG\u0000\u0000data' : 'line1\nline2\nline3\nline4\nline5';
      return { json: { path, version: Number(r.query.get('versionDescriptor.version') ?? 120), content } };
    });
    mock.on('GET', /\/tfs\/Projects\/_apis\/tfvc\/changesets$/, () => ({
      json: {
        value: [
          { changesetId: 120, author: AUTHOR, checkedInBy: AUTHOR, createdDate: '2026-10-02T00:00:00Z', comment: 'Fix the nightly build' },
          { changesetId: 118, author: AUTHOR, checkedInBy: AUTHOR, createdDate: '2026-10-01T00:00:00Z', comment: 'Add src' },
        ],
      },
    }));
    mock.on('GET', /\/tfs\/Projects\/_apis\/tfvc\/changesets\/120$/, () => ({
      json: {
        changesetId: 120,
        author: AUTHOR,
        checkedInBy: AUTHOR,
        createdDate: '2026-10-02T00:00:00Z',
        comment: 'Fix the nightly build',
        workItems: [{ id: 5, title: 'Nightly build fails', workItemType: 'Bug', state: 'Active' }],
      },
    }));
    mock.on('GET', /\/tfs\/Projects\/_apis\/tfvc\/changesets\/120\/changes$/, () => ({
      json: { value: [{ item: { path: '$/Legacy/Main/README.md' }, changeType: 'edit' }, { item: { path: '$/Legacy/Main/src/App.cs' }, changeType: 'add, edit' }] },
    }));
    mock.on('GET', /\/tfs\/Projects\/_apis\/tfvc\/shelvesets$/, (r) =>
      r.query.get('shelvesetId')
        ? { json: { id: r.query.get('shelvesetId'), name: 'wip', owner: AUTHOR, createdDate: '2026-11-01T00:00:00Z', comment: 'Work in progress', workItems: [{ id: 5, title: 'Nightly build fails' }] } }
        : { json: { value: [{ id: SHELVESET, name: 'wip', owner: AUTHOR, createdDate: '2026-11-01T00:00:00Z', comment: 'Work in progress' }] } },
    );
    mock.on('GET', /\/tfs\/Projects\/_apis\/tfvc\/shelvesets\/changes$/, () => ({
      json: { value: [{ item: { path: '$/Legacy/Main/README.md' }, changeType: 'edit' }] },
    }));
    return h;
  }

  it('lists a folder and finds the collection from the $/ path', async () => {
    const harness = await start();
    const { json } = await harness.call('list_tfvc_items', { path: '$/Legacy/Main/' });
    expect(json).toMatchObject({ collection: 'Projects', project: 'Legacy', path: '$/Legacy/Main', count: 2, truncated: false });
    expect(json.items).toEqual([
      { path: '$/Legacy/Main/src', isFolder: true, changeset: 118, changeDate: '2026-10-01T00:00:00Z' },
      { path: '$/Legacy/Main/README.md', isFolder: false, changeset: 120, changeDate: '2026-10-02T00:00:00Z', size: 42 },
    ]);
    const request = harness.mock.requestsTo(/\/tfvc\/items$/).at(-1);
    expect(request?.path).toBe('/tfs/Projects/_apis/tfvc/items');
    expect([request?.query.get('scopePath'), request?.query.get('recursionLevel')]).toEqual(['$/Legacy/Main', 'OneLevel']);
  });

  it('lists the project root when no path is given', async () => {
    const harness = await start();
    const { json } = await harness.call('list_tfvc_items', { collection: 'Projects', project: 'Legacy', recursion: 'full' });
    expect(json.path).toBe('$/Legacy');
    expect(harness.mock.requestsTo(/\/tfvc\/items$/).at(-1)?.query.get('recursionLevel')).toBe('Full');
  });

  it('reads a file at a changeset with line windowing and detects binary files', async () => {
    const harness = await start();
    const { json } = await harness.call('get_tfvc_file_content', { path: '$/Legacy/Main/README.md', changeset: 118, startLine: 2, endLine: 3 });
    expect(json).toMatchObject({ path: '$/Legacy/Main/README.md', changeset: 118, text: 'line2\nline3', startLine: 2, endLine: 3, totalLines: 5, truncated: false });
    expect(json.hint).toMatch(/startLine=4/);
    const query = harness.mock.requestsTo(/\/tfvc\/items$/).at(-1)?.query;
    expect([query?.get('path'), query?.get('includeContent'), query?.get('versionDescriptor.version'), query?.get('versionDescriptor.versionType')]).toEqual([
      '$/Legacy/Main/README.md', 'true', '118', 'changeset',
    ]);
    expect((await harness.call('get_tfvc_file_content', { path: '$/Legacy/Main/logo.png' })).json).toMatchObject({ binary: true });
  });

  it('lists changesets under the project path by default', async () => {
    const harness = await start();
    const { json } = await harness.call('list_changesets', { collection: 'Projects', project: 'Legacy', author: 'CORPTEST\\demo.user', top: 1 });
    expect(json).toMatchObject({ collection: 'Projects', path: '$/Legacy', count: 1, truncated: true });
    expect(json.changesets).toEqual([{ id: 120, author: 'Jordan Example', createdDate: '2026-10-02T00:00:00Z', comment: 'Fix the nightly build' }]);
    const query = harness.mock.requestsTo(/\/tfvc\/changesets$/).at(-1)?.query;
    expect(query?.get('searchCriteria.itemPath')).toBe('$/Legacy');
    expect(query?.get('searchCriteria.author')).toBe('CORPTEST\\demo.user');
    expect([query?.get('$top'), query?.get('$orderby')]).toEqual(['2', 'id desc']);
  });

  it('gets a changeset with its work items and a bounded change list', async () => {
    const harness = await start();
    const { json } = await harness.call('get_changeset', { collection: 'Projects', id: 120, top: 1 });
    expect(json).toMatchObject({
      id: 120,
      author: 'Jordan Example',
      comment: 'Fix the nightly build',
      workItems: [{ id: 5, title: 'Nightly build fails', type: 'Bug', state: 'Active' }],
      changes: [{ path: '$/Legacy/Main/README.md', changeType: 'edit' }],
      changesTruncated: true,
    });
    expect(harness.mock.requestsTo(/\/changesets\/120\/changes$/).at(-1)?.query.get('$top')).toBe('2');
  });

  it('lists shelvesets and reads one with its changes', async () => {
    const harness = await start();
    const list = await harness.call('list_shelvesets', { collection: 'Projects', owner: 'CORPTEST\\demo.user' });
    expect(list.json.shelvesets).toEqual([{ id: SHELVESET, name: 'wip', owner: 'Jordan Example', createdDate: '2026-11-01T00:00:00Z', comment: 'Work in progress' }]);
    expect(harness.mock.requestsTo(/\/tfvc\/shelvesets$/).at(-1)?.query.get('requestData.owner')).toBe('CORPTEST\\demo.user');

    const one = await harness.call('get_shelveset', { collection: 'Projects', shelvesetId: SHELVESET });
    expect(one.json).toMatchObject({
      id: SHELVESET,
      name: 'wip',
      workItems: [{ id: 5, title: 'Nightly build fails' }],
      changes: [{ path: '$/Legacy/Main/README.md', changeType: 'edit' }],
      changesTruncated: false,
    });
    expect(harness.mock.requestsTo(/\/tfvc\/shelvesets\/changes$/).at(-1)?.query.get('shelvesetId')).toBe(SHELVESET);
  });

  it('rejects paths that are not TFVC server paths before calling the server', async () => {
    const harness = await start();
    const result = await harness.call('list_tfvc_items', { collection: 'Projects', path: 'Legacy/Main' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[bad_request\].*\$\//);
    expect(harness.mock.requestsTo(/\/tfvc\//)).toHaveLength(0);
  });

  it('rejects a project that conflicts with the TFVC path before any upstream request', async () => {
    const harness = await start();
    const requestCount = harness.mock.requests.length;
    const result = await harness.call('list_tfvc_items', { project: 'OtherProject', path: '$/Legacy/Main' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[bad_request\].*project.*Legacy/i);
    expect(harness.mock.requests).toHaveLength(requestCount);
  });

  it('uses the path project when the explicit project matches case-insensitively', async () => {
    const harness = await start();
    const { json } = await harness.call('list_tfvc_items', { project: 'legacy', path: '$/Legacy/Main' });
    expect(json).toMatchObject({ collection: 'Projects', project: 'Legacy', path: '$/Legacy/Main' });
    expect(harness.mock.requestsTo(/\/tfs\/Projects\/_apis\/tfvc\/items$/)).toHaveLength(1);
  });
});
