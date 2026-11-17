import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { AdoClient } from '../ado/ado-client.js';
import { AdoError } from '../ado/errors.js';
import { assertSingleHeaders, CallerContextError, credentialRedactor, type CallerContext } from '../context/caller-context.js';
import { SessionMemory } from '../context/session-memory.js';
import type { AppDeps } from '../deps.js';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from '../server.js';
import { whoAmI, type Me } from '../tools/identity.js';
import { TtlCache } from '../util/ttl-cache.js';
import { FailureLimiter, gatewayGuard, originGuard, rpcError, sessionFingerprint } from './security.js';

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  fingerprint: string;
  // Cap key: the Azure DevOps identity id from admission.
  owner: string;
  // Audit label: the signed-in account when known.
  user: string;
  lastSeen: number;
  openStreams: number;
}

export interface HttpApp {
  app: express.Express;
  close(): Promise<void>;
  sessionCount(): number;
}

class AdmissionError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

const ADMISSION_TTL_MS = 10 * 60_000;
// Listed collections tried at admission when the caller names none. Bounded, because each try is a round trip during initialize.
const ADMISSION_PROBES = 5;

interface Admission {
  me: Me;
  refused: string[];
}

// loadConfig has already refused `true` and /0 subnets (alone or in a list), so this is false, a hop count, or Express's address/subnet syntax.
function trustProxySetting(value: string): false | number | string {
  if (/^false$/i.test(value)) return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

export function createHttpApp(deps: AppDeps): HttpApp {
  const { config } = deps;
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', trustProxySetting(config.trustProxy));
  const sessions = new Map<string, Session>();
  // Includes connecting stateful transports and stateless requests until their response closes.
  const transients = new Map<StreamableHTTPServerTransport, { res: Response; dispose(): Promise<void> }>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const rejectClosing = (res: Response): boolean => {
    if (!closing) return false;
    if (!res.headersSent) rpcError(res, 503, -32000, 'The MCP server is shutting down. Try again later.');
    return true;
  };
  const trackTransport = (server: McpServer, transport: StreamableHTTPServerTransport, res: Response, release: () => void = () => undefined): (() => Promise<void>) => {
    let disposed: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      if (!disposed) {
        transients.delete(transport);
        release();
        disposed = Promise.allSettled([transport.close(), server.close()]).then(() => undefined);
      }
      return disposed;
    };
    transients.set(transport, { res, dispose });
    return dispose;
  };
  const admissions = new TtlCache<Admission>(ADMISSION_TTL_MS);
  const callerLimiter = new FailureLimiter(config.authFailureLimit);
  const addressLimiter = new FailureLimiter(config.authFailureLimit * 10);
  const clientIp = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const callerKey = (req: Request): string => `${clientIp(req)}|${sessionFingerprint(req.headers, deps.fingerprintKey).slice(0, 16)}`;
  const recordFailure = (req: Request): void => {
    callerLimiter.record(callerKey(req));
    addressLimiter.record(clientIp(req));
  };

  const deny = (req: Request, res: Response, status: number, message: string, reason: string): void => {
    if (status === 401) recordFailure(req);
    deps.audit({ event: 'admission_denied', reason, status, ip: clientIp(req) });
    rpcError(res, status, status === 503 ? -32000 : -32001, credentialRedactor(undefined, config, req.headers)(message));
  };

  const closeSession = (sessionId: string, reason: string, transportClosed = false): void => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    deps.audit({ event: 'session_close', user: session.user, reason, sessions: sessions.size });
    if (!transportClosed) void session.transport.close();
    void session.server.close();
  };

  const unreachable = (): AdmissionError =>
    new AdmissionError('Azure DevOps Server could not be reached to check the PAT. Check server availability, TLS trust and the configured URL.', 503);

  // With no named collection, only an all-collections PAT can be checked: it is the only kind that may list collections.
  // The list can include collections the user is not a member of, so admission tries the first few in turn.
  const listedCollections = async (client: AdoClient): Promise<string[]> => {
    let listed: string[];
    try {
      listed = await client.listServerCollections();
    } catch (error) {
      if (!(error instanceof AdoError)) throw error;
      if (error.kind !== 'auth' && error.kind !== 'credential') throw unreachable();
      throw new AdmissionError(
        'The PAT could not be checked: it is invalid, or it is scoped to one collection and no collection was named. Send X-ADO-Collections with the collection(s) this PAT is for.',
        401,
      );
    }
    if (listed.length === 0) throw new AdmissionError('This PAT cannot see any collection on the server. Check its organisation scope, or send X-ADO-Collections.', 401);
    return listed.slice(0, ADMISSION_PROBES);
  };

  // Proves the PAT works before a session exists. `refused` lists the probed collections that turned the PAT away.
  const admit = async (ctx: CallerContext, fingerprint: string): Promise<Admission> => {
    return admissions.getOrCreate(fingerprint, async () => {
      const client = new AdoClient(ctx, deps.negotiator, {
        timeoutMs: config.requestTimeoutMs,
        fetchFn: deps.fetchFn,
        maxResponseBytes: config.maxResponseBytes,
      });
      const named = ctx.collections[0];
      if (named) {
        try {
          return { me: await whoAmI(client, { collection: named }), refused: [] };
        } catch (error) {
          if (!(error instanceof AdoError)) throw error;
          if (error.kind === 'auth' || error.kind === 'credential') {
            throw new AdmissionError('The PAT was rejected by Azure DevOps for the requested collection. Check the PAT and X-ADO-Collection / X-ADO-Collections.', 401);
          }
          if (error.kind === 'not_found' || error.kind === 'bad_request') {
            throw new AdmissionError('The requested collection was not found. Check X-ADO-Collection / X-ADO-Collections and the server URL.', 400);
          }
          throw unreachable();
        }
      }
      const candidates = await listedCollections(client);
      const refused: string[] = [];
      for (const collection of candidates) {
        try {
          return { me: await whoAmI(client, { collection }), refused };
        } catch (error) {
          if (!(error instanceof AdoError)) throw error;
          if (!['auth', 'permission', 'not_found', 'bad_request'].includes(error.kind)) throw unreachable();
          refused.push(collection);
        }
      }
      throw new AdmissionError(
        'The PAT can list collections but was not accepted in the checked collections. Send X-ADO-Collections with a collection you are a member of.',
        401,
      );
    });
  };

  // Sessions still connecting, per owner. They count against both caps, because the session map is only filled in once the transport has initialised.
  const pending = new Map<string, number>();
  let pendingTotal = 0;

  // Reserves a session slot synchronously and returns its release function, or which cap is full.
  // At the per-user cap, the owner's least recently used session is closed to make room; if all of the
  // owner's slots are still connecting there is nothing to close, and only this user is turned away.
  const reserveSlot = (owner: string): { release: () => void } | { full: 'user' | 'server' } => {
    const mine = [...sessions.entries()].filter(([, session]) => session.owner === owner).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    const oldest = mine[0];
    const pendingMine = pending.get(owner) ?? 0;
    if (mine.length + pendingMine >= config.maxSessionsPerUser) {
      if (!oldest) return { full: 'user' };
      closeSession(oldest[0], 'evicted');
    } else if (sessions.size + pendingTotal >= config.maxSessions) {
      return { full: 'server' };
    }
    pending.set(owner, pendingMine + 1);
    pendingTotal++;
    let held = true;
    return {
      release: () => {
        if (!held) return;
        held = false;
        pendingTotal--;
        const left = (pending.get(owner) ?? 1) - 1;
        if (left > 0) pending.set(owner, left);
        else pending.delete(owner);
      },
    };
  };

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', name: SERVER_NAME, version: SERVER_VERSION, sessions: sessions.size });
  });

  app.use(
    config.path,
    originGuard(config.allowedOrigins),
    (req, res, next) => {
      if (!callerLimiter.blocked(callerKey(req)) && !addressLimiter.blocked(clientIp(req))) {
        next();
        return;
      }
      res.setHeader('Retry-After', '300');
      rpcError(res, 429, -32001, 'Too many failed authentication attempts. Check the PAT and gateway token, then try again in a few minutes.');
    },
    gatewayGuard(config.httpToken, (req) => {
      recordFailure(req);
      deps.audit({ event: 'admission_denied', reason: 'gateway_token', status: 401, ip: clientIp(req) });
    }),
    express.json({ limit: '5mb' }),
    (_req, res, next) => { if (!rejectClosing(res)) next(); },
  );

  const sessionFor = (req: Request, res: Response): Session | undefined => {
    const sessionId = req.header('mcp-session-id');
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      rpcError(res, sessionId ? 404 : 400, -32000, sessionId ? 'Unknown or expired MCP session. Re-initialize.' : 'Missing Mcp-Session-Id header.');
      return undefined;
    }
    if (session.fingerprint !== sessionFingerprint(req.headers, deps.fingerprintKey)) {
      rpcError(res, 403, -32003, 'This MCP session belongs to different credentials.');
      return undefined;
    }
    session.lastSeen = Date.now();
    return session;
  };

  app.post(config.path, async (req, res) => {
    let ctx: CallerContext;
    try {
      // Node's parsed headers keep only the first Authorization header, so repeats are checked on the raw list.
      assertSingleHeaders(req.rawHeaders);
      ctx = deps.contextFor(req.headers);
    } catch (error) {
      if (error instanceof CallerContextError) {
        deny(req, res, error.httpStatus, error.message, 'caller_headers');
        return;
      }
      throw error;
    }

    if (!config.stateless && req.header('mcp-session-id')) {
      const session = sessionFor(req, res);
      if (session) await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!config.stateless && !isInitializeRequest(req.body)) {
      rpcError(res, 400, -32000, 'Bad Request: send initialize first, or include the Mcp-Session-Id header.');
      return;
    }

    const fingerprint = sessionFingerprint(req.headers, deps.fingerprintKey);
    let admission: Admission;
    try {
      admission = await admit(ctx, fingerprint);
    } catch (error) {
      if (rejectClosing(res)) return;
      if (error instanceof AdmissionError) {
        deny(req, res, error.httpStatus, error.message, 'pat_check');
        return;
      }
      throw error;
    }
    if (rejectClosing(res)) return;
    const { me } = admission;
    const memory = new SessionMemory();
    // Upstream identity labels are untrusted text; preserve the identity id separately for session caps.
    memory.user = credentialRedactor(ctx, config, req.headers)(me.uniqueName ?? me.displayName ?? me.id);
    memory.refusedCollections = new Set(admission.refused.map((name) => name.toLowerCase()));

    if (config.stateless) {
      const server = createMcpServer(deps, { ctx, memory });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const dispose = trackTransport(server, transport, res);
      res.on('close', () => { void dispose(); });
      try {
        await server.connect(transport);
        if (rejectClosing(res)) return;
        await transport.handleRequest(req, res, req.body);
      } finally {
        await dispose();
      }
      return;
    }

    const owner = me.id;
    const user = memory.user ?? owner;
    const slot = reserveSlot(owner);
    if ('full' in slot) {
      deps.audit({ event: 'admission_denied', reason: 'capacity', scope: slot.full, status: 503, ip: clientIp(req) });
      const message =
        slot.full === 'user'
          ? `You already have ${config.maxSessionsPerUser} MCP sessions still connecting (ADO_MCP_MAX_SESSIONS_PER_USER). Wait for them to finish, then try again.`
          : `The MCP server is at its session limit (ADO_MCP_MAX_SESSIONS=${config.maxSessions}). Try again later.`;
      rpcError(res, 503, -32000, message);
      return;
    }
    const { release } = slot;
    const server = createMcpServer(deps, { ctx, memory });
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        release();
        if (closing) return;
        transients.delete(transport);
        sessions.set(sessionId, { transport, server, fingerprint, owner, user, lastSeen: Date.now(), openStreams: 0 });
        deps.audit({ event: 'session_open', user, sessions: sessions.size });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) closeSession(transport.sessionId, 'client', true);
    };
    const dispose = trackTransport(server, transport, res, release);
    try {
      await server.connect(transport);
      if (rejectClosing(res)) return;
      await transport.handleRequest(req, res, req.body);
    } finally {
      release();
      if (closing || transients.has(transport)) await dispose();
    }
  });

  const sessionOnly = async (req: Request, res: Response): Promise<void> => {
    if (config.stateless) {
      res.setHeader('Allow', 'POST');
      rpcError(res, 405, -32000, 'Method not allowed: this server runs in stateless mode.');
      return;
    }
    const session = sessionFor(req, res);
    if (!session) return;
    if (req.method === 'GET') {
      session.openStreams++;
      res.on('close', () => {
        session.openStreams--;
        session.lastSeen = Date.now();
      });
    }
    await session.transport.handleRequest(req, res);
  };
  app.get(config.path, sessionOnly);
  app.delete(config.path, sessionOnly);

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const type = (error as { type?: string } | undefined)?.type;
    if (type === 'entity.parse.failed') rpcError(res, 400, -32700, 'Parse error: body is not valid JSON.');
    else if (type === 'entity.too.large') rpcError(res, 413, -32600, 'Request body is over the 5 MB limit. Attachments are limited to 3 MiB.');
    else rpcError(res, 500, -32603, 'Internal server error.');
  });

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - config.sessionIdleMs;
    for (const [sessionId, session] of [...sessions]) {
      if (session.openStreams > 0 || session.lastSeen >= cutoff) continue;
      closeSession(sessionId, 'idle');
    }
    callerLimiter.sweep();
    addressLimiter.sweep();
  }, 60_000);
  sweeper.unref();

  return {
    app,
    sessionCount: () => sessions.size,
    close() {
      if (closePromise) return closePromise;
      // Terminal before any await: admission is not awaited, and cannot register a session later.
      closing = true;
      clearInterval(sweeper);
      const unfinished = [...transients.values()];
      for (const request of unfinished) rejectClosing(request.res);
      const all = [...sessions.entries()];
      sessions.clear();
      for (const [, session] of all) deps.audit({ event: 'session_close', user: session.user, reason: 'shutdown', sessions: 0 });
      closePromise = Promise.allSettled([
        ...unfinished.map((request) => request.dispose()),
        ...all.flatMap(([, session]) => [session.transport.close(), session.server.close()]),
      ]).then(() => undefined);
      return closePromise;
    },
  };
}
