import { z } from 'zod';
import { truncate } from '../ado/bounded.js';
import { AdoError } from '../ado/errors.js';
import { collectionOf, preview, scopeShape, targetOf, topArg } from './common.js';
import { whoAmI } from './identity.js';
import { defineTool, quoted, type AnyTool } from './registry.js';
import { formatField } from './workitem-tools.js';

interface ApiApproval {
  id: number;
  status?: string;
  approvalType?: string;
  approver?: { displayName?: string };
  release?: { id?: number; name?: string };
  releaseEnvironment?: { id?: number; name?: string };
  createdOn?: string;
  comments?: string;
}

interface ApiEnvironment {
  id: number;
  name?: string;
  status?: string;
  preDeployApprovals?: ApiApproval[];
}

interface ApiRelease {
  id: number;
  name?: string;
  status?: string;
  description?: string;
  createdOn?: string;
  createdBy?: unknown;
  releaseDefinition?: { id?: number; name?: string };
  artifacts?: Array<{ alias?: string; type?: string; definitionReference?: { version?: { id?: string; name?: string } } }>;
  environments?: ApiEnvironment[];
}

const releaseSummary = (release: ApiRelease) => ({
  id: release.id,
  name: release.name,
  status: release.status,
  createdOn: release.createdOn,
  definition: release.releaseDefinition?.name,
  definitionId: release.releaseDefinition?.id,
  environments: (release.environments ?? []).map((environment) => ({ id: environment.id, name: environment.name, status: environment.status })),
});

const listReleaseDefinitions = defineTool({
  name: 'list_release_definitions',
  toolset: 'releases',
  title: 'List release pipelines',
  description: 'Lists classic release pipelines (definitions) in a project.',
  readOnly: true,
  input: { ...scopeShape, searchText: z.string().min(1).optional(), top: topArg(100, 500) },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const data = await client.get<{ value?: Array<{ id: number; name: string; path?: string }> }>({
      ...targetOf(scope),
      path: '_apis/release/definitions',
      area: 'release',
      query: { searchText: args.searchText, $top: args.top + 1 },
    });
    const values = data.value ?? [];
    const definitions = values.slice(0, args.top).map((d) => ({ id: d.id, name: d.name, path: d.path }));
    return { project: scope.project, count: definitions.length, truncated: values.length > args.top, definitions };
  },
});

const listReleases = defineTool({
  name: 'list_releases',
  toolset: 'releases',
  title: 'List releases',
  description: 'Lists releases, newest first, with the status of each environment (stage).',
  readOnly: true,
  input: {
    ...scopeShape,
    definitionId: z.number().int().positive().optional(),
    status: z.enum(['draft', 'active', 'abandoned']).optional(),
    top: topArg(20, 200),
  },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const data = await client.get<{ value?: ApiRelease[] }>({
      ...targetOf(scope),
      path: '_apis/release/releases',
      area: 'release',
      query: { definitionId: args.definitionId, statusFilter: args.status, $expand: 'environments', $top: args.top + 1 },
    });
    const values = data.value ?? [];
    const releases = values.slice(0, args.top).map(releaseSummary);
    return { project: scope.project, count: releases.length, truncated: values.length > args.top, releases };
  },
});

const getRelease = defineTool({
  name: 'get_release',
  toolset: 'releases',
  title: 'Get release',
  description: 'Gets a release with its artifacts and, per environment, the status and pending pre-deployment approvals.',
  readOnly: true,
  input: { ...scopeShape, releaseId: z.number().int().positive() },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const release = await client.get<ApiRelease>({ ...targetOf(scope), path: `_apis/release/releases/${args.releaseId}`, area: 'release' });
    return {
      ...releaseSummary(release),
      description: truncate(release.description ?? '', 2000),
      createdBy: formatField('createdBy', release.createdBy, true),
      artifacts: (release.artifacts ?? []).map((artifact) => ({ alias: artifact.alias, type: artifact.type, version: artifact.definitionReference?.version?.name })),
      environments: (release.environments ?? []).map((environment) => ({
        id: environment.id,
        name: environment.name,
        status: environment.status,
        approvals: (environment.preDeployApprovals ?? []).map((approval) => ({ id: approval.id, status: approval.status, approver: approval.approver?.displayName })),
      })),
    };
  },
});

