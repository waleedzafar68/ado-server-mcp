export const PLACEHOLDER_HOST = 'ado.example';

export interface Exchange {
  method: string;
  path: string;
  query: string;
  status: number;
  contentType: string;
  location?: string;
  headers?: Record<string, string>;
  body: string;
}

export interface ContractCall {
  label: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ContractFixture {
  flavor: 'server-2020' | 'server-25h2';
  recordedAt: string;
  serverUrl: string;
  collections: string[];
  calls: ContractCall[];
  facts: { logHead?: string[] };
  exchanges: Exchange[];
}

export function contractEnv(serverUrl: string, collections: readonly string[], pat: string): Record<string, string> {
  return {
    ADO_MCP_TRANSPORT: 'stdio',
    ADO_DEFAULT_SERVER_URL: serverUrl,
    ADO_PAT: pat,
    ADO_COLLECTIONS: collections.join(','),
    ADO_MCP_READ_ONLY: 'true',
    ADO_MCP_AUDIT_LOG: 'false',
  };
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function queryKey(params: URLSearchParams, transformPart: (value: string) => string = (value) => value): string {
  const entries = [...params.entries()]
    .map(([key, value]): [string, string] => [transformPart(key), transformPart(value)])
    .sort(([a, x], [b, y]) => byCodeUnit(a, b) || byCodeUnit(x, y));
  return new URLSearchParams(entries).toString();
}

export function requestKey(url: URL, serverUrl: string, transformQueryPart: (value: string) => string = (value) => value): { path: string; query: string } {
  const base = new URL(serverUrl).pathname.replace(/\/+$/, '');
  const pathname = decodeURIComponent(url.pathname);
  const belowBase = pathname.toLowerCase() === base.toLowerCase() || pathname.toLowerCase().startsWith(`${base.toLowerCase()}/`);
  const path = belowBase ? pathname.slice(base.length) : pathname;
  // Transform decoded names/values before sorting and encoding. Scrubbing the serialized
  // query would miss encoded private strings and could change ordering after recording.
  return { path, query: queryKey(url.searchParams, transformQueryPart) };
}

const IDENTITY_KEYS = new Set(['displayName', 'uniqueName', 'mailAddress', 'providerDisplayName', 'imageUrl', 'descriptor', 'subjectDescriptor']);
// Git commit authors are { name, email, date } objects, so `name` is only a person under these keys.
const PERSON_OBJECTS = new Set(['author', 'committer', 'pusher']);
const MACHINE_KEYS = new Set(['workerName', 'agentName', 'machineName', 'computerName']);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ACCOUNT = /(?<![\w\\/.:-])([A-Z][A-Z0-9-]{1,14})\\[A-Za-z0-9._$-]+/g;
// Private, loopback, link-local and carrier-grade NAT ranges only, so four-part version numbers elsewhere survive.
const PRIVATE_IPV4 =
  /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|127(?:\.\d{1,3}){3}|169\.254(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})\b/g;
const USER_PATH = /([A-Za-z]:\\Users\\|\/home\/|\/Users\/)[^\\/\s"']+/g;
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Scrubber {
  private readonly people = new Map<string, string>();
  private readonly machines = new Map<string, string>();
  // Windows domains seen in upper case (CORPTEST\name). Accounts in those domains are then scrubbed in any case;
  // a blanket case-insensitive pattern would also rewrite path pieces such as user\agent.
  private readonly domains = new Set<string>();
  private readonly host: RegExp;

  constructor(realHost: string, private readonly secrets: readonly string[]) {
    this.host = new RegExp(escapeRegExp(realHost), 'gi');
  }

  // Discover domains before transforming a group of strings, so traversal order cannot
  // leave lowercase accounts behind. Keep the same path-prefix exception as text().
  learnDomains(value: unknown): void {
    if (typeof value === 'string') {
      for (const [, domain] of value.matchAll(ACCOUNT)) this.domains.add(domain!.toLowerCase());
    } else if (Array.isArray(value)) {
      for (const item of value) this.learnDomains(item);
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        this.learnDomains(key);
        this.learnDomains(item);
      }
    }
  }

  text(value: string): string {
    let out = value;
    for (const secret of this.secrets) if (secret) out = out.split(secret).join('***');
    this.learnDomains(out);
    out = out
      .replace(this.host, PLACEHOLDER_HOST)
      .replace(EMAIL, 'user@example.invalid')
      .replace(USER_PATH, '$1user')
      .replace(ACCOUNT, 'DOMAIN\\user')
      .replace(PRIVATE_IPV4, '192.0.2.1');
    for (const domain of this.domains) {
      out = out.replace(new RegExp(`(?<![\\w\\\\/.:-])${escapeRegExp(domain)}\\\\[A-Za-z0-9._$-]+`, 'gi'), 'DOMAIN\\user');
    }
    return out;
  }

  body(text: string, contentType: string, assignAliases = true): string {
    if (contentType.toLowerCase().includes('json')) {
      try {
        const parsed: unknown = JSON.parse(text);
        this.learnDomains(parsed);
        return JSON.stringify(this.json(parsed, undefined, undefined, assignAliases));
      } catch {
        // Not valid JSON despite the content type: scrub it as text.
      }
    }
    return this.text(text);
  }

  private json(value: unknown, key?: string, parent?: string, assignAliases = true): unknown {
    if (typeof value === 'string') {
      if (assignAliases && key && (IDENTITY_KEYS.has(key) || (key === 'name' && parent && PERSON_OBJECTS.has(parent)))) return this.alias(this.people, 'User', value);
      if (assignAliases && key && MACHINE_KEYS.has(key)) return this.alias(this.machines, 'Agent', value);
      return this.text(value);
    }
    if (Array.isArray(value)) return value.map((item) => this.json(item, undefined, key, assignAliases));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => {
      // These generic leaf names identify people only in their enclosing schema.
      const account = key === 'Account' && parent === 'properties' && k === '$value';
      const avatar = key === 'avatar' && parent === '_links' && k === 'href';
      if (assignAliases && typeof v === 'string' && (account || avatar)) {
        // Keep the existing canonical domain-account mask; bare accounts need an alias.
        const maskedAccount = account ? this.text(v) : undefined;
        return [this.text(k), maskedAccount === 'DOMAIN\\user' ? maskedAccount : this.alias(this.people, 'User', v)];
      }
      return [this.text(k), this.json(v, k, key ?? parent, assignAliases)];
    }));
    return value;
  }

  private alias(seen: Map<string, string>, prefix: string, value: string): string {
    let alias = seen.get(value);
    if (!alias) {
      alias = `${prefix} ${seen.size + 1}`;
      seen.set(value, alias);
    }
    return alias;
  }
}

