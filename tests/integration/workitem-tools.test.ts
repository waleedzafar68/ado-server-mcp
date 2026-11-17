import { afterEach, describe, expect, it } from 'vitest';
import type { MockAdoServer } from '../fixtures/mock-ado-server.js';
import { startHarness, type Harness, type HarnessOptions } from '../helpers/harness.js';

function workItem(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    rev: 3,
    fields: {
      'System.Id': id,
      'System.WorkItemType': 'Task',
      'System.Title': `Item ${id}`,
      'System.State': 'Active',
      'System.TeamProject': 'DemoProject',
      'System.AssignedTo': { displayName: 'Jordan Example', uniqueName: 'CORPTEST\\demo.user' },
      'System.Description': '<div>Fix <b>login</b></div>',
      ...extra,
    },
    _links: { html: { href: `https://devops.example.com/tfs/DemoCollection/_workitems/edit/${id}` } },
  };
}

function withWorkItemRoutes(mock: MockAdoServer): void {
  mock.on('POST', /\/_apis\/wit\/wiql$/i, () => ({ json: { workItems: [{ id: 1 }, { id: 2 }, { id: 3 }] } }));
  mock.on('GET', /\/_apis\/wit\/workitems$/i, (r) => ({ json: { value: (r.query.get('ids') ?? '').split(',').map(Number).map((id) => workItem(id)) } }));
  mock.on('GET', /\/_apis\/wit\/workitems\/(\d+)$/i, (_r, m) => ({ json: workItem(Number(m[1])) }));
  mock.on('PATCH', /\/_apis\/wit\/workitems\/(\d+)$/i, (_r, m) => ({ json: workItem(Number(m[1]), { 'System.State': 'Closed' }) }));
  mock.on('POST', /\/_apis\/wit\/workitems\/\$Task$/i, () => ({ json: workItem(42) }));
  mock.on('GET', /\/_apis\/wit\/workitems\/(\d+)\/revisions$/i, () => ({
    json: { value: [
      { rev: 1, fields: { 'System.Title': 'Item', 'System.State': 'New', 'System.ChangedDate': '2026-11-01T00:00:00Z' } },
      { rev: 2, fields: { 'System.Title': 'Item', 'System.State': 'Active', 'System.ChangedDate': '2026-11-02T00:00:00Z' } },
    ] },
  }));
  mock.on('GET', /\/DemoProject\/_apis\/wit\/workItems\/(\d+)\/comments$/i, () => ({
    json: { totalCount: 1, comments: [{ id: 1, text: '<p>Looks good</p>', createdBy: { displayName: 'Reviewer', uniqueName: 'CORPTEST\\rev' }, createdDate: '2026-11-10T00:00:00Z' }] },
  }));
  mock.on('POST', /\/DemoProject\/_apis\/wit\/workItems\/(\d+)\/comments$/i, () => ({ json: { id: 9, createdDate: '2026-11-16T00:00:00Z' } }));
  mock.on('POST', /\/_apis\/wit\/attachments$/i, () => ({ json: { id: 'att-1', url: 'https://devops.example.com/tfs/DemoCollection/_apis/wit/attachments/att-1' } }));
}