const createRelease = defineTool({
  name: 'create_release',
  toolset: 'releases',
  title: 'Create release',
  description:
    'Creates a release from a release pipeline, optionally pinning artifact versions. Environments with automatic triggers start deploying immediately, so the user is asked to confirm first.',
  readOnly: false,
  destructive: true,
  input: {
    ...scopeShape,
    definitionId: z.number().int().positive(),
    description: z.string().optional(),
    isDraft: z.boolean().default(false),
    artifacts: z
      .array(z.object({ alias: z.string().min(1), versionId: z.string().min(1), versionName: z.string().optional() }))
      .optional()
      .describe('Artifact versions, e.g. [{"alias": "_ci", "versionId": "900"}] (versionId is the build id for build artifacts).'),
  },
  async handler(args, { client, resolver, confirm }) {
    const scope = await resolver.resolve(args, { project: true });
    const definition = await client.get<{ id: number; name?: string }>({ ...targetOf(scope), path: `_apis/release/definitions/${args.definitionId}`, area: 'release' });
    const pinned = (args.artifacts ?? []).map((artifact) => quoted(`${artifact.alias}@${artifact.versionName ?? artifact.versionId}`));
    await confirm(
      `Create a${args.isDraft ? ' draft' : ''} release of ${quoted(definition.name ?? args.definitionId)} in ${quoted(scope.project)}${pinned.length > 0 ? ` with artifacts ${pinned.join(', ')}` : ' with the latest artifacts'}. Stages with automatic triggers start deploying straight away.`,
    );
    const release = await client.post<ApiRelease>({
      ...targetOf(scope),
      path: '_apis/release/releases',
      area: 'release',
      body: {
        definitionId: args.definitionId,
        description: args.description,
        isDraft: args.isDraft,
        ...(args.artifacts
          ? {
            artifacts: args.artifacts.map((artifact) => ({
              alias: artifact.alias,
              instanceReference: { id: artifact.versionId, ...(artifact.versionName ? { name: artifact.versionName } : {}) },
            })),
          }
          : {}),
      },
    });
    return { created: true, ...releaseSummary(release) };
  },
});

const listReleaseApprovals = defineTool({
  name: 'list_release_approvals',
  toolset: 'releases',
  title: 'List release approvals',
  description: 'Lists release approvals, by default the pending ones assigned to you.',
  readOnly: true,
  input: {
    ...scopeShape,
    status: z.enum(['pending', 'approved', 'rejected', 'reassigned', 'canceled', 'skipped', 'undefined']).default('pending'),
    assignedToMe: z.boolean().default(true),
    top: topArg(50, 500),
  },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const me = args.assignedToMe ? await whoAmI(client, collectionOf(scope)) : undefined;
    const data = await client.get<{ value?: ApiApproval[] }>({
      ...targetOf(scope),
      path: '_apis/release/approvals',
      area: 'release',
      // includeMyGroupApprovals: most approvals are assigned to a group such as "Release Managers", not to the user directly.
      query: {
        statusFilter: args.status,
        assignedToFilter: me ? (me.uniqueName ?? me.id) : undefined,
        includeMyGroupApprovals: true,
        top: args.top + 1,
      },
    });
    const values = data.value ?? [];
    const approvals = values.slice(0, args.top).map((approval) => ({
      id: approval.id,
      status: approval.status,
      approvalType: approval.approvalType,
      approver: approval.approver?.displayName,
      release: approval.release?.name,
      releaseId: approval.release?.id,
      environment: approval.releaseEnvironment?.name,
      environmentId: approval.releaseEnvironment?.id,
      createdOn: approval.createdOn,
    }));
    return { project: scope.project, count: approvals.length, truncated: values.length > args.top, approvals };
  },
});

