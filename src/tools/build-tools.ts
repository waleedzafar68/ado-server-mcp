import { z } from 'zod';
import { DEFAULT_MAX_CHARS, HARD_MAX_CHARS, truncate, windowText } from '../ado/bounded.js';
import { scopeShape, shortRef, targetOf, toRef, topArg } from './common.js';
import { defineTool, quoted, type AnyTool } from './registry.js';

interface ApiBuild {
  id: number;
  buildNumber?: string;
  status?: string;
  result?: string;
  definition?: { id?: number; name?: string };
  sourceBranch?: string;
  sourceVersion?: string;
  requestedFor?: { displayName?: string };
  reason?: string;
  queueTime?: string;
  startTime?: string;
  finishTime?: string;
  repository?: { name?: string };
  _links?: { web?: { href?: string } };
}

interface ApiTimelineRecord {
  id: string;
  parentId?: string;
  type?: string;
  name?: string;
  state?: string;
  result?: string;
  startTime?: string;
  finishTime?: string;
  log?: { id?: number } | null;
  errorCount?: number;
  warningCount?: number;
  issues?: Array<{ type?: string; message?: string }>;
}

const buildSummary = (build: ApiBuild) => ({
  id: build.id,
  buildNumber: build.buildNumber,
  status: build.status,
  result: build.result,
  definition: build.definition?.name,
  definitionId: build.definition?.id,
  sourceBranch: shortRef(build.sourceBranch),
  sourceVersion: build.sourceVersion,
  requestedFor: build.requestedFor?.displayName,
  queueTime: build.queueTime,
  startTime: build.startTime,
  finishTime: build.finishTime,
  url: build._links?.web?.href,
});

const buildIdArg = z.number().int().positive().describe('Build id.');
const PROBLEM_RESULTS = new Set(['failed', 'canceled', 'succeededWithIssues']);

const listBuildDefinitions = defineTool({
  name: 'list_build_definitions',
  toolset: 'builds',
  title: 'List build pipelines',
  description: 'Lists build pipelines (YAML and classic) in a project, optionally filtered by name (wildcards allowed).',
  readOnly: true,
  input: { ...scopeShape, name: z.string().min(1).optional().describe('Name filter, e.g. "ado*".'), top: topArg(100, 1000) },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const data = await client.get<{ value?: Array<{ id: number; name: string; path?: string; queueStatus?: string; revision?: number }> }>({
      ...targetOf(scope),
      path: '_apis/build/definitions',
      area: 'build',
      query: { name: args.name, $top: args.top + 1 },
    });
    const all = data.value ?? [];
    return {
      project: scope.project,
      count: Math.min(all.length, args.top),
      truncated: all.length > args.top,
      definitions: all.slice(0, args.top).map((d) => ({ id: d.id, name: d.name, path: d.path, queueStatus: d.queueStatus, revision: d.revision })),
    };
  },
});

const listBuilds = defineTool({
  name: 'list_builds',
  toolset: 'builds',
  title: 'List builds',
  description: 'Lists recent builds, newest first, filtered by pipeline, branch, status, result or requester.',
  readOnly: true,
  input: {
    ...scopeShape,
    definitionId: z.number().int().positive().optional(),
    branch: z.string().min(1).optional(),
    status: z.enum(['inProgress', 'completed', 'cancelling', 'postponed', 'notStarted', 'all']).optional(),
    result: z.enum(['succeeded', 'partiallySucceeded', 'failed', 'canceled']).optional(),
    requestedFor: z.string().min(1).optional().describe('DOMAIN\\user or email of the person the build was requested for.'),
    top: topArg(20, 200),
  },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const data = await client.get<{ value?: ApiBuild[] }>({
      ...targetOf(scope),
      path: '_apis/build/builds',
      area: 'build',
      query: {
        definitions: args.definitionId,
        branchName: args.branch ? toRef(args.branch) : undefined,
        statusFilter: args.status,
        resultFilter: args.result,
        requestedFor: args.requestedFor,
        queryOrder: 'queueTimeDescending',
        $top: args.top + 1,
      },
    });
    const all = data.value ?? [];
    const builds = all.slice(0, args.top).map(buildSummary);
    return { project: scope.project, count: builds.length, truncated: all.length > args.top, builds };
  },
});

const getBuild = defineTool({
  name: 'get_build',
  toolset: 'builds',
  title: 'Get build',
  description: 'Gets one build: status, result, branch, commit, reason, timings and web link.',
  readOnly: true,
  input: { ...scopeShape, buildId: buildIdArg },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const build = await client.get<ApiBuild>({ ...targetOf(scope), path: `_apis/build/builds/${args.buildId}`, area: 'build' });
    return { ...buildSummary(build), reason: build.reason, repository: build.repository?.name };
  },
});

