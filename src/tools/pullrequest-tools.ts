import { z } from 'zod';
import type { AdoClient, Target } from '../ado/ado-client.js';
import { truncate } from '../ado/bounded.js';
import { AdoError } from '../ado/errors.js';
import type { ContextResolver, ResolvedScope } from '../context/context-resolver.js';
import { collectionArg, collectionOf, gitRemoteUrlArg, previewRevision, repoShape, scopeShape, seg, shortRef, targetOf, toRef, topArg } from './common.js';
import { resolveIdentityId, whoAmI } from './identity.js';
import { defineTool, quoted, type AnyTool } from './registry.js';
import { repoScope } from './repository-tools.js';
import { DEFAULT_FIELDS, fetchWorkItems, formatField } from './workitem-tools.js';

interface ApiReviewer {
  id: string;
  displayName?: string;
  uniqueName?: string;
  vote?: number;
  isRequired?: boolean;
}

export interface ApiPullRequest {
  pullRequestId: number;
  title?: string;
  description?: string;
  status?: string;
  isDraft?: boolean;
  createdBy?: unknown;
  creationDate?: string;
  closedDate?: string;
  sourceRefName?: string;
  targetRefName?: string;
  mergeStatus?: string;
  repository?: { id?: string; name?: string; project?: { id?: string; name?: string } };
  reviewers?: ApiReviewer[];
  lastMergeSourceCommit?: { commitId: string };
  completionOptions?: Record<string, unknown>;
  autoCompleteSetBy?: unknown;
}

interface ApiThread {
  id: number;
  status?: string;
  isDeleted?: boolean;
  threadContext?: { filePath?: string; rightFileStart?: { line?: number } } | null;
  comments?: Array<{ id: number; author?: unknown; content?: string; commentType?: string; publishedDate?: string; isDeleted?: boolean }>;
}

interface LoadedPr {
  scope: ResolvedScope;
  pr: ApiPullRequest;
  target: Target;
  base: string;
  projectId: string;
  repoId: string;
}

const VOTES = { approve: 10, approve_with_suggestions: 5, reset: 0, wait_for_author: -5, reject: -10 } as const;
const VOTE_LABELS = new Map<number, string>([
  [10, 'approved'],
  [5, 'approved with suggestions'],
  [0, 'no vote'],
  [-5, 'waiting for author'],
  [-10, 'rejected'],
]);

export function prSummary(pr: ApiPullRequest) {
  return {
    id: pr.pullRequestId,
    title: pr.title,
    status: pr.status,
    isDraft: pr.isDraft === true,
    createdBy: formatField('createdBy', pr.createdBy, true),
    creationDate: pr.creationDate,
    sourceBranch: shortRef(pr.sourceRefName),
    targetBranch: shortRef(pr.targetRefName),
    mergeStatus: pr.mergeStatus,
    repository: pr.repository?.name,
    project: pr.repository?.project?.name,
    reviewers: (pr.reviewers ?? []).map((reviewer) => ({
      id: reviewer.id,
      displayName: reviewer.displayName,
      uniqueName: reviewer.uniqueName,
      vote: reviewer.vote ?? 0,
      voteLabel: VOTE_LABELS.get(reviewer.vote ?? 0) ?? String(reviewer.vote),
      isRequired: reviewer.isRequired === true,
    })),
  };
}

const prIdArg = z.number().int().positive().describe('Pull request id.');
const prArgs = { collection: collectionArg, gitRemoteUrl: gitRemoteUrlArg, pullRequestId: prIdArg };
const threadStatus = z.enum(['active', 'fixed', 'wontFix', 'closed', 'byDesign', 'pending']);

