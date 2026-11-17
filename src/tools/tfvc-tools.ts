import { z } from 'zod';
import type { QueryValue } from '../ado/ado-client.js';
import { DEFAULT_MAX_CHARS, HARD_MAX_CHARS, isProbablyBinary, truncate, windowText } from '../ado/bounded.js';
import { AdoError } from '../ado/errors.js';
import type { ContextResolver, ResolvedScope } from '../context/context-resolver.js';
import { collectionArg, collectionOf, gitRemoteUrlArg, identity, projectArg, requireValue, scopeShape, topArg } from './common.js';
import { defineTool, type AnyTool } from './registry.js';

interface ApiTfvcItem {
  path: string;
  isFolder?: boolean;
  version?: number;
  changeDate?: string;
  size?: number;
  content?: string;
}

interface ApiWorkItemRef {
  id: number;
  title?: string;
  workItemType?: string;
  state?: string;
}

interface ApiChangeset {
  changesetId: number;
  author?: unknown;
  checkedInBy?: unknown;
  createdDate?: string;
  comment?: string;
  commentTruncated?: boolean;
  workItems?: ApiWorkItemRef[];
}

interface ApiShelveset {
  id: string;
  name: string;
  owner?: unknown;
  createdDate?: string;
  comment?: string;
  workItems?: ApiWorkItemRef[];
}

interface ApiChange {
  item?: { path?: string };
  changeType?: string;
}

const RECURSION = { none: 'None', oneLevel: 'OneLevel', full: 'Full' } as const;

const pathArg = z.string().min(1).describe('TFVC server path, e.g. $/Legacy/Main. The project is taken from its first segment.');
const changesetArg = z.number().int().positive().optional().describe('Read as of this changeset (default: latest).');

function tfvcPath(path: string): string {
  if (!path.startsWith('$/')) throw new AdoError('bad_request', `"${path}" is not a TFVC path. TFVC paths start with $/, for example $/Legacy/Main.`);
  return path.length > 2 ? path.replace(/\/+$/, '') : path;
}

const projectFromPath = (path: string | undefined): string | undefined => (path ? /^\$\/([^/]+)/.exec(path)?.[1] : undefined);

const versionQuery = (changeset?: number): Record<string, QueryValue> =>
  changeset ? { 'versionDescriptor.version': changeset, 'versionDescriptor.versionType': 'changeset' } : {};

const person = (ref: unknown): string | undefined => {
  const who = identity(ref);
  return who?.displayName ?? who?.uniqueName;
};

// A $/Project/... path names the project, which lets the resolver find the collection; without a path the project must be resolved.
async function tfvcScope(
  resolver: ContextResolver,
  args: { collection?: string; project?: string; gitRemoteUrl?: string; path?: string },
): Promise<{ scope: ResolvedScope; path?: string }> {
  const path = args.path === undefined ? undefined : tfvcPath(args.path);
  const pathProject = projectFromPath(path);
  if (pathProject && args.project && pathProject.toLowerCase() !== args.project.toLowerCase()) {
    throw new AdoError('bad_request', `The explicit project "${args.project}" conflicts with the TFVC path project "${pathProject}".`);
  }
  const scope = await resolver.resolve({ ...args, project: pathProject ?? args.project }, { project: path === undefined });
  return { scope, path };
}

const workItemSummary = (item: ApiWorkItemRef) => ({ id: item.id, title: item.title, type: item.workItemType, state: item.state });
const changeSummary = (change: ApiChange) => ({ path: change.item?.path, changeType: change.changeType });

const changesetSummary = (changeset: ApiChangeset) => ({
  id: changeset.changesetId,
  author: person(changeset.author),
  createdDate: changeset.createdDate,
  comment: truncate(changeset.comment ?? '', 500),
  ...(changeset.commentTruncated ? { commentTruncated: true } : {}),
});

