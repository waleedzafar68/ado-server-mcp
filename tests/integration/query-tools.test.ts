import { afterEach, describe, expect, it } from 'vitest';
import { classificationPath } from '../../src/tools/query-tools.js';
import { startHarness, type Harness } from '../helpers/harness.js';

describe('classificationPath', () => {
  it.each([
    ['\\DemoProject\\Area', 'DemoProject'],
    ['\\DemoProject\\Area\\Team A', 'DemoProject\\Team A'],
    ['\\DemoProject\\Iteration\\Sprint 1', 'DemoProject\\Sprint 1'],
  ])('converts %s to %s', (path, expected) => {
    expect(classificationPath(path, 'x')).toBe(expected);
  });
});

describe('query and process tools', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function start(): Promise<Harness> {
    h = await startHarness({ env: { ADO_DEFAULT_PROJECT: 'DemoProject' } });
    const mock = h.mock;
    mock.on('GET', /\/DemoProject\/_apis\/wit\/queries$/, () => ({
      json: { value: [{ id: 'f-1', name: 'Shared Queries', path: 'Shared Queries', isFolder: true, isPublic: true, children: [{ id: 'q-1', name: 'Active Bugs', path: 'Shared Queries/Active Bugs', isPublic: true, queryType: 'flat' }] }] },
    }));
    mock.on('GET', /\/DemoProject\/_apis\/wit\/queries\/Shared Queries\/Active Bugs$/, () => ({ json: { id: 'q-1', name: 'Active Bugs', path: 'Shared Queries/Active Bugs' } }));
    mock.on('GET', /\/DemoProject\/_apis\/wit\/wiql\/q-1$/, () => ({ json: { queryType: 'flat', workItems: [{ id: 11 }, { id: 12 }] } }));
    mock.on('GET', /\/_apis\/wit\/workitems$/i, (r) => ({
      json: { value: (r.query.get('ids') ?? '').split(',').map((id) => ({ id: Number(id), rev: 1, fields: { 'System.Title': `Bug ${id}` } })) },
    }));
    mock.on('GET', /\/DemoProject\/_apis\/wit\/workitemtypes$/, () => ({
      json: { value: [{ name: 'Bug', referenceName: 'Microsoft.VSTS.WorkItemTypes.Bug', description: 'A defect', color: 'CC293D', isDisabled: false }] },
    }));
    mock.on('GET', /\/DemoProject\/_apis\/wit\/workitemtypes\/Bug\/states$/, () => ({
      json: { value: [{ name: 'New', category: 'Proposed', color: 'b2b2b2' }, { name: 'Active', category: 'InProgress', color: '007acc' }] },
    }));
    mock.on('GET', /\/DemoProject\/_apis\/wit\/classificationnodes\/Areas$/, () => ({
      json: { id: 1, name: 'DemoProject', path: '\\DemoProject\\Area', hasChildren: true, children: [{ id: 2, name: 'Team A', path: '\\DemoProject\\Area\\Team A', hasChildren: false }] },
    }));
    mock.on('GET', /\/DemoProject\/_apis\/wit\/classificationnodes\/Iterations$/, () => ({
      json: {
        id: 10, name: 'DemoProject', path: '\\DemoProject\\Iteration', hasChildren: true,
        children: [{ id: 11, name: 'Sprint 1', path: '\\DemoProject\\Iteration\\Sprint 1', attributes: { startDate: '2026-11-02T00:00:00Z', finishDate: '2026-11-13T00:00:00Z' } }],
      },
    }));
    return h;
  }

  it('lists saved queries as a flat path list', async () => {
    const harness = await start();
    const { json } = await harness.call('list_queries');
    expect(json.queries).toEqual([
      { id: 'f-1', path: 'Shared Queries', isFolder: true, isPublic: true, queryType: undefined },
      { id: 'q-1', path: 'Shared Queries/Active Bugs', isFolder: false, isPublic: true, queryType: 'flat' },
    ]);
    expect(harness.mock.requestsTo(/\/_apis\/wit\/queries$/).at(-1)?.query.get('$depth')).toBe('2');
  });

  it('runs a saved query by path and hydrates the results', async () => {
    const harness = await start();
    const { json } = await harness.call('run_saved_query', { path: 'Shared Queries/Active Bugs' });
    expect(json).toMatchObject({ queryId: 'q-1', count: 2, ids: [11, 12] });
    expect(json.workItems[1].fields['System.Title']).toBe('Bug 12');
  });

  it('requires a query id or path', async () => {
    const harness = await start();
    expect((await harness.call('run_saved_query', {})).text).toMatch(/^\[bad_request\]/);
  });

  it('lists work item types and states', async () => {
    const harness = await start();
    const types = await harness.call('list_work_item_types');
    expect(types.json).toMatchObject({ count: 1, truncated: false });
    expect(types.json.types[0]).toMatchObject({ name: 'Bug', referenceName: 'Microsoft.VSTS.WorkItemTypes.Bug' });
    const states = await harness.call('list_work_item_states', { type: 'Bug' });
    expect(states.json).toMatchObject({ count: 2, truncated: false });
    expect(states.json.states.map((s: { name: string }) => s.name)).toEqual(['New', 'Active']);
  });

  it('caps type and state lists and reports truncation', async () => {
    const harness = await start();
    harness.mock.on('GET', /\/DemoProject\/_apis\/wit\/workitemtypes$/, () => ({
      json: { value: Array.from({ length: 3 }, (_, n) => ({ name: `Type ${n + 1}` })) },
    }));
    harness.mock.on('GET', /\/DemoProject\/_apis\/wit\/workitemtypes\/Bug\/states$/, () => ({
      json: { value: Array.from({ length: 3 }, (_, n) => ({ name: `State ${n + 1}` })) },
    }));
    const types = await harness.call('list_work_item_types', { top: 2 });
    const states = await harness.call('list_work_item_states', { type: 'Bug', top: 2 });
    expect(types.json).toMatchObject({ count: 2, truncated: true });
    expect(types.json.types.map((type: { name: string }) => type.name)).toEqual(['Type 1', 'Type 2']);
    expect(states.json).toMatchObject({ count: 2, truncated: true });
    expect(states.json.states.map((state: { name: string }) => state.name)).toEqual(['State 1', 'State 2']);
  });

  it('lists areas and iterations with usable paths', async () => {
    const harness = await start();
    const areas = await harness.call('list_areas');
    expect(areas.json.areas.map((a: { path: string }) => a.path)).toEqual(['DemoProject', 'DemoProject\\Team A']);
    const iterations = await harness.call('list_iterations');
    expect(iterations.json.iterations[1]).toEqual({ id: 11, name: 'Sprint 1', path: 'DemoProject\\Sprint 1', startDate: '2026-11-02T00:00:00Z', finishDate: '2026-11-13T00:00:00Z' });
    expect(harness.mock.requestsTo(/classificationnodes\/Iterations$/).at(-1)?.query.get('$depth')).toBe('3');
  });
});
