import { z } from 'zod';
import { DEFAULT_MAX_CHARS, HARD_MAX_CHARS, isProbablyBinary, truncate, windowText } from '../ado/bounded.js';
import type { ContextResolver, ResolvedScope } from '../context/context-resolver.js';
import { collectionArg, collectionOf, gitRemoteUrlArg, projectArg, repoShape, requireValue, scopeShape, seg, shortRef, targetOf, topArg } from './common.js';
import { defineTool, type AnyTool } from './registry.js';

export interface ApiRepo {
  id: string;
  name: string;
  project?: { id?: string; name?: string };
  defaultBranch?: string;
  remoteUrl?: string;
  sshUrl?: string;
  webUrl?: string;
  size?: number;
  isDisabled?: boolean;
}

export const repoSummary = (repo: ApiRepo) => ({
  id: repo.id,
  name: repo.name,
  project: repo.project?.name,
  defaultBranch: shortRef(repo.defaultBranch),
  size: repo.size,
  remoteUrl: repo.remoteUrl,
  sshUrl: repo.sshUrl,
  webUrl: repo.webUrl,
  isDisabled: repo.isDisabled === true,
});

export async function repoScope(
  resolver: ContextResolver,
  args: { collection?: string; project?: string; repository?: string; gitRemoteUrl?: string },
): Promise<{ scope: ResolvedScope; repository: string; base: string }> {
  const scope = await resolver.resolve(args, { repository: true });
  const repository = requireValue(scope.repository, 'repository');
  return { scope, repository, base: `_apis/git/repositories/${seg(repository)}` };
}

export function versionQuery(version: string | undefined, versionType: 'branch' | 'tag' | 'commit') {
  return { 'versionDescriptor.version': version, 'versionDescriptor.versionType': version ? versionType : undefined };
}

const versionArgs = {
  version: z.string().min(1).optional().describe('Branch, tag or commit id (default: the default branch).'),
  versionType: z.enum(['branch', 'tag', 'commit']).default('branch'),
};

const listRepositories = defineTool({
  name: 'list_repositories',
  toolset: 'repositories',
  title: 'List repositories',
  description: 'Lists Git repositories in a project, or in the whole collection when no project is known.',
  readOnly: true,
  input: { collection: collectionArg, project: projectArg, gitRemoteUrl: gitRemoteUrlArg, top: topArg(100, 1000) },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args);
    const data = await client.get<{ value?: ApiRepo[] }>({
      ...(scope.project ? targetOf(scope) : collectionOf(scope)),
      path: '_apis/git/repositories',
      area: 'git',
    });
    const all = data.value ?? [];
    return {
      collection: scope.collection,
      project: scope.project,
      count: Math.min(all.length, args.top),
      truncated: all.length > args.top,
      repositories: all.slice(0, args.top).map(repoSummary),
    };
  },
});

const getRepository = defineTool({
  name: 'get_repository',
  toolset: 'repositories',
  title: 'Get repository',
  description: 'Gets repository details: default branch, clone URLs and size.',
  readOnly: true,
  input: repoShape,
  async handler(args, { client, resolver }) {
    const { scope, base } = await repoScope(resolver, args);
    return { collection: scope.collection, ...repoSummary(await client.get<ApiRepo>({ ...targetOf(scope), path: base, area: 'git' })) };
  },
});

const createRepository = defineTool({
  name: 'create_repository',
  toolset: 'repositories',
  title: 'Create repository',
  description: "Creates a Git repository in a project. Requires the Git 'CreateRepository' permission; a missing permission is reported as [permission] with the TF401027 message.",
  readOnly: false,
  input: { ...scopeShape, name: z.string().min(1).max(256) },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const project = await client.get<{ id: string }>({ ...collectionOf(scope), path: `_apis/projects/${seg(requireValue(scope.project, 'project'))}`, area: 'core' });
    const repo = await client.post<ApiRepo>({ ...targetOf(scope), path: '_apis/git/repositories', area: 'git', body: { name: args.name, project: { id: project.id } } });
    return { created: true, ...repoSummary(repo) };
  },
});

