import { TtlCache } from '../util/ttl-cache.js';
import { AdoError, extractAdoMessage } from './errors.js';
import { basicAuth, httpError, isAuthFailure, readLimited, redirectError } from './http.js';

export const API_AREAS = ['core', 'wit', 'witComments', 'work', 'git', 'policy', 'build', 'release', 'wiki', 'tfvc'] as const;
export type ApiArea = (typeof API_AREAS)[number];
export type FetchFn = typeof fetch;

export interface ApiVersionProfile {
  serverVersion: string;
  source: 'options' | 'probe' | 'forced';
  versions: Record<ApiArea, string>;
}

export interface ResourceLocation {
  area?: string;
  resourceName?: string;
  maxVersion?: string;
  releasedVersion?: string;
  resourceVersion?: number;
}

export interface NegotiatorOptions {
  timeoutMs: number;
  ttlMs?: number;
  forceApiVersion?: string;
}

export const MAX_SUPPORTED_VERSION = 7.2;
export const PROBE_VERSIONS = ['7.2', '7.1', '7.0', '6.0'] as const;

const AREA_NAMES = {
  core: 'core',
  wit: 'wit',
  work: 'work',
  git: 'git',
  policy: 'policy',
  build: 'build',
  release: 'release',
  wiki: 'wiki',
  tfvc: 'tfvc',
} as const satisfies Record<Exclude<ApiArea, 'witComments'>, string>;

const toNumber = (value: string | undefined): number => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
};
const capped = (value: string | undefined): number => Math.min(toNumber(value), MAX_SUPPORTED_VERSION);
const format = (value: number): string => value.toFixed(1);

export function commentsVersionFor(version: string): string {
  const value = capped(version);
  return `${format(value)}-preview.${value >= 7.1 ? 4 : 3}`;
}

export function profileForVersion(version: string, source: ApiVersionProfile['source']): ApiVersionProfile {
  const v = format(capped(version));
  return {
    serverVersion: v,
    source,
    versions: { core: v, wit: v, witComments: commentsVersionFor(v), work: v, git: v, policy: v, build: v, release: v, wiki: v, tfvc: v },
  };
}

export function profileFromOptions(locations: ResourceLocation[]): ApiVersionProfile {
  const serverMax = Math.max(0, ...locations.map((location) => capped(location.maxVersion)));
  if (serverMax === 0) throw new AdoError('version', 'The server advertised no REST API versions in OPTIONS _apis.');
  const released = locations.map((location) => capped(location.releasedVersion)).filter((value) => value > 0);
  const profile = profileForVersion(format(released.length > 0 ? Math.max(...released) : serverMax), 'options');

  for (const [area, name] of Object.entries(AREA_NAMES) as Array<[Exclude<ApiArea, 'witComments'>, string]>) {
    const entries = locations.filter((location) => (location.area ?? '').toLowerCase() === name);
    if (entries.length === 0) continue;
    const max = Math.max(...entries.map((entry) => capped(entry.maxVersion)));
    const areaReleased = Math.max(...entries.map((entry) => capped(entry.releasedVersion)));
    profile.versions[area] = areaReleased >= max ? format(max) : areaReleased > 0 ? format(areaReleased) : `${format(max)}-preview`;
  }

  const comments = locations
    .filter((location) => (location.area ?? '').toLowerCase() === 'wit' && (location.resourceName ?? '').toLowerCase() === 'comments')
    .sort((a, b) => capped(b.maxVersion) - capped(a.maxVersion))[0];
  if (comments) {
    const max = capped(comments.maxVersion);
    profile.versions.witComments = capped(comments.releasedVersion) >= max
      ? format(max)
      : `${format(max)}-preview.${comments.resourceVersion ?? 1}`;
  }
  return profile;
}

interface RawResponse {
  status: number;
  contentType: string;
  location: string;
  text: string;
}

const MAX_DISCOVERY_BYTES = 4 * 1024 * 1024;

function parseLocations(text: string): ResourceLocation[] {
  try {
    const parsed = JSON.parse(text) as { value?: unknown };
    return Array.isArray(parsed.value) ? (parsed.value as ResourceLocation[]) : [];
  } catch {
    return [];
  }
}

export class VersionNegotiator {
  private readonly cache: TtlCache<ApiVersionProfile>;

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly options: NegotiatorOptions,
  ) {
    this.cache = new TtlCache<ApiVersionProfile>(options.ttlMs ?? 3_600_000);
  }

  async getProfile(collectionUrl: string, pat: string): Promise<ApiVersionProfile> {
    if (this.options.forceApiVersion) return profileForVersion(this.options.forceApiVersion, 'forced');
    const key = collectionUrl.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) return cached;
    const profile = await this.discover(collectionUrl, pat);
    this.cache.set(key, profile);
    return profile;
  }

  updateArea(collectionUrl: string, area: ApiArea, version: string): void {
    const key = collectionUrl.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) this.cache.set(key, { ...cached, versions: { ...cached.versions, [area]: version } });
  }

  private async discover(collectionUrl: string, pat: string): Promise<ApiVersionProfile> {
    const options = await this.send(`${collectionUrl}/_apis`, 'OPTIONS', pat);
    this.assertAuthenticated(options, collectionUrl);
    if (options.status === 200) {
      const locations = parseLocations(options.text);
      if (locations.length > 0) return profileFromOptions(locations);
    }

    for (const candidate of PROBE_VERSIONS) {
      const probe = await this.send(`${collectionUrl}/_apis/projects?$top=1&api-version=${candidate}`, 'GET', pat);
      this.assertAuthenticated(probe, collectionUrl);
      if (probe.status === 200) return profileForVersion(candidate, 'probe');
      if (probe.status === 404) {
        throw new AdoError('not_found', `No Azure DevOps collection answers at ${collectionUrl}. Check the collection name.`, 404);
      }
      if (probe.status === 400) continue;
      throw httpError(probe.status, extractAdoMessage(probe.text), `Version discovery for ${collectionUrl}`);
    }
    throw new AdoError('version', `Could not agree on a REST API version with ${collectionUrl} (tried ${PROBE_VERSIONS.join(', ')}).`);
  }

  private assertAuthenticated(response: RawResponse, collectionUrl: string): void {
    if (isAuthFailure(response.status, response.contentType, response.location)) {
      throw new AdoError(
        'auth',
        `Authentication failed for ${collectionUrl} (HTTP ${response.status}). The PAT is invalid, expired, or not valid for this collection — use X-ADO-Collection-PATs for collection-specific PATs.`,
        response.status,
      );
    }
    if (response.status >= 300 && response.status < 400) throw redirectError(response.status, response.location, `Version discovery for ${collectionUrl}`);
  }

  private async send(url: string, method: string, pat: string): Promise<RawResponse> {
    const response = await this.fetchFn(url, {
      method,
      headers: { Authorization: basicAuth(pat), Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    let text = '';
    try {
      text = await readLimited(response, MAX_DISCOVERY_BYTES, `${method} ${url}`);
    } catch (error) {
      // An oversized OPTIONS document is read as "no locations", which falls back to probing.
      if (!(method === 'OPTIONS' && error instanceof AdoError && error.kind === 'too_large')) throw error;
    }
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      location: response.headers.get('location') ?? '',
      text,
    };
  }
}