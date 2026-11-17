#!/usr/bin/env node
// Live smoke test for a running ado-server-mcp. Reads always; TFVC and writes are opt-in.
// Credentials come only from environment variables. Every printed value is scrubbed.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const env = process.env;
const url = env.ADO_SMOKE_URL ?? 'http://127.0.0.1:8080/mcp';
const pat = env.ADO_SMOKE_PAT;
const token = env.ADO_MCP_TOKEN;
const collections = env.ADO_SMOKE_COLLECTIONS ?? 'DemoCollection';
const remote = env.ADO_SMOKE_REMOTE ?? 'https://devops.example.com/tfs/DemoCollection/DemoProject/_git/ado-server-mcp';
const writeProject = env.ADO_SMOKE_WRITE_PROJECT;
const writeCollection = env.ADO_SMOKE_WRITE_COLLECTION ?? collections.split(',')[0].trim();
const doneState = env.ADO_SMOKE_WRITE_DONE_STATE ?? 'Removed';

const secretForms = new Set();
for (const secret of [pat, token].filter((value) => typeof value === 'string' && value.length > 0)) {
  const forms = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), encodeURI(secret), new URLSearchParams({ s: secret }).toString().slice(2)];
  for (const raw of [secret, `:${secret}`]) {
    forms.push(Buffer.from(raw).toString('base64'), Buffer.from(raw).toString('base64url'));
  }
  for (const form of forms) {
    secretForms.add(form);
    secretForms.add(form.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()));
  }
}
const secrets = [...secretForms].sort((a, b) => b.length - a.length);
const scrub = (value) => secrets.reduce((text, secret) => text.split(secret).join('***'), String(value));
const log = (value) => console.log(scrub(value));
const errorLog = (value) => console.error(scrub(value));
const message = (error) => error instanceof Error ? error.message : String(error);

if (!pat) {
  errorLog('Set ADO_SMOKE_PAT to the PAT to test with. It is sent only as Authorization: Bearer <PAT>.');
  process.exit(2);
}

const headers = { Authorization: `Bearer ${pat}`, 'X-ADO-Collections': collections };
if (token) headers['X-ADO-MCP-Token'] = token;
if (env.ADO_SMOKE_SERVER_URL) headers['X-ADO-Server-URL'] = env.ADO_SMOKE_SERVER_URL;
if (writeProject) headers['X-ADO-Allow-Destructive'] = 'true';

