import { z } from 'zod';
import type { AdoClient, Target } from '../ado/ado-client.js';
import { AdoError } from '../ado/errors.js';
import type { ContextResolver, ResolvedScope } from '../context/context-resolver.js';
import { collectionOf, preview, scopeShape, seg, targetOf, topArg } from './common.js';
import { resolveTeam } from './project-tools.js';
import { defineTool, type AnyTool } from './registry.js';
import { DEFAULT_FIELDS, fetchWorkItems, formatField } from './workitem-tools.js';

interface ApiIteration {
  id: string;
  name: string;
  path?: string;
  attributes?: { startDate?: string; finishDate?: string; timeFrame?: string };
}

interface ApiCapacity {
  teamMember?: unknown;
  activities?: Array<{ name?: string; capacityPerDay?: number }>;
  daysOff?: Array<{ start?: string; end?: string }>;
}

const teamArg = z.string().min(1).optional().describe("Team name. Defaults to the project's default team.");
const teamShape = { ...scopeShape, team: teamArg };

const iterationSummary = (iteration: ApiIteration) => ({
  id: iteration.id,
  name: iteration.name,
  path: iteration.path,
  startDate: iteration.attributes?.startDate,
  finishDate: iteration.attributes?.finishDate,
  timeFrame: iteration.attributes?.timeFrame,
});

async function teamScope(
  client: AdoClient,
  resolver: ContextResolver,
  args: { collection?: string; project?: string; gitRemoteUrl?: string; team?: string },
): Promise<{ scope: ResolvedScope; team: string; target: Target }> {
  const scope = await resolver.resolve(args, { project: true });
  const team = await resolveTeam(client, scope, args.team);
  return { scope, team, target: { ...targetOf(scope), team } };
}

async function currentIteration(client: AdoClient, target: Target): Promise<ApiIteration | undefined> {
  const data = await client.get<{ value?: ApiIteration[] }>({ ...target, path: '_apis/work/teamsettings/iterations', area: 'work', query: { $timeframe: 'current' } });
  return data.value?.[0];
}

async function iterationIdOrCurrent(client: AdoClient, target: Target, team: string, iterationId?: string): Promise<string> {
  if (iterationId) return iterationId;
  const current = await currentIteration(client, target);
  if (!current) throw new AdoError('not_found', `Team "${team}" has no current sprint. Pass iterationId (see list_sprints).`);
  return current.id;
}

const listBoards = defineTool({
  name: 'list_boards', toolset: 'boards', title: 'List boards',
  description: 'Lists the Kanban boards of a team.', readOnly: true,
  input: { ...teamShape, top: topArg(100, 1000) },
  async handler(args, { client, resolver }) {
    const { scope, team, target } = await teamScope(client, resolver, args);
    const data = await client.get<{ value?: Array<{ id: string; name: string }> }>({ ...target, path: '_apis/work/boards', area: 'work' });
    const all = data.value ?? [];
    const boards = all.slice(0, args.top).map((board) => ({ id: board.id, name: board.name }));
    return { project: scope.project, team, count: boards.length, truncated: all.length > boards.length, boards };
  },
});

const getBoardColumns = defineTool({
  name: 'get_board_columns', toolset: 'boards', title: 'Get board columns',
  description: 'Lists the columns of a board with WIP limits and the work item states mapped to each column.', readOnly: true,
  input: { ...teamShape, board: z.string().min(1).describe('Board name (e.g. "Stories", "Backlog items") or id.'), top: topArg(100, 1000) },
  async handler(args, { client, resolver }) {
    const { team, target } = await teamScope(client, resolver, args);
    const data = await client.get<{
      value?: Array<{ id: string; name: string; columnType?: string; itemLimit?: number; isSplit?: boolean; stateMappings?: Record<string, string> }>;
    }>({ ...target, path: `_apis/work/boards/${seg(args.board)}/columns`, area: 'work' });
    const all = data.value ?? [];
    const columns = all.slice(0, args.top).map((column) => ({
      id: column.id,
      name: column.name,
      columnType: column.columnType,
      itemLimit: column.itemLimit,
      isSplit: column.isSplit,
      stateMappings: column.stateMappings,
    }));
    return { team, board: args.board, count: columns.length, truncated: all.length > columns.length, columns };
  },
});