const listTfvcItems = defineTool({
  name: 'list_tfvc_items',
  toolset: 'tfvc',
  title: 'List TFVC items',
  description: 'Lists files and folders under a TFVC server path ($/Project/...), one level deep by default, optionally as of a changeset.',
  readOnly: true,
  input: {
    ...scopeShape,
    path: pathArg.optional().describe('Folder to list, e.g. $/Legacy/Main (default: $/{project}).'),
    recursion: z.enum(['none', 'oneLevel', 'full']).default('oneLevel'),
    changeset: changesetArg,
    top: topArg(200, 2000),
  },
  async handler(args, { client, resolver }) {
    const { scope, path } = await tfvcScope(resolver, args);
    const scopePath = path ?? `$/${requireValue(scope.project, 'project')}`;
    const data = await client.get<{ value?: ApiTfvcItem[] }>({
      ...collectionOf(scope),
      path: '_apis/tfvc/items',
      area: 'tfvc',
      query: { scopePath, recursionLevel: RECURSION[args.recursion], ...versionQuery(args.changeset) },
    });
    const items = (data.value ?? []).filter((item) => args.recursion === 'none' || item.path.toLowerCase() !== scopePath.toLowerCase());
    return {
      collection: scope.collection,
      project: scope.project,
      path: scopePath,
      count: Math.min(items.length, args.top),
      truncated: items.length > args.top,
      items: items.slice(0, args.top).map((item) => ({
        path: item.path,
        isFolder: item.isFolder === true,
        changeset: item.version,
        changeDate: item.changeDate,
        size: item.size,
      })),
    };
  },
});

const getTfvcFileContent = defineTool({
  name: 'get_tfvc_file_content',
  toolset: 'tfvc',
  title: 'Read TFVC file',
  description: `Reads a text file from TFVC with line windowing (startLine/endLine or tailLines; at most maxChars characters, default ${DEFAULT_MAX_CHARS}). Binary files are detected and not returned.`,
  readOnly: true,
  input: {
    ...scopeShape,
    path: pathArg.describe('File path, e.g. $/Legacy/Main/src/App.cs.'),
    changeset: changesetArg,
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    tailLines: z.number().int().min(1).optional(),
    maxChars: z.number().int().min(1).max(HARD_MAX_CHARS).default(DEFAULT_MAX_CHARS),
  },
  async handler(args, { client, resolver }) {
    const { scope, path } = await tfvcScope(resolver, args);
    const item = await client.get<ApiTfvcItem>({
      ...collectionOf(scope),
      path: '_apis/tfvc/items',
      area: 'tfvc',
      query: { path, includeContent: true, ...versionQuery(args.changeset) },
    });
    const content = item.content ?? '';
    const ids = { collection: scope.collection, path: item.path ?? path, changeset: item.version };
    if (isProbablyBinary(content)) return { ...ids, binary: true, message: 'Binary file: content is not returned.' };
    const window = windowText(content, { startLine: args.startLine, endLine: args.endLine, tailLines: args.tailLines, maxChars: args.maxChars });
    return {
      ...ids,
      ...window,
      ...(window.endLine < window.totalLines ? { hint: `More lines follow: call again with startLine=${window.endLine + 1}.` } : {}),
    };
  },
});

const listChangesets = defineTool({
  name: 'list_changesets',
  toolset: 'tfvc',
  title: 'List changesets',
  description: 'Lists TFVC changesets, newest first, that touch a server path (default: the whole project), filtered by author and date range.',
  readOnly: true,
  input: {
    ...scopeShape,
    path: pathArg.optional().describe('Only changesets under this path (default: $/{project}).'),
    author: z.string().min(1).optional().describe('DOMAIN\\user, email or display name.'),
    fromDate: z.string().min(1).optional().describe('ISO date; only changesets created on or after it.'),
    toDate: z.string().min(1).optional().describe('ISO date; only changesets created on or before it.'),
    top: topArg(25, 200),
  },
  async handler(args, { client, resolver }) {
    const { scope, path } = await tfvcScope(resolver, args);
    const itemPath = path ?? `$/${requireValue(scope.project, 'project')}`;
    const data = await client.get<{ value?: ApiChangeset[] }>({
      ...collectionOf(scope),
      path: '_apis/tfvc/changesets',
      area: 'tfvc',
      query: {
        'searchCriteria.itemPath': itemPath,
        'searchCriteria.author': args.author,
        'searchCriteria.fromDate': args.fromDate,
        'searchCriteria.toDate': args.toDate,
        $top: args.top + 1,
        $orderby: 'id desc',
      },
    });
    const all = data.value ?? [];
    const changesets = all.slice(0, args.top).map(changesetSummary);
    return { collection: scope.collection, path: itemPath, count: changesets.length, truncated: all.length > args.top, changesets };
  },
});