export interface Replay {
  fetch: typeof fetch;
  misses: string[];
}

// These affect pagination, retries and conditional reads. Never persist or replay authentication or cookies.
const REPLAY_HEADERS = ['x-ms-continuationtoken', 'retry-after', 'etag'] as const;

export function replayHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(REPLAY_HEADERS.flatMap((key) => {
    const value = headers.get(key);
    return value === null ? [] : [[key, value]];
  }));
}

export function replay(fixture: ContractFixture): Replay {
  const recorded = new Map<string, Exchange[]>();
  for (const exchange of fixture.exchanges) {
    const key = `${exchange.method} ${exchange.path}?${exchange.query}`;
    recorded.set(key, [...(recorded.get(key) ?? []), exchange]);
  }
  const served = new Map<string, number>();
  const misses: string[] = [];

  const replayFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const { path, query } = requestKey(url, fixture.serverUrl);
    const key = `${method} ${path}?${query}`;
    const list = recorded.get(key);
    if (!list) {
      misses.push(key);
      throw new TypeError(`fetch failed: no recorded response for ${key}`);
    }
    const index = served.get(key) ?? 0;
    served.set(key, index + 1);
    const exchange = list[Math.min(index, list.length - 1)]!;
    const headers = new Headers({ ...replayHeaders(new Headers(exchange.headers)), 'content-type': exchange.contentType });
    if (exchange.location) headers.set('location', exchange.location);
    const empty = [204, 205, 304].includes(exchange.status) || method === 'HEAD';
    return new Response(empty ? null : exchange.body, { status: exchange.status, headers });
  };

  return { fetch: replayFetch, misses };
}