const listSprints = defineTool({
  name: 'list_sprints', toolset: 'boards', title: 'List sprints',
  description: 'Lists the sprints (iterations) a team subscribes to, optionally only past, current or future ones.', readOnly: true,
  input: { ...teamShape, timeFrame: z.enum(['past', 'current', 'future']).optional(), top: topArg(50, 500) },
  async handler(args, { client, resolver }) {
    const { team, target } = await teamScope(client, resolver, args);
    const data = await client.get<{ value?: ApiIteration[] }>({ ...target, path: '_apis/work/teamsettings/iterations', area: 'work' });
    const all = (data.value ?? [])
      .filter((iteration) => !args.timeFrame || iteration.attributes?.timeFrame?.toLowerCase() === args.timeFrame)
      .map(iterationSummary);
    const sprints = all.slice(0, args.top);
    return { team, count: sprints.length, truncated: all.length > sprints.length, sprints };
  },
});

const getCurrentSprint = defineTool({
  name: 'get_current_sprint', toolset: 'boards', title: 'Get current sprint',
  description: "Returns the team's current sprint (@CurrentIteration), or null when none is active.", readOnly: true,
  input: teamShape,
  async handler(args, { client, resolver }) {
    const { team, target } = await teamScope(client, resolver, args);
    const current = await currentIteration(client, target);
    return { team, sprint: current ? iterationSummary(current) : null };
  },
});

const getSprintWorkItems = defineTool({
  name: 'get_sprint_work_items', toolset: 'boards', title: 'Get sprint work items',
  description: 'Lists the work items planned in a sprint (the current sprint by default), including child tasks, with their fields.', readOnly: true,
  input: {
    ...teamShape,
    iterationId: z.string().min(1).optional().describe('Iteration id from list_sprints. Defaults to the current sprint.'),
    hydrate: z.boolean().default(true),
    fields: z.array(z.string().min(1)).optional(),
    top: topArg(100, 500),
  },
  async handler(args, { client, resolver }) {
    const { scope, team, target } = await teamScope(client, resolver, args);
    const iterationId = await iterationIdOrCurrent(client, target, team, args.iterationId);
    const data = await client.get<{ workItemRelations?: Array<{ target?: { id: number } | null }> }>({
      ...target,
      path: `_apis/work/teamsettings/iterations/${seg(iterationId)}/workitems`,
      area: 'work',
      apiVersion: preview(await client.version(target, 'work')),
    });
    const all = [...new Set((data.workItemRelations ?? []).flatMap((relation) => (relation.target ? [relation.target.id] : [])))];
    const ids = all.slice(0, args.top);
    return {
      team,
      iterationId,
      count: ids.length,
      truncated: all.length > ids.length,
      ids,
      ...(args.hydrate && ids.length > 0 ? { workItems: await fetchWorkItems(client, collectionOf(scope), ids, args.fields ?? DEFAULT_FIELDS) } : {}),
    };
  },
});

const getSprintCapacity = defineTool({
  name: 'get_sprint_capacity', toolset: 'boards', title: 'Get sprint capacity',
  description: 'Returns capacity per day, activities and days off for each team member in a sprint (the current sprint by default), plus team days off.', readOnly: true,
  input: { ...teamShape, iterationId: z.string().min(1).optional(), top: topArg(100, 1000) },
  async handler(args, { client, resolver }) {
    const { team, target } = await teamScope(client, resolver, args);
    const iterationId = await iterationIdOrCurrent(client, target, team, args.iterationId);
    const base = `_apis/work/teamsettings/iterations/${seg(iterationId)}`;
    const [capacity, daysOff] = await Promise.all([
      client.get<{ value?: ApiCapacity[]; teamMembers?: ApiCapacity[] }>({ ...target, path: `${base}/capacities`, area: 'work' }),
      client.get<{ daysOff?: Array<{ start?: string; end?: string }> }>({ ...target, path: `${base}/teamdaysoff`, area: 'work' }),
    ]);
    const allMembers = (capacity.teamMembers ?? capacity.value ?? []).map((entry) => {
      const activities = (entry.activities ?? []).map((activity) => ({ name: activity.name, capacityPerDay: activity.capacityPerDay ?? 0 }));
      return {
        member: formatField('teamMember', entry.teamMember, true),
        capacityPerDay: activities.reduce((sum, activity) => sum + activity.capacityPerDay, 0),
        activities,
        daysOff: (entry.daysOff ?? []).map((day) => ({ start: day.start, end: day.end })),
      };
    });
    const members = allMembers.slice(0, args.top);
    return {
      team,
      iterationId,
      totalCapacityPerDay: allMembers.reduce((sum, member) => sum + member.capacityPerDay, 0),
      totalMemberCount: allMembers.length,
      count: members.length,
      truncated: allMembers.length > members.length,
      teamDaysOff: (daysOff.daysOff ?? []).map((day) => ({ start: day.start, end: day.end })),
      members,
    };
  },
});

export const boardTools: AnyTool[] = [listBoards, getBoardColumns, listSprints, getCurrentSprint, getSprintWorkItems, getSprintCapacity];
