import { z } from 'zod';
import type { AdoClient, Target } from '../ado/ado-client.js';
import { htmlToText, truncate } from '../ado/bounded.js';
import { AdoError } from '../ado/errors.js';
import type { ResolvedScope } from '../context/context-resolver.js';
import { collectionArg, collectionOf, gitRemoteUrlArg, projectArg, scopeShape, seg, targetOf, topArg } from './common.js';
import { resolveTeam } from './project-tools.js';
import { defineTool, type AnyTool } from './registry.js';

export const DEFAULT_FIELDS = [
  'System.Id', 'System.WorkItemType', 'System.Title', 'System.State', 'System.AssignedTo',
  'System.AreaPath', 'System.IterationPath', 'System.ChangedDate',
];

const HTML_FIELDS = new Set([
  'System.Description', 'System.History', 'Microsoft.VSTS.TCM.ReproSteps',
  'Microsoft.VSTS.Common.AcceptanceCriteria', 'Microsoft.VSTS.TCM.SystemInfo',
]);
const MAX_FIELD_CHARS = 4000;
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const TEAM_MACROS = /@CurrentIteration\b|@TeamAreas\b/i;
const NOISY_FIELDS = new Set(['System.Rev', 'System.ChangedDate', 'System.RevisedDate', 'System.AuthorizedDate', 'System.Watermark', 'System.AuthorizedAs', 'System.PersonId']);
const LINK_TYPES: Record<string, string> = {
  parent: 'System.LinkTypes.Hierarchy-Reverse', child: 'System.LinkTypes.Hierarchy-Forward', related: 'System.LinkTypes.Related',
  predecessor: 'System.LinkTypes.Dependency-Reverse', successor: 'System.LinkTypes.Dependency-Forward',
};

export interface ApiWorkItem {
  id: number;
  rev?: number;
  fields?: Record<string, unknown>;
  relations?: Array<{ rel: string; url: string; attributes?: Record<string, unknown> }>;
  _links?: { html?: { href?: string } };
}

export interface WiqlResult {
  workItems?: Array<{ id: number }>;
  workItemRelations?: Array<{ target?: { id: number } | null }>;
}

type PatchOp = { op: 'add' | 'test'; path: string; value: unknown };

export function formatField(name: string, value: unknown, asText: boolean): unknown {
  if (value && typeof value === 'object' && 'displayName' in value) {
    const person = value as { displayName?: string; uniqueName?: string };
    return person.uniqueName ? `${person.displayName} <${person.uniqueName}>` : person.displayName;
  }
  if (typeof value === 'string') return truncate(asText && HTML_FIELDS.has(name) ? htmlToText(value) : value, MAX_FIELD_CHARS);
  return value;
}

export function simplifyWorkItem(item: ApiWorkItem, options: { asText?: boolean; fields?: string[] } = {}) {
  const asText = options.asText ?? true;
  const wanted = options.fields?.map((field) => field.toLowerCase());
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(item.fields ?? {})) {
    if (wanted && !wanted.includes(name.toLowerCase())) continue;
    fields[name] = formatField(name, value, asText);
  }
  return {
    id: item.id, rev: item.rev, fields,
    ...(item.relations ? { relations: item.relations.map((relation) => ({ rel: relation.rel, url: relation.url, name: relation.attributes?.name, comment: relation.attributes?.comment })) } : {}),
    ...(item._links?.html?.href ? { url: item._links.html.href } : {}),
  };
}

export async function fetchWorkItems(client: AdoClient, target: Target, ids: number[], fields?: string[]) {
  const items: ApiWorkItem[] = [];
  for (let index = 0; index < ids.length; index += 200) {
    const data = await client.get<{ value?: Array<ApiWorkItem | null> }>({
      serverUrl: target.serverUrl, collection: target.collection, path: '_apis/wit/workitems', area: 'wit',
      query: { ids: ids.slice(index, index + 200).join(','), fields: fields?.join(','), errorPolicy: 'Omit' },
    });
    for (const item of data.value ?? []) if (item) items.push(item);
  }
  return items.map((item) => simplifyWorkItem(item));
}

