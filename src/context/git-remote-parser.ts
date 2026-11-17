export interface ParsedRemote {
  serverUrl?: string;
  sshHost?: string;
  collection: string;
  project: string;
  repository: string;
}

const CLOUD_HOST = /(^|\.)dev\.azure\.com$|\.visualstudio\.com$/i;

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseGitRemoteUrl(remote: string, knownCollections: readonly string[] = []): ParsedRemote | undefined {
  const trimmed = remote.trim();
  if (!trimmed) return undefined;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || CLOUD_HOST.test(url.hostname)) return undefined;

  const segments = url.pathname.split('/').filter(Boolean).map(decode);
  const marker = segments.findIndex((segment) => segment === '_git' || segment === '_ssh');
  const repository = marker >= 0 ? segments[marker + 1] : undefined;
  if (!repository) return undefined;

  const before = segments.slice(0, marker);
  const known = knownCollections.map((name) => name.toLowerCase());
  let prefix: string[];
  let collection: string | undefined;
  let project: string | undefined;

  const knownIndex = before.findLastIndex((segment) => known.includes(segment.toLowerCase()));
  if (knownIndex >= 0) {
    if (before.length > knownIndex + 2) return undefined;
    prefix = before.slice(0, knownIndex);
    collection = before[knownIndex];
    project = before[knownIndex + 1] ?? repository;
  } else {
    let rest = before;
    prefix = [];
    if (rest[0]?.toLowerCase() === 'tfs') {
      prefix = [rest[0]];
      rest = rest.slice(1);
    }
    if (rest.length === 0) return undefined;
    if (rest.length === 1) {
      collection = rest[0];
      project = repository;
    } else {
      prefix = [...prefix, ...rest.slice(0, -2)];
      collection = rest[rest.length - 2];
      project = rest[rest.length - 1];
    }
  }
  if (!collection || !project) return undefined;

  // An SSH remote names no HTTP server URL, but its host must still be checked before anything is written (Task 8).
  if (url.protocol === 'ssh:') return { serverUrl: undefined, sshHost: url.hostname.toLowerCase(), collection, project, repository };
  const serverUrl = `${url.protocol}//${url.host}${prefix.length > 0 ? `/${prefix.map((segment) => encodeURIComponent(segment)).join('/')}` : ''}`;
  return { serverUrl, collection, project, repository };
}