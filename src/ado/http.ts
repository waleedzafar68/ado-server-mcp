import { AdoError } from './errors.js';

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function basicAuth(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`;
}

const SIGN_IN_LOCATION = /_signin|signin|login|wsfederation|oauth2/i;

// Azure DevOps Server / IIS answer a bad PAT with 401, a TFS 203 sign-in page, a redirect to a sign-in page,
// or a 200 HTML page. A JSON or plain-text API should never return HTML.
export function isAuthFailure(status: number, contentType: string, location = ''): boolean {
  return (
    status === 401 ||
    status === 203 ||
    (status >= 300 && status < 400 && SIGN_IN_LOCATION.test(location)) ||
    (status >= 200 && status < 300 && contentType.toLowerCase().includes('text/html'))
  );
}

// Redirects are never followed: the PAT must not be replayed to a URL the caller did not configure.
export function redirectError(status: number, location: string, what: string): AdoError {
  let target = location ? 'another path on the same server' : 'an unspecified location';
  try {
    target = new URL(location).host;
  } catch {
    // Relative or empty Location: keep the generic description.
  }
  return new AdoError(
    'server',
    `${what} was redirected (HTTP ${status}) to ${target}. Redirects are not followed so your PAT stays with the configured server; check ADO_DEFAULT_SERVER_URL and the load balancer.`,
    status,
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the Azure DevOps Server';
  }
}

function tooLarge(maxBytes: number, what: string): AdoError {
  const mib = (maxBytes / 1024 / 1024).toFixed(1);
  return new AdoError(
    'too_large',
    `${what} returned more than ${mib} MiB (ADO_MAX_RESPONSE_BYTES). Narrow the request: a line range, a smaller top, or a more specific path.`,
    413,
  );
}

export async function readLimited(response: Response, maxBytes: number, what: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw tooLarge(maxBytes, what);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge(maxBytes, what);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// encodeURIComponent leaves "." and ".." intact, and URL parsing would then resolve them as path steps.
export function safeSegment(value: string | number): string {
  const text = String(value);
  if (text === '' || text === '.' || text === '..') throw new AdoError('bad_request', `"${text}" is not a valid name or id.`);
  return encodeURIComponent(text);
}

export function mapFetchError(error: unknown, url: string): AdoError {
  if (error instanceof AdoError) return error;
  const err = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const host = hostOf(url);
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return new AdoError('network', `Azure DevOps Server at ${host} did not answer in time. Check VPN and firewall routes from the MCP host.`);
  }
  const code = err?.cause?.code;
  if (code && TLS_CODES.has(code)) {
    return new AdoError(
      'tls',
      `TLS validation failed for ${host} (${code}). Trust your internal CA with NODE_EXTRA_CA_CERTS=/path/to/ca.pem; this server never disables TLS verification.`,
    );
  }
  return new AdoError('network', `Could not reach ${host}: ${code ?? err?.cause?.message ?? err?.message ?? 'unknown error'}.`);
}

export function httpError(status: number, message: string, what: string): AdoError {
  if (status === 401) {
    return new AdoError('auth', `Azure DevOps Server rejected the credentials for ${what} (HTTP 401): ${message}`, status);
  }
  if (status === 403) return new AdoError('permission', `Azure DevOps Server denied ${what} for your account: ${message}`, status);
  if (status === 404) return new AdoError('not_found', `${what} was not found or is not visible to you: ${message}`, status);
  if (status === 409 || status === 412) return new AdoError('conflict', `${what} conflicted with the current state: ${message}`, status);
  if (status >= 500) return new AdoError('server', `Azure DevOps Server failed on ${what} (HTTP ${status}): ${message}`, status);
  return new AdoError('bad_request', `Azure DevOps Server rejected ${what} (HTTP ${status}): ${message}`, status);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}