async function loadPr(
  client: AdoClient,
  resolver: ContextResolver,
  args: { collection?: string; gitRemoteUrl?: string; pullRequestId: number },
): Promise<LoadedPr> {
  const scope = await resolver.resolve({ collection: args.collection, gitRemoteUrl: args.gitRemoteUrl });
  const pr = await client.get<ApiPullRequest>({ ...collectionOf(scope), path: `_apis/git/pullrequests/${args.pullRequestId}`, area: 'git' });
  const repoId = pr.repository?.id;
  const projectId = pr.repository?.project?.id;
  const projectName = pr.repository?.project?.name;
  if (!repoId || !projectId || !projectName) throw new AdoError('server', `Pull request ${args.pullRequestId} did not include its repository and project.`);
  return {
    scope,
    pr,
    repoId,
    projectId,
    target: { ...collectionOf(scope), project: projectName },
    base: `_apis/git/repositories/${seg(repoId)}/pullRequests/${args.pullRequestId}`,
  };
}

const listPullRequests = defineTool({
  name: 'list_pull_requests',
  toolset: 'pullrequests',
  title: 'List pull requests',
  description: 'Lists pull requests in a repository (or the whole project when no repository is known), filtered by status, creator, reviewer and branches.',
  readOnly: true,
  input: {
    ...repoShape,
    status: z.enum(['active', 'completed', 'abandoned', 'all']).default('active'),
    creator: z.string().min(1).optional().describe('Identity id, DOMAIN\\user or email.'),
    reviewer: z.string().min(1).optional().describe('Identity id, DOMAIN\\user or email.'),
    sourceBranch: z.string().min(1).optional(),
    targetBranch: z.string().min(1).optional(),
    top: topArg(50, 500),
  },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const collection = collectionOf(scope);
    const [creatorId, reviewerId] = await Promise.all([
      args.creator ? resolveIdentityId(client, collection, args.creator) : undefined,
      args.reviewer ? resolveIdentityId(client, collection, args.reviewer) : undefined,
    ]);
    const data = await client.get<{ value?: ApiPullRequest[] }>({
      ...targetOf(scope),
      path: scope.repository ? `_apis/git/repositories/${seg(scope.repository)}/pullrequests` : '_apis/git/pullrequests',
      area: 'git',
      query: {
        'searchCriteria.status': args.status,
        'searchCriteria.creatorId': creatorId,
        'searchCriteria.reviewerId': reviewerId,
        'searchCriteria.sourceRefName': args.sourceBranch ? toRef(args.sourceBranch) : undefined,
        'searchCriteria.targetRefName': args.targetBranch ? toRef(args.targetBranch) : undefined,
        $top: args.top + 1,
      },
    });
    const all = data.value ?? [];
    return {
      project: scope.project,
      repository: scope.repository,
      count: Math.min(all.length, args.top),
      truncated: all.length > args.top,
      pullRequests: all.slice(0, args.top).map(prSummary),
    };
  },
});

const listMyPullRequests = defineTool({
  name: 'list_my_pull_requests',
  toolset: 'pullrequests',
  title: 'List my pull requests',
  description: 'Lists active pull requests in a project that you created and/or that you are a reviewer on.',
  readOnly: true,
  input: { ...scopeShape, role: z.enum(['created', 'reviewing', 'both']).default('both'), top: topArg(50, 200) },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const me = await whoAmI(client, collectionOf(scope));
    const byRole = async (criterion: 'creatorId' | 'reviewerId'): Promise<ApiPullRequest[]> =>
      (
        await client.get<{ value?: ApiPullRequest[] }>({
          ...targetOf(scope),
          path: '_apis/git/pullrequests',
          area: 'git',
          query: { 'searchCriteria.status': 'active', [`searchCriteria.${criterion}`]: me.id, $top: args.top + 1 },
        })
      ).value ?? [];
    const [created, reviewing] = await Promise.all([
      args.role === 'reviewing' ? [] : byRole('creatorId'),
      args.role === 'created' ? [] : byRole('reviewerId'),
    ]);
    const createdTruncated = created.length > args.top;
    const reviewingTruncated = reviewing.length > args.top;
    return {
      user: me.displayName,
      project: scope.project,
      created: created.slice(0, args.top).map(prSummary),
      reviewing: reviewing.slice(0, args.top).map(prSummary),
      createdTruncated,
      reviewingTruncated,
      truncated: createdTruncated || reviewingTruncated,
    };
  },
});

