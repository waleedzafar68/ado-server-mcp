import { afterEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../helpers/harness.js';

const EXPECTED: Record<string, string[]> = {
  context: ['whoami_and_collections', 'resolve_repo_context'],
  projects: ['list_projects', 'get_project', 'list_teams', 'list_team_members'],
  workitems: [
    'query_work_items', 'get_work_item', 'get_work_items', 'get_work_item_revisions', 'create_work_item', 'update_work_item',
    'list_work_item_comments', 'add_work_item_comment', 'link_work_item', 'add_work_item_attachment', 'my_work_items',
  ],
  queries: ['list_queries', 'run_saved_query', 'list_work_item_types', 'list_work_item_states', 'list_areas', 'list_iterations'],
  boards: ['list_boards', 'get_board_columns', 'list_sprints', 'get_current_sprint', 'get_sprint_work_items', 'get_sprint_capacity'],
  repositories: [
    'list_repositories', 'get_repository', 'create_repository', 'list_branches', 'list_repository_items', 'get_file_content',
    'list_commits', 'get_commit', 'diff_branches',
  ],
  pullrequests: [
    'list_pull_requests', 'list_my_pull_requests', 'get_pull_request', 'create_pull_request', 'update_pull_request',
    'update_pull_request_status', 'get_pull_request_changes', 'get_pull_request_policies', 'list_pull_request_work_items',
    'link_pull_request_to_work_item', 'list_pull_request_threads', 'add_pull_request_comment', 'reply_to_pull_request_thread',
    'set_pull_request_thread_status', 'vote_on_pull_request', 'manage_pull_request_reviewers',
  ],
  builds: ['list_build_definitions', 'list_builds', 'get_build', 'queue_build', 'get_build_timeline', 'get_build_log', 'list_build_artifacts'],
  releases: [
    'list_release_definitions', 'list_releases', 'get_release', 'create_release', 'list_release_approvals',
    'update_release_approval', 'deploy_release_environment',
  ],
  wiki: ['list_wikis', 'list_wiki_pages', 'get_wiki_page', 'create_or_update_wiki_page'],
  tfvc: ['list_tfvc_items', 'get_tfvc_file_content', 'list_changesets', 'get_changeset', 'list_shelvesets', 'get_shelveset'],
};
const ALL_NAMES = Object.values(EXPECTED).flat();

describe('published catalog', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('publishes exactly the 78 specified tools with annotations', async () => {
    h = await startHarness();
    const { tools } = await h.client.listTools();
    expect(ALL_NAMES).toHaveLength(78);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...ALL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(tool.description?.length ?? 0).toBeGreaterThan(20);
      expect(tool.annotations).toMatchObject({ openWorldHint: true });
      expect(typeof tool.annotations?.readOnlyHint).toBe('boolean');
    }
    expect(tools.filter((tool) => tool.annotations?.readOnlyHint)).toHaveLength(58);
    expect(tools.filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name).sort()).toEqual([
      'create_or_update_wiki_page', 'create_release', 'deploy_release_environment', 'queue_build', 'update_pull_request_status', 'update_release_approval',
    ]);
    expect(h.client.getInstructions()).toContain('78 tools');
  });

  it('publishes only the 58 read-only tools in read-only mode', async () => {
    h = await startHarness({ env: { ADO_MCP_READ_ONLY: 'true' } });
    const { tools } = await h.client.listTools();
    expect(tools).toHaveLength(58);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(h.client.getInstructions()).toContain('read-only');
  });

  it('filters by toolset and always keeps context tools', async () => {
    h = await startHarness({ env: { ADO_MCP_TOOLSETS: 'wiki,builds' } });
    const names = (await h.client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...EXPECTED.context, ...EXPECTED.wiki, ...EXPECTED.builds].sort());
  });

  it('narrows tools/list to the caller toolsets and read-only flag', async () => {
    h = await startHarness({ caller: { toolsets: new Set(['wiki'] as const), readOnly: true } });
    const names = (await h.client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...EXPECTED.context, 'list_wikis', 'list_wiki_pages', 'get_wiki_page'].sort());
  });

  it('offers workflow prompts that drive the tools', async () => {
    h = await startHarness();
    const { prompts } = await h.client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual(['diagnose_build_failure', 'review_pull_request', 'sprint_status']);
    const review = await h.client.getPrompt({ name: 'review_pull_request', arguments: { pullRequestId: '101' } });
    const text = (review.messages[0]?.content as { text: string }).text;
    expect(text).toContain('101');
    expect(text).toContain('get_pull_request_changes');
    expect(text).toContain('get_pull_request_policies');
    const build = await h.client.getPrompt({ name: 'diagnose_build_failure', arguments: { buildId: '900' } });
    expect((build.messages[0]?.content as { text: string }).text).toContain('get_build_timeline');
  });
});