const listBranches = defineTool({
  name: 'list_branches',
  toolset: 'repositories',
  title: 'List branches',
  description: 'Lists branches with their tip commit. With includeAheadBehind=true, also returns ahead/behind counts against the default branch (slower).',
  readOnly: true,
  input: {
    ...repoShape,
    filter: z.string().optional().describe('Branch name prefix, e.g. "feature/".'),
    includeAheadBehind: z.boolean().default(false),
    top: topArg(100, 1000),
  },
  async handler(args, { client, resolver }) {
    const { scope, repository, base } = await repoScope(resolver, args);
    const prefix = args.filter ?? '';
    if (args.includeAheadBehind) {
      const data = await client.get<{
        value?: Array<{ name: string; aheadCount?: number; behindCount?: number; isBaseVersion?: boolean; commit?: { commitId?: string; comment?: string } }>;
      }>({ ...targetOf(scope), path: `${base}/stats/branches`, area: 'git' });
      const all = (data.value ?? []).filter((branch) => branch.name.startsWith(prefix));
      return {
        repository,
        count: Math.min(all.length, args.top),
        truncated: all.length > args.top,
        branches: all.slice(0, args.top).map((branch) => ({
          name: branch.name,
          aheadCount: branch.aheadCount,
          behindCount: branch.behindCount,
          isBaseVersion: branch.isBaseVersion === true,
          commitId: branch.commit?.commitId,
          comment: branch.commit?.comment ? truncate(branch.commit.comment, 200) : undefined,
        })),
      };
    }
    const data = await client.get<{ value?: Array<{ name: string; objectId: string; creator?: { displayName?: string } }> }>({
      ...targetOf(scope),
      path: `${base}/refs`,
      area: 'git',
      query: { filter: `heads/${prefix}`, $top: args.top + 1 },
    });
    const all = data.value ?? [];
    return {
      repository,
      count: Math.min(all.length, args.top),
      truncated: all.length > args.top,
      branches: all.slice(0, args.top).map((ref) => ({ name: shortRef(ref.name), commitId: ref.objectId, creator: ref.creator?.displayName })),
    };
  },
});

const listRepositoryItems = defineTool({
  name: 'list_repository_items',
  toolset: 'repositories',
  title: 'List files and folders',
  description: 'Lists files and folders at a path in a branch, tag or commit.',
  readOnly: true,
  input: {
    ...repoShape,
    path: z.string().default('/'),
    recursion: z.enum(['none', 'oneLevel', 'full']).default('oneLevel'),
    ...versionArgs,
    top: topArg(200, 2000),
  },
  async handler(args, { client, resolver }) {
    const { scope, repository, base } = await repoScope(resolver, args);
    const data = await client.get<{ value?: Array<{ path: string; isFolder?: boolean; gitObjectType?: string; commitId?: string }> }>({
      ...targetOf(scope),
      path: `${base}/items`,
      area: 'git',
      query: { scopePath: args.path, recursionLevel: args.recursion, ...versionQuery(args.version, args.versionType) },
    });
    const all = data.value ?? [];
    return {
      repository,
      path: args.path,
      count: Math.min(all.length, args.top),
      truncated: all.length > args.top,
      items: all.slice(0, args.top).map((item) => ({ path: item.path, isFolder: item.isFolder === true, gitObjectType: item.gitObjectType, commitId: item.commitId })),
    };
  },
});

const getFileContent = defineTool({
  name: 'get_file_content',
  toolset: 'repositories',
  title: 'Read file',
  description: `Reads a text file with line windowing (startLine/endLine or tailLines; at most maxChars characters, default ${DEFAULT_MAX_CHARS}). Binary files are detected and not returned.`,
  readOnly: true,
  input: {
    ...repoShape,
    path: z.string().min(1),
    ...versionArgs,
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    tailLines: z.number().int().min(1).optional(),
    maxChars: z.number().int().min(1).max(HARD_MAX_CHARS).default(DEFAULT_MAX_CHARS),
  },
  async handler(args, { client, resolver }) {
    const { scope, repository, base } = await repoScope(resolver, args);
    const item = await client.get<{ path?: string; objectId?: string; commitId?: string; content?: string; contentMetadata?: { isBinary?: boolean } }>({
      ...targetOf(scope),
      path: `${base}/items`,
      area: 'git',
      query: { path: args.path, includeContent: true, includeContentMetadata: true, $format: 'json', ...versionQuery(args.version, args.versionType) },
    });
    const content = item.content ?? '';
    const path = item.path ?? args.path;
    if (item.contentMetadata?.isBinary || isProbablyBinary(content)) {
      return { repository, path, commitId: item.commitId, binary: true, message: 'Binary file: content is not returned.' };
    }
    const window = windowText(content, { startLine: args.startLine, endLine: args.endLine, tailLines: args.tailLines, maxChars: args.maxChars });
    return {
      repository,
      path,
      commitId: item.commitId,
      objectId: item.objectId,
      ...window,
      ...(window.endLine < window.totalLines ? { hint: `More lines follow: call again with startLine=${window.endLine + 1}.` } : {}),
    };
  },
});

