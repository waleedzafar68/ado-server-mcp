import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Flavor = '2020' | '25H2';

export interface MockProject { id: string; name: string; defaultTeam: string; sourceControl?: 'Git' | 'Tfvc' }
export interface MockRepository { id: string; name: string; project: string; defaultBranch: string }
export interface MockCollection { name: string; pats: string[]; projects: MockProject[]; repositories: MockRepository[] }

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  apiVersion: string | null;
  pat?: string;
  body: unknown;
  headers: IncomingMessage['headers'];
}

export interface RouteResult {
  status?: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export type RouteHandler = (request: RecordedRequest, match: RegExpExecArray) => RouteResult | Promise<RouteResult>;

export interface MockAdoOptions {
  flavor: Flavor;
  collections?: MockCollection[];
  optionsBlocked?: boolean;
  allCollectionsPats?: string[];
}

const PREVIEW_ONLY = [/\/_apis\/wit\/workItems\/\d+\/comments/i, /\/_apis\/policy\/evaluations/i, /\/_apis\/connectionData$/i];

export function defaultCollections(): MockCollection[] {
  return [
    {
      name: 'DemoCollection',
      pats: ['pat-demo', 'pat-all'],
      projects: [
        { id: 'p-devsecops', name: 'DemoProject', defaultTeam: 'DemoProject Team' },
        { id: 'p-service', name: 'DemoService', defaultTeam: 'DemoService Team' },
        { id: 'p-product', name: 'Demo Product', defaultTeam: 'Demo Product Team' },
      ],
      repositories: [
        { id: 'r-mcp', name: 'ado-server-mcp', project: 'DemoProject', defaultBranch: 'refs/heads/develop' },
        { id: 'r-devsecops', name: 'DemoProject', project: 'DemoProject', defaultBranch: 'refs/heads/master' },
        { id: 'r-service', name: 'demoservice-api', project: 'DemoService', defaultBranch: 'refs/heads/main' },
        { id: 'r-shared-demo', name: 'shared-lib', project: 'DemoService', defaultBranch: 'refs/heads/main' },
      ],
    },
    {
      name: 'LegacyCollection',
      pats: ['pat-2017', 'pat-all'],
      projects: [
        { id: 'p-portal', name: 'LEGACY PRODUCT', defaultTeam: 'LEGACY PRODUCT Team' },
        { id: 'p-skills', name: 'DemoAutomation', defaultTeam: 'DemoAutomation Team' },
      ],
      repositories: [
        { id: 'r-portal', name: 'portal-portal', project: 'LEGACY PRODUCT', defaultBranch: 'refs/heads/main' },
        { id: 'r-shared-2017', name: 'shared-lib', project: 'DemoAutomation', defaultBranch: 'refs/heads/main' },
      ],
    },
  ];
}

export function resourceLocations(flavor: Flavor): Array<Record<string, unknown>> {
  const version = flavor === '2020' ? '6.0' : '7.2';
  const ga = (area: string, resourceName: string) => ({
    id: `${area}-${resourceName}`, area, resourceName, minVersion: '1.0', maxVersion: version, releasedVersion: version, resourceVersion: 1,
  });
  return [
    ga('core', 'projects'),
    ga('core', 'teams'),
    ga('wit', 'workItems'),
    ga('wit', 'wiql'),
    { id: 'wit-comments', area: 'wit', resourceName: 'comments', minVersion: '5.1', maxVersion: version, releasedVersion: '0.0', resourceVersion: flavor === '2020' ? 3 : 4 },
    ga('work', 'boards'),
    ga('git', 'repositories'),
    ga('git', 'pullRequests'),
    { id: 'policy-evaluations', area: 'policy', resourceName: 'evaluations', minVersion: '5.0', maxVersion: version, releasedVersion: '0.0', resourceVersion: 1 },
    ga('build', 'builds'),
    ga('Release', 'releases'),
    ga('wiki', 'wikis'),
    ga('tfvc', 'items'),
    ga('tfvc', 'changesets'),
    ga('tfvc', 'shelvesets'),
    ...(flavor === '25H2'
      ? [{ id: 'core-future', area: 'core', resourceName: 'future', minVersion: '7.3', maxVersion: '7.3', releasedVersion: '0.0', resourceVersion: 1 }]
      : []),
  ];
}

// Deterministic GUID-shaped identity from a SHA-256 digest (not reversible to the PAT).
export function userIdFor(pat: string): string {
  const hex = createHash('sha256').update(pat).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function parsePat(authorization: string | undefined): string | undefined {
  if (!authorization || !/^basic /i.test(authorization)) return undefined;
  const decoded = Buffer.from(authorization.slice(authorization.indexOf(' ') + 1), 'base64').toString('utf8');
  if (!decoded.includes(':')) return undefined;
  return decoded.slice(decoded.indexOf(':') + 1);
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export class MockAdoServer {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }> = [];
  private readonly collections: MockCollection[];
  private server: Server | undefined;
  private port = 0;

  constructor(readonly options: MockAdoOptions) {
    this.collections = options.collections ?? defaultCollections();
  }

  get serverUrl(): string {
    return `http://127.0.0.1:${this.port}/tfs`;
  }

  get maxVersion(): number {
    return this.options.flavor === '2020' ? 6.0 : 7.2;
  }

  on(method: string, pattern: RegExp, handler: RouteHandler): this {
    this.routes.unshift({ method: method.toUpperCase(), pattern, handler });
    return this;
  }

  requestsTo(pattern: RegExp, method?: string): RecordedRequest[] {
    const normalized = method?.toUpperCase();
    return this.requests.filter((request) => pattern.test(request.path) && (!normalized || request.method.toUpperCase() === normalized));
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        res.statusCode = 500;
        res.end(String(error));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const contentType = String(req.headers['content-type'] ?? '');
    const body =
      raw.length === 0 ? undefined
        : contentType.includes('json') ? JSON.parse(raw.toString('utf8'))
          : contentType.includes('octet-stream') ? raw
            : raw.toString('utf8');

    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      apiVersion: url.searchParams.get('api-version'),
      pat: parsePat(req.headers.authorization),
      body,
      headers: req.headers,
    };
    this.requests.push(recorded);

    const result = await this.route(recorded);
    res.statusCode = result.status ?? 200;
    for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
    if (result.json !== undefined) {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(result.json));
      return;
    }
    res.setHeader('content-type', result.contentType ?? 'text/plain; charset=utf-8');
    res.end(result.text ?? '');
  }

