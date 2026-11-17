import { z } from 'zod';
import { AdoError } from '../ado/errors.js';
import { collectionArg, gitRemoteUrlArg, projectArg, repositoryArg, seg, shortRef, targetOf } from './common.js';
import { whoAmI, type Me } from './identity.js';
import { defineTool, type AnyTool } from './registry.js';

const whoamiAndCollections = defineTool({
  name: 'whoami_and_collections',
  toolset: 'context',
  title: 'Who am I and which collections can I reach',
  description:
    'Checks authentication against each configured Azure DevOps collection. Reports the signed-in user, per-collection status (authenticated, unauthorized, unreachable, error) and the negotiated REST API versions (6.0 on Server 2020, 7.2 on 25H2). Never returns secrets.',
  readOnly: true,
  input: { collection: collectionArg },
  async handler(args, { ctx, client }) {
    let names = args.collection ? [args.collection] : ctx.collections;
    let hint: string | undefined;
    if (names.length === 0) {
      try {
        names = await client.listServerCollections();
      } catch {
        hint = 'No collections are configured and this PAT cannot list collections. Add X-ADO-Collections (ADO_COLLECTIONS for stdio) to your MCP client configuration.';
      }
    }
    const collections = await Promise.all(
      names.map(async (name) => {
        try {
          const target = { collection: name };
          const profile = await client.profile(target);
          const user: Me = await whoAmI(client, target);
          return {
            collection: name,
            status: 'authenticated',
            user,
            apiVersion: profile.serverVersion,
            versionSource: profile.source,
            apiVersions: profile.versions,
          };
        } catch (error) {
          const kind = error instanceof AdoError ? error.kind : 'server';
          const status = kind === 'auth' || kind === 'credential' ? 'unauthorized' : kind === 'network' || kind === 'tls' ? 'unreachable' : 'error';
          return { collection: name, status, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    const user = collections.flatMap((entry) => ('user' in entry ? [entry.user] : []))[0];
    return {
      serverUrl: ctx.serverUrl,
      user,
      defaultProject: ctx.defaultProject,
      readOnly: ctx.readOnly,
      collections,
      ...(hint ? { hint } : {}),
    };
  },
});

const resolveRepoContext = defineTool({
  name: 'resolve_repo_context',
  toolset: 'context',
  title: 'Resolve repository context',
  description:
    "Works out serverUrl, collection, project and repository from the terminal's git remote (`git remote get-url origin`), a repository or folder name, MCP workspace roots and the caller's collections. When several match, asks the user. Call it once at the start of a task and reuse the result in later tool calls.",
  readOnly: true,
  input: {
    gitRemoteUrl: gitRemoteUrlArg,
    repoOrFolderHint: z.string().min(1).optional().describe('Repository or workspace folder name, used when no git remote is available.'),
    collection: collectionArg,
    project: projectArg,
    repository: repositoryArg,
  },
  async handler(args, { client, resolver }) {
    const fromHint = !args.repository && !args.gitRemoteUrl && args.repoOrFolderHint !== undefined;
    const scope = await resolver.resolve(
      {
        collection: args.collection,
        project: args.project,
        repository: args.repository ?? (fromHint ? args.repoOrFolderHint : undefined),
        gitRemoteUrl: args.gitRemoteUrl,
      },
      { repository: true },
    );
    const sources = scope.sources.map((source) => (fromHint && source === 'repository:argument' ? 'repository:hint' : source));

    let repo: { id: string; name: string; defaultBranch?: string; remoteUrl?: string; sshUrl?: string } | undefined;
    let warning: string | undefined;
    try {
      repo = await client.get({ ...targetOf(scope), path: `_apis/git/repositories/${seg(scope.repository ?? '')}`, area: 'git' });
    } catch (error) {
      if (error instanceof AdoError && (error.kind === 'not_found' || error.kind === 'permission')) warning = error.message;
      else throw error;
    }

    const explicit = sources.includes('collection:gitRemoteUrl') || sources.includes('collection:argument');
    return {
      serverUrl: scope.serverUrl,
      collection: scope.collection,
      project: scope.project,
      repository: repo?.name ?? scope.repository,
      repositoryId: repo?.id,
      defaultBranch: shortRef(repo?.defaultBranch),
      remoteUrl: repo?.remoteUrl,
      sshUrl: repo?.sshUrl,
      verified: repo !== undefined,
      confidence: repo ? (explicit ? 'high' : 'medium') : 'low',
      sources,
      ...(warning ? { warning } : {}),
    };
  },
});

export const contextTools: AnyTool[] = [whoamiAndCollections, resolveRepoContext];