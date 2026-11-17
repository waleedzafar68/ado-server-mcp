import { z } from 'zod';
import type { AdoClient } from '../ado/ado-client.js';
import { truncate } from '../ado/bounded.js';
import { AdoError } from '../ado/errors.js';
import type { ResolvedScope } from '../context/context-resolver.js';
import { collectionArg, collectionOf, gitRemoteUrlArg, identity, requireValue, scopeShape, seg, topArg } from './common.js';
import { defineTool, type AnyTool } from './registry.js';

interface ApiProject {
  id: string;
  name: string;
  description?: string;
  state?: string;
  visibility?: string;
  lastUpdateTime?: string;
}

const projectSummary = (project: ApiProject) => ({
  id: project.id,
  name: project.name,
  description: project.description ? truncate(project.description, 300) : undefined,
  state: project.state,
  visibility: project.visibility,
  lastUpdateTime: project.lastUpdateTime,
});

async function listProjectsIn(client: AdoClient, serverUrl: string, collection: string, top: number) {
  const { items, truncated } = await client.getAllPages<ApiProject>(
    { serverUrl, collection, path: '_apis/projects', area: 'core', query: { $top: Math.min(top, 500) } },
    5,
  );
  return {
    collection,
    count: Math.min(items.length, top),
    truncated: truncated || items.length > top,
    projects: items.slice(0, top).map(projectSummary),
  };
}

export async function resolveTeam(client: AdoClient, scope: ResolvedScope, team?: string): Promise<string> {
  if (team) return team;
  const project = requireValue(scope.project, 'project');
  const details = await client.get<{ defaultTeam?: { name?: string } }>({
    ...collectionOf(scope),
    path: `_apis/projects/${seg(project)}`,
    area: 'core',
  });
  const name = details.defaultTeam?.name;
  if (!name) throw new AdoError('not_found', `Project ${project} has no default team. Pass team explicitly.`);
  return name;
}

const listProjects = defineTool({
  name: 'list_projects',
  toolset: 'projects',
  title: 'List projects',
  description: 'Lists the projects you can see in a collection, or in every configured collection when allCollections=true.',
  readOnly: true,
  input: {
    collection: collectionArg,
    gitRemoteUrl: gitRemoteUrlArg,
    allCollections: z.boolean().default(false).describe('List projects in every collection you configured.'),
    top: topArg(100, 500),
  },
  async handler(args, { ctx, client, resolver }) {
    if (args.allCollections) {
      const collections = await resolver.availableCollections(ctx.serverUrl);
      return {
        collections: await Promise.all(
          collections.map(async (collection) => {
            try {
              return await listProjectsIn(client, ctx.serverUrl, collection, args.top);
            } catch (error) {
              if (error instanceof AdoError) return { collection, error: `[${error.kind}] ${error.message}` };
              throw error;
            }
          }),
        ),
      };
    }
    const scope = await resolver.resolve({ collection: args.collection, gitRemoteUrl: args.gitRemoteUrl });
    return listProjectsIn(client, scope.serverUrl, scope.collection, args.top);
  },
});

const getProject = defineTool({
  name: 'get_project',
  toolset: 'projects',
  title: 'Get project',
  description: 'Returns project details: description, visibility, source control type (Git/TFVC), process template and default team.',
  readOnly: true,
  input: scopeShape,
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const project = await client.get<
      ApiProject & {
        defaultTeam?: { id?: string; name?: string };
        capabilities?: { versioncontrol?: { sourceControlType?: string }; processTemplate?: { templateName?: string } };
      }
    >({
      ...collectionOf(scope),
      path: `_apis/projects/${seg(requireValue(scope.project, 'project'))}`,
      area: 'core',
      query: { includeCapabilities: true },
    });
    return {
      collection: scope.collection,
      ...projectSummary(project),
      defaultTeam: project.defaultTeam ? { id: project.defaultTeam.id, name: project.defaultTeam.name } : undefined,
      sourceControl: project.capabilities?.versioncontrol?.sourceControlType,
      processTemplate: project.capabilities?.processTemplate?.templateName,
    };
  },
});

const listTeams = defineTool({
  name: 'list_teams',
  toolset: 'projects',
  title: 'List teams',
  description: 'Lists teams in a project. With mine=true, only teams you belong to.',
  readOnly: true,
  input: { ...scopeShape, mine: z.boolean().default(false), top: topArg(100, 500) },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const data = await client.get<{ value?: Array<{ id: string; name: string; description?: string }> }>({
      ...collectionOf(scope),
      path: `_apis/projects/${seg(requireValue(scope.project, 'project'))}/teams`,
      area: 'core',
      query: { $top: args.top + 1, $mine: args.mine || undefined },
    });
    const all = data.value ?? [];
    const teams = all.slice(0, args.top);
    return {
      collection: scope.collection,
      project: scope.project,
      count: teams.length,
      truncated: all.length > args.top,
      teams: teams.map((team) => ({ id: team.id, name: team.name, description: team.description ? truncate(team.description, 200) : undefined })),
    };
  },
});

const listTeamMembers = defineTool({
  name: 'list_team_members',
  toolset: 'projects',
  title: 'List team members',
  description: "Lists members of a team (the project's default team when team is omitted).",
  readOnly: true,
  input: { ...scopeShape, team: z.string().min(1).optional().describe("Team name. Defaults to the project's default team."), top: topArg(100, 500) },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const team = await resolveTeam(client, scope, args.team);
    const data = await client.get<{ value?: Array<{ identity?: unknown; isTeamAdmin?: boolean }> }>({
      ...collectionOf(scope),
      path: `_apis/projects/${seg(requireValue(scope.project, 'project'))}/teams/${seg(team)}/members`,
      area: 'core',
      query: { $top: args.top + 1 },
    });
    const all = data.value ?? [];
    return {
      team,
      count: Math.min(all.length, args.top),
      truncated: all.length > args.top,
      members: all.slice(0, args.top).map((member) => ({ ...identity(member.identity), isTeamAdmin: member.isTeamAdmin === true })),
    };
  },
});

export const projectTools: AnyTool[] = [listProjects, getProject, listTeams, listTeamMembers];