export function idsFromWiql(data: WiqlResult, top: number): { ids: number[]; truncated: boolean } {
  const refs = data.workItems ?? (data.workItemRelations ?? []).flatMap((relation) => (relation.target ? [relation.target] : []));
  const ids = [...new Set(refs.map((ref) => ref.id))];
  return { ids: ids.slice(0, top), truncated: ids.length > top };
}

export async function runWiql(client: AdoClient, target: Target, wiql: string, top: number) {
  const data = await client.post<WiqlResult>({ ...target, path: '_apis/wit/wiql', area: 'wit', query: { $top: top + 1 }, body: { query: wiql } });
  return idsFromWiql(data, top);
}

function addField(ops: PatchOp[], name: string, value: unknown): void {
  if (value !== undefined) ops.push({ op: 'add', path: `/fields/${name}`, value });
}

function workItemUrl(client: AdoClient, scope: ResolvedScope, id: number): string {
  return `${client.collectionUrl(collectionOf(scope))}/_apis/wit/workItems/${id}`;
}

async function workItemProject(client: AdoClient, scope: ResolvedScope, id: number, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const item = await client.get<ApiWorkItem>({ ...collectionOf(scope), path: `_apis/wit/workitems/${id}`, area: 'wit', query: { fields: 'System.TeamProject' } });
  const project = item.fields?.['System.TeamProject'];
  if (typeof project !== 'string') throw new AdoError('not_found', `Could not determine the project of work item ${id}. Pass project explicitly.`);
  return project;
}

const itemScope = { collection: collectionArg, gitRemoteUrl: gitRemoteUrlArg };
const idArg = z.number().int().positive().describe('Work item id.');
const fieldsArg = z.array(z.string().min(1)).optional().describe(`Field reference names to return (default: ${DEFAULT_FIELDS.join(', ')}).`);
const extraFieldsArg = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Extra fields by reference name, e.g. {"Microsoft.VSTS.Common.Priority": 2}.');
const jsonPatch = 'application/json-patch+json';

const queryWorkItems = defineTool({
  name: 'query_work_items', toolset: 'workitems', title: 'Query work items (WIQL)',
  description: 'Runs a WIQL query and, by default, returns the fields of the matching work items in the same call. Queries that use @project run in the resolved project; queries that use @CurrentIteration or @TeamAreas run for a team (default: the project default team).',
  readOnly: true,
  input: { ...scopeShape, team: z.string().min(1).optional().describe('Team used for @CurrentIteration and @TeamAreas (default: the project default team).'), wiql: z.string().min(1).describe("WIQL, e.g. SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] = 'Active'"), top: topArg(50, 200), fields: fieldsArg, hydrate: z.boolean().default(true).describe('Return work item fields, not only ids.') },
  async handler(args, { client, resolver }) {
    const needsTeam = TEAM_MACROS.test(args.wiql);
    const needsProject = needsTeam || /@project\b/i.test(args.wiql);
    const scope = await resolver.resolve(args, { project: needsProject });
    const target = needsProject ? targetOf(scope) : collectionOf(scope);
    const team = needsTeam ? await resolveTeam(client, scope, args.team) : undefined;
    const { ids, truncated } = await runWiql(client, team ? { ...target, team } : target, args.wiql, args.top);
    return { collection: scope.collection, project: needsProject ? scope.project : undefined, ...(team ? { team } : {}), count: ids.length, truncated, ids,
      ...(args.hydrate && ids.length > 0 ? { workItems: await fetchWorkItems(client, target, ids, args.fields ?? DEFAULT_FIELDS) } : {}) };
  },
});

const getWorkItem = defineTool({
  name: 'get_work_item', toolset: 'workitems', title: 'Get work item', description: 'Gets one work item by id. Pass fields to limit output, includeRelations for links and attachments; HTML fields are converted to text by default.', readOnly: true,
  input: { ...itemScope, id: idArg, fields: fieldsArg, includeRelations: z.boolean().default(false), asText: z.boolean().default(true).describe('Convert HTML fields (Description, Repro Steps, ...) to plain text.') },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args);
    const item = await client.get<ApiWorkItem>({ ...collectionOf(scope), path: `_apis/wit/workitems/${args.id}`, area: 'wit', query: args.includeRelations ? { $expand: 'relations' } : { fields: args.fields?.join(',') } });
    return simplifyWorkItem(item, { asText: args.asText, fields: args.fields });
  },
});