const getPullRequest = defineTool({
  name: 'get_pull_request',
  toolset: 'pullrequests',
  title: 'Get pull request',
  description: 'Gets a pull request by id: description, reviewers and votes, merge status, draft state, completion options and web link.',
  readOnly: true,
  input: prArgs,
  async handler(args, { client, resolver }) {
    const { pr, target } = await loadPr(client, resolver, args);
    return {
      ...prSummary(pr),
      description: truncate(pr.description ?? '', 4000),
      closedDate: pr.closedDate,
      lastMergeSourceCommit: pr.lastMergeSourceCommit?.commitId,
      autoComplete: pr.autoCompleteSetBy ? formatField('autoCompleteSetBy', pr.autoCompleteSetBy, true) : undefined,
      completionOptions: pr.completionOptions,
      webUrl: `${client.collectionUrl(target)}/${seg(target.project ?? '')}/_git/${seg(pr.repository?.name ?? '')}/pullrequest/${pr.pullRequestId}`,
    };
  },
});

const createPullRequest = defineTool({
  name: 'create_pull_request',
  toolset: 'pullrequests',
  title: 'Create pull request',
  description: "Creates a pull request (optionally as a draft) with reviewers and linked work items. The target branch defaults to the repository's default branch.",
  readOnly: false,
  input: {
    ...repoShape,
    sourceBranch: z.string().min(1),
    targetBranch: z.string().min(1).optional(),
    title: z.string().min(1),
    description: z.string().optional(),
    isDraft: z.boolean().default(false),
    reviewers: z.array(z.string().min(1)).optional().describe('Identity ids, DOMAIN\\user names or emails.'),
    workItemIds: z.array(z.number().int().positive()).optional(),
  },
  async handler(args, { client, resolver }) {
    const { scope, base } = await repoScope(resolver, args);
    const target = targetOf(scope);
    const targetBranch = args.targetBranch ?? (await client.get<{ defaultBranch?: string }>({ ...target, path: base, area: 'git' })).defaultBranch;
    if (!targetBranch) throw new AdoError('bad_request', 'The repository has no default branch. Pass targetBranch.');
    const reviewers = await Promise.all((args.reviewers ?? []).map(async (reviewer) => ({ id: await resolveIdentityId(client, collectionOf(scope), reviewer) })));
    const pr = await client.post<ApiPullRequest>({
      ...target,
      path: `${base}/pullrequests`,
      area: 'git',
      body: {
        sourceRefName: toRef(args.sourceBranch),
        targetRefName: toRef(targetBranch),
        title: args.title,
        description: args.description,
        isDraft: args.isDraft,
        reviewers,
        workItemRefs: (args.workItemIds ?? []).map((id) => ({ id: String(id) })),
      },
    });
    return { created: true, ...prSummary(pr) };
  },
});

const updatePullRequest = defineTool({
  name: 'update_pull_request',
  toolset: 'pullrequests',
  title: 'Update pull request',
  description: 'Changes the title, description, target branch or draft state of a pull request.',
  readOnly: false,
  idempotent: true,
  input: {
    ...prArgs,
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    targetBranch: z.string().min(1).optional(),
    isDraft: z.boolean().optional(),
  },
  async handler(args, { client, resolver }) {
    const body: Record<string, unknown> = {};
    if (args.title !== undefined) body.title = args.title;
    if (args.description !== undefined) body.description = args.description;
    if (args.targetBranch !== undefined) body.targetRefName = toRef(args.targetBranch);
    if (args.isDraft !== undefined) body.isDraft = args.isDraft;
    if (Object.keys(body).length === 0) throw new AdoError('bad_request', 'Nothing to update: pass title, description, targetBranch or isDraft.');
    const { target, base } = await loadPr(client, resolver, args);
    return { updated: true, ...prSummary(await client.patch<ApiPullRequest>({ ...target, path: base, area: 'git', body })) };
  },
});

