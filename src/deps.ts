import { randomBytes } from 'node:crypto';
import type { FetchFn } from './ado/version-negotiator.js';
import { VersionNegotiator } from './ado/version-negotiator.js';
import { NO_AUDIT, stderrAudit, type AuditSink } from './audit.js';
import type { ServerConfig } from './config/env.js';
import { buildCallerContext, buildStdioCallerContext, type CallerContext, type HeaderBag } from './context/caller-context.js';
import { TtlCache } from './util/ttl-cache.js';

// A destructive call must start writing while the client is still waiting for it (Task 9's runTool).
export interface CallTiming {
  // The tool-call timeout of common MCP clients.
  clientTimeoutMs: number;
  // The first write must start at least this long before the client gives up.
  writeReserveMs: number;
  // Below this, a confirmation prompt is not worth showing.
  minPromptMs: number;
}

export const DEFAULT_CALL_TIMING: CallTiming = { clientTimeoutMs: 60_000, writeReserveMs: 10_000, minPromptMs: 10_000 };

export interface AppDeps {
  config: ServerConfig;
  fetchFn: FetchFn;
  negotiator: VersionNegotiator;
  catalogCache: TtlCache<unknown>;
  fingerprintKey: Buffer;
  audit: AuditSink;
  timing: CallTiming;
  contextFor(headers?: HeaderBag): CallerContext;
}

export function createDeps(config: ServerConfig, fetchFn: FetchFn = fetch, audit?: AuditSink): AppDeps {
  const stdioContext = config.transport === 'stdio' ? buildStdioCallerContext(config) : undefined;
  return {
    config,
    fetchFn,
    negotiator: new VersionNegotiator(fetchFn, { timeoutMs: config.requestTimeoutMs, forceApiVersion: config.forceApiVersion }),
    catalogCache: new TtlCache<unknown>(300_000),
    fingerprintKey: randomBytes(32),
    audit: audit ?? (config.auditLog ? stderrAudit() : NO_AUDIT),
    timing: { ...DEFAULT_CALL_TIMING, clientTimeoutMs: config.clientTimeoutMs },
    contextFor: (headers) => stdioContext ?? buildCallerContext(headers ?? {}, config),
  };
}