# ado-server-mcp

A remote [Model Context Protocol](https://modelcontextprotocol.io) server targeting **self-hosted Azure DevOps Server 2020, 2022 and 25H2**. See the validation status below before relying on a version in production.
Everyone points their AI client at **one URL**. Each caller sends their own PAT and collection(s), and every action runs with **that caller's own Azure DevOps permissions**: no shared service account, no cookies, no stored credentials.

- REST version negotiation per collection: `6.0` on Server 2020 and `7.2` on 25H2, with automatic downgrade and preview retries.
- Works out the collection, project and repository from the terminal's git remote, or from a `$/Project/...` path for TFVC. When it can't tell, it **asks you** (MCP elicitation) and remembers the answer for the session. Clients that cannot ask get a `disambiguation_required` list.
- 78 tools (58 read-only) across 11 toolsets, Git and TFVC, plus 3 workflow prompts.
- Destructive actions (complete or abandon a PR, approve or deploy a release, create a release, queue a build, write a wiki page) ask you to confirm first.

## Supported versions and validation status

| Server | REST version target | Evidence in this repository |
|---|---|---|
| 2020 | `6.0`; WIT comments `6.0-preview.3` | Simulated integration coverage and nine live read calls verified with a local-only development recording. Internal recordings are excluded from Git. |
| 2022 | `7.0` / `7.1` | Negotiation compatibility target; no live 2022 validation or recording. |
| 25H2 | `7.2`; WIT comments `7.2-preview.4` | Simulated integration coverage only. A live 25H2 server is unavailable; live validation and recording remain pending. |

The local-only Server 2020 development recording covered identity/collections, projects, repositories, pull requests, builds, timeline, log tail, log head and wikis. It proves those nine read calls for the recorded internal setup, not the entire catalog or live write behavior. Live TFVC validation is explicitly held pending an approved collection/path; TFVC currently has simulated coverage only. No live write validation is claimed.

## Run it

Commands use PowerShell 7+ on Windows, from `C:\tools\ado-server-mcp`. Node.js 22+ is required outside Docker.

### Docker (recommended)

```powershell
Copy-Item .env.example .env          # then edit ADO_DEFAULT_SERVER_URL / ADO_ALLOWED_HOSTS / ADO_MCP_HTTP_TOKEN
New-Item -ItemType Directory -Force certs | Out-Null
# Optional: export your internal root CA as PEM to certs\ca.crt (see Troubleshooting)
docker compose up -d --build
Invoke-RestMethod http://127.0.0.1:8080/healthz
```

Put the container behind your HTTPS reverse proxy (IIS ARR, nginx or Traefik) and publish `https://<your-mcp-host>/mcp`.

- PATs travel in request headers: **publish the client endpoint over HTTPS**. The compose file publishes plain HTTP on `127.0.0.1:8080` only, for a proxy on the same host. If the proxy runs on another machine, bind a private interface (for example `10.0.0.5:8080:8080`), firewall it to the proxy and protect that inter-host hop with TLS or an encrypted tunnel. Never publish the plain HTTP backend on every interface.
- Turn off response buffering for `/mcp`, because the server streams Server-Sent Events. For nginx, use `proxy_buffering off; proxy_read_timeout 1h;`.
- Set `ADO_MCP_TRUST_PROXY` to the number of proxy hops (`1` for one proxy) or the proxy's address, so rate limiting sees real client addresses. `true` and any `/0` subnet (`0.0.0.0/0`, `::/0`, also inside a list) are refused: they would believe whatever `X-Forwarded-For` a caller sends. The hop count must equal the real number of proxies in front of the server; a higher number lets callers set their own address the same way.

### Node

The Node process reads its environment; it does not automatically load `.env`. The compose service loads `.env` using `env_file`. For a direct run, export the required settings in the shell:

```powershell
npm ci
npm run build
$env:ADO_DEFAULT_SERVER_URL = 'https://devops.example.com/tfs'
npm start        # listens on http://127.0.0.1:8080/mcp
```

### Local stdio mode (single user, no HTTP)

This example uses Cursor's environment interpolation; build the project first.

```json
{
  "mcpServers": {
    "ado-server-local": {
      "command": "node",
      "args": ["C:/tools/ado-server-mcp/dist/index.js"],
      "env": {
        "ADO_MCP_TRANSPORT": "stdio",
        "ADO_DEFAULT_SERVER_URL": "https://devops.example.com/tfs",
        "ADO_PAT": "${env:ADO_PAT}",
        "ADO_COLLECTIONS": "DemoCollection,LegacyCollection,Projects",
        "ADO_DEFAULT_PROJECT": "DemoProject"
      }
    }
  }
}
```

In stdio mode, `ADO_PAT`, `ADO_COLLECTIONS`, `ADO_COLLECTION_PATS`, `ADO_DEFAULT_PROJECT` and `ADO_ALLOW_DESTRUCTIVE` stand in for the HTTP headers below.

## Server configuration

| Variable | Default | Purpose |
|---|---|---|
| `ADO_MCP_TRANSPORT` | `http` | `http` (Streamable HTTP) or `stdio`. |
| `ADO_DEFAULT_SERVER_URL` | — | Server base URL without the collection, e.g. `https://devops.example.com/tfs`. |
| `ADO_ALLOWED_HOSTS` | host of `ADO_DEFAULT_SERVER_URL` | Hosts callers may target with `X-ADO-Server-URL` or a git remote. This blocks PAT exfiltration to other hosts. |
| `ADO_HOST_ALIASES` | — | Map internal remote hosts to an allowed host, e.g. `legacy-devops:8080=devops.example.com`. Remotes cloned from `http://legacy-devops:8080/tfs/...` then work without plain HTTP. |
| `ADO_ALLOW_INSECURE_HTTP` | `false` | Allow `http://` Azure DevOps URLs. Lab servers only; the server warns at startup. |
| `ADO_MCP_HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Bind address. |
| `ADO_MCP_PORT` | `8080` | Port. |
| `ADO_MCP_PATH` | `/mcp` | MCP endpoint path (not `/healthz`). |
| `ADO_MCP_HTTP_TOKEN` | — | Optional gateway token, at least 32 chars. Callers send it as `X-ADO-MCP-Token`. Without it, the server warns at startup when it listens beyond localhost. |
| `ADO_MCP_ALLOWED_ORIGINS` | — | Browser origins allowed to call `/mcp`. Requests from other origins get 403. |
| `ADO_MCP_TRUST_PROXY` | — | Express `trust proxy`: a hop count, the proxy address or subnet, or `loopback`. `true` and `/0` subnets (alone or in a list) are refused because callers could fake their address. A hop count must equal the real number of proxies. Use `false` when clients connect directly. Left unset on a non-loopback host, startup prints a warning. |
| `ADO_MCP_TOOLSETS` | `all` | Subset of toolsets to expose to everyone (`context` is always on). |
| `ADO_MCP_READ_ONLY` | `false` | Hide and block every write tool for everyone. |
| `ADO_MCP_STATELESS` | `false` | One server per request, for load balancers without sticky sessions. It disables elicitation, roots and remembered answers. |
| `ADO_MCP_SESSION_IDLE_MS` | `1800000` | Idle MCP sessions are closed after this long. Sessions with an open event stream are kept. |
| `ADO_MCP_MAX_SESSIONS` | `200` | Global session cap. When it is full, new sessions get 503. |
| `ADO_MCP_MAX_SESSIONS_PER_USER` | `10` | Per Azure DevOps identity. The user's least recently used session is closed to make room. |
| `ADO_MCP_AUTH_FAILURE_LIMIT` | `20` | 401s per caller (address plus credentials) in 5 minutes before 429. An address alone may fail ten times as often. |
| `ADO_MCP_CLIENT_TIMEOUT_MS` | `60000` | How long MCP clients wait for a tool call (at least 30000). Destructive calls must finish confirming and start their first write 10 s before it runs out. |
| `ADO_MCP_AUDIT_LOG` | `true` | JSON audit lines on stderr. |
| `ADO_REQUEST_TIMEOUT_MS` | `30000` | Timeout per Azure DevOps REST call. |
| `ADO_MAX_RESPONSE_BYTES` | `10485760` | Largest Azure DevOps response the server reads. Larger ones fail with `[too_large]`. |
| `ADO_FORCE_API_VERSION` | — | Pin a REST version (`6.0`, `7.2`) instead of negotiating. |
| `ADO_PAT`, `ADO_COLLECTION_PATS`, `ADO_COLLECTIONS`, `ADO_DEFAULT_PROJECT`, `ADO_ALLOW_DESTRUCTIVE` | — | **stdio only.** Setting a PAT or `ADO_ALLOW_DESTRUCTIVE` in HTTP mode stops startup. |

## Caller headers

| Header | Example | Purpose |
|---|---|---|
| `Authorization: Bearer` | `Bearer <your PAT>` | Your PAT, used for every collection without its own entry in `X-ADO-Collection-PATs`. `Basic base64(:PAT)` works too. |
| `X-ADO-MCP-Token` | `<gateway token>` | Only when the server sets `ADO_MCP_HTTP_TOKEN`. |
| `X-ADO-Collection` / `X-ADO-Collections` | `DemoCollection,LegacyCollection,Projects` | Collections you work in, in order of preference. |
| `X-ADO-Collection-PATs` | `DemoCollection=<PAT_FOR_DEMOCOLLECTION>,Projects=<PAT_FOR_PROJECTS>` | Per-collection PATs. Also accepts JSON or base64 JSON. The names are added to your collections. |
| `X-ADO-Default-Project` | `DemoProject` | Fallback project when nothing else decides. |
| `X-ADO-Default-Repository` | `ado-server-mcp` | Fallback repository when a tool needs one and you named no collection, project or repository. |
| `X-ADO-Git-Remote` | `https://devops.example.com/tfs/DemoCollection/DemoProject/_git/ado-server-mcp` | Your workspace's git remote, for clients where the assistant cannot run `git`. Used when a call names nothing. |
| `X-ADO-Server-URL` | `https://<other-host>/tfs` | Use another Azure DevOps Server. It must be in `ADO_ALLOWED_HOSTS`. |
| `X-ADO-Toolsets` | `pullrequests,builds` | Only show these toolsets in your session. This keeps the tool list short. |
| `X-ADO-Read-Only` | `true` | Make your own session read-only. |
| `X-ADO-Allow-Destructive` | `true` | Skip the confirmation prompt for destructive tools in your session. Clients that cannot show prompts need this to run them at all. |

Send each header once. Repeated headers, or a comma in a single-value header, are rejected.

**Multiple collections.** An all-collections PAT plus `X-ADO-Collections: DemoCollection,LegacyCollection,Projects` is enough. If your PATs are scoped to one collection each, send `X-ADO-Collection-PATs` instead, or as well. `whoami_and_collections` shows which collections authenticate.

**PAT check.** Session admission reuses a successful check cached per credential fingerprint for up to 10 minutes. On a cache miss, the server checks your PAT against the first collection you name. If you name none, the server lists the collections the PAT can see, which only an all-collections PAT can do, and checks the first five in turn until one accepts it. A PAT scoped to one collection must therefore come with `X-ADO-Collections`; without it the session is refused with 401. Reconnecting or sending a new `initialize` does not force a fresh check while that successful result is cached, so a revoked PAT may still open a session during the remaining cache window. Requests actually sent to Azure DevOps continue to use the caller's PAT and are subject to its current upstream authorization.

**How the context is picked:**

1. Explicit tool arguments.
2. A git remote: the assistant runs `git remote get-url origin` and passes it in, or `X-ADO-Git-Remote` supplies one.
3. `X-ADO-Default-Repository`, when the call names no collection, project or repository.
4. **Collection:** your only collection; else the one collection that has the named project or repository; else your MCP workspace roots; else ask.
5. **Project:** the project that owns the named repository; else `X-ADO-Default-Project`; else your workspace roots; else the collection's only project; else ask.
6. **Repository:** your workspace roots; else the project's only repository; else ask.

"Ask" reuses an earlier answer from the same session if there is one. Results that used a remembered or asked answer carry a `context` block saying so. To switch, name the collection, project or repository in your request.

For TFVC, pass a server path such as `$/Legacy/Main`, and the project and collection follow from it. Call `resolve_repo_context` once at the start of a task.

## Client configuration

Replace `https://<your-mcp-host>/mcp` with the published URL. Keep the PAT in an environment variable or a secret prompt, never inline. Leave out `X-ADO-MCP-Token` if the server has no gateway token.

### Cursor: `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)

```json
{
  "mcpServers": {
    "ado-server": {
      "url": "https://<your-mcp-host>/mcp",
      "headers": {
        "Authorization": "Bearer ${env:ADO_PAT}",
        "X-ADO-MCP-Token": "${env:ADO_MCP_TOKEN}",
        "X-ADO-Collections": "DemoCollection,LegacyCollection,Projects",
        "X-ADO-Default-Project": "DemoProject"
      }
    }
  }
}
```

Make `ADO_PAT` and, if used, `ADO_MCP_TOKEN` available to Cursor, then restart it. The header interpolation and configuration locations follow [Cursor MCP documentation](https://cursor.com/docs/mcp).

### Claude Code

```powershell
claude mcp add --transport http ado-server https://<your-mcp-host>/mcp `
  --header "Authorization: Bearer $env:ADO_PAT" `
  --header "X-ADO-MCP-Token: $env:ADO_MCP_TOKEN" `
  --header "X-ADO-Collections: DemoCollection,LegacyCollection,Projects"
```

`claude mcp add` above stores the expanded header values in the local configuration. Prefer a project `.mcp.json` containing environment references when sharing configuration. Claude Code expands `${VAR}` in it, as documented in [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp):

```json
{
  "mcpServers": {
    "ado-server": {
      "type": "http",
      "url": "https://<your-mcp-host>/mcp",
      "headers": {
        "Authorization": "Bearer ${ADO_PAT}",
        "X-ADO-MCP-Token": "${ADO_MCP_TOKEN}",
        "X-ADO-Collections": "DemoCollection,LegacyCollection,Projects"
      }
    }
  }
}
```

### Codex: `~/.codex/config.toml`

```toml
[mcp_servers.ado-server]
url = "https://<your-mcp-host>/mcp"
bearer_token_env_var = "ADO_PAT"                              # sent as Authorization: Bearer <PAT>
env_http_headers = { "X-ADO-MCP-Token" = "ADO_MCP_TOKEN" }    # header = name of the env var holding the value
http_headers = { "X-ADO-Collections" = "DemoCollection,LegacyCollection,Projects", "X-ADO-Default-Project" = "DemoProject" }
```

These HTTP settings follow the current [Codex MCP configuration reference](https://developers.openai.com/codex/mcp). Set the named variables in the environment from which Codex starts.

### VS Code with the Copilot harness

Use `~/.copilot/mcp-config.json` for your account, or a workspace-root `.mcp.json` for shared configuration. Supply the referenced variables where Copilot runs. The current [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) documents these destinations and environment references.

```json
{
  "mcpServers": {
    "ado-server": {
      "type": "http",
      "url": "https://<your-mcp-host>/mcp",
      "headers": {
        "Authorization": "Bearer ${ADO_PAT}",
        "X-ADO-MCP-Token": "${ADO_MCP_TOKEN}",
        "X-ADO-Collections": "DemoCollection,LegacyCollection,Projects"
      }
    }
  }
}
```

### VS Code Local harness: `.vscode/mcp.json`

For the older editor-managed Local harness, this format prompts for the PAT. Input prompts do not transfer to the Copilot harness; use the environment-based example above for Copilot. The [VS Code Local compatibility reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration#editor-managed-configuration-for-local-harness-compatibility) describes this format.

```json
{
  "inputs": [
    { "type": "promptString", "id": "ado-pat", "description": "Azure DevOps Server PAT", "password": true }
  ],
  "servers": {
    "ado-server": {
      "type": "http",
      "url": "https://<your-mcp-host>/mcp",
      "headers": { "Authorization": "Bearer ${input:ado-pat}", "X-ADO-Collections": "DemoCollection,LegacyCollection,Projects" }
    }
  }
}
```

## Toolsets

| Toolset | Tools |
|---|---|
| `context` | `whoami_and_collections`, `resolve_repo_context` (always on) |
| `projects` | projects, teams, team members |
| `workitems` | get/create/update/link work items, comments, attachments, WIQL (team-scoped macros), my work items |
| `queries` | saved queries, work item types and states, area/iteration paths |
| `boards` | boards, columns, sprints, sprint work items, capacity |
| `repositories` | Git repositories, branches, commits, file content, diffs |
| `pullrequests` | list/create/update/complete PRs, reviewers, votes, threads, policies, linked work items |
| `builds` | definitions, builds, queue, timeline, logs (server-side line ranges), artifacts |
| `releases` | release definitions, releases, approvals, deploy |
| `wiki` | wikis, page tree, read and write pages |
| `tfvc` | TFVC items, file content, changesets, shelvesets (read-only) |

Prompts: `review_pull_request`, `diagnose_build_failure`, `sprint_status`.

## Security

- **No stored PATs.** Each session is bound to an HMAC fingerprint of the caller's credentials, so someone else's session id is useless without the same PAT.
- **Session admission.** Successful Azure DevOps PAT checks are cached per credential fingerprint for up to 10 minutes. A new session or `initialize` can reuse that result even if the PAT has since been revoked; a cache miss requires a fresh check. Requests sent upstream still use the caller's PAT and Azure DevOps enforces its current permissions. Failed admission attempts are rate-limited per caller (address plus credentials), with a ten-times-higher ceiling per address, so one colleague's expired PAT does not lock out everyone behind the same proxy. Sessions are capped per user and globally.
- **No leaks.** PATs and tokens are scrubbed from logs, errors and tool output. A 401 never carries `WWW-Authenticate`, so clients don't start an OAuth flow.
- **TLS.** Verification is never turned off. Use `NODE_EXTRA_CA_CERTS` for internal CAs.
- **Read-only modes.** `ADO_MCP_READ_ONLY` and `X-ADO-Read-Only` hide and block write tools.
- **Destructive tools** (complete or abandon a PR, approve or deploy a release, create a release, queue a build, write a wiki page) carry `destructiveHint`. They show you what they are about to do, by name, and wait for your yes. A late answer or a cancelled call changes nothing. Names that come from Azure DevOps (titles, branches, paths, stages) appear in double quotes, on one line, cut at 80 characters, with square brackets, angle brackets, backticks and the `://` of bare URLs swapped for look-alikes, so a crafted PR title can't pose as part of the server's sentence or render as a link or image. The first write must start at least 10 seconds before `ADO_MCP_CLIENT_TIMEOUT_MS` (within 50 seconds of the call by default). This reserve reduces timeout/retry risk; it does not guarantee an upstream write finishes before the client deadline. If loading the target leaves too little time to ask, the call fails with `[network]` before asking, and nothing changes.
- **Clients that cannot show prompts** get `[confirmation_required]` unless the session sends `X-ADO-Allow-Destructive: true`. That header turns the server-side confirmation off completely, so with it you rely on your client's own approval prompts for tool calls. Keep those on (for example, don't auto-approve this server's tools) if you send the header.
- **Writes and foreign remotes.** If a git remote points at a host the server may not call, or at a server other than the one `X-ADO-Server-URL` pins, read tools warn in their result, and write tools refuse instead of writing to a same-named project on the configured server.
- **Audit.** Each tool call writes one JSON line to stderr: tool, user, collection, project, outcome, duration, argument names, the identifying values (PR, build, release, approval, environment and definition ids, and the action, vote or status), and whether a destructive call was confirmed by prompt or pre-approved. Titles, comments and content are never logged. Session open and close, and refused admissions, are logged the same way.
- **Bounded responses.** Large lists are shortened with a `truncated` note, and responses over `ADO_MAX_RESPONSE_BYTES` fail with `[too_large]` instead of exhausting memory.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| 401 when connecting | A fresh admission check rejected the PAT: it may be wrong, expired, or invalid for the first collection you named. Successful admission checks can be reused for up to 10 minutes, so reconnecting does not always trigger a fresh check (see PAT check above). |
| 401 `Send X-ADO-Collections` | Your PAT is scoped to one collection, or invalid, and you named no collection. Or it can list collections but was not accepted in the first five. Add `X-ADO-Collections`. |
| `[auth] ... sign-in page (203)` | The PAT is not valid for that collection. Create it in that collection, or add a per-collection PAT. |
| 429 `Too many failed authentication attempts` | Repeated 401s with your credentials, or very many from your address. Fix the PAT or gateway token and wait 5 minutes. |
| 503 `at its session limit` | `ADO_MCP_MAX_SESSIONS` is reached. Close idle clients or raise the limit. |
| `[tls] ... unable to verify the first certificate` | The internal CA isn't trusted. Export it as PEM to `certs/ca.crt` (below) and set `NODE_EXTRA_CA_CERTS`. |
| `[version] ...` | Very old server, or a pinned `ADO_FORCE_API_VERSION` that is too high. |
| `[confirmation_required]` | A destructive tool, and your client cannot show confirmation prompts. Send `X-ADO-Allow-Destructive: true` only when the client's own approval prompts govern those calls. |
| `[too_large]` | The response exceeded `ADO_MAX_RESPONSE_BYTES`. Narrow the request (`top`, a path or a line range). |
| `[network] ... too little time to finish` | Azure DevOps was slow to load what a destructive tool would change. Nothing was changed; call the tool again. |
| `disambiguation_required` | Two or more collections, projects or repositories match. Pass the one you mean, or add `X-ADO-Default-Project`. |
| A collection shows `unauthorized` in `whoami_and_collections` | Expected for a PAT scoped to another collection. Add that collection's PAT to `X-ADO-Collection-PATs`. |
| Git remote `http://legacy-devops:8080/...` is ignored | Add `ADO_HOST_ALIASES=legacy-devops:8080=devops.example.com` on the server. |

Export a Windows-trusted root CA to PEM:

```powershell
$cert = Get-ChildItem Cert:\LocalMachine\Root | Where-Object Subject -Match 'example' | Select-Object -First 1
"-----BEGIN CERTIFICATE-----`n$([Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks'))`n-----END CERTIFICATE-----" |
  Set-Content -Encoding ascii certs\ca.crt
```

## Upgrade runbook: Server 2020 → 25H2

When upgrading your own server in place, keep its configured host and move from REST 6.0 to 7.2. The server re-negotiates on its own: versions are cached for 60 minutes, and a version error triggers an immediate retry. Live 25H2 validation remains pending until that server is available. After the upgrade:

1. Restart the MCP server, so it negotiates at once instead of waiting for the cache to expire.
2. Run the live smoke test (`npm run smoke`). `whoami_and_collections` must show `apiVersion: "7.2"` and `apiVersions.witComments: "7.2-preview.4"`.
3. Record the 25H2 contract fixture locally as ignored `tests/contracts/server-25h2.json`. Never commit recordings or their Git history:

   ```powershell
   $env:ADO_RECORD_FLAVOR = 'server-25h2'
   npm run record:contracts
   npx vitest run tests/contracts
   ```

4. If a test fails, compare the sanitized recording with the negotiated API versions, request shapes and expected behavior. Correct simulated fixtures only when live evidence supports the change, then fix code test-first. Do not assume every failure is a mock defect.

**Two servers side by side.** `X-ADO-Collection-PATs` is keyed by collection name only. If an old and a new server ever run at the same time with the same collection names, use one MCP connection per server, each with its own `X-ADO-Server-URL`.

## Development

```powershell
npm ci
npm test                 # unit, simulated integration and optional local-only contract replay
npm run typecheck
npm run build
npm run smoke            # live read-only check against a running server (scripts/smoke.mjs)
npm run record:contracts # live read-only recording (VPN; PAT supplied in ADO_PAT)
```

The contract recorder uses `ADO_RECORD_FLAVOR` (`server-2020` or `server-25h2`), `ADO_RECORD_SERVER_URL`, `ADO_RECORD_COLLECTION`, `ADO_RECORD_PROJECT` and `ADO_RECORD_REPOSITORY` for its target. The generic example defaults are Server 2020, `https://devops.example.com/tfs`, `DemoCollection`, `DemoProject` and `ado-server-mcp`. It requires a completed build with task logs. Optional `ADO_RECORD_TFVC_COLLECTION` and `ADO_RECORD_TFVC_PATH` enable live TFVC recording only after that scope is approved; leave both unset while the live TFVC hold applies. Supply `ADO_PAT` only to the recorder process, never the HTTP service. Review local recordings before use. All recorded `tests/contracts/*.json` files are ignored and must never be committed, including in private repositories.
