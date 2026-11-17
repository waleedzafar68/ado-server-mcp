import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdoClient } from '../../src/ado/ado-client.js';
import { AdoError, DisambiguationRequired, type DisambiguationPayload } from '../../src/ado/errors.js';
import { VersionNegotiator } from '../../src/ado/version-negotiator.js';
import { loadConfig } from '../../src/config/env.js';
import { buildCallerContext } from '../../src/context/caller-context.js';
import { ContextResolver, NO_BRIDGE, type ClientBridge } from '../../src/context/context-resolver.js';
import { SessionMemory } from '../../src/context/session-memory.js';
import { TtlCache } from '../../src/util/ttl-cache.js';
import { MockAdoServer } from '../fixtures/mock-ado-server.js';

const mock = new MockAdoServer({ flavor: '2020' });
beforeAll(async () => { await mock.start(); });
afterAll(async () => { await mock.stop(); });

const BOTH = { authorization: 'Bearer pat-all', 'x-ado-collections': 'DemoCollection,LegacyCollection' };
const DEMO_ONLY = { authorization: 'Bearer pat-demo', 'x-ado-collections': 'DemoCollection' };

function resolverFor(
  headers: Record<string, string>,
  bridge: ClientBridge = NO_BRIDGE,
  options: { env?: Record<string, string>; memory?: SessionMemory; write?: boolean } = {},
): ContextResolver {
  const config = loadConfig({ ADO_DEFAULT_SERVER_URL: mock.serverUrl, ADO_ALLOW_INSECURE_HTTP: 'true', ...options.env });
  const client = new AdoClient(buildCallerContext(headers, config), new VersionNegotiator(fetch, { timeoutMs: 5000 }), { timeoutMs: 5000 });
  return new ContextResolver(client, bridge, new TtlCache<unknown>(60_000), 'test-fingerprint', options.memory, { write: options.write });
}

function fakeBridge(options: {
  choose?: (field: string, values: string[]) => string | undefined;
  text?: (field: string) => string | undefined;
  roots?: string[];
}) {
  const asked: Array<{ field: string; values: string[] }> = [];
  let rootCalls = 0;
  const bridge: ClientBridge = {
    supportsElicitation: options.choose !== undefined || options.text !== undefined,
    supportsRoots: options.roots !== undefined,
    elicitChoice: async (_message, field, values) => {
      asked.push({ field, values });
      return options.choose?.(field, values);
    },
    elicitText: async (_message, field) => {
      asked.push({ field, values: [] });
      return options.text?.(field);
    },
    confirm: async () => false,
    listRootNames: async () => {
      rootCalls++;
      return options.roots ?? [];
    },
  };
  return { bridge, asked, rootCalls: () => rootCalls };
}

async function disambiguation(promise: Promise<unknown>): Promise<DisambiguationPayload> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  if (!(error instanceof DisambiguationRequired)) throw new Error(`expected DisambiguationRequired, got ${String(error)}`);
  return error.payload;
}