const getChangeset = defineTool({
  name: 'get_changeset',
  toolset: 'tfvc',
  title: 'Get changeset',
  description: 'Gets one TFVC changeset: author, date, full comment, linked work items and the changed paths.',
  readOnly: true,
  input: {
    collection: collectionArg,
    project: projectArg,
    gitRemoteUrl: gitRemoteUrlArg,
    id: z.number().int().positive().describe('Changeset number.'),
    top: topArg(100, 1000).describe('Maximum number of changed paths to return (default 100, max 1000).'),
  },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args);
    const [changeset, changes] = await Promise.all([
      client.get<ApiChangeset>({ ...collectionOf(scope), path: `_apis/tfvc/changesets/${args.id}`, area: 'tfvc', query: { includeWorkItems: true } }),
      client.get<{ value?: ApiChange[] }>({ ...collectionOf(scope), path: `_apis/tfvc/changesets/${args.id}/changes`, area: 'tfvc', query: { $top: args.top + 1 } }),
    ]);
    const all = changes.value ?? [];
    return {
      collection: scope.collection,
      ...changesetSummary(changeset),
      comment: truncate(changeset.comment ?? '', 4000),
      checkedInBy: person(changeset.checkedInBy),
      workItems: (changeset.workItems ?? []).map(workItemSummary),
      changes: all.slice(0, args.top).map(changeSummary),
      changesTruncated: all.length > args.top,
    };
  },
});

const listShelvesets = defineTool({
  name: 'list_shelvesets',
  toolset: 'tfvc',
  title: 'List shelvesets',
  description: 'Lists TFVC shelvesets in a collection, optionally only those owned by one person. Pass an id to get_shelveset for its changes.',
  readOnly: true,
  input: {
    collection: collectionArg,
    gitRemoteUrl: gitRemoteUrlArg,
    owner: z.string().min(1).optional().describe('DOMAIN\\user or email of the owner.'),
    top: topArg(25, 200),
  },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args);
    const data = await client.get<{ value?: ApiShelveset[] }>({
      ...collectionOf(scope),
      path: '_apis/tfvc/shelvesets',
      area: 'tfvc',
      query: { 'requestData.owner': args.owner, $top: args.top + 1 },
    });
    const all = data.value ?? [];
    return {
      collection: scope.collection,
      count: Math.min(all.length, args.top),
      truncated: all.length > args.top,
      shelvesets: all.slice(0, args.top).map((shelveset) => ({
        id: shelveset.id,
        name: shelveset.name,
        owner: person(shelveset.owner),
        createdDate: shelveset.createdDate,
        comment: truncate(shelveset.comment ?? '', 500),
      })),
    };
  },
});

const getShelveset = defineTool({
  name: 'get_shelveset',
  toolset: 'tfvc',
  title: 'Get shelveset',
  description: 'Gets one TFVC shelveset with its comment, linked work items and changed paths.',
  readOnly: true,
  input: {
    collection: collectionArg,
    gitRemoteUrl: gitRemoteUrlArg,
    shelvesetId: z.string().min(1).describe('Shelveset id as "name;owner", from list_shelvesets.'),
    top: topArg(100, 1000).describe('Maximum number of changed paths to return (default 100, max 1000).'),
  },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args);
    const [shelveset, changes] = await Promise.all([
      client.get<ApiShelveset>({
        ...collectionOf(scope),
        path: '_apis/tfvc/shelvesets',
        area: 'tfvc',
        query: { shelvesetId: args.shelvesetId, 'requestData.includeDetails': true, 'requestData.includeWorkItems': true },
      }),
      client.get<{ value?: ApiChange[] }>({
        ...collectionOf(scope),
        path: '_apis/tfvc/shelvesets/changes',
        area: 'tfvc',
        query: { shelvesetId: args.shelvesetId, $top: args.top + 1 },
      }),
    ]);
    const all = changes.value ?? [];
    return {
      collection: scope.collection,
      id: shelveset.id,
      name: shelveset.name,
      owner: person(shelveset.owner),
      createdDate: shelveset.createdDate,
      comment: truncate(shelveset.comment ?? '', 4000),
      workItems: (shelveset.workItems ?? []).map(workItemSummary),
      changes: all.slice(0, args.top).map(changeSummary),
      changesTruncated: all.length > args.top,
    };
  },
});

export const tfvcTools: AnyTool[] = [listTfvcItems, getTfvcFileContent, listChangesets, getChangeset, listShelvesets, getShelveset];