  private async route(r: RecordedRequest): Promise<RouteResult> {
    if (r.path === '/tfs/_apis/projectCollections') {
      if (!r.pat || !(this.options.allCollectionsPats ?? ['pat-all']).includes(r.pat)) {
        return { status: 401, text: 'Unauthorized', headers: { 'WWW-Authenticate': 'Basic realm="tfs"' } };
      }
      return { json: { count: this.collections.length, value: this.collections.map((c) => ({ id: `c-${c.name}`, name: c.name })) } };
    }

    const segments = r.path.split('/');
    const collection = this.collections.find((c) => same(c.name, segments[2] ?? ''));
    if (segments[1] !== 'tfs' || !collection) {
      return { status: 404, contentType: 'text/html', text: '<html><body>TF400324: Team Foundation services are not available.</body></html>' };
    }

    if (!r.pat || !collection.pats.includes(r.pat)) {
      return this.options.flavor === '2020'
        ? { status: 203, contentType: 'text/html', text: '<html><body>Sign in to Azure DevOps Server</body></html>' }
        : { status: 401, text: '', headers: { 'WWW-Authenticate': 'Bearer, Basic realm="tfs", NTLM' } };
    }

    const rest = `/${segments.slice(3).join('/')}`;
    if (r.method === 'OPTIONS' && rest === '/_apis') {
      return this.options.optionsBlocked
        ? { status: 405, text: 'Method Not Allowed' }
        : { json: { count: resourceLocations(this.options.flavor).length, value: resourceLocations(this.options.flavor) } };
    }

    const versionProblem = this.versionProblem(r);
    if (versionProblem) return versionProblem;

    for (const route of this.routes) {
      if (route.method !== (r.method ?? 'GET').toUpperCase()) continue;
      route.pattern.lastIndex = 0;
      const match = route.pattern.exec(r.path);
      if (match) return route.handler(r, match);
    }

    return this.builtin(collection, rest, r) ?? {
      status: 404,
      json: { message: `TF400898: mock route not found: ${r.method} ${r.path}`, typeKey: 'NotFoundException' },
    };
  }

