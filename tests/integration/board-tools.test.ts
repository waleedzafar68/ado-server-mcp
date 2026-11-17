import { afterEach, describe, expect, it } from 'vitest';
import type { Flavor } from '../fixtures/mock-ado-server.js';
import { startHarness, type Harness } from '../helpers/harness.js';

const TEAM = /\/tfs\/DemoCollection\/DemoProject\/DemoProject Team\/_apis\/work/;

describe('boards and sprints tools', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function start(flavor: Flavor = '2020'): Promise<Harness> {
    h = await startHarness({ flavor, env: { ADO_DEFAULT_PROJECT: 'DemoProject' } });
    const mock = h.mock;
    const sprint = (id: string, name: string, timeFrame: string) => ({
      id, name, path: `DemoProject\\${name}`, attributes: { startDate: '2026-11-02T00:00:00Z', finishDate: '2026-11-13T00:00:00Z', timeFrame },
    });
    mock.on('GET', /\/_apis\/work\/boards$/, () => ({ json: { value: [{ id: 'b1', name: 'Stories' }] } }));
    mock.on('GET', /\/_apis\/work\/boards\/Stories\/columns$/, () => ({
      json: { value: [{ id: 'c1', name: 'New', columnType: 'incoming', itemLimit: 0, isSplit: false, stateMappings: { 'User Story': 'New' } }] },
    }));
    mock.on('GET', /\/_apis\/work\/teamsettings\/iterations$/, (r) => ({
      json: { value: r.query.get('$timeframe') === 'current' ? [sprint('it-2', 'Sprint 2', 'current')] : [sprint('it-1', 'Sprint 1', 'past'), sprint('it-2', 'Sprint 2', 'current'), sprint('it-3', 'Sprint 3', 'future')] },
    }));
    mock.on('GET', /\/_apis\/work\/teamsettings\/iterations\/it-2\/workitems$/, () => ({
      json: { workItemRelations: [{ rel: null, source: null, target: { id: 21 } }, { rel: 'System.LinkTypes.Hierarchy-Forward', source: { id: 21 }, target: { id: 22 } }] },
    }));
    mock.on('GET', /\/_apis\/wit\/workitems$/i, (r) => ({
      json: { value: (r.query.get('ids') ?? '').split(',').map((id) => ({ id: Number(id), rev: 1, fields: { 'System.Title': `Story ${id}` } })) },
    }));
    const member = { teamMember: { id: 'u1', displayName: 'Jordan Example', uniqueName: 'CORPTEST\\demo.user' }, activities: [{ name: 'Development', capacityPerDay: 6 }], daysOff: [{ start: '2026-11-05T00:00:00Z', end: '2026-11-05T00:00:00Z' }] };
    mock.on('GET', /\/_apis\/work\/teamsettings\/iterations\/it-2\/capacities$/, () => ({
      json: flavor === '2020' ? { count: 1, value: [member] } : { teamMembers: [member], totalCapacityPerDay: 6, totalDaysOff: 1 },
    }));
    mock.on('GET', /\/_apis\/work\/teamsettings\/iterations\/it-2\/teamdaysoff$/, () => ({ json: { daysOff: [{ start: '2026-11-11T00:00:00Z', end: '2026-11-11T00:00:00Z' }] } }));
    return h;
  }

  it('lists boards of the default team', async () => {
    const harness = await start();
    const { json } = await harness.call('list_boards');
    expect(json).toEqual({ project: 'DemoProject', team: 'DemoProject Team', count: 1, truncated: false, boards: [{ id: 'b1', name: 'Stories' }] });
    expect(harness.mock.requestsTo(/\/_apis\/work\/boards$/).at(-1)?.path).toMatch(TEAM);
  });

  it('reads board columns for an explicit team', async () => {
    const harness = await start();
    const { json } = await harness.call('get_board_columns', { team: 'Platform', board: 'Stories' });
    expect(json).toMatchObject({ count: 1, truncated: false });
    expect(json.columns[0]).toMatchObject({ name: 'New', columnType: 'incoming', stateMappings: { 'User Story': 'New' } });
    expect(harness.mock.requestsTo(/columns$/).at(-1)?.path).toBe('/tfs/DemoCollection/DemoProject/Platform/_apis/work/boards/Stories/columns');
  });

  it('filters sprints by time frame', async () => {
    const harness = await start();
    const { json } = await harness.call('list_sprints', { timeFrame: 'past' });
    expect(json.sprints.map((s: { name: string }) => s.name)).toEqual(['Sprint 1']);
  });

  it('gets the current sprint', async () => {
    const harness = await start();
    expect((await harness.call('get_current_sprint')).json.sprint).toMatchObject({ id: 'it-2', name: 'Sprint 2', timeFrame: 'current' });
    expect(harness.mock.requestsTo(/iterations$/).at(-1)?.query.get('$timeframe')).toBe('current');
  });

  it('lists sprint work items with the preview API and hydrates them', async () => {
    const harness = await start();
    const { json } = await harness.call('get_sprint_work_items');
    expect(json).toMatchObject({ iterationId: 'it-2', count: 2, ids: [21, 22] });
    expect(json.workItems[0].fields['System.Title']).toBe('Story 21');
    expect(harness.mock.requestsTo(/iterations\/it-2\/workitems$/).at(-1)?.apiVersion).toBe('6.0-preview');
  });

  it.each(['2020', '25H2'] as const)('normalises sprint capacity on Server %s', async (flavor) => {
    const harness = await start(flavor);
    const { json } = await harness.call('get_sprint_capacity', { iterationId: 'it-2' });
    expect(json).toEqual({
      team: 'DemoProject Team',
      iterationId: 'it-2',
      totalCapacityPerDay: 6,
      totalMemberCount: 1,
      count: 1,
      truncated: false,
      teamDaysOff: [{ start: '2026-11-11T00:00:00Z', end: '2026-11-11T00:00:00Z' }],
      members: [{ member: 'Jordan Example <CORPTEST\\demo.user>', capacityPerDay: 6, activities: [{ name: 'Development', capacityPerDay: 6 }], daysOff: [{ start: '2026-11-05T00:00:00Z', end: '2026-11-05T00:00:00Z' }] }],
    });
  });

  it('caps boards, columns, and capacity members while retaining full counts and capacity totals', async () => {
    const harness = await start();
    harness.mock.on('GET', /\/_apis\/work\/boards$/, () => ({ json: { value: [{ id: 'b1', name: 'Stories' }, { id: 'b2', name: 'Features' }] } }));
    harness.mock.on('GET', /\/_apis\/work\/boards\/Stories\/columns$/, () => ({ json: { value: [
      { id: 'c1', name: 'New' }, { id: 'c2', name: 'Active' },
    ] } }));
    const member = (id: string, capacityPerDay: number) => ({ teamMember: { displayName: id, uniqueName: `${id}@example.test` }, activities: [{ name: 'Development', capacityPerDay }] });
    harness.mock.on('GET', /\/_apis\/work\/teamsettings\/iterations\/it-2\/capacities$/, () => ({
      json: { value: [member('A', 4), member('B', 5)] },
    }));

    const boards = (await harness.call('list_boards', { top: 1 })).json;
    expect(boards).toMatchObject({ count: 1, truncated: true, boards: [{ id: 'b1' }] });
    const columns = (await harness.call('get_board_columns', { board: 'Stories', top: 1 })).json;
    expect(columns).toMatchObject({ count: 1, truncated: true, columns: [{ id: 'c1' }] });
    const capacity = (await harness.call('get_sprint_capacity', { iterationId: 'it-2', top: 1 })).json;
    expect(capacity).toMatchObject({ totalCapacityPerDay: 9, totalMemberCount: 2, count: 1, truncated: true, members: [{ member: 'A <A@example.test>' }] });
  });
});