const updateReleaseApproval = defineTool({
  name: 'update_release_approval',
  toolset: 'releases',
  title: 'Approve or reject release',
  description: 'Approves or rejects a release approval step with an optional comment. Only do this when the user explicitly asks.',
  readOnly: false,
  destructive: true,
  input: { ...scopeShape, approvalId: z.number().int().positive(), status: z.enum(['approved', 'rejected']), comments: z.string().optional() },
  async handler(args, { client, resolver, confirm }) {
    const scope = await resolver.resolve(args, { project: true });
    const path = `_apis/release/approvals/${args.approvalId}`;
    const current = await client.get<ApiApproval>({ ...targetOf(scope), path, area: 'release' });
    if (current.status !== 'pending') {
      throw new AdoError('bad_request', `Approval ${args.approvalId} is already ${current.status ?? 'decided'}; only pending approvals can be approved or rejected. Call list_release_approvals for the current ones.`);
    }
    const stage = current.approvalType === 'postDeploy' ? 'post-deployment' : 'pre-deployment';
    await confirm(
      `${args.status === 'approved' ? 'Approve' : 'Reject'} the ${stage} approval for ${quoted(current.release?.name ?? `release ${current.release?.id ?? '?'}`)} → ${quoted(current.releaseEnvironment?.name ?? `environment ${current.releaseEnvironment?.id ?? '?'}`)} in ${quoted(scope.project)} (assigned to ${quoted(current.approver?.displayName ?? 'unknown')}).`,
    );
    const approval = await client.patch<ApiApproval>({
      ...targetOf(scope),
      path,
      area: 'release',
      body: { status: args.status, comments: args.comments },
    });
    return { id: approval.id, status: approval.status };
  },
});

const deployReleaseEnvironment = defineTool({
  name: 'deploy_release_environment',
  toolset: 'releases',
  title: 'Deploy release environment',
  description: 'Starts deployment of a release to one environment (stage). Only do this when the user explicitly asks.',
  readOnly: false,
  destructive: true,
  input: { ...scopeShape, releaseId: z.number().int().positive(), environmentId: z.number().int().positive(), comment: z.string().optional() },
  async handler(args, { client, resolver, confirm }) {
    const scope = await resolver.resolve(args, { project: true });
    const target = targetOf(scope);
    const release = await client.get<ApiRelease>({ ...target, path: `_apis/release/releases/${args.releaseId}`, area: 'release' });
    const stage = release.environments?.find((environment) => environment.id === args.environmentId);
    if (!stage) throw new AdoError('not_found', `Release ${release.name ?? args.releaseId} has no environment ${args.environmentId}. Call get_release for its environment ids.`);
    await confirm(
      `Deploy ${quoted(release.name ?? `release ${args.releaseId}`)} of ${quoted(release.releaseDefinition?.name ?? 'its pipeline')} to ${quoted(stage.name ?? `environment ${stage.id}`)} (currently ${stage.status ?? 'unknown'}) in ${quoted(scope.project)}.`,
    );
    const environment = await client.patch<ApiEnvironment>({
      ...target,
      path: `_apis/release/releases/${args.releaseId}/environments/${args.environmentId}`,
      area: 'release',
      apiVersion: preview(await client.version(target, 'release')),
      body: { status: 'inProgress', comment: args.comment },
    });
    return { releaseId: args.releaseId, environmentId: environment.id, name: environment.name, status: environment.status };
  },
});

export const releaseTools: AnyTool[] = [
  listReleaseDefinitions,
  listReleases,
  getRelease,
  createRelease,
  listReleaseApprovals,
  updateReleaseApproval,
  deployReleaseEnvironment,
];
