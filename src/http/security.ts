import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Request, RequestHandler, Response } from 'express';
import type { ServerConfig } from '../config/env.js';

// 401s never carry WWW-Authenticate: MCP clients read it as the start of OAuth discovery, which this server does not offer.
export function rpcError(res: Response, httpStatus: number, code: number, message: string): void {
  res.status(httpStatus).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

export function originGuard(allowedOrigins: readonly string[]): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || allowedOrigins.includes(origin.replace(/\/+$/, '').toLowerCase())) {
      next();
      return;
    }
    rpcError(res, 403, -32000, 'Origin is not allowed. Configure ADO_MCP_ALLOWED_ORIGINS for trusted browser origins.');
  };
}

export const GATEWAY_TOKEN_HEADER = 'x-ado-mcp-token';

export function gatewayGuard(token: string | undefined, onFailure: (req: Request) => void = () => undefined): RequestHandler {
  if (!token) return (_req, _res, next) => next();
  const expected = createHash('sha256').update(token).digest();
  return (req, res, next) => {
    const raw = req.headers[GATEWAY_TOKEN_HEADER];
    const presented = Array.isArray(raw) ? undefined : raw?.trim();
    const actual = createHash('sha256').update(presented ?? '').digest();
    if (presented && timingSafeEqual(actual, expected)) {
      next();
      return;
    }
    onFailure(req);
    rpcError(res, 401, -32001, 'Missing or invalid gateway token. Send X-ADO-MCP-Token: <ADO_MCP_HTTP_TOKEN>.');
  };
}

const FINGERPRINT_HEADERS = ['authorization', 'x-ado-collection-pats', 'x-ado-server-url', 'x-ado-collection', 'x-ado-collections', GATEWAY_TOKEN_HEADER];

export function sessionFingerprint(headers: IncomingHttpHeaders, key: Buffer): string {
  const material = FINGERPRINT_HEADERS.map((name) => {
    const value = headers[name];
    return `${name}=${Array.isArray(value) ? value.join(',') : (value ?? '')}`;
  }).join('\n');
  return createHmac('sha256', key).update(material).digest('hex');
}

// Sliding-window count of authentication failures per key (caller or address).
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 5 * 60_000,
  ) {}

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.limit;
  }

  record(key: string, now = Date.now()): void {
    this.failures.set(key, [...this.recent(key, now), now]);
  }

  sweep(now = Date.now()): void {
    for (const key of [...this.failures.keys()]) this.recent(key, now);
  }

  private recent(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (kept.length > 0) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function startupWarnings(config: ServerConfig): string[] {
  if (config.transport !== 'http') return [];
  const warnings: string[] = [];
  const exposed = !LOOPBACK.has(config.host);
  if (!config.httpToken && exposed) {
    warnings.push(
      `ADO_MCP_HTTP_TOKEN is not set and the server listens on ${config.host}. Any client that can reach it can open sessions with a PAT of its own. PATs are checked at initialize and failures are rate-limited, but put the server behind an authenticating gateway or set ADO_MCP_HTTP_TOKEN.`,
    );
  }
  if (exposed && !config.trustProxy) {
    warnings.push(
      'ADO_MCP_TRUST_PROXY is not set. Behind a reverse proxy or load balancer, every caller then shares the proxy address in the rate limiter. Set it to the proxy hop count or subnet (or "false" when clients connect directly).',
    );
  }
  if (config.allowInsecureHttp) warnings.push('ADO_ALLOW_INSECURE_HTTP is on: PATs may be sent to Azure DevOps over plain HTTP.');
  return warnings;
}