const queueBuild = defineTool({
  name: 'queue_build',
  toolset: 'builds',
  title: 'Queue build',
  description:
    'Queues a build of a pipeline on a branch, with optional variables and YAML template (runtime) parameters. Pipelines can deploy, so the user is asked to confirm first.',
  readOnly: false,
  destructive: true,
  input: {
    ...scopeShape,
    definitionId: z.number().int().positive(),
    branch: z.string().min(1).optional().describe("Branch to build (default: the pipeline's default branch)."),
    variables: z.record(z.string(), z.string()).optional().describe('Queue-time variables, e.g. {"configuration": "Release"}.'),
    templateParameters: z.record(z.string(), z.string()).optional().describe('YAML runtime parameters.'),
  },
  async handler(args, { client, resolver, confirm }) {
    const scope = await resolver.resolve(args, { project: true });
    const definition = await client.get<{ id: number; name?: string; repository?: { defaultBranch?: string } }>({
      ...targetOf(scope),
      path: `_apis/build/definitions/${args.definitionId}`,
      area: 'build',
    });
    const pairs = (values: Record<string, string> | undefined) =>
      Object.entries(values ?? {}).map(([key, value]) => `${quoted(key, 40)}=${quoted(value, 60)}`).join(', ');
    const inputs = [
      args.variables ? `variables ${pairs(args.variables)}` : undefined,
      args.templateParameters ? `parameters ${pairs(args.templateParameters)}` : undefined,
    ].filter(Boolean);
    const branchName = shortRef(args.branch ? toRef(args.branch) : definition.repository?.defaultBranch);
    const branch = branchName ? quoted(branchName) : 'its default branch';
    await confirm(
      `Queue pipeline ${quoted(definition.name ?? args.definitionId)} (definition ${args.definitionId}) on ${branch} in ${quoted(scope.project)}${inputs.length > 0 ? ` with ${inputs.join(' and ')}` : ''}.`,
    );
    const build = await client.post<ApiBuild>({
      ...targetOf(scope),
      path: '_apis/build/builds',
      area: 'build',
      body: {
        definition: { id: args.definitionId },
        ...(args.branch ? { sourceBranch: toRef(args.branch) } : {}),
        ...(args.variables ? { parameters: JSON.stringify(args.variables) } : {}),
        ...(args.templateParameters ? { templateParameters: args.templateParameters } : {}),
      },
    });
    return { queued: true, ...buildSummary(build) };
  },
});

const getBuildTimeline = defineTool({
  name: 'get_build_timeline',
  toolset: 'builds',
  title: 'Get build timeline',
  description: 'Lists the stages, jobs and tasks of a build with result, issues and logId. Use onlyProblems=true to find what failed, then get_build_log.',
  readOnly: true,
  input: { ...scopeShape, buildId: buildIdArg, onlyProblems: z.boolean().default(false), top: topArg(200, 2000) },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const data = await client.get<{ records?: ApiTimelineRecord[] }>({ ...targetOf(scope), path: `_apis/build/builds/${args.buildId}/timeline`, area: 'build' });
    const filtered = (data.records ?? [])
      .filter((record) => !args.onlyProblems || PROBLEM_RESULTS.has(record.result ?? '') || (record.issues?.length ?? 0) > 0);
    const records = filtered
      .slice(0, args.top)
      .map((record) => ({
        id: record.id,
        parentId: record.parentId,
        type: record.type,
        name: record.name,
        state: record.state,
        result: record.result,
        logId: record.log?.id,
        errorCount: record.errorCount,
        warningCount: record.warningCount,
        issuesTruncated: (record.issues?.length ?? 0) > 10,
        issues: (record.issues ?? []).slice(0, 10).map((issue) => ({ type: issue.type, message: truncate(issue.message ?? '', 500) })),
      }));
    return { buildId: args.buildId, count: records.length, truncated: filtered.length > args.top, records };
  },
});