const updatePullRequestStatus = defineTool({
  name: 'update_pull_request_status',
  toolset: 'pullrequests',
  title: 'Complete, abandon or reactivate pull request',
  description: "Completes (merges), abandons or reactivates a pull request. Completing sends the PR's last merge source commit, so it fails if the source branch moved.",
  readOnly: false,
  destructive: true,
  input: {
    ...prArgs,
    action: z.enum(['complete', 'abandon', 'reactivate']),
    mergeStrategy: z.enum(['noFastForward', 'squash', 'rebase', 'rebaseMerge']).default('noFastForward'),
    deleteSourceBranch: z.boolean().default(false),
    transitionWorkItems: z.boolean().default(true),
    mergeCommitMessage: z.string().optional(),
  },
  async handler(args, { client, resolver, confirm }) {
    const { pr, target, base } = await loadPr(client, resolver, args);
    const which = `pull request !${pr.pullRequestId} ${quoted(pr.title)} (${quoted(shortRef(pr.sourceRefName))} â†’ ${quoted(shortRef(pr.targetRefName))}) in ${quoted(pr.repository?.name ?? 'the repository')}`;
    let body: Record<string, unknown>;
    let action: string;
    if (args.action === 'complete') {
      if (pr.status !== 'active') throw new AdoError('bad_request', `Pull request ${pr.pullRequestId} is ${pr.status}; only active pull requests can be completed.`);
      if (pr.isDraft) throw new AdoError('bad_request', 'Draft pull requests cannot be completed. Publish it first with update_pull_request isDraft=false.');
      if (!pr.lastMergeSourceCommit) throw new AdoError('conflict', 'Azure DevOps has not computed a merge for this pull request yet. Try again shortly.');
      body = {
        status: 'completed',
        lastMergeSourceCommit: pr.lastMergeSourceCommit,
        completionOptions: {
          mergeStrategy: args.mergeStrategy,
          deleteSourceBranch: args.deleteSourceBranch,
          transitionWorkItems: args.transitionWorkItems,
          ...(args.mergeCommitMessage ? { mergeCommitMessage: args.mergeCommitMessage } : {}),
        },
      };
      action = `Complete (${args.mergeStrategy}) ${which}${args.deleteSourceBranch ? ', deleting the source branch' : ''}.`;
    } else {
      body = { status: args.action === 'abandon' ? 'abandoned' : 'active' };
      action = `${args.action === 'abandon' ? 'Abandon' : 'Reactivate'} ${which}.`;
    }
    await confirm(action);
    return { action: args.action, ...prSummary(await client.patch<ApiPullRequest>({ ...target, path: base, area: 'git', body })) };
  },
});

const getPullRequestChanges = defineTool({
  name: 'get_pull_request_changes',
  toolset: 'pullrequests',
  title: 'Get pull request changes',
  description: 'Lists the files changed in the latest (or a given) iteration of a pull request.',
  readOnly: true,
  input: { ...prArgs, iterationId: z.number().int().positive().optional(), top: topArg(100, 1000) },
  async handler(args, { client, resolver }) {
    const { target, base } = await loadPr(client, resolver, args);
    let iterationId = args.iterationId;
    if (!iterationId) {
      const iterations = await client.get<{ value?: Array<{ id: number }> }>({ ...target, path: `${base}/iterations`, area: 'git' });
      iterationId = Math.max(0, ...(iterations.value ?? []).map((iteration) => iteration.id));
      if (!iterationId) throw new AdoError('not_found', `Pull request ${args.pullRequestId} has no iterations yet.`);
    }
    const data = await client.get<{ changeEntries?: Array<{ item?: { path?: string }; changeType?: string; originalPath?: string }> }>({
      ...target,
      path: `${base}/iterations/${iterationId}/changes`,
      area: 'git',
      query: { $top: args.top + 1 },
    });
    const allChanges = data.changeEntries ?? [];
    const changes = allChanges.slice(0, args.top).map((entry) => ({ path: entry.item?.path, changeType: entry.changeType, originalPath: entry.originalPath }));
    return { pullRequestId: args.pullRequestId, count: changes.length, truncated: allChanges.length > args.top, iterationId, changes };
  },
});

