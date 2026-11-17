import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { credentialRedactor, type HeaderBag } from '../context/caller-context.js';
import type { AppDeps } from '../deps.js';

function scopeHint(collection?: string, project?: string): string {
  const parts = [collection ? `collection "${collection}"` : undefined, project ? `project "${project}"` : undefined].filter(Boolean);
  return parts.length > 0
    ? `Use ${parts.join(' and ')}.`
    : 'If the collection or project is unclear, run `git remote get-url origin` and pass it as gitRemoteUrl, or call resolve_repo_context.';
}

export function registerPrompts(server: McpServer, deps: AppDeps): void {
  const userMessage = (text: string, headers?: HeaderBag) => ({
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: credentialRedactor(undefined, deps.config, headers)(text) } }],
  });
  server.registerPrompt(
    'review_pull_request',
    {
      title: 'Review a pull request',
      description: 'Reviews an Azure DevOps Server pull request: changes, policies and open comments.',
      argsSchema: {
        pullRequestId: z.string().describe('Pull request id.'),
        collection: z.string().optional(),
      },
    },
    ({ pullRequestId, collection }, extra) =>
      userMessage(
        [
          `Review pull request ${pullRequestId}. ${scopeHint(collection)}`,
          '1. Call get_pull_request for the description, reviewers and merge status.',
          '2. Call get_pull_request_changes and read the important changed files with get_file_content (use startLine/endLine for large files).',
          '3. Call get_pull_request_policies to see what blocks completion.',
          '4. Call list_pull_request_threads to see open review comments.',
          '5. Summarise: what the change does, risks and bugs, missing tests, and blocking policies.',
          'Do not vote, comment or complete the pull request unless I ask you to.',
        ].join('\n'),
        extra.requestInfo?.headers,
      ),
  );

  server.registerPrompt(
    'diagnose_build_failure',
    {
      title: 'Diagnose a failed build',
      description: 'Finds the failing step of a build and explains the error from its log.',
      argsSchema: {
        buildId: z.string().describe('Build id.'),
        collection: z.string().optional(),
        project: z.string().optional(),
      },
    },
    ({ buildId, collection, project }, extra) =>
      userMessage(
        [
          `Diagnose why build ${buildId} failed. ${scopeHint(collection, project)}`,
          '1. Call get_build for the pipeline, branch and commit.',
          '2. Call get_build_timeline with onlyProblems=true to find the failing task and its logId.',
          '3. Call get_build_log for that logId (the default tail is usually enough; widen with startLine/endLine if needed).',
          '4. Explain the root cause, quote the key error lines, and propose a fix. If the failure is in code, look up the file with get_file_content.',
          'Do not queue a new build unless I ask you to.',
        ].join('\n'),
        extra.requestInfo?.headers,
      ),
  );

  server.registerPrompt(
    'sprint_status',
    {
      title: 'Sprint status',
      description: "Summarises the team's current sprint: progress, risks and capacity.",
      argsSchema: {
        team: z.string().optional(),
        project: z.string().optional(),
        collection: z.string().optional(),
      },
    },
    ({ team, project, collection }, extra) =>
      userMessage(
        [
          `Give me the status of the current sprint${team ? ` for team "${team}"` : ''}. ${scopeHint(collection, project)}`,
          '1. Call get_current_sprint.',
          '2. Call get_sprint_work_items with fields System.Title, System.State, System.AssignedTo, Microsoft.VSTS.Scheduling.RemainingWork.',
          '3. Call get_sprint_capacity.',
          '4. Summarise done vs remaining work per person, items at risk, and whether remaining work fits the remaining capacity.',
        ].join('\n'),
        extra.requestInfo?.headers,
      ),
  );
}