describe('ContextResolver', () => {
  it('uses explicit arguments without calling the server', async () => {
    const before = mock.requests.length;
    const scope = await resolverFor(BOTH).resolve({ collection: 'DemoCollection', project: 'DemoService' }, { project: true });
    expect(scope).toEqual({ serverUrl: mock.serverUrl, collection: 'DemoCollection', project: 'DemoService', repository: undefined, sources: ['collection:argument', 'project:argument'] });
    expect(mock.requests.length).toBe(before);
  });

  it('reads everything from the terminal git remote', async () => {
    const scope = await resolverFor(DEMO_ONLY).resolve({ gitRemoteUrl: `${mock.serverUrl}/DemoCollection/DemoProject/_git/ado-server-mcp` }, { repository: true });
    expect(scope).toMatchObject({ serverUrl: mock.serverUrl, collection: 'DemoCollection', project: 'DemoProject', repository: 'ado-server-mcp' });
    expect(scope.sources).toEqual(['collection:gitRemoteUrl', 'project:gitRemoteUrl', 'repository:gitRemoteUrl']);
  });

  it('rejects remotes that are not Azure DevOps Server remotes', async () => {
    await expect(resolverFor(DEMO_ONLY).resolve({ gitRemoteUrl: 'https://github.com/org/repo.git' })).rejects.toBeInstanceOf(AdoError);
  });

  it('uses the only configured collection and the default project', async () => {
    const scope = await resolverFor({ ...DEMO_ONLY, 'x-ado-default-project': 'DemoProject' }).resolve({}, { project: true });
    expect(scope).toMatchObject({ collection: 'DemoCollection', project: 'DemoProject', sources: ['collection:only-configured', 'project:default'] });
  });

  it('finds the collection that owns a repository', async () => {
    const scope = await resolverFor(BOTH).resolve({ repository: 'portal-portal' }, { repository: true });
    expect(scope).toMatchObject({ collection: 'LegacyCollection', project: 'LEGACY PRODUCT', repository: 'portal-portal' });
    expect(scope.sources).toContain('collection:cross-collection-search');
  });

  it('finds the collection that owns a project', async () => {
    const scope = await resolverFor(BOTH).resolve({ project: 'DemoAutomation' }, { project: true });
    expect(scope).toMatchObject({ collection: 'LegacyCollection', project: 'DemoAutomation' });
  });

  it('returns disambiguation when a repository exists in two collections', async () => {
    const payload = await disambiguation(resolverFor(BOTH).resolve({ repository: 'shared-lib' }, { repository: true }));
    expect(payload).toMatchObject({ status: 'disambiguation_required', missing: 'collection' });
    expect(payload.options).toEqual([
      { collection: 'DemoCollection', project: 'DemoService', repository: 'shared-lib' },
      { collection: 'LegacyCollection', project: 'DemoAutomation', repository: 'shared-lib' },
    ]);
  });

  it('asks through elicitation when the client supports it', async () => {
    const { bridge, asked } = fakeBridge({ choose: () => 'LegacyCollection' });
    const scope = await resolverFor(BOTH, bridge).resolve({ repository: 'shared-lib' }, { repository: true });
    expect(scope).toMatchObject({ collection: 'LegacyCollection', project: 'DemoAutomation', repository: 'shared-lib' });
    expect(scope.sources).toContain('collection:asked');
    expect(asked).toEqual([{ field: 'collection', values: ['DemoCollection', 'LegacyCollection'] }]);
  });

  it('falls back to disambiguation when the user declines', async () => {
    const { bridge } = fakeBridge({ choose: () => undefined });
    await expect(resolverFor(BOTH, bridge).resolve({ repository: 'shared-lib' }, { repository: true })).rejects.toBeInstanceOf(DisambiguationRequired);
  });

  it('matches MCP workspace roots against repositories', async () => {
    const { bridge } = fakeBridge({ roots: ['demoservice-api'] });
    const scope = await resolverFor(BOTH, bridge).resolve({}, { repository: true });
    expect(scope).toMatchObject({ collection: 'DemoCollection', project: 'DemoService', repository: 'demoservice-api' });
    expect(scope.sources).toEqual(['collection:mcp-roots', 'project:mcp-roots', 'repository:mcp-roots']);
  });

  it('explains when a scoped PAT cannot list collections', async () => {
    const payload = await disambiguation(resolverFor({ authorization: 'Bearer pat-demo' }).resolve({}));
    expect(payload.options).toEqual([]);
    expect(payload.message).toMatch(/cannot list collections/);
  });

  it('lists server collections for an all-collections PAT and asks', async () => {
    const { bridge, asked } = fakeBridge({ choose: () => 'DemoCollection' });
    const scope = await resolverFor({ authorization: 'Bearer pat-all' }, bridge).resolve({});
    expect(scope).toMatchObject({ collection: 'DemoCollection', sources: ['collection:asked'] });
    expect(asked[0]?.values).toEqual(['DemoCollection', 'LegacyCollection']);

    const memory = new SessionMemory();
    memory.refusedCollections = new Set(['democollection']);
    const filtered = fakeBridge({ choose: (_field, values) => values[0] });
    const narrowed = await resolverFor({ authorization: 'Bearer pat-all' }, filtered.bridge, { memory }).resolve({});
    expect(narrowed.collection).toBe('LegacyCollection');
    expect(filtered.asked.flatMap((question) => question.values)).not.toContain('DemoCollection');
  });

  it('offers collections with their projects', async () => {
    const payload = await disambiguation(resolverFor(BOTH).resolve({}));
    expect(payload.options).toEqual([
      { collection: 'DemoCollection', projects: ['DemoProject', 'DemoService', 'Demo Product'] },
      { collection: 'LegacyCollection', projects: ['LEGACY PRODUCT', 'DemoAutomation'] },
    ]);
  });

  it('asks for the project when the collection has several', async () => {
    const payload = await disambiguation(resolverFor(DEMO_ONLY).resolve({}, { project: true }));
    expect(payload.missing).toBe('project');
    expect(payload.options.map((option) => option.project)).toEqual(['DemoProject', 'DemoService', 'Demo Product']);
  });

  it('infers the project from a known repository', async () => {
    const scope = await resolverFor(DEMO_ONLY).resolve({ repository: 'demoservice-api' }, { repository: true });
    expect(scope).toMatchObject({ collection: 'DemoCollection', project: 'DemoService', repository: 'demoservice-api' });
    expect(scope.sources).toContain('project:repository-lookup');
  });

  it('does not take the repository from the remote when the project disagrees', async () => {
    const remote = `${mock.serverUrl}/DemoCollection/DemoProject/_git/ado-server-mcp`;
    const payload = await disambiguation(resolverFor(DEMO_ONLY).resolve({ project: 'DemoService', gitRemoteUrl: remote }, { repository: true }));
    expect(payload.missing).toBe('repository');
    expect(payload.options.map((option) => option.repository)).not.toContain('ado-server-mcp');
  });

  it('keeps the home server when an explicit collection disagrees with the remote', async () => {
    const port = new URL(mock.serverUrl).port;
    const aliased = resolverFor(BOTH, NO_BRIDGE, { env: { ADO_HOST_ALIASES: `legacy-devops:8080=127.0.0.1:${port}` } });
    const scope = await aliased.resolve({ collection: 'LegacyCollection', gitRemoteUrl: `http://legacy-devops:8080/tfs/DemoCollection/DemoProject/_git/ado-server-mcp` });
    expect(scope.serverUrl).toBe(mock.serverUrl);
    expect(scope.collection).toBe('LegacyCollection');
    expect(scope.sources).toContain('collection:argument');
    expect(scope.sources).not.toContain('collection:gitRemoteUrl');
  });

  it('does not refuse writes when an explicit collection disagrees with an allowed aliased remote', async () => {
    const port = new URL(mock.serverUrl).port;
    const aliased = resolverFor(BOTH, NO_BRIDGE, { env: { ADO_HOST_ALIASES: `legacy-devops:8080=127.0.0.1:${port}` }, write: true });
    const scope = await aliased.resolve({ collection: 'LegacyCollection', gitRemoteUrl: `http://legacy-devops:8080/tfs/DemoCollection/DemoProject/_git/ado-server-mcp` });
    expect(scope.serverUrl).toBe(mock.serverUrl);
    expect(scope.sources).not.toContain('serverUrl:remote-ignored');
  });

  it('maps aliased internal remotes and ignores remotes on hosts that are not allowed', async () => {
    const port = new URL(mock.serverUrl).port;
    const aliased = resolverFor(DEMO_ONLY, NO_BRIDGE, { env: { ADO_HOST_ALIASES: `legacy-devops:8080=127.0.0.1:${port}` } });
    const scope = await aliased.resolve({ gitRemoteUrl: 'http://legacy-devops:8080/tfs/DemoCollection/DemoProject/_git/ado-server-mcp' }, { repository: true });
    expect(scope).toMatchObject({ serverUrl: `https://127.0.0.1:${port}/tfs`, collection: 'DemoCollection', repository: 'ado-server-mcp' });

    const other = await resolverFor(DEMO_ONLY).resolve({ gitRemoteUrl: 'http://otherhost:8080/tfs/DemoCollection/DemoProject/_git/ado-server-mcp' }, { repository: true });
    expect(other).toMatchObject({ serverUrl: mock.serverUrl, collection: 'DemoCollection', project: 'DemoProject', repository: 'ado-server-mcp' });
    expect(other.sources).toContain('serverUrl:remote-ignored');

    const sshHome = await resolverFor(DEMO_ONLY).resolve({ gitRemoteUrl: 'ssh://127.0.0.1:22/tfs/DemoCollection/DemoProject/_ssh/ado-server-mcp' }, { repository: true });
    expect(sshHome.sources).not.toContain('serverUrl:remote-ignored');
    const sshOther = await resolverFor(DEMO_ONLY).resolve({ gitRemoteUrl: 'ssh://othertfs:22/tfs/DemoCollection/DemoProject/_ssh/ado-server-mcp' }, { repository: true });
    expect(sshOther).toMatchObject({ serverUrl: mock.serverUrl, collection: 'DemoCollection', project: 'DemoProject' });
    expect(sshOther.sources).toContain('serverUrl:remote-ignored');
  });

  it('refuses writes through a remote on a host that is not allowed', async () => {
    const remote = 'http://otherhost:8080/tfs/DemoCollection/DemoProject/_git/ado-server-mcp';
    const error = await resolverFor(DEMO_ONLY, NO_BRIDGE, { write: true }).resolve({ gitRemoteUrl: remote }, { repository: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdoError);
    expect((error as AdoError).kind).toBe('bad_request');
    expect((error as AdoError).message).toMatch(/otherhost:8080.*ADO_HOST_ALIASES.*without gitRemoteUrl/);

    const writer = (headers: Record<string, string>) => resolverFor(headers, NO_BRIDGE, { write: true });
    const ssh = await writer(DEMO_ONLY).resolve({ gitRemoteUrl: 'ssh://othertfs:22/tfs/DemoCollection/DemoProject/_ssh/ado-server-mcp' }, { repository: true }).catch((e: unknown) => e);
    expect((ssh as AdoError).message).toMatch(/points at "othertfs", which is not this connection's server/);
    const fromHeader = await writer({ ...DEMO_ONLY, 'x-ado-git-remote': remote }).resolve({}, { repository: true }).catch((e: unknown) => e);
    expect((fromHeader as AdoError).message).toMatch(/X-ADO-Git-Remote header is then ignored/);
  });

  it('checks the remote against a server pinned by X-ADO-Server-URL', async () => {
    const env = { ADO_ALLOWED_HOSTS: '127.0.0.1,devops.example.com,ado25.example.com' };
    const pinned = { ...DEMO_ONLY, 'x-ado-server-url': 'https://ado25.example.com/tfs' };
    const write = { env, write: true };
    const http = await resolverFor(pinned, NO_BRIDGE, write)
      .resolve({ gitRemoteUrl: 'https://devops.example.com/tfs/DemoCollection/DemoProject/_git/ado-server-mcp' }, { repository: true })
      .catch((e: unknown) => e);
    expect((http as AdoError).kind).toBe('bad_request');
    expect((http as AdoError).message).toMatch(/points at "devops\.example\.com", but X-ADO-Server-URL pins this connection to ado25\.example\.com/);
    const ssh = await resolverFor(pinned, NO_BRIDGE, write)
      .resolve({ gitRemoteUrl: 'ssh://devops.example.com:22/tfs/DemoCollection/DemoProject/_ssh/ado-server-mcp' }, { repository: true })
      .catch((e: unknown) => e);
    expect((ssh as AdoError).message).toMatch(/pins this connection to ado25\.example\.com/);

    const home = await resolverFor({ ...DEMO_ONLY, 'x-ado-server-url': mock.serverUrl }, NO_BRIDGE, { env })
      .resolve({ gitRemoteUrl: `${mock.serverUrl}/DemoCollection/DemoProject/_git/ado-server-mcp` }, { repository: true });
    expect(home).toMatchObject({ serverUrl: mock.serverUrl, collection: 'DemoCollection', repository: 'ado-server-mcp' });
    expect(home.sources).not.toContain('serverUrl:remote-ignored');
  });

  it('uses the X-ADO-Git-Remote header only when the call names nothing', async () => {
    const headers = { ...BOTH, 'x-ado-git-remote': `${mock.serverUrl}/DemoCollection/DemoProject/_git/ado-server-mcp` };
    const fromHeader = await resolverFor(headers).resolve({}, { repository: true });
    expect(fromHeader).toMatchObject({ collection: 'DemoCollection', project: 'DemoProject', repository: 'ado-server-mcp' });
    expect(fromHeader.sources).toEqual(['collection:git-remote-header', 'project:git-remote-header', 'repository:git-remote-header']);

    const named = await resolverFor(headers).resolve({ repository: 'portal-portal' }, { repository: true });
    expect(named).toMatchObject({ collection: 'LegacyCollection', project: 'LEGACY PRODUCT', repository: 'portal-portal' });
  });

  it('uses X-ADO-Default-Repository when the call names no project or repository', async () => {
    const headers = { ...BOTH, 'x-ado-default-repository': 'demoservice-api' };
    const scope = await resolverFor(headers).resolve({}, { repository: true });
    expect(scope).toMatchObject({ collection: 'DemoCollection', project: 'DemoService', repository: 'demoservice-api' });
    expect(scope.sources).toEqual(['repository:default', 'collection:cross-collection-search', 'project:cross-collection-search']);

    const payload = await disambiguation(resolverFor(headers).resolve({ project: 'DemoProject' }, { repository: true }));
    expect(payload.missing).toBe('repository');
    expect((await disambiguation(resolverFor(headers).resolve({ collection: 'DemoCollection' }, { repository: true }))).missing).toBe('project');
  });

  it('remembers answers for the rest of the session', async () => {
    const memory = new SessionMemory();
    const { bridge, asked } = fakeBridge({ choose: () => 'LegacyCollection' });
    await resolverFor(BOTH, bridge, { memory }).resolve({ repository: 'shared-lib' }, { repository: true });
    const again = await resolverFor(BOTH, bridge, { memory }).resolve({ repository: 'shared-lib' }, { repository: true });
    expect(again).toMatchObject({ collection: 'LegacyCollection', project: 'DemoAutomation' });
    expect(again.sources).toContain('collection:remembered');
    expect(asked).toHaveLength(1);

    const explicit = await resolverFor(BOTH, bridge, { memory }).resolve({ collection: 'DemoCollection', repository: 'shared-lib' }, { repository: true });
    expect(explicit).toMatchObject({ collection: 'DemoCollection', project: 'DemoService' });
  });

  it('asks one question at a time when calls run in parallel', async () => {
    const memory = new SessionMemory();
    const { bridge, asked } = fakeBridge({ choose: () => 'DemoCollection' });
    const scopes = await Promise.all([1, 2, 3].map(() => resolverFor(BOTH, bridge, { memory }).resolve({})));
    expect(scopes.map((scope) => scope.collection)).toEqual(['DemoCollection', 'DemoCollection', 'DemoCollection']);
    expect(asked).toHaveLength(1);
  });

  it('lists workspace roots once per session until they change', async () => {
    const memory = new SessionMemory();
    const { bridge, rootCalls } = fakeBridge({ roots: ['demoservice-api'] });
    await resolverFor(BOTH, bridge, { memory }).resolve({}, { repository: true });
    await resolverFor(BOTH, bridge, { memory }).resolve({}, { repository: true });
    expect(rootCalls()).toBe(1);
    memory.invalidateRoots();
    await resolverFor(BOTH, bridge, { memory }).resolve({}, { repository: true });
    expect(rootCalls()).toBe(2);
  });

  it('names the collections it could not search', async () => {
    const headers = { authorization: 'Bearer pat-demo', 'x-ado-collections': 'DemoCollection,LegacyCollection' };
    const payload = await disambiguation(resolverFor(headers).resolve({ repository: 'portal-portal' }, { repository: true }));
    expect(payload.message).toMatch(/could not be searched: "LegacyCollection"/);
    expect(payload.message).not.toMatch(/None of your collections/);
  });

  it('asks for a typed answer when there is nothing to choose from', async () => {
    const { bridge, asked } = fakeBridge({ text: () => 'DemoCollection' });
    const scope = await resolverFor({ authorization: 'Bearer pat-demo' }, bridge).resolve({});
    expect(scope).toMatchObject({ collection: 'DemoCollection', sources: ['collection:asked'] });
    expect(asked).toEqual([{ field: 'collection', values: [] }]);
  });

  it('checks a typed collection before remembering it', async () => {
    const memory = new SessionMemory();
    const { bridge } = fakeBridge({ text: () => 'Dem0Collection' });
    const error = await resolverFor({ authorization: 'Bearer pat-demo' }, bridge, { memory }).resolve({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdoError);
    expect((error as AdoError).kind).toBe('not_found');
    expect(memory.recall('collection')).toBeUndefined();
  });

  it('records the last resolved scope for the audit log and result context', async () => {
    const resolver = resolverFor(DEMO_ONLY);
    await resolver.resolve({ collection: 'DemoCollection', project: 'DemoService' }, { project: true });
    expect(resolver.lastScope).toEqual({ collection: 'DemoCollection', project: 'DemoService', repository: undefined, sources: ['collection:argument', 'project:argument'] });
  });
});