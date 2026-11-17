import { z } from 'zod';
import { truncate } from '../ado/bounded.js';
import { requireValue, scopeShape, seg, targetOf, topArg } from './common.js';
import { defineTool, type AnyTool } from './registry.js';
import { DEFAULT_FIELDS, fetchWorkItems, idsFromWiql, type WiqlResult } from './workitem-tools.js';

interface QueryNode {
  id: string;
  name: string;
  path: string;
  isFolder?: boolean;
  isPublic?: boolean;
  queryType?: string;
  children?: QueryNode[];
}

interface ClassificationNode {
  id: number;
  name: string;
  path?: string;
  hasChildren?: boolean;
  attributes?: { startDate?: string; finishDate?: string };
  children?: ClassificationNode[];
}

export function classificationPath(path: string | undefined, fallback: string): string {
  if (!path) return fallback;
  const parts = path.split('\\').filter(Boolean);
  if (parts[1] === 'Area' || parts[1] === 'Iteration') parts.splice(1, 1);
  return parts.join('\\');
}

function flatten<T extends { children?: T[] }>(roots: T[], limit: number): { items: T[]; truncated: boolean } {
  const items: T[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) break;
    if (items.length === limit) return { items, truncated: true };
    items.push(node);
    for (const child of [...(node.children ?? [])].reverse()) stack.push(child);
  }
  return { items, truncated: false };
}

const depthArg = z.number().int().min(1).max(10).default(3).describe('How many levels below the root to return.');

const listQueries = defineTool({
  name: 'list_queries',
  toolset: 'queries',
  title: 'List saved queries',
  description: 'Lists saved work item queries and folders (My Queries and Shared Queries) as paths.',
  readOnly: true,
  input: { ...scopeShape, depth: z.number().int().min(0).max(2).default(2), top: topArg(200, 1000) },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const data = await client.get<{ value?: QueryNode[] }>({
      ...targetOf(scope),
      path: '_apis/wit/queries',
      area: 'wit',
      query: { $depth: args.depth, $expand: 'minimal' },
    });
    const { items, truncated } = flatten(data.value ?? [], args.top);
    return {
      project: scope.project,
      count: items.length,
      truncated,
      queries: items.map((node) => ({ id: node.id, path: node.path, isFolder: node.isFolder === true, isPublic: node.isPublic, queryType: node.queryType })),
    };
  },
});

const runSavedQuery = defineTool({
  name: 'run_saved_query',
  toolset: 'queries',
  title: 'Run saved query',
  description: 'Runs a saved query by id or path (e.g. "Shared Queries/Active Bugs") and returns the matching work items.',
  readOnly: true,
  input: {
    ...scopeShape,
    queryId: z.string().min(1).optional(),
    path: z.string().min(1).optional().describe('Query path, e.g. "Shared Queries/Active Bugs".'),
    top: topArg(50, 200),
    fields: z.array(z.string().min(1)).optional(),
    hydrate: z.boolean().default(true),
  },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    let queryId = args.queryId;
    if (!queryId) {
      const path = requireValue(args.path, 'queryId or path');
      const query = await client.get<QueryNode>({ ...targetOf(scope), path: `_apis/wit/queries/${path.split('/').map(seg).join('/')}`, area: 'wit' });
      queryId = query.id;
    }
    const data = await client.get<WiqlResult & { queryType?: string }>({
      ...targetOf(scope),
      path: `_apis/wit/wiql/${seg(queryId)}`,
      area: 'wit',
      query: { $top: args.top + 1 },
    });
    const { ids, truncated } = idsFromWiql(data, args.top);
    return {
      project: scope.project,
      queryId,
      queryType: data.queryType,
      count: ids.length,
      truncated,
      ids,
      ...(args.hydrate && ids.length > 0 ? { workItems: await fetchWorkItems(client, targetOf(scope), ids, args.fields ?? DEFAULT_FIELDS) } : {}),
    };
  },
});

const listWorkItemTypes = defineTool({
  name: 'list_work_item_types',
  toolset: 'queries',
  title: 'List work item types',
  description: 'Lists the work item types of a project (Bug, Task, User Story, ...).',
  readOnly: true,
  input: { ...scopeShape, top: topArg(100, 1000) },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const data = await client.get<{ value?: Array<{ name: string; referenceName?: string; description?: string; color?: string; isDisabled?: boolean }> }>({
      ...targetOf(scope),
      path: '_apis/wit/workitemtypes',
      area: 'wit',
    });
    const all = data.value ?? [];
    const types = all.slice(0, args.top).map((type) => ({
      name: type.name,
      referenceName: type.referenceName,
      description: type.description ? truncate(type.description, 200) : undefined,
      color: type.color,
      isDisabled: type.isDisabled === true,
    }));
    return { project: scope.project, count: types.length, truncated: all.length > types.length, types };
  },
});

const listWorkItemStates = defineTool({
  name: 'list_work_item_states',
  toolset: 'queries',
  title: 'List work item states',
  description: 'Lists the valid states of a work item type and their categories (Proposed, InProgress, Resolved, Completed, Removed).',
  readOnly: true,
  input: { ...scopeShape, type: z.string().min(1).describe('Work item type, e.g. "Bug".'), top: topArg(100, 1000) },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const data = await client.get<{ value?: Array<{ name: string; category?: string; color?: string }> }>({
      ...targetOf(scope),
      path: `_apis/wit/workitemtypes/${seg(args.type)}/states`,
      area: 'wit',
    });
    const all = data.value ?? [];
    const states = all.slice(0, args.top).map((state) => ({ name: state.name, category: state.category, color: state.color }));
    return { project: scope.project, type: args.type, count: states.length, truncated: all.length > states.length, states };
  },
});

function classificationTool(kind: 'Areas' | 'Iterations') {
  const iterations = kind === 'Iterations';
  return defineTool({
    name: iterations ? 'list_iterations' : 'list_areas',
    toolset: 'queries',
    title: iterations ? 'List iterations' : 'List area paths',
    description: iterations
      ? 'Lists iteration paths (sprints) of a project with start and finish dates, in the form used by System.IterationPath.'
      : 'Lists area paths of a project in the form used by System.AreaPath.',
    readOnly: true,
    input: { ...scopeShape, depth: depthArg, top: topArg(500, 2000) },
    async handler(args, { client, resolver }) {
      const scope = await resolver.resolve(args, { project: true });
      const root = await client.get<ClassificationNode>({
        ...targetOf(scope),
        path: `_apis/wit/classificationnodes/${kind}`,
        area: 'wit',
        query: { $depth: args.depth },
      });
      const { items, truncated } = flatten([root], args.top);
      const nodes = items.map((node) => ({
        id: node.id,
        name: node.name,
        path: classificationPath(node.path, node.name),
        ...(iterations ? { startDate: node.attributes?.startDate, finishDate: node.attributes?.finishDate } : { hasChildren: node.hasChildren === true }),
      }));
      return { project: scope.project, count: nodes.length, truncated, [iterations ? 'iterations' : 'areas']: nodes };
    },
  });
}

export const queryTools: AnyTool[] = [listQueries, runSavedQuery, listWorkItemTypes, listWorkItemStates, classificationTool('Areas'), classificationTool('Iterations')];
