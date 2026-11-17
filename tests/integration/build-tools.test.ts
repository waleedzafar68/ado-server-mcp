import { afterEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness, type HarnessOptions } from '../helpers/harness.js';

const BUILD = {
  id: 900,
  buildNumber: '20261116.1',
  status: 'completed',
  result: 'failed',
  definition: { id: 12, name: 'ado-server-mcp-ci' },
  sourceBranch: 'refs/heads/develop',
  sourceVersion: 'abc123',
  requestedFor: { displayName: 'Jordan Example', uniqueName: 'CORPTEST\\demo.user' },
  reason: 'individualCI',
  queueTime: '2026-11-16T10:00:00Z',
  startTime: '2026-11-16T10:01:00Z',
  finishTime: '2026-11-16T10:05:00Z',
  repository: { name: 'ado-server-mcp' },
  _links: { web: { href: 'https://devops.example.com/tfs/DemoCollection/DemoProject/_build/results?buildId=900' } },
};
const LOG = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n');

describe('build tools', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function start(options: HarnessOptions = {}): Promise<Harness> {
    h = await startHarness({ ...options, env: { ADO_DEFAULT_PROJECT: 'DemoProject', ...options.env } });
    const mock = h.mock;
    mock.on('GET', /\/_apis\/build\/definitions$/, () => ({ json: { value: [{ id: 12, name: 'ado-server-mcp-ci', path: '\\', queueStatus: 'enabled', revision: 3 }] } }));
    mock.on('GET', /\/_apis\/build\/definitions\/12$/, () => ({ json: { id: 12, name: 'ado-server-mcp-ci', repository: { defaultBranch: 'refs/heads/develop' } } }));
    mock.on('GET', /\/_apis\/build\/builds$/, () => ({ json: { value: [BUILD] } }));
    mock.on('GET', /\/_apis\/build\/builds\/900$/, () => ({ json: BUILD }));
    mock.on('POST', /\/_apis\/build\/builds$/, () => ({ json: { ...BUILD, id: 901, status: 'notStarted', result: undefined } }));
    mock.on('GET', /\/_apis\/build\/builds\/900\/timeline$/, () => ({
      json: {
        records: [
          { id: 's1', type: 'Stage', name: 'Build', state: 'completed', result: 'failed', errorCount: 1 },
          { id: 't1', parentId: 's1', type: 'Task', name: 'npm test', state: 'completed', result: 'failed', log: { id: 7 }, errorCount: 1, issues: [{ type: 'error', message: 'Process completed with exit code 1.' }] },
          { id: 't2', parentId: 's1', type: 'Task', name: 'npm ci', state: 'completed', result: 'succeeded', log: { id: 6 } },
        ],
      },
    }));
    mock.on('GET', /\/_apis\/build\/builds\/900\/logs$/, () => ({ json: { value: [{ id: 6, lineCount: 20 }, { id: 7, lineCount: 300 }, { id: 8 }, { id: 9, lineCount: 300 }] } }));
    mock.on('GET', /\/_apis\/build\/builds\/900\/logs\/9$/, () => ({ text: LOG, contentType: 'text/plain' }));
    mock.on('GET', /\/_apis\/build\/builds\/900\/logs\/7$/, (r) => {
      const lines = LOG.split('\n');
      const start = Number(r.query.get('startLine') ?? 1);
      const end = Number(r.query.get('endLine') ?? lines.length);
      return { text: lines.slice(start - 1, end).join('\n'), contentType: 'text/plain' };
    });
    mock.on('GET', /\/_apis\/build\/builds\/900\/logs\/8$/, () => ({ text: LOG, contentType: 'text/plain' }));
    mock.on('GET', /\/_apis\/build\/builds\/900\/artifacts$/, () => ({ json: { value: [{ id: 1, name: 'drop', resource: { type: 'Container', downloadUrl: 'https://tfs/drop.zip' } }] } }));
    return h;
  }

  function terminatedLog(harness: Harness, visibleLines: number, ignoresRange = false): string[] {
    const lines = Array.from({ length: visibleLines }, (_, index) => `line ${index + 1}`);
    const text = `${lines.join('\n')}\n`;
    harness.mock.on('GET', /\/_apis\/build\/builds\/900\/logs$/, () => ({ json: { value: [{ id: 10, lineCount: visibleLines + 1 }] } }));
    harness.mock.on('GET', /\/_apis\/build\/builds\/900\/logs\/10$/, (request) => {
      const start = Number(request.query.get('startLine') ?? 1);
      const end = Number(request.query.get('endLine') ?? visibleLines + 1);
      return { text: ignoresRange ? text : text.split('\n').slice(start - 1, end).join('\n'), contentType: 'text/plain' };
    });
    return lines;
  }

  it('lists definitions and builds with mapped filters', async () => {
    const harness = await start();
    expect((await harness.call('list_build_definitions', { name: 'ado*' })).json.definitions[0]).toEqual({ id: 12, name: 'ado-server-mcp-ci', path: '\\', queueStatus: 'enabled', revision: 3 });
    const { json } = await harness.call('list_builds', { definitionId: 12, branch: 'develop', result: 'failed', top: 5 });
    expect(json.builds[0]).toMatchObject({ id: 900, buildNumber: '20261116.1', result: 'failed', definition: 'ado-server-mcp-ci', sourceBranch: 'develop', requestedFor: 'Jordan Example' });
    const query = harness.mock.requestsTo(/\/_apis\/build\/builds$/, 'GET').at(-1)?.query;
    expect([query?.get('definitions'), query?.get('branchName'), query?.get('resultFilter'), query?.get('$top')]).toEqual(['12', 'refs/heads/develop', 'failed', '6']);
  });

  it('caps builds after requesting one extra and reports whether more exist', async () => {
    const harness = await start();
    harness.mock.on('GET', /\/_apis\/build\/builds$/, () => ({ json: { value: [BUILD, { ...BUILD, id: 901 }, { ...BUILD, id: 902 }] } }));

    const capped = await harness.call('list_builds', { top: 2 });
    expect(capped.json).toMatchObject({ count: 2, truncated: true, builds: [{ id: 900 }, { id: 901 }] });
    expect(harness.mock.requestsTo(/\/_apis\/build\/builds$/, 'GET').at(-1)?.query.get('$top')).toBe('3');

    harness.mock.on('GET', /\/_apis\/build\/builds$/, () => ({ json: { value: [BUILD] } }));
    const complete = await harness.call('list_builds', { top: 2 });
    expect(complete.json).toMatchObject({ count: 1, truncated: false, builds: [{ id: 900 }] });
  });

  it('gets a build', async () => {
    const harness = await start();
    expect((await harness.call('get_build', { buildId: 900 })).json).toMatchObject({ id: 900, reason: 'individualCI', repository: 'ado-server-mcp', url: BUILD._links.web.href });
  });

  it('queues a build with variables and template parameters', async () => {
    const harness = await start();
    const { json } = await harness.call('queue_build', { definitionId: 12, branch: 'develop', variables: { configuration: 'Release' }, templateParameters: { env: 'dev' } });
    expect(json).toMatchObject({ queued: true, id: 901 });
    expect(harness.mock.requestsTo(/\/_apis\/build\/builds$/, 'POST').at(-1)?.body).toEqual({
      definition: { id: 12 },
      sourceBranch: 'refs/heads/develop',
      parameters: '{"configuration":"Release"}',
      templateParameters: { env: 'dev' },
    });
    const { tools } = await harness.client.listTools();
    expect(tools.find((tool) => tool.name === 'queue_build')?.annotations?.destructiveHint).toBe(true);
  });

  it('names the pipeline, branch and inputs when asking to queue', async () => {
    const harness = await start({ env: { ADO_ALLOW_DESTRUCTIVE: 'false' }, elicit: (field) => (field === 'confirm' ? 'false' : undefined) });
    const result = await harness.call('queue_build', { definitionId: 12, variables: { configuration: 'Release' }, templateParameters: { env: 'dev' } });
    expect(result.text).toMatch(/^\[declined\]/);
    expect(harness.elicitations[0]?.message).toMatch(/^Queue pipeline "ado-server-mcp-ci" \(definition 12\) on "develop" in "DemoProject" with variables "configuration"="Release" and parameters "env"="dev"\./);
    expect(harness.mock.requestsTo(/\/_apis\/build\/builds$/, 'POST')).toHaveLength(0);
  });

  it('shows only failing timeline records', async () => {
    const harness = await start();
    const { json } = await harness.call('get_build_timeline', { buildId: 900, onlyProblems: true });
    expect(json.records.map((r: { name: string }) => r.name)).toEqual(['Build', 'npm test']);
    expect(json.records[1]).toMatchObject({ logId: 7, issues: [{ type: 'error', message: 'Process completed with exit code 1.' }] });
  });

  it('filters timeline problems before capping and reports omitted issues', async () => {
    const harness = await start();
    const issues = Array.from({ length: 11 }, (_, index) => ({ type: 'error', message: `issue ${index + 1}` }));
    harness.mock.on('GET', /\/_apis\/build\/builds\/900\/timeline$/, () => ({ json: { records: [
      { id: 'ok', type: 'Task', name: 'passing', result: 'succeeded' },
      { id: 'problem-1', type: 'Task', name: 'failed 1', result: 'failed', issues },
      { id: 'problem-2', type: 'Task', name: 'failed 2', result: 'failed' },
    ] } }));

    const { json } = await harness.call('get_build_timeline', { buildId: 900, onlyProblems: true, top: 1 });
    expect(json).toMatchObject({ count: 1, truncated: true, records: [{ id: 'problem-1', issuesTruncated: true }] });
    expect(json.records[0].issues[0]).toMatchObject({ message: 'issue 1' });
    expect(json.records[0].issues).toHaveLength(10);
  });

  it('asks the server for an exact bounded tail and precise explicit ranges', async () => {
    const harness = await start();
    const tail = await harness.call('get_build_log', { buildId: 900, logId: 7 });
    expect(tail.json).toMatchObject({ startLine: 101, endLine: 300, totalLines: 300, truncated: false });
    expect(tail.json.text.split('\n')[0]).toBe('line 101');
    const request = harness.mock.requestsTo(/\/logs\/7$/).at(-1);
    expect(request?.headers.accept).toBe('text/plain');
    expect([request?.query.get('startLine'), request?.query.get('endLine')]).toEqual(['101', '300']);

    const range = await harness.call('get_build_log', { buildId: 900, logId: 7, startLine: 1, endLine: 2 });
    expect(range.json).toMatchObject({ text: 'line 1\nline 2', startLine: 1, endLine: 2 });

    const capped = await harness.call('get_build_log', { buildId: 900, logId: 7, startLine: 1, endLine: 300, maxChars: 30 });
    expect(capped.json).toMatchObject({ startLine: 1, endLine: 4, truncated: true });
  });

  it('preserves character truncation for a clipped single-line range', async () => {
    const harness = await start();
    harness.mock.on('GET', /\/_apis\/build\/builds\/900\/logs$/, () => ({ json: { value: [{ id: 10, lineCount: 1 }] } }));
    harness.mock.on('GET', /\/_apis\/build\/builds\/900\/logs\/10$/, () => ({ text: 'abcdefghij', contentType: 'text/plain' }));

    const { json } = await harness.call('get_build_log', { buildId: 900, logId: 10, startLine: 1, endLine: 1, maxChars: 3 });
    expect(json).toMatchObject({ text: 'abc', startLine: 1, endLine: 1, totalLines: 1, truncated: true });
  });

  it.each([
    { visibleLines: 10, startLine: 1, ranges: [['1', '11']] },
    { visibleLines: 21, startLine: 2, ranges: [['3', '22'], ['2', '22']] },
    { visibleLines: 300, startLine: 281, ranges: [['282', '301'], ['281', '301']] },
  ])('returns the complete visible tail when metadata counts the terminal empty row ($visibleLines visible lines)', async ({ visibleLines, startLine, ranges }) => {
    const harness = await start();
    const lines = terminatedLog(harness, visibleLines);
    const result = await harness.call('get_build_log', { buildId: 900, logId: 10, tailLines: 20, maxChars: 100_000 });
    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({ text: lines.slice(-20).join('\n'), startLine, endLine: visibleLines, totalLines: visibleLines, truncated: false });
    const requests = harness.mock.requestsTo(/\/logs\/10$/);
    expect(requests.map((request) => [request.query.get('startLine'), request.query.get('endLine')])).toEqual(ranges);
  });

  it('keeps absolute offsets and newest lines when a terminal-row tail is character-capped', async () => {
    const harness = await start();
    terminatedLog(harness, 300);
    const { json } = await harness.call('get_build_log', { buildId: 900, logId: 10, tailLines: 20, maxChars: 30 });
    expect(json).toMatchObject({ text: 'line 298\nline 299\nline 300', startLine: 298, endLine: 300, totalLines: 300, truncated: true });
  });

  it('preserves bounded 1-based ranges and normalizes a terminal empty row only when reaching it', async () => {
    const harness = await start();
    terminatedLog(harness, 10);
    const head = await harness.call('get_build_log', { buildId: 900, logId: 10, startLine: 1, endLine: 3 });
    expect(head.json).toMatchObject({ text: 'line 1\nline 2\nline 3', startLine: 1, endLine: 3, truncated: false });
    const end = await harness.call('get_build_log', { buildId: 900, logId: 10, startLine: 8, endLine: 11 });
    expect(end.json).toMatchObject({ text: 'line 8\nline 9\nline 10', startLine: 8, endLine: 10, totalLines: 10, truncated: false });
    const requests = harness.mock.requestsTo(/\/logs\/10$/);
    expect(requests.map((request) => [request.query.get('startLine'), request.query.get('endLine')])).toEqual([['1', '3'], ['8', '11']]);
  });

  it('normalizes visible line counts when the server ignores ranges and returns a terminated full log', async () => {
    const harness = await start();
    const lines = terminatedLog(harness, 300, true);
    const tail = await harness.call('get_build_log', { buildId: 900, logId: 10, tailLines: 20 });
    expect(tail.json).toMatchObject({ text: lines.slice(-20).join('\n'), startLine: 281, endLine: 300, totalLines: 300, truncated: false });
    const range = await harness.call('get_build_log', { buildId: 900, logId: 10, startLine: 5, endLine: 6 });
    expect(range.json).toMatchObject({ text: 'line 5\nline 6', startLine: 5, endLine: 6, totalLines: 300, truncated: false });
  });

  it('recognizes an ignored range at the terminal-row tail boundary', async () => {
    const harness = await start();
    const lines = terminatedLog(harness, 21, true);
    const { json } = await harness.call('get_build_log', { buildId: 900, logId: 10, tailLines: 20 });
    expect(json).toMatchObject({ text: lines.slice(1).join('\n'), startLine: 2, endLine: 21, totalLines: 21, truncated: false });
    const requests = harness.mock.requestsTo(/\/logs\/10$/);
    expect(requests.map((request) => [request.query.get('startLine'), request.query.get('endLine')])).toEqual([['3', '22']]);
  });

  it.each([
    { visibleLines: 20, tailLines: 20, ranges: [['2', '21'], ['1', '21']] },
    { visibleLines: 1, tailLines: 1, ranges: [['2', '2'], ['1', '2']] },
  ])('disambiguates an ignored full log containing exactly the requested $tailLines tail lines', async ({ visibleLines, tailLines, ranges }) => {
    const harness = await start();
    const lines = terminatedLog(harness, visibleLines, true);
    const { json } = await harness.call('get_build_log', { buildId: 900, logId: 10, tailLines });
    expect(json).toMatchObject({ text: lines.join('\n'), startLine: 1, endLine: visibleLines, totalLines: visibleLines, truncated: false });
    const requests = harness.mock.requestsTo(/\/logs\/10$/);
    expect(requests.map((request) => [request.query.get('startLine'), request.query.get('endLine')])).toEqual(ranges);
  });

  it.each([
    { ignoresRange: false, newline: false, ranges: [['2', '21']] },
    { ignoresRange: false, newline: true, ranges: [['2', '21'], ['1', '21']] },
    { ignoresRange: true, newline: false, ranges: [['2', '21']] },
    { ignoresRange: true, newline: true, ranges: [['2', '21']] },
  ])('preserves a 20-line tail with accurate metadata (ignoresRange=$ignoresRange, newline=$newline)', async ({ ignoresRange, newline, ranges }) => {
    const harness = await start();
    const lines = Array.from({ length: 21 }, (_, index) => `line ${index + 1}`);
    harness.mock.on('GET', /\/_apis\/build\/builds\/900\/logs$/, () => ({ json: { value: [{ id: 10, lineCount: 21 }] } }));
    harness.mock.on('GET', /\/_apis\/build\/builds\/900\/logs\/10$/, (request) => {
      const start = Number(request.query.get('startLine'));
      const end = Number(request.query.get('endLine'));
      const selected = ignoresRange ? lines : lines.slice(start - 1, end);
      return { text: selected.join('\n') + (newline ? '\n' : ''), contentType: 'text/plain' };
    });
    const { json } = await harness.call('get_build_log', { buildId: 900, logId: 10, tailLines: 20 });
    expect(json).toMatchObject({ text: lines.slice(1).join('\n'), startLine: 2, endLine: 21, totalLines: 21, truncated: false });
    const requests = harness.mock.requestsTo(/\/logs\/10$/);
    expect(requests.map((request) => [request.query.get('startLine'), request.query.get('endLine')])).toEqual(ranges);
  });

  it('recovers a one-line tail when the initial range contains only the terminal empty row', async () => {
    const harness = await start();
    terminatedLog(harness, 21);
    const { json } = await harness.call('get_build_log', { buildId: 900, logId: 10, tailLines: 1 });
    expect(json).toMatchObject({ text: 'line 21', startLine: 21, endLine: 21, totalLines: 21, truncated: false });
    const requests = harness.mock.requestsTo(/\/logs\/10$/);
    expect(requests.map((request) => [request.query.get('startLine'), request.query.get('endLine')])).toEqual([['22', '22'], ['21', '22']]);
  });

  it('keeps the newest lines when a ranged tail is character-capped', async () => {
    const harness = await start();
    const { json } = await harness.call('get_build_log', { buildId: 900, logId: 7, tailLines: 200, maxChars: 30 });

    expect(json).toMatchObject({ text: 'line 298\nline 299\nline 300', startLine: 298, endLine: 300, totalLines: 300, truncated: true });
    const request = harness.mock.requestsTo(/\/logs\/7$/).at(-1);
    expect([request?.query.get('startLine'), request?.query.get('endLine')]).toEqual(['101', '300']);
  });

  it('windows locally when the server does not report lineCount', async () => {
    const harness = await start();
    const { json } = await harness.call('get_build_log', { buildId: 900, logId: 8, tailLines: 2 });
    expect(json).toMatchObject({ text: 'line 299\nline 300', startLine: 299, endLine: 300, totalLines: 300 });
    expect(harness.mock.requestsTo(/\/logs\/8$/).at(-1)?.query.get('startLine')).toBeNull();
  });

  it('windows locally when the server ignores the requested range', async () => {
    const harness = await start();
    const { json } = await harness.call('get_build_log', { buildId: 900, logId: 9, startLine: 5, endLine: 6 });
    expect(json).toMatchObject({ text: 'line 5\nline 6', startLine: 5, endLine: 6, totalLines: 300 });
  });

  it('keeps the newest lines when an ignored ranged tail is character-capped', async () => {
    const harness = await start();
    const { json } = await harness.call('get_build_log', { buildId: 900, logId: 9, tailLines: 200, maxChars: 30 });

    expect(json).toMatchObject({ text: 'line 298\nline 299\nline 300', startLine: 298, endLine: 300, totalLines: 300, truncated: true });
    const request = harness.mock.requestsTo(/\/logs\/9$/).at(-1);
    expect([request?.query.get('startLine'), request?.query.get('endLine')]).toEqual(['101', '300']);
  });

  it('lists artifacts', async () => {
    const harness = await start();
    const { json } = await harness.call('list_build_artifacts', { buildId: 900 });
    expect(json).toMatchObject({ count: 1, truncated: false, artifacts: [{ id: 1, name: 'drop', type: 'Container', downloadUrl: 'https://tfs/drop.zip' }] });
    expect(harness.mock.requestsTo(/\/_apis\/build\/builds\/900\/artifacts$/, 'GET').at(-1)?.query.get('$top')).toBe('101');
  });

  it('caps artifacts at the requested top and reports complete results', async () => {
    const harness = await start();
    harness.mock.on('GET', /\/_apis\/build\/builds\/900\/artifacts$/, () => ({ json: { value: Array.from({ length: 3 }, (_, id) => ({ id, name: `artifact-${id}` })) } }));
    const capped = await harness.call('list_build_artifacts', { buildId: 900, top: 2 });
    expect(capped.json).toMatchObject({ count: 2, truncated: true, artifacts: [{ id: 0 }, { id: 1 }] });
    expect(harness.mock.requestsTo(/\/_apis\/build\/builds\/900\/artifacts$/, 'GET').at(-1)?.query.get('$top')).toBe('3');

    harness.mock.on('GET', /\/_apis\/build\/builds\/900\/artifacts$/, () => ({ json: { value: [{ id: 1, name: 'drop' }] } }));
    const complete = await harness.call('list_build_artifacts', { buildId: 900, top: 2 });
    expect(complete.json).toMatchObject({ count: 1, truncated: false, artifacts: [{ id: 1 }] });
  });
});
