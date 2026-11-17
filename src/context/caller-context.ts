import { createHmac } from 'node:crypto';
import { TOOLSETS, type ServerConfig, type Toolset } from '../config/env.js';
import { AdoError } from '../ado/errors.js';

export type HeaderBag = Record<string, string | string[] | undefined>;

export interface CollectionPat {
  name: string;
  pat: string;
}

export interface HostPolicy {
  allowedHosts: readonly string[];
  allowInsecureHttp: boolean;
  hostAliases: ReadonlyMap<string, string>;
}

export interface CallerContext extends HostPolicy {
  serverUrl: string;
  serverUrlPinned: boolean;
  collections: string[];
  globalPat?: string;
  collectionPats: ReadonlyMap<string, CollectionPat>;
  defaultProject?: string;
  defaultRepository?: string;
  gitRemote?: string;
  toolsets?: ReadonlySet<Toolset>;
  readOnly: boolean;
  allowDestructive: boolean;
}

export class CallerContextError extends Error {
  constructor(
    message: string,
    readonly httpStatus: 400 | 401 | 403 = 400,
  ) {
    super(message);
    this.name = 'CallerContextError';
  }
}

export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function assertAllowedServerUrl(url: string, policy: HostPolicy): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new CallerContextError('Azure DevOps Server URL must be an absolute URL.');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && policy.allowInsecureHttp)) {
    throw new CallerContextError('Azure DevOps Server URL must use https.', 403);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new CallerContextError('Azure DevOps Server URL must not contain credentials, a query string, or a fragment.', 403);
  }
  if (!policy.allowedHosts.includes(parsed.hostname.toLowerCase())) {
    throw new CallerContextError('Azure DevOps Server host is not in ADO_ALLOWED_HOSTS on this MCP server.', 403);
  }
  return normalizeServerUrl(`${parsed.origin}${parsed.pathname}`);
}

// An SSH remote gives a host but no server URL, so it is trusted only when it is the caller's own server (after ADO_HOST_ALIASES).
// Alias keys may carry the HTTP port (legacy-devops:8080); an SSH remote uses another port, so match on the host name alone.
export function sshHostMatches(host: string, serverUrl: string, policy: HostPolicy): boolean {
  const name = host.toLowerCase();
  const alias = [...policy.hostAliases].find(([key]) => key.replace(/:\d+$/, '') === name)?.[1];
  return (alias ?? name).replace(/:\d+$/, '') === new URL(serverUrl).hostname.toLowerCase();
}

// Server URL taken from a git remote: apply ADO_HOST_ALIASES, then the allowlist. Undefined means "ignore it".
export function remoteServerUrl(url: string, policy: HostPolicy): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const alias = policy.hostAliases.get(parsed.host.toLowerCase()) ?? policy.hostAliases.get(parsed.hostname.toLowerCase());
  const candidate = alias ? `https://${alias}${parsed.pathname}` : `${parsed.origin}${parsed.pathname}`;
  try {
    return assertAllowedServerUrl(candidate, policy);
  } catch {
    return undefined;
  }
}

function header(headers: HeaderBag, name: string, kind: 'single' | 'list' = 'single'): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw) && raw.length > 1) throw new CallerContextError(`Send the ${name} header only once.`);
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined;
  if (value && kind === 'single' && value.includes(',')) {
    throw new CallerContextError(`Send the ${name} header only once (its value contains a comma).`);
  }
  return value;
}