const listCommits = defineTool({
  name: 'list_commits',
  toolset: 'repositories',
  title: 'List commits',
  description: 'Lists commits, newest first, filtered by branch, path, author or date range.',
  readOnly: true,
  input: {
    ...repoShape,
    branch: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    author: z.string().min(1).optional(),
    fromDate: z.string().optional().describe('ISO date, e.g. 2026-11-01.'),
    toDate: z.string().optional(),
    top: topArg(50, 500),
  },
  async handler(args, { client, resolver }) {
    const { scope, repository, base } = await repoScope(resolver, args);
    const data = await client.get<{
      value?: Array<{ commitId: string; author?: { name?: string; email?: string; date?: string }; comment?: string; changeCounts?: Record<string, number> }>;
    }>({
      ...targetOf(scope),
      path: `${base}/commits`,
      area: 'git',
      query: {
        'searchCriteria.itemVersion.version': args.branch,
        'searchCriteria.itemVersion.versionType': args.branch ? 'branch' : undefined,
        'searchCriteria.itemPath': args.path,
        'searchCriteria.author': args.author,
        'searchCriteria.fromDate': args.fromDate,
        'searchCriteria.toDate': args.toDate,
        'searchCriteria.$top': args.top + 1,
      },
    });
    const all = data.value ?? [];
    const commits = all.slice(0, args.top).map((commit) => ({
      commitId: commit.commitId,
      author: commit.author?.name,
      email: commit.author?.email,
      date: commit.author?.date,
      comment: truncate(commit.comment ?? '', 300),
      changeCounts: commit.changeCounts,
    }));
    return { repository, count: commits.length, truncated: all.length > args.top, commits };
  },
});

const getCommit = defineTool({
  name: 'get_commit',
  toolset: 'repositories',
  title: 'Get commit',
  description: 'Gets a commit with its message, parents and changed files.',
  readOnly: true,
  input: { ...repoShape, commitId: z.string().min(1).describe('Full or abbreviated commit id.'), top: topArg(100, 1000) },
  async handler(args, { client, resolver }) {
    const { scope, repository, base } = await repoScope(resolver, args);
    const commit = await client.get<{
      commitId: string;
      parents?: string[];
      author?: { name?: string; date?: string };
      committer?: { name?: string; date?: string };
      comment?: string;
      changeCounts?: Record<string, number>;
      changes?: Array<{ item?: { path?: string }; changeType?: string }>;
    }>({ ...targetOf(scope), path: `${base}/commits/${seg(args.commitId)}`, area: 'git', query: { changeCount: args.top + 1 } });
    const allChanges = commit.changes ?? [];
    const changes = allChanges.slice(0, args.top).map((change) => ({ path: change.item?.path, changeType: change.changeType }));
    return {
      repository,
      commitId: commit.commitId,
      parents: commit.parents,
      author: commit.author,
      committer: commit.committer,
      comment: truncate(commit.comment ?? '', 2000),
      changeCounts: commit.changeCounts,
      count: changes.length,
      truncated: allChanges.length > args.top,
      changes,
    };
  },
});

const diffBranches = defineTool({
  name: 'diff_branches',
  toolset: 'repositories',
  title: 'Compare branches',
  description: 'Compares two branches: ahead/behind counts, common commit and the changed files.',
  readOnly: true,
  input: { ...repoShape, baseBranch: z.string().min(1), targetBranch: z.string().min(1), top: topArg(100, 2000) },
  async handler(args, { client, resolver }) {
    const { scope, repository, base } = await repoScope(resolver, args);
    const diff = await client.get<{
      aheadCount?: number;
      behindCount?: number;
      commonCommit?: string;
      allChangesIncluded?: boolean;
      changeCounts?: Record<string, number>;
      changes?: Array<{ item?: { path?: string }; changeType?: string }>;
    }>({
      ...targetOf(scope),
      path: `${base}/diffs/commits`,
      area: 'git',
      query: {
        baseVersion: shortRef(args.baseBranch),
        baseVersionType: 'branch',
        targetVersion: shortRef(args.targetBranch),
        targetVersionType: 'branch',
        diffCommonCommit: true,
        $top: args.top + 1,
      },
    });
    const allChanges = diff.changes ?? [];
    const changes = allChanges.slice(0, args.top).map((change) => ({ path: change.item?.path, changeType: change.changeType }));
    return {
      repository,
      baseBranch: args.baseBranch,
      targetBranch: args.targetBranch,
      aheadCount: diff.aheadCount,
      behindCount: diff.behindCount,
      commonCommit: diff.commonCommit,
      allChangesIncluded: diff.allChangesIncluded,
      changeCounts: diff.changeCounts,
      count: changes.length,
      truncated: allChanges.length > args.top || diff.allChangesIncluded === false,
      changes,
    };
  },
});

export const repositoryTools: AnyTool[] = [
  listRepositories,
  getRepository,
  createRepository,
  listBranches,
  listRepositoryItems,
  getFileContent,
  listCommits,
  getCommit,
  diffBranches,
];
