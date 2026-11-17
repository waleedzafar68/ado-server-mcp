import { afterEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../helpers/harness.js';

describe('projects tools', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('lists projects in the configured collection', async () => {
    h = await startHarness();
    const { json } = await h.call('list_projects');
    expect(json).toMatchObject({ collection: 'DemoCollection', count: 3, truncated: false });
    expect(json.projects.map((p: { name: string }) => p.name)).toEqual(['DemoProject', 'DemoService', 'Demo Product']);
  });

  it('lists projects across collections and reports per-collection failures', async () => {
    h = await startHarness({ env: { ADO_COLLECTIONS: 'DemoCollection,LegacyCollection' } });
    const { json } = await h.call('list_projects', { allCollections: true });
    expect(json.collections[0]).toMatchObject({ collection: 'DemoCollection', count: 3 });
    expect(json.collections[1].collection).toBe('LegacyCollection');
    expect(json.collections[1].error).toMatch(/^\[auth\]/);
  });

  it('gets project details with capabilities and default team', async () => {
    h = await startHarness();
    const { json } = await h.call('get_project', { project: 'DemoProject' });
    expect(json).toMatchObject({ id: 'p-devsecops', name: 'DemoProject', defaultTeam: { name: 'DemoProject Team' }, sourceControl: 'Git', processTemplate: 'Agile' });
    expect(h.mock.requestsTo(/\/_apis\/projects\/DemoProject$/).at(-1)?.query.get('includeCapabilities')).toBe('true');
  });

  it('lists teams', async () => {
    h = await startHarness();
    h.mock.on('GET', /\/tfs\/DemoCollection\/_apis\/projects\/DemoProject\/teams$/, () => ({
      json: { value: [{ id: 't1', name: 'DemoProject Team', description: 'The default project team.' }] },
    }));
    const { json } = await h.call('list_teams', { project: 'DemoProject', mine: true });
    expect(json.truncated).toBe(false);
    expect(json.teams).toEqual([{ id: 't1', name: 'DemoProject Team', description: 'The default project team.' }]);
    expect(h.mock.requestsTo(/\/teams$/).at(-1)?.query.get('$mine')).toBe('true');
  });

  it('reports when the team list is capped at top', async () => {
    h = await startHarness();
    h.mock.on('GET', /\/tfs\/DemoCollection\/_apis\/projects\/DemoProject\/teams$/, () => ({
      json: { value: [
        { id: 't1', name: 'Team One' },
        { id: 't2', name: 'Team Two' },
        { id: 't3', name: 'Team Three' },
      ] },
    }));
    const { json } = await h.call('list_teams', { project: 'DemoProject', top: 2 });
    expect(json.count).toBe(2);
    expect(json.truncated).toBe(true);
    expect(json.teams.map((team: { name: string }) => team.name)).toEqual(['Team One', 'Team Two']);
    expect(h.mock.requestsTo(/\/teams$/).at(-1)?.query.get('$top')).toBe('3');
  });

  it('lists members of the default team', async () => {
    h = await startHarness();
    h.mock.on('GET', /\/teams\/DemoProject Team\/members$/, () => ({
      json: { value: [{ identity: { id: 'u1', displayName: 'Jordan Example', uniqueName: 'CORPTEST\\demo.user' }, isTeamAdmin: true }] },
    }));
    const { json } = await h.call('list_team_members', { project: 'DemoProject' });
    expect(json).toEqual({
      team: 'DemoProject Team',
      count: 1,
      truncated: false,
      members: [{ id: 'u1', displayName: 'Jordan Example', uniqueName: 'CORPTEST\\demo.user', isTeamAdmin: true }],
    });
  });

  it('uses api-version 7.2 on Azure DevOps Server 25H2', async () => {
    h = await startHarness({ flavor: '25H2' });
    await h.call('list_projects');
    expect(h.mock.requestsTo(/\/DemoCollection\/_apis\/projects$/, 'GET').at(-1)?.apiVersion).toBe('7.2');
  });
});
