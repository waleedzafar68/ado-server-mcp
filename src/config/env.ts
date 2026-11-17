export const TOOLSETS = [
  'projects',
  'workitems',
  'queries',
  'boards',
  'repositories',
  'pullrequests',
  'builds',
  'releases',
  'wiki',
  'tfvc',
] as const;

export type Toolset = (typeof TOOLSETS)[number];
export type Transport = 'http' | 'stdio';

export interface StdioCredentials {
  pat?: string;
  collections: string[];
  collectionPats?: string;
  defaultProject?: string;
  allowDestructive: boolean;
}

export interface ServerConfig {
  transport: Transport;
  defaultServerUrl?: string;
  allowedHosts: string[];
  allowInsecureHttp: boolean;
  host: string;
  port: number;
  path: string;
  httpToken?: string;
  allowedOrigins: string[];
  toolsets: ReadonlySet<Toolset>;
  readOnly: boolean;
  forceApiVersion?: string;
  requestTimeoutMs: number;
  stateless: boolean;
  sessionIdleMs: number;
  // Lowercased "host" or "host:port" seen in git remotes -> allowlisted canonical host.
  hostAliases: ReadonlyMap<string, string>;
  maxResponseBytes: number;
  maxSessions: number;
  maxSessionsPerUser: number;
  authFailureLimit: number;
  trustProxy?: string;
  // How long MCP clients wait for a tool call; destructive calls budget their prompt and first write within it.
  clientTimeoutMs: number;
  auditLog: boolean;
  stdio: StdioCredentials;
}

export class ConfigError extends Error {
  constructor(readonly failures: string[]) {
    super(failures.join('\n'));
    this.name = 'ConfigError';
  }
}