function patFromAuthorization(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const bearer = /^Bearer\s+(\S+)$/i.exec(value);
  if (bearer) return bearer[1];
  const basic = /^Basic\s+(\S+)$/i.exec(value);
  if (basic) {
    const decoded = Buffer.from(basic[1] ?? '', 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return (separator >= 0 ? decoded.slice(separator + 1) : decoded).trim() || undefined;
  }
  throw new CallerContextError('Authorization must be "Bearer <your Azure DevOps PAT>" (or "Basic base64(:PAT)").', 401);
}

function parseToolsets(value: string | undefined): ReadonlySet<Toolset> | undefined {
  if (!value) return undefined;
  const result = new Set<Toolset>();
  for (const name of splitList(value).map((item) => item.toLowerCase())) {
    if (!(TOOLSETS as readonly string[]).includes(name)) {
      throw new CallerContextError(`Unknown toolset in X-ADO-Toolsets. Valid toolsets: ${TOOLSETS.join(', ')}.`);
    }
    result.add(name as Toolset);
  }
  return result;
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseCollectionPats(raw: string | undefined): Map<string, CollectionPat> {
  const result = new Map<string, CollectionPat>();
  if (!raw?.trim()) return result;

  let text = raw.trim();
  if (!text.startsWith('{')) {
    const decoded = Buffer.from(text, 'base64').toString('utf8').trim();
    if (decoded.startsWith('{')) text = decoded;
  }

  const add = (name: string, pat: unknown): void => {
    const cleanName = name.trim();
    if (!cleanName || typeof pat !== 'string' || !pat.trim()) {
      throw new CallerContextError('X-ADO-Collection-PATs entries must map collection names to non-empty PATs.');
    }
    result.set(cleanName.toLowerCase(), { name: cleanName, pat: pat.trim() });
  };

  if (text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CallerContextError('X-ADO-Collection-PATs is not valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CallerContextError('X-ADO-Collection-PATs JSON must be an object of collection to PAT.');
    }
    for (const [name, pat] of Object.entries(parsed as Record<string, unknown>)) add(name, pat);
    return result;
  }

  for (const entry of splitList(text)) {
    const separator = entry.indexOf('=');
    if (separator <= 0) throw new CallerContextError('X-ADO-Collection-PATs must look like "DemoCollection=pat1,LegacyCollection=pat2".');
    add(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return result;
}

function mergeCollections(lists: Array<string | undefined>, pats: ReadonlyMap<string, CollectionPat>): string[] {
  const seen = new Map<string, string>();
  for (const list of lists) {
    for (const name of splitList(list)) if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  for (const { name } of pats.values()) if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  return [...seen.values()];
}

const TRUTHY = /^(true|1|yes)$/i;
const FALSY = /^(false|0|no)$/i;

function flag(headers: HeaderBag, name: string, display: string): boolean {
  const value = header(headers, name);
  if (!value) return false;
  if (TRUTHY.test(value)) return true;
  if (FALSY.test(value)) return false;
  throw new CallerContextError(`${display} must be true or false.`);
}

export function assertSingleHeaders(rawHeaders: readonly string[]): void {
  const counts = new Map<string, number>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (name === 'authorization' || name.startsWith('x-ado-')) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  for (const [name, count] of counts) {
    if (count > 1) {
      throw new CallerContextError(`Send the ${name === 'authorization' ? 'authorization' : 'X-ADO-*'} header only once.`);
    }
  }
}

function hostPolicy(config: ServerConfig): HostPolicy {
  return { allowedHosts: config.allowedHosts, allowInsecureHttp: config.allowInsecureHttp, hostAliases: config.hostAliases };
}

export function buildCallerContext(headers: HeaderBag, config: ServerConfig): CallerContext {
  const policy = hostPolicy(config);
  const explicitServer = header(headers, 'x-ado-server-url');
  const serverUrlRaw = explicitServer ?? config.defaultServerUrl;
  if (!serverUrlRaw) {
    throw new CallerContextError('No Azure DevOps Server URL: send X-ADO-Server-URL or configure ADO_DEFAULT_SERVER_URL on the MCP server.');
  }
  const serverUrl = assertAllowedServerUrl(serverUrlRaw, policy);
  const collectionPats = parseCollectionPats(header(headers, 'x-ado-collection-pats', 'list'));
  const globalPat = patFromAuthorization(header(headers, 'authorization'));
  if (!globalPat && collectionPats.size === 0) {
    throw new CallerContextError('Send your Azure DevOps PAT as Authorization: Bearer <PAT> (or per collection in X-ADO-Collection-PATs).', 401);
  }
  return {
    serverUrl,
    serverUrlPinned: explicitServer !== undefined,
    collections: mergeCollections([header(headers, 'x-ado-collection', 'list'), header(headers, 'x-ado-collections', 'list')], collectionPats),
    globalPat,
    collectionPats,
    defaultProject: header(headers, 'x-ado-default-project'),
    defaultRepository: header(headers, 'x-ado-default-repository'),
    gitRemote: header(headers, 'x-ado-git-remote'),
    toolsets: parseToolsets(header(headers, 'x-ado-toolsets', 'list')),
    readOnly: config.readOnly || flag(headers, 'x-ado-read-only', 'X-ADO-Read-Only'),
    allowDestructive: flag(headers, 'x-ado-allow-destructive', 'X-ADO-Allow-Destructive'),
    ...policy,
  };
}

export function buildStdioCallerContext(config: ServerConfig): CallerContext {
  const policy = hostPolicy(config);
  if (!config.defaultServerUrl) throw new CallerContextError('ADO_DEFAULT_SERVER_URL is required in stdio mode.');
  const collectionPats = parseCollectionPats(config.stdio.collectionPats);
  if (!config.stdio.pat && collectionPats.size === 0) {
    throw new CallerContextError('Set ADO_PAT or ADO_COLLECTION_PATS for stdio mode.', 401);
  }
  return {
    serverUrl: assertAllowedServerUrl(config.defaultServerUrl, policy),
    serverUrlPinned: false,
    collections: mergeCollections([config.stdio.collections.join(',')], collectionPats),
    globalPat: config.stdio.pat,
    collectionPats,
    defaultProject: config.stdio.defaultProject,
    readOnly: config.readOnly,
    allowDestructive: config.stdio.allowDestructive,
    ...policy,
  };
}

export function resolvePat(ctx: CallerContext, collection: string): string {
  const specific = ctx.collectionPats.get(collection.toLowerCase());
  if (specific) return specific.pat;
  if (ctx.globalPat) return ctx.globalPat;
  throw new AdoError('credential', `No PAT covers collection "${collection}". Add it to X-ADO-Collection-PATs or send Authorization: Bearer <PAT>.`);
}

export function credentialFingerprint(ctx: CallerContext, key: Buffer): string {
  const pats = [...ctx.collectionPats.entries()].map(([name, entry]) => [name, entry.pat]).sort();
  const material = JSON.stringify([ctx.serverUrl.toLowerCase(), ctx.globalPat ?? '', pats]);
  return createHmac('sha256', key).update(material).digest('hex');
}

export function redactSecrets(text: string, ctx?: CallerContext): string {
  return credentialRedactor(ctx)(text);
}

// Build before context validation as well as afterwards: malformed caller headers must not
// prevent the outbound boundary from knowing the credentials in the other headers.
export function credentialRedactor(ctx?: CallerContext, config?: ServerConfig, headers: HeaderBag = {}): (text: string) => string {
  const secrets: Array<string | undefined> = [ctx?.globalPat, config?.stdio.pat, config?.httpToken];
  for (const entry of ctx?.collectionPats.values() ?? []) secrets.push(entry.pat);
  const values = (name: string): string[] => [headers[name] ?? []].flat();
  secrets.push(...values('x-ado-mcp-token').map((value) => value.trim()));
  for (const value of values('authorization')) {
    secrets.push(value.trim());
    try { secrets.push(patFromAuthorization(value.trim())); } catch { /* Fixed validation errors handle malformed authorization. */ }
  }
  for (const value of [...values('x-ado-collection-pats'), config?.stdio.collectionPats]) {
    if (!value) continue;
    secrets.push(value.trim());
    try { for (const entry of parseCollectionPats(value).values()) secrets.push(entry.pat); } catch { /* Invalid maps receive fixed diagnostics. */ }
  }
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    forms.add(secret);
    forms.add(JSON.stringify(secret).slice(1, -1));
    // URLs and Basic authorization can expose an encoded credential even when raw text is absent.
    const uri = encodeURIComponent(Buffer.from(secret).toString('utf8'));
    forms.add(uri);
    forms.add(uri.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()));
    forms.add(Buffer.from(secret).toString('base64'));
    forms.add(Buffer.from(`:${secret}`).toString('base64'));
  }
  const alternatives = [...forms].sort((a, b) => b.length - a.length).map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // One replacement pass: shorter overlaps cannot expose suffixes or re-match the replacement.
  const pattern = new RegExp([...alternatives, '\\b(?:Basic|Bearer)\\s+[A-Za-z0-9+/=._-]{8,}'].join('|'), 'g');
  return (text) => text.replace(pattern, (match) => /^(Basic|Bearer)\s/i.test(match) ? `${match.split(/\s/, 1)[0]} ***` : '***');
}

// Scrub values and keys before JSON serialization; replacing escaped JSON text can corrupt it.
export function redactStrings<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, redact)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactStrings(item, redact)])) as T;
  }
  return value;
}
