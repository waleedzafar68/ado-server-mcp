import type { ServerConfig } from '../config/env.js';

export function buildInstructions(config: ServerConfig, toolCount: number): string {
  const lines = [
    `ado-server-mcp exposes ${toolCount} tools for self-hosted Azure DevOps Server (2020 and 25H2). Every call runs with the caller's own PAT and permissions.`,
    '',
    'Context:',
    '1. If the user is working in a local repository and did not name a collection, project or repository, run `git remote get-url origin` and pass the result as gitRemoteUrl. Or call resolve_repo_context once at the start and reuse its collection/project/repository. TFVC projects have no git remote: pass the server path (for example $/Legacy/Main) and the tfvc tools take the project from it.',
    '2. When a tool returns status "disambiguation_required", show its options to the user and ask which one to use. Never guess.',
    '3. When authentication fails or you need to know which collections are reachable, call whoami_and_collections.',
    '',
    'Efficiency:',
    '4. For work items, request specific fields; query_work_items can hydrate results in one call.',
    '5. For failed builds, call get_build_timeline with onlyProblems=true before reading get_build_log with tailLines or a line range.',
    '6. Long text is windowed: pass startLine/endLine/maxChars to read more.',
    '',
    'Safety:',
    '7. Only create, update, comment, vote, approve, complete, abandon, queue or deploy when the user explicitly asked for that change.',
    '8. Completing or abandoning pull requests, approving or deploying releases, creating releases, queuing builds and writing wiki pages ask the user to confirm first. If a tool returns [confirmation_required] or [declined], tell the user and do not retry on your own.',
  ];
  if (config.readOnly) lines.push('9. This server is read-only: write tools are not available.');
  return lines.join('\n');
}