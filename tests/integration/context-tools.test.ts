import { afterEach, describe, expect, it } from 'vitest';
import { userIdFor } from '../fixtures/mock-ado-server.js';
import { startHarness, type Harness } from '../helpers/harness.js';

const BOTH = { ADO_PAT: 'pat-all', ADO_COLLECTIONS: 'DemoCollection,LegacyCollection' };

describe('context tools', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('reports the caller and Server 2020 versions without leaking the PAT', async () => {
    h = await startHarness();
    const { isError, json, text } = await h.call('whoami_and_collections');
    expect(isError).toBe(false);
    expect(json.user).toEqual({ id: userIdFor('pat-demo'), displayName: 'Jordan Example', uniqueName: 'CORPTEST\\demo.user' });
    expect(json.collections).toEqual([
      expect.objectContaining({ collection: 'DemoCollection', status: 'authenticated', apiVersion: '6.0', apiVersions: expect.objectContaining({ witComments: '6.0-preview.3' }) }),
    ]);
    expect(text).not.toContain('pat-demo');
  });

  it('reports Server 25H2 versions', async () => {
    h = await startHarness({ flavor: '25H2' });
    const { json } = await h.call('whoami_and_collections');
    expect(json.collections[0]).toMatchObject({ apiVersion: '7.2', apiVersions: { witComments: '7.2-preview.4', core: '7.2' } });
  });

  it('marks collections the PAT does not cover as unauthorized', async () => {
    h = await startHarness({ env: { ADO_COLLECTIONS: 'DemoCollection,LegacyCollection' } });
    const { json } = await h.call('whoami_and_collections');
    expect(json.collections.map((c: { status: string }) => c.status)).toEqual(['authenticated', 'unauthorized']);
  });

  it('resolves and verifies the repository behind a git remote', async () => {
    h = await startHarness();
    const { json } = await h.call('resolve_repo_context', { gitRemoteUrl: `${h.mock.serverUrl}/DemoCollection/DemoProject/_git/ado-server-mcp` });
    expect(json).toMatchObject({
      serverUrl: h.mock.serverUrl,
      collection: 'DemoCollection',
      project: 'DemoProject',
      repository: 'ado-server-mcp',
      repositoryId: 'r-mcp',
      defaultBranch: 'develop',
      verified: true,
      confidence: 'high',
    });
  });

  it('returns disambiguation for an ambiguous folder name', async () => {
    h = await startHarness({ env: BOTH });
    const { isError, json } = await h.call('resolve_repo_context', { repoOrFolderHint: 'shared-lib' });
    expect(isError).toBe(false);
    expect(json).toMatchObject({ status: 'disambiguation_required', missing: 'collection' });
    expect(json.options).toHaveLength(2);
  });

  it('asks the user through elicitation', async () => {
    h = await startHarness({ env: BOTH, elicit: (field) => (field === 'collection' ? 'DemoCollection' : undefined) });
    const { json } = await h.call('resolve_repo_context', { repoOrFolderHint: 'shared-lib' });
    expect(json).toMatchObject({ collection: 'DemoCollection', project: 'DemoService', repository: 'shared-lib', verified: true, confidence: 'medium' });
    expect(h.elicitations[0]).toMatchObject({ field: 'collection', values: ['DemoCollection', 'LegacyCollection'] });
  });

  it('uses MCP workspace roots', async () => {
    h = await startHarness({ env: BOTH, roots: ['ado-server-mcp'] });
    const { json } = await h.call('resolve_repo_context', {});
    expect(json).toMatchObject({ collection: 'DemoCollection', project: 'DemoProject', repository: 'ado-server-mcp' });
    expect(json.sources).toContain('collection:mcp-roots');
  });

  it('lists the context tools as read-only', async () => {
    h = await startHarness();
    const { tools } = await h.client.listTools();
    const context = tools.filter((tool) => ['whoami_and_collections', 'resolve_repo_context'].includes(tool.name));
    expect(context).toHaveLength(2);
    expect(context.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  });
});