const getBuildLog = defineTool({
  name: 'get_build_log',
  toolset: 'builds',
  title: 'Read build log',
  description: `Reads a build log by logId (from get_build_timeline). By default returns the last 200 lines; use startLine/endLine or tailLines (max ${DEFAULT_MAX_CHARS} characters unless maxChars is set).`,
  readOnly: true,
  input: {
    ...scopeShape,
    buildId: buildIdArg,
    logId: z.number().int().positive(),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    tailLines: z.number().int().min(1).optional(),
    maxChars: z.number().int().min(1).max(HARD_MAX_CHARS).default(DEFAULT_MAX_CHARS),
  },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const target = targetOf(scope);
    const logPath = `_apis/build/builds/${args.buildId}/logs/${args.logId}`;
    const ids = { buildId: args.buildId, logId: args.logId };
    const ranged = args.startLine !== undefined || args.endLine !== undefined;
    const tailLines = ranged ? undefined : (args.tailLines ?? 200);

    const logs = await client.get<{ value?: Array<{ id: number; lineCount?: number }> }>({ ...target, path: `_apis/build/builds/${args.buildId}/logs`, area: 'build' });
    const lineCount = logs.value?.find((log) => log.id === args.logId)?.lineCount;
    if (lineCount === undefined) {
      const text = await client.get<string>({ ...target, path: logPath, area: 'build', accept: 'text' });
      return { ...ids, ...windowText(text, { startLine: args.startLine, endLine: args.endLine, tailLines, maxChars: args.maxChars }) };
    }

    // Keep the initial range exact so an ignored range returning just one extra
    // visible line is still distinguishable from the requested tail.
    let startLine = tailLines !== undefined ? Math.max(1, lineCount - tailLines + 1) : Math.max(1, args.startLine ?? 1);
    const endLine = tailLines !== undefined ? lineCount : Math.min(lineCount, args.endLine ?? lineCount);
    if (startLine > endLine) return { ...ids, text: '', startLine, endLine: startLine - 1, totalLines: lineCount, truncated: false };
    // Server line numbers are 1-based and inclusive; tests/contracts checks this against recorded server responses.
    let text = await client.get<string>({ ...target, path: logPath, area: 'build', accept: 'text', query: { startLine, endLine } });
    let window = windowText(text, tailLines !== undefined ? { tailLines, maxChars: args.maxChars } : { maxChars: args.maxChars });
    // Metadata can include the terminal empty row. Probe one row earlier after
    // an EOF shortage (including an empty one-row tail), or when a terminated
    // full log could exactly fill a range starting at row 2. Starting that probe
    // at row 1 resolves the latter ambiguity whether or not ranges are honored.
    const shortEof = window.totalLines === endLine - startLine && (text.endsWith('\n') || text === '');
    const ambiguousFullLog = startLine === 2 && text.endsWith('\n') && window.totalLines === lineCount - 1;
    if (tailLines !== undefined && startLine > 1 && (shortEof || ambiguousFullLog)) {
      startLine -= 1;
      text = await client.get<string>({ ...target, path: logPath, area: 'build', accept: 'text', query: { startLine, endLine } });
      window = windowText(text, { tailLines, maxChars: args.maxChars });
    }
    // Some servers ignore startLine/endLine and send the whole log.
    if (window.totalLines > endLine - startLine + 1) {
      const fullWindow = tailLines !== undefined
        ? window
        : windowText(text, { startLine, endLine, maxChars: args.maxChars });
      return { ...ids, ...fullWindow };
    }
    // Normalize only when an EOF range proves the metadata includes that terminal
    // empty row. A newline on a middle range does not establish the full log's count.
    const terminalRow = endLine === lineCount && text.endsWith('\n') && window.totalLines === endLine - startLine;
    const totalLines = terminalRow ? lineCount - 1 : lineCount;
    const absoluteStart = startLine + window.startLine - 1;
    const absoluteEnd = startLine + window.endLine - 1;
    return {
      ...ids,
      text: window.text,
      startLine: absoluteStart,
      endLine: absoluteEnd,
      totalLines,
      truncated: window.truncated || absoluteEnd < Math.min(endLine, totalLines),
    };
  },
});

const listBuildArtifacts = defineTool({
  name: 'list_build_artifacts',
  toolset: 'builds',
  title: 'List build artifacts',
  description: 'Lists the artifacts a build published, with download URLs.',
  readOnly: true,
  input: { ...scopeShape, buildId: buildIdArg, top: topArg(100, 1000) },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const data = await client.get<{ value?: Array<{ id: number; name: string; resource?: { type?: string; downloadUrl?: string } }> }>({
      ...targetOf(scope),
      path: `_apis/build/builds/${args.buildId}/artifacts`,
      area: 'build',
      query: { $top: args.top + 1 },
    });
    const all = data.value ?? [];
    const artifacts = all.slice(0, args.top).map((artifact) => ({ id: artifact.id, name: artifact.name, type: artifact.resource?.type, downloadUrl: artifact.resource?.downloadUrl }));
    return {
      buildId: args.buildId,
      count: artifacts.length,
      truncated: all.length > args.top,
      artifacts,
    };
  },
});

export const buildTools: AnyTool[] = [listBuildDefinitions, listBuilds, getBuild, queueBuild, getBuildTimeline, getBuildLog, listBuildArtifacts];