const getWorkItems = defineTool({
  name: 'get_work_items', toolset: 'workitems', title: 'Get work items (batch)', description: 'Gets up to 200 work items by id in one call, with an optional lower result limit.', readOnly: true,
  input: { ...itemScope, ids: z.array(z.number().int().positive()).min(1).max(200), top: topArg(200, 200), fields: fieldsArg },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args);
    const ids = args.ids.slice(0, args.top);
    const workItems = await fetchWorkItems(client, collectionOf(scope), ids, args.fields ?? DEFAULT_FIELDS);
    return { collection: scope.collection, count: workItems.length, truncated: args.ids.length > args.top, workItems };
  },
});

const getWorkItemRevisions = defineTool({
  name: 'get_work_item_revisions', toolset: 'workitems', title: 'Get work item history', description: 'Returns revisions of a work item: who changed it, when, the state and title, and which fields changed.', readOnly: true,
  input: { ...itemScope, id: idArg, top: topArg(20, 200), skip: z.number().int().min(0).default(0) },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args);
    const contextCount = args.skip > 0 ? 1 : 0;
    const pageSkip = Math.max(0, args.skip - contextCount);
    const data = await client.get<{ value?: ApiWorkItem[]; count?: number; totalCount?: number }>({
      ...collectionOf(scope),
      path: `_apis/wit/workitems/${args.id}/revisions`,
      area: 'wit',
      query: { $top: args.top + 1 + contextCount, $skip: pageSkip },
    });
    const all = data.value ?? [];
    let previous: Record<string, unknown> = contextCount > 0 ? all[0]?.fields ?? {} : {};
    const page = all.slice(contextCount, contextCount + args.top);
    const revisions = page.map((revision) => {
      const fields = revision.fields ?? {};
      const changedFields = Object.keys(fields).filter((name) => !NOISY_FIELDS.has(name) && JSON.stringify(fields[name]) !== JSON.stringify(previous[name]));
      previous = fields;
      return { rev: revision.rev, changedDate: fields['System.ChangedDate'], changedBy: formatField('System.ChangedBy', fields['System.ChangedBy'], true), state: fields['System.State'], title: fields['System.Title'], changedFields: changedFields.slice(0, 25) };
    });
    const truncated = all.length > contextCount + revisions.length || (data.totalCount !== undefined && data.totalCount > args.skip + revisions.length);
    return { workItemId: args.id, count: revisions.length, truncated, revisions };
  },
});

const createWorkItem = defineTool({
  name: 'create_work_item', toolset: 'workitems', title: 'Create work item', description: 'Creates a work item (Task, Bug, User Story, ...) in a project, optionally under a parent work item.', readOnly: false,
  input: { ...scopeShape, type: z.string().min(1).describe('Work item type, e.g. "Task", "Bug", "User Story".'), title: z.string().min(1), description: z.string().optional().describe('HTML or plain text.'), assignedTo: z.string().optional().describe('Display name, email or DOMAIN\\user.'), state: z.string().optional(), areaPath: z.string().optional(), iterationPath: z.string().optional(), parentId: z.number().int().positive().optional(), additionalFields: extraFieldsArg },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const ops: PatchOp[] = [];
    addField(ops, 'System.Title', args.title); addField(ops, 'System.Description', args.description); addField(ops, 'System.AssignedTo', args.assignedTo); addField(ops, 'System.State', args.state); addField(ops, 'System.AreaPath', args.areaPath); addField(ops, 'System.IterationPath', args.iterationPath);
    for (const [name, value] of Object.entries(args.additionalFields ?? {})) addField(ops, name, value);
    if (args.parentId) ops.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: workItemUrl(client, scope, args.parentId) } });
    const created = await client.post<ApiWorkItem>({ ...targetOf(scope), path: `_apis/wit/workitems/$${seg(args.type)}`, area: 'wit', body: ops, contentType: jsonPatch });
    return { created: true, ...simplifyWorkItem(created, { fields: DEFAULT_FIELDS }) };
  },
});

