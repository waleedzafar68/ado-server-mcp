import type { CallerContext } from '../context/caller-context.js';
import { assertAllowedServerUrl, redactSecrets, resolvePat } from '../context/caller-context.js';
import { AdoError, extractAdoMessage } from './errors.js';
import { basicAuth, delay, httpError, isAuthFailure, mapFetchError, readLimited, redirectError, safeSegment } from './http.js';
import type { ApiArea, ApiVersionProfile, FetchFn, VersionNegotiator } from './version-negotiator.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type QueryValue = string | number | boolean | undefined | null;

export interface Target {
  serverUrl?: string;
  collection: string;
  project?: string;
  team?: string;
}

export interface AdoRequest extends Target {
  path: string;
  area: ApiArea;
  method?: HttpMethod;
  query?: Record<string, QueryValue>;
  body?: unknown;
  rawBody?: Uint8Array;
  contentType?: string;
  headers?: Record<string, string>;
  accept?: 'json' | 'text';
  apiVersion?: string;
}

export type ReadRequest = Omit<AdoRequest, 'method' | 'body' | 'rawBody'>;
export type WriteRequest = Omit<AdoRequest, 'method'>;

export interface AdoResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

export interface AdoClientOptions {
  timeoutMs: number;
  fetchFn?: FetchFn;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  beforeWrite?: (what: string) => void;
  redact?: (text: string) => string;
}

export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const OUT_OF_RANGE = /latest REST API version this server supports is (\d+\.\d+)/i;
const PREVIEW_REQUIRED = /-preview flag must be supplied|is under preview/i;

export function nextApiVersion(current: string, message: string): { version: string; reason: 'range' | 'preview' } | undefined {
  const range = OUT_OF_RANGE.exec(message)?.[1];
  if (range && range !== current.split('-')[0]) {
    return { version: current.includes('-preview') ? `${range}-preview` : range, reason: 'range' };
  }
  if (PREVIEW_REQUIRED.test(message) && !current.includes('-preview')) return { version: `${current}-preview`, reason: 'preview' };
  return undefined;
}

function retryDelayMs(response: Response, attempt: number): number {
  const seconds = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
  return Number.isFinite(seconds) ? Math.min(seconds * 1000, 5000) : 250 * (attempt + 1);
}

export class AdoClient {
  private readonly fetchFn: FetchFn;

  constructor(
    private readonly ctx: CallerContext,
    private readonly negotiator: VersionNegotiator,
    private readonly options: AdoClientOptions,
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  get caller(): CallerContext {
    return this.ctx;
  }

  serverUrlFor(target: { serverUrl?: string }): string {
    return target.serverUrl ? assertAllowedServerUrl(target.serverUrl, this.ctx) : this.ctx.serverUrl;
  }

  collectionUrl(target: Target): string {
    return `${this.serverUrlFor(target)}/${safeSegment(target.collection)}`;
  }

  async profile(target: Target): Promise<ApiVersionProfile> {
    const collectionUrl = this.collectionUrl(target);
    try {
      return await this.negotiator.getProfile(collectionUrl, resolvePat(this.ctx, target.collection));
    } catch (error) {
      throw this.clean(mapFetchError(error, collectionUrl));
    }
  }

  async version(target: Target, area: ApiArea): Promise<string> {
    return (await this.profile(target)).versions[area];
  }

  async request<T>(req: AdoRequest): Promise<AdoResponse<T>> {
    const method = req.method ?? 'GET';
    const what = `${method} ${req.path}`;
    const collectionUrl = this.collectionUrl(req);
    const pat = resolvePat(this.ctx, req.collection);
    let version = req.apiVersion ?? (await this.profile(req)).versions[req.area];
    // After the version lookup, which can be slow on a cold cache, so the registry's deadline check sees the real start time.
    if (!SAFE_METHODS.has(method)) this.options.beforeWrite?.(what);
    let versionRetried = false;

    for (let attempt = 0; ; attempt++) {
      const url = this.buildUrl(collectionUrl, req, version);
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method,
          headers: this.headers(pat, req),
          body: this.body(req),
          redirect: 'manual',
          signal: this.signal(),
        });
      } catch (error) {
        if (this.options.signal?.aborted) throw new AdoError('network', `The MCP client cancelled the call during ${what}.`);
        throw this.clean(mapFetchError(error, url));
      }