const getPullRequestPolicies = defineTool({
  name: 'get_pull_request_policies',
  toolset: 'pullrequests',
  title: 'Get pull request policy status',
  description: 'Shows the branch policy evaluations (reviewers, builds, work item linking, ...) for a pull request and which ones block completion.',
  readOnly: true,
  input: { ...prArgs, top: topArg(100, 1000) },
  async handler(args, { client, resolver }) {
    const { pr, target, projectId } = await loadPr(client, resolver, args);
    const result = await client.getAllPages<{
      status?: string;
      configuration?: { isBlocking?: boolean; type?: { displayName?: string }; settings?: { displayName?: string } };
    }>({
      ...target,
      path: '_apis/policy/evaluations',
      area: 'policy',
      apiVersion: previewRevision(await client.version(target, 'policy'), 1),
      query: { artifactId: `vstfs:///CodeReview/CodeReviewId/${projectId}/${pr.pullRequestId}` },
    });
    const allPolicies = result.items.map((evaluation) => ({
      policy: evaluation.configuration?.settings?.displayName ?? evaluation.configuration?.type?.displayName,
      status: evaluation.status,
      isBlocking: evaluation.configuration?.isBlocking === true,
    }));
    const allBlocking = allPolicies.filter((policy) => policy.isBlocking && !['approved', 'notApplicable'].includes(policy.status ?? ''));
    const policies = allPolicies.slice(0, args.top);
    const blocking = allBlocking.slice(0, args.top);
    return {
      pullRequestId: pr.pullRequestId,
      canComplete: allBlocking.length === 0 && !result.truncated,
      count: policies.length,
      truncated: result.truncated || allPolicies.length > args.top,
      blockingCount: allBlocking.length,
      blockingTruncated: result.truncated || allBlocking.length > args.top,
      blocking,
      policies,
    };
  },
});

const listPullRequestWorkItems = defineTool({
  name: 'list_pull_request_work_items',
  toolset: 'pullrequests',
  title: 'List pull request work items',
  description: 'Lists the work items linked to a pull request.',
  readOnly: true,
  input: { ...prArgs, hydrate: z.boolean().default(true), top: topArg(100, 1000) },
  async handler(args, { client, resolver }) {
    const { scope, target, base } = await loadPr(client, resolver, args);
    const result = await client.getAllPages<{ id: string }>({ ...target, path: `${base}/workitems`, area: 'git' });
    const allIds = result.items.map((ref) => Number(ref.id)).filter((id) => Number.isInteger(id));
    const ids = allIds.slice(0, args.top);
    return {
      pullRequestId: args.pullRequestId,
      count: ids.length,
      truncated: result.truncated || allIds.length > args.top,
      ids,
      ...(args.hydrate && ids.length > 0 ? { workItems: await fetchWorkItems(client, collectionOf(scope), ids, DEFAULT_FIELDS) } : {}),
    };
  },
});

const linkPullRequestToWorkItem = defineTool({
  name: 'link_pull_request_to_work_item',
  toolset: 'pullrequests',
  title: 'Link pull request to work item',
  description: 'Links a pull request to a work item (it shows on the work item under Development).',
  readOnly: false,
  idempotent: true,
  input: { ...prArgs, workItemId: z.number().int().positive() },
  async handler(args, { client, resolver }) {
    const { scope, pr, projectId, repoId } = await loadPr(client, resolver, args);
    const artifactUrl = `vstfs:///Git/PullRequestId/${projectId}%2F${repoId}%2F${pr.pullRequestId}`;
    await client.patch({
      ...collectionOf(scope),
      path: `_apis/wit/workitems/${args.workItemId}`,
      area: 'wit',
      contentType: 'application/json-patch+json',
      body: [{ op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url: artifactUrl, attributes: { name: 'Pull Request' } } }],
    });
    return { linked: true, pullRequestId: pr.pullRequestId, workItemId: args.workItemId, artifactUrl };
  },
});

