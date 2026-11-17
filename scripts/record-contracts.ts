// Records real Azure DevOps Server responses into tests/contracts/<flavor>.json for the replay test.
// The PAT comes only from ADO_PAT and never reaches the output: the scrubber masks it and the write is refused if it survives.
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config/env.js';
import { createDeps } from '../src/deps.js';
import { createMcpServer } from '../src/server.js';
import { basicAuth } from '../src/ado/http.js';
import { contractEnv, queryKey, replayHeaders, requestKey, Scrubber, type ContractCall, type ContractFixture, type Exchange } from '../tests/contracts/contract-format.js';

interface ReadOptions {
  fetchFn: typeof fetch;
  maxResponseBytes: number;
  timeoutMs: number;
}

interface RecordingOptions extends ReadOptions {
  serverUrl: string;
  scrubber: Scrubber;
  exchanges: Exchange[];
}

// Read once: cloning/teeing a response before enforcing the limit can buffer without bound,
// and awaiting cancellation on one branch of a tee can deadlock on the unread branch.
async function boundedFetch(input: Parameters<typeof fetch>[0], init: RequestInit | undefined, options: ReadOptions): Promise<{ response: Response; bytes: Buffer }> {
  const controller = new AbortController();
  const caller = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
  const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new DOMException('Contract response timed out.', 'TimeoutError')), options.timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => {
      // Cancellation must not hold the deadline open if the upstream stream ignores it.
      if (reader) void reader.cancel().catch(() => undefined);
      else void response?.body?.cancel().catch(() => undefined);
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([cancelled, (async () => {
      signal.throwIfAborted();
      response = await options.fetchFn(input, { ...init, signal });
      if (signal.aborted) void response.body?.cancel().catch(() => undefined);
      signal.throwIfAborted();
      const declared = Number(response.headers.get('content-length'));
      if (declared > options.maxResponseBytes) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error('Response exceeded ADO_MAX_RESPONSE_BYTES.');
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (response.body) {
        reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          total += value.byteLength;
          if (total > options.maxResponseBytes) {
            void reader.cancel().catch(() => undefined);
            throw new Error('Response exceeded ADO_MAX_RESPONSE_BYTES.');
          }
          chunks.push(value);
        }
      }
      return { response, bytes: Buffer.concat(chunks) };
    })()]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export function createRecordingFetch(options: RecordingOptions): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const { response, bytes } = await boundedFetch(input, init, options);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const contentType = response.headers.get('content-type') ?? '';
    const location = response.headers.get('location');
    options.scrubber.learnDomains([...url.searchParams]);
    const key = requestKey(url, options.serverUrl, (value) => options.scrubber.text(value));
    options.exchanges.push({
      method, path: options.scrubber.text(key.path), query: key.query, status: response.status,
      contentType: options.scrubber.text(contentType),
      ...(location ? { location: options.scrubber.text(location) } : {}),
      headers: Object.fromEntries(Object.entries(replayHeaders(response.headers)).map(([key, value]) => [key, options.scrubber.text(value)])),
      body: options.scrubber.body(bytes.toString('utf8'), contentType),
    });
    const empty = response.body === null || [204, 205, 304].includes(response.status) || method === 'HEAD';
    const rebuilt = new Response(empty ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    // These read-only fetch properties are not constructor options.
    Object.defineProperties(rebuilt, {
      url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
    });
    return rebuilt;
  };
}

interface LogOptions extends ReadOptions {
  serverUrl: string;
  collection: string;
  project: string;
  buildId: number;
  logId: number;
  apiVersion: string;
  pat: string;
  scrubber: Scrubber;
}

// Independent ground truth, outside the build-log tool and outside the exchange recorder.
export async function downloadLogHead(options: LogOptions): Promise<string[]> {
  const url = `${options.serverUrl}/${encodeURIComponent(options.collection)}/${encodeURIComponent(options.project)}/_apis/build/builds/${options.buildId}/logs/${options.logId}?api-version=${encodeURIComponent(options.apiVersion)}`;
  const { response, bytes } = await boundedFetch(url, {
    headers: { authorization: basicAuth(options.pat), accept: 'text/plain' }, redirect: 'manual',
  }, options);
  if (!response.ok) throw new Error(`Downloading the full log failed: HTTP ${response.status}`);
  return bytes.toString('utf8').split(/\r?\n/).slice(0, 3).map((line) => options.scrubber.text(line));
}

export function serializeFixture(fixture: ContractFixture, scrubber: Scrubber, pat: string): string {
  // Later calls/bodies can teach a domain absent when an earlier query was recorded.
  // Discover all remaining domains before re-scrubbing decoded query parts, then encode.
  scrubber.learnDomains(fixture);
  for (const exchange of fixture.exchanges) scrubber.learnDomains([...new URLSearchParams(exchange.query)]);
  const complete = { ...fixture, exchanges: fixture.exchanges.map((exchange) => ({
    ...exchange, query: queryKey(new URLSearchParams(exchange.query), (value) => scrubber.text(value)),
    // Parse structured bodies again under the complete domain knowledge, retaining
    // the stable identity/agent aliases assigned when the response was recorded.
    body: scrubber.body(exchange.body, exchange.contentType, false),
  })) };
  // Scrub metadata as well as HTTP bodies: paths, query strings, headers and call arguments
  // can contain credentials or personal data, including JSON object keys.
  const out = JSON.stringify(JSON.parse(scrubber.body(JSON.stringify(complete), 'application/json')), null, 2);
  const escaped = JSON.stringify(pat).slice(1, -1);
  if (!pat || out.includes(pat) || out.includes(escaped)) throw new Error('Refusing to write the fixture: it still contains the PAT.');
  return `${out}\n`;
}