const state = {};
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const step = (tool, args, options = {}) => ({ tool, args: typeof args === 'function' ? args : () => args, ...options });
const positiveInteger = (value, field) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Expected a positive integer ${field}.`);
  return value;
};
const steps = [
  step('whoami_and_collections', {}),
  step('resolve_repo_context', { gitRemoteUrl: remote }),
  step('list_projects', { gitRemoteUrl: remote, top: 10 }),
  step('list_branches', { gitRemoteUrl: remote, top: 5 }),
  step('list_pull_requests', { gitRemoteUrl: remote, status: 'all', top: 3 }),
  step('list_builds', { gitRemoteUrl: remote, top: 3 }),
];

if (env.ADO_SMOKE_TFVC_PATH) {
  const tfvc = { collection: env.ADO_SMOKE_TFVC_COLLECTION ?? 'Projects', path: env.ADO_SMOKE_TFVC_PATH };
  steps.push(step('list_tfvc_items', { ...tfvc, top: 10 }), step('list_changesets', { ...tfvc, top: 3 }));
}

if (writeProject) {
  const scope = { collection: writeCollection, project: writeProject };
  const title = `ado-server-mcp smoke ${stamp}`;
  const workItems = { group: 'work items' };
  steps.push(
    step('create_work_item', { ...scope, type: 'Task', title }, {
      ...workItems, critical: true,
      save: (json) => {
        // Retain a valid id for cleanup even if the revision is malformed.
        state.workItem = positiveInteger(json?.id, 'work item id');
        state.rev = positiveInteger(json?.rev, 'work item revision');
      },
    }),
    step('update_work_item', () => ({ collection: writeCollection, id: state.workItem, title: `${title} (updated)`, comment: 'ado-server-mcp smoke: update', expectedRevision: state.rev }), workItems),
    step('update_work_item', () => ({ collection: writeCollection, id: state.workItem, title: 'must not apply', expectedRevision: state.rev }), { ...workItems, label: 'stale revision', expectError: /^\[conflict\]/ }),
    step('add_work_item_comment', () => ({ ...scope, id: state.workItem, text: 'ado-server-mcp smoke comment' }), workItems),
  );
  if (env.ADO_SMOKE_WRITE_WIKI) {
    const page = { ...scope, wiki: env.ADO_SMOKE_WRITE_WIKI, path: `/ado-server-mcp-smoke-${stamp}` };
    const wiki = { group: 'wiki' };
    steps.push(
      step('create_or_update_wiki_page', { ...page, content: '# smoke\n\ncreated' }, {
        ...wiki, critical: true, label: 'create',
        save: (json) => {
          if (typeof json?.eTag !== 'string' || !json.eTag.trim()) throw new Error('Expected a nonempty wiki eTag.');
          state.eTag = json.eTag;
        },
      }),
      step('create_or_update_wiki_page', () => ({ ...page, content: '# smoke\n\nupdated', eTag: state.eTag }), { ...wiki, label: 'update with eTag' }),
      step('create_or_update_wiki_page', { ...page, content: '# smoke\n\nmust not apply' }, { ...wiki, label: 'update without eTag', expectError: /^\[conflict\]/ }),
    );
  }
  if (env.ADO_SMOKE_WRITE_REPOSITORY && env.ADO_SMOKE_WRITE_BRANCH) {
    const pr = { group: 'pull request' };
    steps.push(
      step('create_pull_request', { ...scope, repository: env.ADO_SMOKE_WRITE_REPOSITORY, sourceBranch: env.ADO_SMOKE_WRITE_BRANCH, title, isDraft: false }, {
        ...pr, critical: true, save: (json) => { state.pr = positiveInteger(json?.id, 'pull request id'); },
      }),
      step('vote_on_pull_request', () => ({ collection: writeCollection, pullRequestId: state.pr, vote: 'wait_for_author' }), pr),
      step('vote_on_pull_request', () => ({ collection: writeCollection, pullRequestId: state.pr, vote: 'reset' }), { ...pr, label: 'reset' }),
      step('update_pull_request_status', () => ({ collection: writeCollection, pullRequestId: state.pr, action: 'abandon' }), { ...pr, cleanup: () => state.pr !== undefined }),
    );
  }
  steps.push(step('update_work_item', () => ({ collection: writeCollection, id: state.workItem, state: doneState }), {
    ...workItems, label: `clean up: ${doneState}`, cleanup: () => state.workItem !== undefined,
  }));
}

let failures = 0;
let client;
const skippedGroups = new Set();
try {
  client = new Client({ name: 'ado-server-mcp-smoke', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  const { tools } = await client.listTools();
  log(`connected to ${url}: ${tools.length} tools`);
  for (const { tool, args, label, expectError, save, critical, group, cleanup } of steps) {
    const name = `${tool}${label ? ` (${label})` : ''}`;
    if (cleanup ? !cleanup() : group && skippedGroups.has(group)) {
      log(`\n=== ${name}: skipped`);
      continue;
    }
    const giveUp = () => {
      if (!critical || !group) return;
      log(`critical step failed: skipping the rest of the ${group} steps`);
      skippedGroups.add(group);
    };
    let result;
    try {
      result = await client.callTool({ name: tool, arguments: args() });
    } catch (error) {
      failures += 1;
      log(`\n=== ${name}: FAIL (${message(error)})`);
      giveUp();
      continue;
    }
    const text = (result.content ?? []).map((part) => part.type === 'text' ? part.text : `[${part.type}]`).join('\n');
    const leaked = scrub(text) !== text;
    let parseError;
    // Capture cleanup identifiers even when a successful create also leaks a secret.
    if (save && !result.isError) {
      try { save(JSON.parse(text)); } catch (error) { parseError = error; }
    }
    const ok = !leaked && !parseError && (expectError ? result.isError === true && expectError.test(text) : !result.isError);
    if (!ok) failures += 1;
    const verdict = leaked ? 'FAIL (output contains a secret)' : ok ? (expectError ? 'ok (expected error)' : 'ok') : 'FAIL';
    log(`\n=== ${name}: ${verdict}`);
    log(scrub(text).slice(0, 2000));
    if (parseError) log(`could not read the result: ${message(parseError)}`);
    if (!ok) giveUp();
  }
} catch (error) {
  failures += 1;
  errorLog(`smoke test aborted: ${message(error)}`);
} finally {
  if (client) {
    try { await client.close(); } catch (error) {
      failures += 1;
      errorLog(`could not close smoke client: ${message(error)}`);
    }
  }
}

log(`\n${failures === 0 ? 'SMOKE PASSED' : `SMOKE FAILED (${failures})`}`);
process.exitCode = failures === 0 ? 0 : 1;