const listPullRequestThreads = defineTool({
  name: 'list_pull_request_threads',
  toolset: 'pullrequests',
  title: 'List pull request comments',
  description: 'Lists review comment threads with file/line context and status. System threads are hidden unless includeSystem=true.',
  readOnly: true,
  input: { ...prArgs, status: threadStatus.optional(), includeSystem: z.boolean().default(false), top: topArg(50, 500) },
  async handler(args, { client, resolver }) {
    const { target, base } = await loadPr(client, resolver, args);
    const result = await client.getAllPages<ApiThread>({ ...target, path: `${base}/threads`, area: 'git' });
    const filteredThreads = result.items
      .filter((thread) => !thread.isDeleted)
      .filter((thread) => args.includeSystem || !(thread.comments ?? []).every((comment) => comment.commentType === 'system'))
      .filter((thread) => !args.status || thread.status === args.status);
    const threads = filteredThreads.slice(0, args.top).map((thread) => {
      const visibleComments = (thread.comments ?? []).filter((comment) => !comment.isDeleted);
      return {
        id: thread.id,
        status: thread.status,
        filePath: thread.threadContext?.filePath,
        line: thread.threadContext?.rightFileStart?.line,
        commentsTruncated: visibleComments.length > 20,
        comments: visibleComments
          .slice(0, 20)
          .map((comment) => ({
            id: comment.id,
            author: formatField('author', comment.author, true),
            content: truncate(comment.content ?? '', 1000),
            publishedDate: comment.publishedDate,
          })),
      };
    });
    return { pullRequestId: args.pullRequestId, count: threads.length, truncated: result.truncated || filteredThreads.length > args.top, threads };
  },
});

const addPullRequestComment = defineTool({
  name: 'add_pull_request_comment',
  toolset: 'pullrequests',
  title: 'Comment on pull request',
  description: 'Starts a new comment thread on a pull request, either general or inline on a file and line.',
  readOnly: false,
  input: {
    ...prArgs,
    content: z.string().min(1),
    filePath: z.string().min(1).optional().describe('File for an inline comment, e.g. /src/index.ts.'),
    line: z.number().int().positive().optional().describe('Line in the new version of the file.'),
  },
  async handler(args, { client, resolver }) {
    if (args.line && !args.filePath) throw new AdoError('bad_request', 'line requires filePath.');
    const { target, base } = await loadPr(client, resolver, args);
    const thread = await client.post<{ id: number; comments?: Array<{ id: number }> }>({
      ...target,
      path: `${base}/threads`,
      area: 'git',
      body: {
        comments: [{ parentCommentId: 0, content: args.content, commentType: 'text' }],
        status: 'active',
        ...(args.filePath
          ? { threadContext: { filePath: args.filePath, ...(args.line ? { rightFileStart: { line: args.line, offset: 1 }, rightFileEnd: { line: args.line, offset: 1 } } : {}) } }
          : {}),
      },
    });
    return { threadId: thread.id, commentId: thread.comments?.[0]?.id };
  },
});

const replyToPullRequestThread = defineTool({
  name: 'reply_to_pull_request_thread',
  toolset: 'pullrequests',
  title: 'Reply to pull request comment',
  description: 'Replies to an existing pull request comment thread.',
  readOnly: false,
  input: { ...prArgs, threadId: z.number().int().positive(), content: z.string().min(1), parentCommentId: z.number().int().min(0).default(1) },
  async handler(args, { client, resolver }) {
    const { target, base } = await loadPr(client, resolver, args);
    const comment = await client.post<{ id: number }>({
      ...target,
      path: `${base}/threads/${args.threadId}/comments`,
      area: 'git',
      body: { content: args.content, parentCommentId: args.parentCommentId, commentType: 'text' },
    });
    return { threadId: args.threadId, commentId: comment.id };
  },
});