describe('work item tools', () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.close(); h = undefined; });
  async function start(options: HarnessOptions = {}): Promise<Harness> {
    h = await startHarness(options);
    withWorkItemRoutes(h.mock);
    return h;
  }

  it('runs project WIQL and hydrates fields with a lookahead top', async () => {
    const harness = await start();
    const { json } = await harness.call('query_work_items', { project: 'DemoProject', wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] = 'Active'", top: 2 });
    expect(json).toMatchObject({ collection: 'DemoCollection', project: 'DemoProject', count: 2, truncated: true, ids: [1, 2] });
    expect(json.workItems[0].fields['System.AssignedTo']).toBe('Jordan Example <CORPTEST\\demo.user>');
    const wiql = harness.mock.requestsTo(/\/_apis\/wit\/wiql$/, 'POST').at(-1);
    expect(wiql?.path).toBe('/tfs/DemoCollection/DemoProject/_apis/wit/wiql');
    expect(wiql?.query.get('$top')).toBe('3');
    expect(harness.mock.requestsTo(/\/_apis\/wit\/workitems$/i, 'GET').at(-1)?.query.get('fields')).toContain('System.Title');
  });
  it('runs collection-wide WIQL when @project is not used', async () => {
    const harness = await start();
    await harness.call('query_work_items', { wiql: 'SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 1', hydrate: false });
    expect(harness.mock.requestsTo(/\/_apis\/wit\/wiql$/, 'POST').at(-1)?.path).toBe('/tfs/DemoCollection/_apis/wit/wiql');
  });
  it('runs team-macro WIQL on the team URL', async () => {
    const harness = await start();
    const { json } = await harness.call('query_work_items', { project: 'DemoProject', wiql: 'SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] = @CurrentIteration', hydrate: false });
    expect(json).toMatchObject({ project: 'DemoProject', team: 'DemoProject Team' });
    expect(harness.mock.requestsTo(/\/_apis\/wit\/wiql$/, 'POST').at(-1)?.path).toBe('/tfs/DemoCollection/DemoProject/DemoProject Team/_apis/wit/wiql');
  });
  it('gets a work item with HTML converted to text and optional field filter', async () => {
    const harness = await start();
    expect((await harness.call('get_work_item', { id: 5 })).json.fields['System.Description']).toBe('Fix login');
    expect(Object.keys((await harness.call('get_work_item', { id: 5, fields: ['System.Title'] })).json.fields)).toEqual(['System.Title']);
  });
  it('summarises revisions with changed fields and reports capped versus complete results', async () => {
    const harness = await start();
    const { json } = await harness.call('get_work_item_revisions', { id: 5, top: 1 });
    expect(json.revisions[0]).toMatchObject({ rev: 1, state: 'New' });
    expect(json).toMatchObject({ count: 1, truncated: true });
    const complete = await harness.call('get_work_item_revisions', { id: 5, top: 3 });
    expect(complete.json).toMatchObject({ count: 2, truncated: false });
    expect(complete.json.revisions[1]).toMatchObject({ rev: 2, state: 'Active', changedFields: ['System.State'] });
  });
  it('compares a paged revision with its predecessor and preserves page truncation', async () => {
    const harness = await start();
    const revisions = [
      { rev: 1, fields: { 'System.Title': 'Same title', 'System.State': 'New' } },
      { rev: 2, fields: { 'System.Title': 'Same title', 'System.State': 'Active' } },
      { rev: 3, fields: { 'System.Title': 'Renamed', 'System.State': 'Active' } },
    ];
    harness.mock.on('GET', /\/_apis\/wit\/workitems\/(\d+)\/revisions$/i, (request) => {
      const skip = Number(request.query.get('$skip') ?? 0);
      const top = Number(request.query.get('$top') ?? revisions.length);
      return { json: { value: revisions.slice(skip, skip + top) } };
    });
    const { json } = await harness.call('get_work_item_revisions', { id: 5, skip: 1, top: 1 });
    expect(json).toMatchObject({ count: 1, truncated: true });
    expect(json.revisions[0]).toMatchObject({ rev: 2, changedFields: ['System.State'] });
    const request = harness.mock.requestsTo(/\/revisions$/i, 'GET').at(-1);
    expect(request?.query.get('$skip')).toBe('0');
    expect(request?.query.get('$top')).toBe('3');
  });
  it('creates a work item with a parent link', async () => {
    const harness = await start();
    const { json } = await harness.call('create_work_item', { project: 'DemoProject', type: 'Task', title: 'Write plan', parentId: 7, additionalFields: { 'Microsoft.VSTS.Common.Priority': 2 } });
    expect(json).toMatchObject({ created: true, id: 42 });
    const request = harness.mock.requestsTo(/\/_apis\/wit\/workitems\/\$Task$/i, 'POST').at(-1);
    expect(request?.headers['content-type']).toBe('application/json-patch+json');
    expect(request?.body).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'Write plan' },
      { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: 2 },
      { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${harness.mock.serverUrl}/DemoCollection/_apis/wit/workItems/7` } },
    ]);
  });
  it('updates with optimistic concurrency and refuses empty updates', async () => {
    const harness = await start();
    await harness.call('update_work_item', { id: 5, state: 'Closed', comment: 'Done', expectedRevision: 3 });
    expect(harness.mock.requestsTo(/\/_apis\/wit\/workitems\/5$/i, 'PATCH').at(-1)?.body).toEqual([
      { op: 'test', path: '/rev', value: 3 }, { op: 'add', path: '/fields/System.State', value: 'Closed' }, { op: 'add', path: '/fields/System.History', value: 'Done' },
    ]);
    const empty = await harness.call('update_work_item', { id: 5 });
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/^\[bad_request\] Nothing to update/);
  });
  it('reports concurrency conflicts', async () => {
    const harness = await start();
    harness.mock.on('PATCH', /\/_apis\/wit\/workitems\/6$/i, () => ({ status: 412, json: { message: 'TF26071: This work item has been changed by someone else since you opened it.' } }));
    expect((await harness.call('update_work_item', { id: 6, title: 'x', expectedRevision: 1 })).text).toMatch(/^\[conflict\].*TF26071/);
  });
  it('reads comments with the Server 2020 preview version and reports complete results', async () => {
    const harness = await start();
    const { json } = await harness.call('list_work_item_comments', { id: 5 });
    expect(json).toMatchObject({ workItemId: 5, project: 'DemoProject', totalCount: 1, count: 1, truncated: false });
    expect(json.comments[0]).toMatchObject({ text: 'Looks good', createdBy: 'Reviewer <CORPTEST\\rev>' });
    expect(harness.mock.requestsTo(/\/comments$/i, 'GET').at(-1)?.apiVersion).toBe('6.0-preview.3');
  });
  it('reports truncated comment results when upstream has more than top', async () => {
    const harness = await start();
    harness.mock.on('GET', /\/DemoProject\/_apis\/wit\/workItems\/(\d+)\/comments$/i, () => ({ json: { totalCount: 3, comments: [1, 2, 3].map((id) => ({ id, text: `Comment ${id}` })) } }));
    const { json } = await harness.call('list_work_item_comments', { id: 5, top: 2 });
    expect(json).toMatchObject({ totalCount: 3, count: 2, truncated: true });
    expect(json.comments).toHaveLength(2);
  });
  it('reads and writes comments with the 25H2 preview version', async () => {
    const harness = await start({ flavor: '25H2' });
    await harness.call('list_work_item_comments', { id: 5, project: 'DemoProject' });
    const added = await harness.call('add_work_item_comment', { id: 5, project: 'DemoProject', text: 'Ship it' });
    expect(added.json).toMatchObject({ added: true, commentId: 9 });
    expect(harness.mock.requestsTo(/\/comments$/i).map((r) => r.apiVersion)).toEqual(['7.2-preview.4', '7.2-preview.4']);
    expect(harness.mock.requestsTo(/\/comments$/i, 'POST').at(-1)?.body).toEqual({ text: 'Ship it' });
  });
  it('gets a bounded batch and reports truncation', async () => {
    const harness = await start();
    const { json } = await harness.call('get_work_items', { ids: [1, 2, 3], top: 2 });
    expect(json).toMatchObject({ count: 2, truncated: true });
    expect(json.workItems.map((item: { id: number }) => item.id)).toEqual([1, 2]);
    expect((await harness.call('get_work_items', { ids: [1, 2], top: 2 })).json.truncated).toBe(false);
  });
  it('links work items using friendly link names', async () => {
    const harness = await start();
    expect((await harness.call('link_work_item', { id: 5, targetId: 8, linkType: 'child' })).json).toMatchObject({ linked: true, rel: 'System.LinkTypes.Hierarchy-Forward' });
    expect((await harness.call('link_work_item', { id: 5, targetId: 8, linkType: 'sibling' })).text).toMatch(/^\[bad_request\]/);
  });
  it('uploads and attaches a file', async () => {
    const harness = await start();
    expect((await harness.call('add_work_item_attachment', { id: 5, fileName: 'notes.txt', content: 'hello' })).json).toMatchObject({ attached: true, attachmentId: 'att-1', size: 5 });
    const upload = harness.mock.requestsTo(/\/_apis\/wit\/attachments$/i, 'POST').at(-1);
    expect(upload?.query.get('fileName')).toBe('notes.txt');
    expect(upload?.headers['content-type']).toBe('application/octet-stream');
    expect(Buffer.isBuffer(upload?.body) && (upload?.body as Buffer).toString('utf8')).toBe('hello');
    expect((harness.mock.requestsTo(/\/_apis\/wit\/workitems\/5$/i, 'PATCH').at(-1)?.body as Array<{ value: { rel: string } }>)[0]?.value.rel).toBe('AttachedFile');
  });
  it('lists my open work items in the default project', async () => {
    const harness = await start({ env: { ADO_DEFAULT_PROJECT: 'DemoProject' } });
    expect((await harness.call('my_work_items')).json.count).toBe(3);
    const query = (harness.mock.requestsTo(/\/_apis\/wit\/wiql$/, 'POST').at(-1)?.body as { query: string }).query;
    expect(query).toContain('[System.AssignedTo] = @Me');
    expect(query).toContain("[System.TeamProject] = 'DemoProject'");
    expect(query).toContain('NOT IN');
  });
  it('hides write tools in read-only mode', async () => {
    const harness = await start({ env: { ADO_MCP_READ_ONLY: 'true' } });
    const names = (await harness.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('get_work_item');
    expect(names).not.toContain('create_work_item');
  });
});