  private versionProblem(r: RecordedRequest): RouteResult | undefined {
    const version = r.apiVersion;
    if (!version) return { status: 400, json: { message: 'No api-version was supplied for the request.', typeKey: 'VssVersionNotSpecifiedException' } };
    const base = Number.parseFloat(version);
    if (!Number.isFinite(base) || base > this.maxVersion + 1e-9) {
      return {
        status: 400,
        json: {
          message: `The requested REST API version of ${version} is out of range for this server. The latest REST API version this server supports is ${this.maxVersion.toFixed(1)}.`,
          typeKey: 'VssVersionOutOfRangeException',
        },
      };
    }
    if (PREVIEW_ONLY.some((pattern) => pattern.test(r.path)) && !version.includes('-preview')) {
      return {
        status: 400,
        json: {
          message: `The requested version "${version}" of the resource is under preview. The -preview flag must be supplied in the api-version for such requests. For example: "${version}-preview"`,
          typeKey: 'VssInvalidPreviewVersionException',
        },
      };
    }
    return undefined;
  }

  private builtin(collection: MockCollection, rest: string, r: RecordedRequest): RouteResult | undefined {
    const repoJson = (repo: MockRepository) => {
      const project = collection.projects.find((p) => p.name === repo.project)!;
      return {
        id: repo.id,
        name: repo.name,
        project: { id: project.id, name: project.name },
        defaultBranch: repo.defaultBranch,
        remoteUrl: `${this.serverUrl}/${collection.name}/${encodeURIComponent(project.name)}/_git/${repo.name}`,
        sshUrl: `ssh://127.0.0.1:22/tfs/${collection.name}/${encodeURIComponent(project.name)}/_ssh/${repo.name}`,
        size: 2048,
        isDisabled: false,
      };
    };

    if (r.method === 'POST' && /^\/[^/]+\/_apis\/git\/repositories$/.test(rest)) {
      return {
        status: 403,
        json: {
          message: "TF401027: You need the Git 'CreateRepository' permission to perform this action. Details: identity 'CORPTEST\\demo.user', scope 'project'.",
          typeKey: 'GitNeedsPermissionException',
        },
      };
    }
    if (r.method !== 'GET') return undefined;

    if (rest === '/_apis/connectionData') {
      return {
        json: {
          authenticatedUser: { id: userIdFor(r.pat ?? ''), providerDisplayName: 'Jordan Example', properties: { Account: { $value: 'CORPTEST\\demo.user' } } },
          instanceId: 'instance-1',
          deploymentType: 'onPremises',
        },
      };
    }
    if (rest === '/_apis/projects') {
      return { json: { count: collection.projects.length, value: collection.projects.map((p) => ({ id: p.id, name: p.name, state: 'wellFormed', visibility: 'private' })) } };
    }
    const project = /^\/_apis\/projects\/([^/]+)$/.exec(rest);
    if (project) {
      const found = collection.projects.find((p) => same(p.name, project[1] ?? '') || p.id === project[1]);
      return found
        ? {
          json: {
            id: found.id,
            name: found.name,
            description: `${found.name} project`,
            state: 'wellFormed',
            visibility: 'private',
            defaultTeam: { id: `t-${found.id}`, name: found.defaultTeam },
            capabilities: { versioncontrol: { sourceControlType: found.sourceControl ?? 'Git' }, processTemplate: { templateName: 'Agile' } },
          },
        }
        : { status: 404, json: { message: `TF200016: The following project does not exist: ${project[1]}.` } };
    }
    if (rest === '/_apis/git/repositories') {
      return { json: { count: collection.repositories.length, value: collection.repositories.map(repoJson) } };
    }
    const projectRepos = /^\/([^/]+)\/_apis\/git\/repositories$/.exec(rest);
    if (projectRepos) {
      const key = projectRepos[1] ?? '';
      const proj = collection.projects.find((p) => same(p.name, key) || p.id === key);
      if (!proj) {
        return { status: 404, json: { message: `TF200016: The following project does not exist: ${key}.` } };
      }
      const value = collection.repositories.filter((repo) => same(repo.project, proj.name)).map(repoJson);
      return { json: { count: value.length, value } };
    }
    const repo = /^\/([^/]+)\/_apis\/git\/repositories\/([^/]+)$/.exec(rest);
    if (repo) {
      const projKey = repo[1] ?? '';
      const proj = collection.projects.find((p) => same(p.name, projKey) || p.id === projKey);
      if (!proj) {
        return { status: 404, json: { message: `TF200016: The following project does not exist: ${projKey}.` } };
      }
      const found = collection.repositories.find((x) => same(x.project, proj.name) && (same(x.name, repo[2] ?? '') || x.id === repo[2]));
      return found
        ? { json: repoJson(found) }
        : { status: 404, json: { message: `TF401019: The Git repository with name or identifier ${repo[2]} does not exist or you do not have permissions for the operation you are attempting.` } };
    }
    return undefined;
  }
}