      const location = response.headers.get('location') ?? '';
      if (isAuthFailure(response.status, response.headers.get('content-type') ?? '', location)) {
        await response.body?.cancel();
        throw this.clean(new AdoError(
          'auth',
          `Authentication failed for collection "${req.collection}" (HTTP ${response.status}). The PAT is invalid, expired, missing a scope, or not valid for this collection — send a collection-specific PAT in X-ADO-Collection-PATs if needed.`,
          response.status,
        ));
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw this.clean(redirectError(response.status, location, what));
      }

      if (response.ok) return { data: await this.parse<T>(response, req, url, what), status: response.status, headers: response.headers };

      const message = extractAdoMessage(await this.errorText(response, url, what));
      if (response.status === 400 && !versionRetried) {
        const next = nextApiVersion(version, message);
        if (next) {
          versionRetried = true;
          version = next.version;
          if (next.reason === 'range' && !req.apiVersion) this.negotiator.updateArea(collectionUrl, req.area, next.version);
          continue;
        }
      }
      if (method === 'GET' && RETRYABLE_STATUS.has(response.status) && attempt < 2) {
        await delay(retryDelayMs(response, attempt));
        continue;
      }
      throw this.clean(httpError(response.status, message, what));
    }
  }

  async get<T>(req: ReadRequest): Promise<T> {
    return (await this.request<T>({ ...req, method: 'GET' })).data;
  }

  async post<T>(req: WriteRequest): Promise<T> {
    return (await this.request<T>({ ...req, method: 'POST' })).data;
  }

  async patch<T>(req: WriteRequest): Promise<T> {
    return (await this.request<T>({ ...req, method: 'PATCH' })).data;
  }

  async put<T>(req: WriteRequest): Promise<T> {
    return (await this.request<T>({ ...req, method: 'PUT' })).data;
  }

  async del<T>(req: ReadRequest): Promise<T> {
    return (await this.request<T>({ ...req, method: 'DELETE' })).data;
  }

  async getAllPages<T>(req: ReadRequest, maxPages = 10): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const response = await this.request<{ value?: T[] }>({ ...req, method: 'GET', query: { ...req.query, continuationToken: token } });
      items.push(...(response.data?.value ?? []));
      token = response.headers.get('x-ms-continuationtoken') ?? undefined;
      pages++;
    } while (token && pages < maxPages);
    return { items, truncated: Boolean(token) };
  }

  async listServerCollections(serverUrl?: string): Promise<string[]> {
    const base = this.serverUrlFor({ serverUrl });
    const pat = this.ctx.globalPat;
    if (!pat) throw new AdoError('credential', 'Listing collections needs a PAT in Authorization: Bearer <PAT> that was created for all accessible collections.');
    const url = `${base}/_apis/projectCollections?api-version=6.0&$top=100`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: { Authorization: basicAuth(pat), Accept: 'application/json' },
        redirect: 'manual',
        signal: this.signal(),
      });
    } catch (error) {
      throw this.clean(mapFetchError(error, url));
    }
    const location = response.headers.get('location') ?? '';
    const listWhat = 'GET _apis/projectCollections';
    if (isAuthFailure(response.status, response.headers.get('content-type') ?? '', location)) {
      await response.body?.cancel();
      throw this.clean(new AdoError('auth', 'This PAT cannot list collections (it is probably scoped to a single collection).', response.status));
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw this.clean(redirectError(response.status, location, listWhat));
    }
    if (!response.ok) throw this.clean(httpError(response.status, extractAdoMessage(await this.errorText(response, url, listWhat)), listWhat));
    const text = await this.readBody(response, this.maxResponseBytes, listWhat, url);
    let data: { value?: Array<{ name: string }> };
    try {
      data = JSON.parse(text) as { value?: Array<{ name: string }> };
    } catch {
      throw this.clean(new AdoError('server', `Expected JSON from _apis/projectCollections but received: ${text.slice(0, 200)}`));
    }
    return (data.value ?? []).map((collection) => collection.name);
  }

  private get maxResponseBytes(): number {
    return this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  private signal(): AbortSignal {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    return this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout;
  }

  private async errorText(response: Response, url: string, what: string): Promise<string> {
    try {
      return await this.readBody(response, MAX_ERROR_BODY_BYTES, what, url);
    } catch (error) {
      if (error instanceof AdoError && error.kind === 'too_large') {
        return `(error body larger than ${MAX_ERROR_BODY_BYTES / 1024} KiB)`;
      }
      throw error;
    }
  }

  private buildUrl(collectionUrl: string, req: AdoRequest, version: string): string {
    const parts = [collectionUrl];
    if (req.project) parts.push(safeSegment(req.project));
    if (req.team) parts.push(safeSegment(req.team));
    const pathPart = req.path.replace(/^\/+/, '').split('?')[0]!;
    for (const segment of pathPart.split('/')) {
      if (segment === '.' || segment === '..' || segment.includes('\\') || /%2e|%2f/i.test(segment)) {
        throw new AdoError('bad_request', `Invalid request path "${req.path}".`);
      }
    }
    parts.push(pathPart);
    const url = new URL(parts.join('/'));
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    url.searchParams.set('api-version', version);
    return url.toString();
  }

  private headers(pat: string, req: AdoRequest): Record<string, string> {
    const pin = new Set(['authorization', 'cookie', 'host', 'content-type']);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers ?? {})) {
      if (!pin.has(key.toLowerCase())) headers[key] = value;
    }
    headers.Authorization = basicAuth(pat);
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'accept')) {
      headers.Accept = req.accept === 'text' ? 'text/plain' : 'application/json';
    }
    if (req.rawBody) headers['Content-Type'] = req.contentType ?? 'application/octet-stream';
    else if (req.body !== undefined) headers['Content-Type'] = req.contentType ?? 'application/json';
    return headers;
  }

  private body(req: AdoRequest): RequestInit['body'] {
    // Uint8Array is a valid fetch body; the cast only bridges lib.dom / undici typing differences.
    if (req.rawBody) return req.rawBody as unknown as RequestInit['body'];
    return req.body === undefined ? undefined : JSON.stringify(req.body);
  }

  private async parse<T>(response: Response, req: AdoRequest, url: string, what: string): Promise<T> {
    const text = await this.readBody(response, this.maxResponseBytes, what, url);
    if (req.accept === 'text') return text as T;
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw this.clean(new AdoError('server', `Expected JSON from ${req.path} but received: ${text.slice(0, 200)}`));
    }
  }

  private async readBody(response: Response, maxBytes: number, what: string, url: string): Promise<string> {
    const signal = this.signal();
    try {
      return await Promise.race([
        readLimited(response, maxBytes, what),
        new Promise<never>((_, reject) => {
          const abort = (): void => {
            void response.body?.cancel().catch(() => {
              // Body may already be locked by readLimited.
            });
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          };
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } catch (error) {
      this.mapBodyReadError(error, url, what);
    }
  }

  private mapBodyReadError(error: unknown, url: string, what: string): never {
    if (error instanceof AdoError) throw error;
    if (this.options.signal?.aborted) throw new AdoError('network', `The MCP client cancelled the call during ${what}.`);
    throw this.clean(mapFetchError(error, url));
  }

  private clean(error: AdoError): AdoError {
    return new AdoError(error.kind, this.options.redact ? this.options.redact(error.message) : redactSecrets(error.message, this.ctx), error.status);
  }
}