async function main(): Promise<void> {
  const env = process.env;
  const pat = env.ADO_PAT;
  if (!pat) {
    console.error('Set ADO_PAT to a PAT with read scopes. It is used only in memory.');
    process.exit(2);
  }

  const flavor: ContractFixture['flavor'] = env.ADO_RECORD_FLAVOR === 'server-25h2' ? 'server-25h2' : 'server-2020';
  const serverUrl = (env.ADO_RECORD_SERVER_URL ?? 'https://devops.example.com/tfs').replace(/\/+$/, '');
  const collection = env.ADO_RECORD_COLLECTION ?? 'DemoCollection';
  const project = env.ADO_RECORD_PROJECT ?? 'DemoProject';
  const repository = env.ADO_RECORD_REPOSITORY ?? 'ado-server-mcp';
  const tfvcCollection = env.ADO_RECORD_TFVC_COLLECTION;
  const tfvcPath = env.ADO_RECORD_TFVC_PATH;
  const collections = tfvcCollection && tfvcPath && tfvcCollection !== collection ? [collection, tfvcCollection] : [collection];

  const scrubber = new Scrubber(new URL(serverUrl).host, [pat, Buffer.from(`:${pat}`).toString('base64'), encodeURIComponent(pat)]);
  const exchanges: Exchange[] = [];
  const config = loadConfig({ ...contractEnv(serverUrl, collections, pat),
    ...(env.ADO_MAX_RESPONSE_BYTES ? { ADO_MAX_RESPONSE_BYTES: env.ADO_MAX_RESPONSE_BYTES } : {}),
    ...(env.ADO_REQUEST_TIMEOUT_MS ? { ADO_REQUEST_TIMEOUT_MS: env.ADO_REQUEST_TIMEOUT_MS } : {}),
  });
  const recordingFetch = createRecordingFetch({ fetchFn: fetch, serverUrl, scrubber, exchanges, maxResponseBytes: config.maxResponseBytes, timeoutMs: config.requestTimeoutMs });
  const deps = createDeps(config, recordingFetch);
  const server = createMcpServer(deps, { ctx: deps.contextFor() });
  const client = new Client({ name: 'record-contracts', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  const calls: ContractCall[] = [];
  const facts: ContractFixture['facts'] = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function call(label: string, tool: string, args: Record<string, unknown>): Promise<any> {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? '').join('\n');
    if (result.isError) throw new Error(`Contract call failed: ${label} (${tool}).`);
    calls.push({ label, tool, args });
    console.log(`recorded ${label}`);
    return JSON.parse(text);
  }

  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    const identity = await call('whoami', 'whoami_and_collections', {});
    await call('projects', 'list_projects', { collection, top: 5 });
    await call('repositories', 'list_repositories', { collection, project, top: 5 });
    await call('pull-requests', 'list_pull_requests', { collection, project, repository, status: 'all', top: 3 });
    const builds = await call('builds', 'list_builds', { collection, project, status: 'completed', top: 5 });
    const buildId: number | undefined = builds.builds[0]?.id;
    if (!buildId) throw new Error(`No completed builds in ${project}. Set ADO_RECORD_PROJECT to a project that has builds.`);
    const timeline = await call('timeline', 'get_build_timeline', { collection, project, buildId });
    const logId: number | undefined = timeline.records.find((record: { type?: string; logId?: number }) => record.type === 'Task' && record.logId)?.logId;
    if (!logId) throw new Error(`Build ${buildId} has no task logs.`);
    await call('log-tail', 'get_build_log', { collection, project, buildId, logId, tailLines: 20, maxChars: 100_000 });
    await call('log-head', 'get_build_log', { collection, project, buildId, logId, startLine: 1, endLine: 3, maxChars: 100_000 });
    facts.logHead = await downloadLogHead({ fetchFn: fetch, serverUrl, collection, project, buildId, logId,
      apiVersion: identity.collections[0].apiVersion, pat, scrubber, maxResponseBytes: config.maxResponseBytes, timeoutMs: config.requestTimeoutMs });
    await call('wikis', 'list_wikis', { collection, project });
    if (tfvcCollection && tfvcPath) {
      const items = await call('tfvc-items', 'list_tfvc_items', { collection: tfvcCollection, path: tfvcPath, recursion: 'full', top: 50 });
      const file = items.items.find((item: { isFolder?: boolean; size?: number }) => !item.isFolder && (item.size ?? 1) > 0);
      if (file) await call('tfvc-file', 'get_tfvc_file_content', { collection: tfvcCollection, path: file.path, endLine: 20, maxChars: 20_000 });
      else console.log('no non-empty TFVC file in the first 50 items: tfvc-file not recorded');
      await call('changesets', 'list_changesets', { collection: tfvcCollection, path: tfvcPath, top: 3 });
    }

    const fixture: ContractFixture = {
      flavor,
      recordedAt: new Date().toISOString(),
      serverUrl: scrubber.text(serverUrl),
      collections,
      calls,
      facts,
      exchanges,
    };
    const out = serializeFixture(fixture, scrubber, pat);
    await writeFile(new URL(`../tests/contracts/${flavor}.json`, import.meta.url), out, 'utf8');
    console.log(`wrote tests/contracts/${flavor}.json: ${calls.length} calls, ${exchanges.length} HTTP exchanges`);
  } finally {
    try { await client.close(); } finally { await server.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Raw tool, config, URL and fetch errors may contain credentials. Do not print them.
    console.error('Contract recording failed; no fixture was written. Check VPN, read scopes, recording inputs and response budgets.');
    process.exitCode = 1;
  });
}