export const MIN_HTTP_TOKEN_LENGTH = 32;

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function bool(value: string | undefined): boolean {
  return ['true', '1', 'yes'].includes((value ?? '').trim().toLowerCase());
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function integer(value: string | undefined, fallback: number): number {
  const raw = optional(value);
  return raw === undefined ? fallback : Number(raw);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const failures: string[] = [];

  const transportRaw = (optional(env.ADO_MCP_TRANSPORT) ?? 'http').toLowerCase();
  if (transportRaw !== 'http' && transportRaw !== 'stdio') {
    failures.push(`ADO_MCP_TRANSPORT must be "http" or "stdio", got "${transportRaw}".`);
  }
  const transport: Transport = transportRaw === 'stdio' ? 'stdio' : 'http';
  const allowInsecureHttp = bool(env.ADO_ALLOW_INSECURE_HTTP);

  const defaultServerUrl = optional(env.ADO_DEFAULT_SERVER_URL)?.replace(/\/+$/, '');
  let defaultHost: string | undefined;
  if (defaultServerUrl) {
    try {
      const parsed = new URL(defaultServerUrl);
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && allowInsecureHttp)) {
        failures.push('ADO_DEFAULT_SERVER_URL must use https:// (set ADO_ALLOW_INSECURE_HTTP=true only for lab servers).');
      }
      defaultHost = parsed.hostname.toLowerCase();
    } catch {
      failures.push(`ADO_DEFAULT_SERVER_URL is not an absolute URL: "${defaultServerUrl}".`);
    }
  }

  const allowedHosts = list(env.ADO_ALLOWED_HOSTS).map((host) => host.toLowerCase());
  if (allowedHosts.length === 0 && defaultHost) allowedHosts.push(defaultHost);
  if (allowedHosts.length === 0) {
    failures.push('Set ADO_DEFAULT_SERVER_URL or ADO_ALLOWED_HOSTS so the server knows which Azure DevOps Server hosts it may call.');
  }

  const port = integer(env.ADO_MCP_PORT, 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) failures.push('ADO_MCP_PORT must be an integer between 0 and 65535.');

  const path = optional(env.ADO_MCP_PATH) ?? '/mcp';
  if (!path.startsWith('/')) failures.push('ADO_MCP_PATH must start with "/".');
  if (path.replace(/\/+$/, '') === '/healthz') failures.push('ADO_MCP_PATH must not be /healthz, which serves the health probe.');

  const httpToken = optional(env.ADO_MCP_HTTP_TOKEN);
  if (httpToken && httpToken.length < MIN_HTTP_TOKEN_LENGTH) {
    failures.push(`ADO_MCP_HTTP_TOKEN must be at least ${MIN_HTTP_TOKEN_LENGTH} characters (generate one with: openssl rand -hex 32).`);
  }

  const toolsets = new Set<Toolset>();
  const toolsetNames = list(env.ADO_MCP_TOOLSETS).map((name) => name.toLowerCase());
  if (toolsetNames.length === 0 || toolsetNames.includes('all')) {
    for (const toolset of TOOLSETS) toolsets.add(toolset);
  } else {
    for (const name of toolsetNames) {
      if ((TOOLSETS as readonly string[]).includes(name)) toolsets.add(name as Toolset);
      else failures.push(`Unknown toolset "${name}" in ADO_MCP_TOOLSETS. Valid toolsets: ${TOOLSETS.join(', ')}.`);
    }
  }

  const requestTimeoutMs = integer(env.ADO_REQUEST_TIMEOUT_MS, 30_000);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000) failures.push('ADO_REQUEST_TIMEOUT_MS must be an integer >= 1000.');

  const sessionIdleMs = integer(env.ADO_MCP_SESSION_IDLE_MS, 1_800_000);
  if (!Number.isInteger(sessionIdleMs) || sessionIdleMs < 60_000) failures.push('ADO_MCP_SESSION_IDLE_MS must be an integer >= 60000.');

  const forceApiVersion = optional(env.ADO_FORCE_API_VERSION);
  if (forceApiVersion && !/^\d+\.\d+$/.test(forceApiVersion)) failures.push('ADO_FORCE_API_VERSION must look like 6.0 or 7.2.');

  const hostAliases = new Map<string, string>();
  for (const entry of list(env.ADO_HOST_ALIASES)) {
    const [alias, target] = entry.split('=').map((part) => part.trim().toLowerCase());
    if (!alias || !target) failures.push(`ADO_HOST_ALIASES entry "${entry}" must look like legacy-devops:8080=devops.example.com.`);
    else if (!allowedHosts.includes(target.replace(/:\d+$/, ''))) failures.push(`ADO_HOST_ALIASES target "${target}" must be listed in ADO_ALLOWED_HOSTS.`);
    else hostAliases.set(alias, target);
  }

  const maxResponseBytes = integer(env.ADO_MAX_RESPONSE_BYTES, 10 * 1024 * 1024);
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 65_536) failures.push('ADO_MAX_RESPONSE_BYTES must be an integer >= 65536.');
  const maxSessions = integer(env.ADO_MCP_MAX_SESSIONS, 200);
  if (!Number.isInteger(maxSessions) || maxSessions < 1) failures.push('ADO_MCP_MAX_SESSIONS must be a positive integer.');
  const maxSessionsPerUser = integer(env.ADO_MCP_MAX_SESSIONS_PER_USER, 10);
  if (!Number.isInteger(maxSessionsPerUser) || maxSessionsPerUser < 1) failures.push('ADO_MCP_MAX_SESSIONS_PER_USER must be a positive integer.');
  const authFailureLimit = integer(env.ADO_MCP_AUTH_FAILURE_LIMIT, 20);
  if (!Number.isInteger(authFailureLimit) || authFailureLimit < 1) failures.push('ADO_MCP_AUTH_FAILURE_LIMIT must be a positive integer.');
  const auditRaw = optional(env.ADO_MCP_AUDIT_LOG);
  const trustProxy = optional(env.ADO_MCP_TRUST_PROXY);
  // Express takes a comma-separated list; one entry that trusts everything (true, or any /0 subnet) is enough to trust every hop.
  const trustsEveryone = (trustProxy ?? '').split(',').some((entry) => /^(true|.*\/0)$/i.test(entry.trim()));
  if (trustProxy && trustsEveryone) {
    failures.push(`ADO_MCP_TRUST_PROXY=${trustProxy} makes Express believe the leftmost X-Forwarded-For entry, which callers write themselves, so they could dodge the rate limiter. Set the proxy hop count (for example 1), the proxy addresses or subnets, "loopback", or "false".`);
  }
  const clientTimeoutMs = integer(env.ADO_MCP_CLIENT_TIMEOUT_MS, 60_000);
  if (!Number.isInteger(clientTimeoutMs) || clientTimeoutMs < 30_000) {
    failures.push('ADO_MCP_CLIENT_TIMEOUT_MS must be an integer >= 30000 (the write reserve and the shortest confirmation prompt take 20 seconds of it).');
  }

  const stdio: StdioCredentials = {
    pat: optional(env.ADO_PAT),
    collections: list(env.ADO_COLLECTIONS),
    collectionPats: optional(env.ADO_COLLECTION_PATS),
    defaultProject: optional(env.ADO_DEFAULT_PROJECT),
    allowDestructive: bool(env.ADO_ALLOW_DESTRUCTIVE),
  };

  if (transport === 'http' && (stdio.pat || stdio.collectionPats)) {
    failures.push('ADO_PAT / ADO_COLLECTION_PATS must not be set when ADO_MCP_TRANSPORT=http: every caller sends their own PAT as Authorization: Bearer <PAT> or in X-ADO-Collection-PATs.');
  }
  if (transport === 'http' && stdio.allowDestructive) {
    failures.push('ADO_ALLOW_DESTRUCTIVE applies to stdio only; HTTP callers opt in per session with the X-ADO-Allow-Destructive header.');
  }
  if (transport === 'stdio') {
    if (!defaultServerUrl) failures.push('ADO_DEFAULT_SERVER_URL is required in stdio mode.');
    if (!stdio.pat && !stdio.collectionPats) failures.push('ADO_PAT or ADO_COLLECTION_PATS is required in stdio mode.');
  }

  if (failures.length > 0) throw new ConfigError(failures);

  return {
    transport,
    defaultServerUrl,
    allowedHosts,
    allowInsecureHttp,
    host: optional(env.ADO_MCP_HOST) ?? '127.0.0.1',
    port,
    path,
    httpToken,
    allowedOrigins: list(env.ADO_MCP_ALLOWED_ORIGINS).map((origin) => origin.replace(/\/+$/, '').toLowerCase()),
    toolsets,
    readOnly: bool(env.ADO_MCP_READ_ONLY),
    forceApiVersion,
    requestTimeoutMs,
    stateless: bool(env.ADO_MCP_STATELESS),
    sessionIdleMs,
    hostAliases,
    maxResponseBytes,
    maxSessions,
    maxSessionsPerUser,
    authFailureLimit,
    trustProxy,
    clientTimeoutMs,
    auditLog: auditRaw === undefined ? true : bool(auditRaw),
    stdio,
  };
}