const updateWorkItem = defineTool({
  name: 'update_work_item', toolset: 'workitems', title: 'Update work item', description: 'Updates title, state, assignee or other fields and can add a History comment. Pass expectedRevision to fail with [conflict] if someone changed the item meanwhile.', readOnly: false,
  input: { ...itemScope, id: idArg, title: z.string().min(1).optional(), state: z.string().min(1).optional(), assignedTo: z.string().optional(), comment: z.string().min(1).optional().describe('Added to the work item History (discussion).'), additionalFields: extraFieldsArg, expectedRevision: z.number().int().positive().optional() },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args);
    const ops: PatchOp[] = [];
    if (args.expectedRevision !== undefined) ops.push({ op: 'test', path: '/rev', value: args.expectedRevision });
    addField(ops, 'System.Title', args.title); addField(ops, 'System.State', args.state); addField(ops, 'System.AssignedTo', args.assignedTo); addField(ops, 'System.History', args.comment);
    for (const [name, value] of Object.entries(args.additionalFields ?? {})) addField(ops, name, value);
    if (ops.every((op) => op.op === 'test')) throw new AdoError('bad_request', 'Nothing to update: pass title, state, assignedTo, comment or additionalFields.');
    const updated = await client.patch<ApiWorkItem>({ ...collectionOf(scope), path: `_apis/wit/workitems/${args.id}`, area: 'wit', body: ops, contentType: jsonPatch });
    return { updated: true, ...simplifyWorkItem(updated, { fields: DEFAULT_FIELDS }) };
  },
});

const listWorkItemComments = defineTool({
  name: 'list_work_item_comments', toolset: 'workitems', title: 'List work item comments', description: 'Lists discussion comments of a work item as plain text, newest first.', readOnly: true,
  input: { ...itemScope, project: projectArg, id: idArg, top: topArg(20, 200) },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve({ collection: args.collection, gitRemoteUrl: args.gitRemoteUrl });
    const project = await workItemProject(client, scope, args.id, args.project);
    const data = await client.get<{ totalCount?: number; comments?: Array<{ id: number; text?: string; createdBy?: unknown; createdDate?: string; modifiedDate?: string }> }>({
      ...collectionOf(scope), project, path: `_apis/wit/workItems/${args.id}/comments`, area: 'witComments', query: { $top: args.top + 1 },
    });
    const all = data.comments ?? [];
    const comments = all.slice(0, args.top);
    const totalCount = data.totalCount ?? all.length;
    return { workItemId: args.id, project, totalCount, count: comments.length, truncated: all.length > args.top || totalCount > comments.length,
      comments: comments.map((comment) => ({ id: comment.id, createdBy: formatField('createdBy', comment.createdBy, true), createdDate: comment.createdDate, modifiedDate: comment.modifiedDate, text: truncate(htmlToText(comment.text ?? ''), 2000) })) };
  },
});

const addWorkItemComment = defineTool({
  name: 'add_work_item_comment', toolset: 'workitems', title: 'Add work item comment', description: 'Adds a discussion comment to a work item.', readOnly: false,
  input: { ...itemScope, project: projectArg, id: idArg, text: z.string().min(1).describe('Comment text (HTML allowed).') },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve({ collection: args.collection, gitRemoteUrl: args.gitRemoteUrl });
    const project = await workItemProject(client, scope, args.id, args.project);
    const comment = await client.post<{ id: number; createdDate?: string }>({ ...collectionOf(scope), project, path: `_apis/wit/workItems/${args.id}/comments`, area: 'witComments', body: { text: args.text } });
    return { added: true, workItemId: args.id, commentId: comment.id, createdDate: comment.createdDate };
  },
});