const setPullRequestThreadStatus = defineTool({
  name: 'set_pull_request_thread_status',
  toolset: 'pullrequests',
  title: 'Resolve or reopen pull request comment',
  description: 'Sets the status of a comment thread: active, fixed (resolved), wontFix, closed, byDesign or pending.',
  readOnly: false,
  idempotent: true,
  input: { ...prArgs, threadId: z.number().int().positive(), status: threadStatus },
  async handler(args, { client, resolver }) {
    const { target, base } = await loadPr(client, resolver, args);
    const thread = await client.patch<{ id: number; status?: string }>({ ...target, path: `${base}/threads/${args.threadId}`, area: 'git', body: { status: args.status } });
    return { threadId: thread.id, status: thread.status };
  },
});

const voteOnPullRequest = defineTool({
  name: 'vote_on_pull_request',
  toolset: 'pullrequests',
  title: 'Vote on pull request',
  description: 'Records your own reviewer vote: approve (10), approve_with_suggestions (5), reset (0), wait_for_author (-5) or reject (-10).',
  readOnly: false,
  idempotent: true,
  input: { ...prArgs, vote: z.enum(['approve', 'approve_with_suggestions', 'reset', 'wait_for_author', 'reject']) },
  async handler(args, { client, resolver }) {
    const { scope, target, base } = await loadPr(client, resolver, args);
    const me = await whoAmI(client, collectionOf(scope));
    const value = VOTES[args.vote];
    await client.put({ ...target, path: `${base}/reviewers/${seg(me.id)}`, area: 'git', body: { vote: value } });
    return { voted: true, pullRequestId: args.pullRequestId, vote: args.vote, value, reviewer: me.displayName };
  },
});

const managePullRequestReviewers = defineTool({
  name: 'manage_pull_request_reviewers',
  toolset: 'pullrequests',
  title: 'Add or remove pull request reviewers',
  description: 'Adds reviewers (optionally as required) and/or removes reviewers from a pull request.',
  readOnly: false,
  idempotent: true,
  input: {
    ...prArgs,
    add: z.array(z.string().min(1)).optional().describe('Identity ids, DOMAIN\\user names or emails to add.'),
    remove: z.array(z.string().min(1)).optional().describe('Identity ids, DOMAIN\\user names or emails to remove.'),
    required: z.boolean().default(false).describe('Add the new reviewers as required.'),
  },
  async handler(args, { client, resolver }) {
    if (!args.add?.length && !args.remove?.length) throw new AdoError('bad_request', 'Pass add and/or remove.');
    const { scope, target, base } = await loadPr(client, resolver, args);
    const collection = collectionOf(scope);
    const added: string[] = [];
    for (const reviewer of args.add ?? []) {
      const id = await resolveIdentityId(client, collection, reviewer);
      await client.put({ ...target, path: `${base}/reviewers/${seg(id)}`, area: 'git', body: { vote: 0, isRequired: args.required } });
      added.push(id);
    }
    const removed: string[] = [];
    for (const reviewer of args.remove ?? []) {
      const id = await resolveIdentityId(client, collection, reviewer);
      await client.del({ ...target, path: `${base}/reviewers/${seg(id)}`, area: 'git' });
      removed.push(id);
    }
    return { added, removed };
  },
});

export const pullRequestTools: AnyTool[] = [
  listPullRequests,
  listMyPullRequests,
  getPullRequest,
  createPullRequest,
  updatePullRequest,
  updatePullRequestStatus,
  getPullRequestChanges,
  getPullRequestPolicies,
  listPullRequestWorkItems,
  linkPullRequestToWorkItem,
  listPullRequestThreads,
  addPullRequestComment,
  replyToPullRequestThread,
  setPullRequestThreadStatus,
  voteOnPullRequest,
  managePullRequestReviewers,
];