const linkWorkItem = defineTool({
  name: 'link_work_item', toolset: 'workitems', title: 'Link work items', description: 'Adds a link from one work item to another: parent, child, related, predecessor, successor, or any link type reference name.', readOnly: false,
  input: { ...itemScope, id: idArg, targetId: z.number().int().positive(), linkType: z.string().min(1).describe('parent, child, related, predecessor, successor, or a reference name such as System.LinkTypes.Duplicate-Forward.'), comment: z.string().optional() },
  async handler(args, { client, resolver }) {
    const rel = LINK_TYPES[args.linkType.toLowerCase()] ?? (args.linkType.includes('.') ? args.linkType : undefined);
    if (!rel) throw new AdoError('bad_request', `Unknown link type "${args.linkType}". Use ${Object.keys(LINK_TYPES).join(', ')} or a reference name.`);
    const scope = await resolver.resolve(args);
    await client.patch({ ...collectionOf(scope), path: `_apis/wit/workitems/${args.id}`, area: 'wit', contentType: jsonPatch, body: [{ op: 'add', path: '/relations/-', value: { rel, url: workItemUrl(client, scope, args.targetId), ...(args.comment ? { attributes: { comment: args.comment } } : {}) } }] });
    return { linked: true, id: args.id, targetId: args.targetId, rel };
  },
});

const addWorkItemAttachment = defineTool({
  name: 'add_work_item_attachment', toolset: 'workitems', title: 'Attach file to work item', description: 'Uploads a file (text or base64, at most 3 MiB) and attaches it to a work item.', readOnly: false,
  input: { ...itemScope, id: idArg, fileName: z.string().min(1), content: z.string().describe('File content: plain text, or base64 when encoding="base64".'), encoding: z.enum(['text', 'base64']).default('text'), comment: z.string().optional() },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args);
    const bytes = Buffer.from(args.content, args.encoding === 'base64' ? 'base64' : 'utf8');
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new AdoError('bad_request', `Attachment is ${bytes.length} bytes; the limit is ${MAX_ATTACHMENT_BYTES} bytes (3 MiB).`);
    const uploaded = await client.post<{ id: string; url: string }>({ ...collectionOf(scope), path: '_apis/wit/attachments', area: 'wit', query: { fileName: args.fileName }, rawBody: bytes, contentType: 'application/octet-stream' });
    await client.patch({ ...collectionOf(scope), path: `_apis/wit/workitems/${args.id}`, area: 'wit', contentType: jsonPatch, body: [{ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: uploaded.url, attributes: { comment: args.comment ?? '' } } }] });
    return { attached: true, workItemId: args.id, attachmentId: uploaded.id, url: uploaded.url, size: bytes.length };
  },
});

const myWorkItems = defineTool({
  name: 'my_work_items', toolset: 'workitems', title: 'My work items', description: 'Lists work items assigned to you (@Me), newest changes first, in the resolved or default project (collection-wide when neither is known).', readOnly: true,
  input: { ...scopeShape, includeClosed: z.boolean().default(false), top: topArg(50, 200), fields: fieldsArg },
  async handler(args, { ctx, client, resolver }) {
    const scope = await resolver.resolve(args);
    const project = scope.project ?? ctx.defaultProject;
    const clauses = ['[System.AssignedTo] = @Me'];
    if (project) clauses.push(`[System.TeamProject] = '${project.replace(/'/g, "''")}'`);
    if (!args.includeClosed) clauses.push("[System.State] NOT IN ('Closed', 'Done', 'Removed')");
    const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;
    const target = collectionOf(scope);
    const { ids, truncated } = await runWiql(client, target, wiql, args.top);
    return { collection: scope.collection, project, count: ids.length, truncated, workItems: ids.length > 0 ? await fetchWorkItems(client, target, ids, args.fields ?? DEFAULT_FIELDS) : [] };
  },
});

export const workItemTools: AnyTool[] = [queryWorkItems, getWorkItem, getWorkItems, getWorkItemRevisions, createWorkItem, updateWorkItem, listWorkItemComments, addWorkItemComment, linkWorkItem, addWorkItemAttachment, myWorkItems];
