import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  ElicitResultSchema,
  ListRootsResultSchema,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { AdoClient } from '../ado/ado-client.js';
import { HARD_MAX_CHARS, truncate } from '../ado/bounded.js';
import { AdoError, DisambiguationRequired } from '../ado/errors.js';
import type { ServerConfig, Toolset } from '../config/env.js';
import { CallerContextError, credentialFingerprint, credentialRedactor, redactStrings, type CallerContext } from '../context/caller-context.js';
import { ContextResolver, type ClientBridge } from '../context/context-resolver.js';
import { SessionMemory } from '../context/session-memory.js';
import type { AppDeps } from '../deps.js';

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
export type ToolsetName = Toolset | 'context';
export type InputShape = Record<string, z.ZodType>;

export interface ToolEnv {
  ctx: CallerContext;
  client: AdoClient;
  resolver: ContextResolver;
  config: ServerConfig;
  // Destructive tools call this once, after loading their target and before writing. It throws [declined] unless the user agrees.
  confirm(action: string): Promise<void>;
}

export interface ToolDefinition<S extends InputShape = InputShape> {
  name: string;
  toolset: ToolsetName;
  title: string;
  description: string;
  readOnly: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  input: S;
  handler: (args: z.infer<z.ZodObject<S>>, env: ToolEnv) => Promise<unknown>;
}

export type AnyTool = ToolDefinition<InputShape>;

export function defineTool<S extends InputShape>(definition: ToolDefinition<S>): AnyTool {
  return definition as unknown as AnyTool;
}

export function selectTools(
  tools: readonly AnyTool[],
  config: ServerConfig,
  ctx?: Pick<CallerContext, 'toolsets' | 'readOnly'>,
): AnyTool[] {
  return tools.filter((tool) => {
    if (tool.toolset !== 'context') {
      if (!config.toolsets.has(tool.toolset)) return false;
      if (ctx?.toolsets && !ctx.toolsets.has(tool.toolset)) return false;
    }
    return tool.readOnly || !(config.readOnly || ctx?.readOnly);
  });
}

export function registerTools(server: McpServer, tools: readonly AnyTool[], deps: AppDeps, memory = new SessionMemory()): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly,
          destructiveHint: !tool.readOnly && (tool.destructive ?? false),
          idempotentHint: tool.readOnly || (tool.idempotent ?? false),
          openWorldHint: true,
        },
      },
      // The SDK infers the callback type from the schema; our handlers are typed through defineTool instead.
      (async (args: Record<string, unknown>, extra: ToolExtra) => runTool(server, tool, args, extra, deps, memory)) as never,
    );
  }
}

function boundedText(text: string): string {
  return text.length <= HARD_MAX_CHARS ? text : truncate(text, HARD_MAX_CHARS - 64);
}

function success(value: unknown): CallToolResult {
  const text = typeof value === 'string' ? boundedText(value) : fitJson(value);
  return { content: [{ type: 'text', text }] };
}

function failure(kind: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: boundedText(`[${kind}] ${message}`) }] };
}

const MAX_LIST_DEPTH = 4;
const MAX_SHORTEN_PASSES = 8;
type ListPath = Array<string | number>;

// Cutting serialised JSON would leave it unparseable, so shorten lists instead: the longest one first, nested ones included, until the result fits.
function fitJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  if (text.length <= HARD_MAX_CHARS) return text;
  let current = value;
  const shortened: string[] = [];
  for (let pass = 0; pass < MAX_SHORTEN_PASSES; pass++) {
    const found = findLongest(current);
    if (!found) break;
    const size = JSON.stringify(current, null, 2).length;
    const keep = Math.max(1, Math.floor(found.items.length * (HARD_MAX_CHARS / size) * 0.9));
    current = replaceAt(current, found.path, found.items.slice(0, keep));
    shortened.push(`${keep} of ${found.items.length} ${found.path.length > 0 ? found.path.join('.') : 'items'}`);
    const note = `Showing ${shortened.join('; ')} to stay under ${HARD_MAX_CHARS} characters. Narrow the request or lower top to see the rest.`;
    const out = JSON.stringify(Array.isArray(current) ? { truncated: true, note, items: current } : { ...(current as object), truncated: true, note }, null, 2);
    if (out.length <= HARD_MAX_CHARS) return out;
  }
  return JSON.stringify(
    { truncated: true, note: `The result was ${text.length} characters, over the ${HARD_MAX_CHARS} limit. Narrow the request (top, fields, path or line range).` },
    null,
    2,
  );
}

function findLongest(value: unknown, path: ListPath = []): { path: ListPath; items: unknown[] } | undefined {
  if (!value || typeof value !== 'object' || path.length > MAX_LIST_DEPTH) return undefined;
  let best = Array.isArray(value) && value.length > 1 ? { path, items: value as unknown[] } : undefined;
  const children: Array<[string | number, unknown]> = Array.isArray(value) ? value.map((item, index) => [index, item]) : Object.entries(value);
  for (const [key, entry] of children) {
    const found = findLongest(entry, [...path, key]);
    if (found && (!best || found.items.length > best.items.length)) best = found;
  }
  return best;
}

function replaceAt(root: unknown, path: ListPath, items: unknown[]): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return items;
  if (Array.isArray(root) && typeof head === 'number') return root.map((entry, index) => (index === head ? replaceAt(entry, rest, items) : entry));
  const object = root as Record<string, unknown>;
  return { ...object, [head]: replaceAt(object[head], rest, items) };
}

const NOTABLE_SOURCE = /:(remembered|asked)$|^serverUrl:remote-ignored$/;

function witportalntext(value: unknown, scope: ContextResolver['lastScope']): unknown {
  if (!scope || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const from = scope.sources.filter((source) => NOTABLE_SOURCE.test(source));
  if (from.length === 0) return value;
  const warning = from.includes('serverUrl:remote-ignored')
    ? "The git remote is on a server this connection does not use (its host may not be called, or X-ADO-Server-URL pins another server), so this came from the same-named collection and project on the connection's server. Check that is the one the user meant."
    : undefined;
  return { ...value, context: { collection: scope.collection, project: scope.project, repository: scope.repository, from, ...(warning ? { warning } : {}) } };
}

// Identifying arguments only; free text (titles, comments, content, WIQL) never reaches the audit log.
const AUDITED_VALUES = ['pullRequestId', 'id', 'buildId', 'releaseId', 'approvalId', 'environmentId', 'definitionId', 'action', 'vote', 'status'];

function auditedValues(args: Record<string, unknown>, redact: (text: string) => string): Record<string, unknown> | undefined {
  const picked: [string, unknown][] = [];
  for (const key of AUDITED_VALUES) {
    const value = args[key];
    if (typeof value === 'number') picked.push([key, value]);
    else if (typeof value === 'string') picked.push([key, truncate(redact(value), 40)]);
  }
  return picked.length > 0 ? Object.fromEntries(picked) : undefined;
}

export async function runTool(
  server: McpServer,
  tool: AnyTool,
  args: Record<string, unknown>,
  extra: ToolExtra,
  deps: AppDeps,
  memory: SessionMemory,
): Promise<CallToolResult> {
  const started = Date.now();
  let ctx: CallerContext | undefined;
  let redact = credentialRedactor(undefined, deps.config, extra.requestInfo?.headers);
  // An object rather than `let`s: TypeScript does not track assignments made inside the closure below.
  const state: { fingerprint?: string; resolver?: ContextResolver; outcome: string; confirmation?: 'preapproved' | 'elicited' } = { outcome: 'ok' };
  const fail = (kind: string, message: string): CallToolResult => {
    state.outcome = kind;
    return failure(kind, redact(message));
  };

  const execute = async (): Promise<CallToolResult> => {
    try {
      ctx = deps.contextFor(extra.requestInfo?.headers);
      redact = credentialRedactor(ctx, deps.config, extra.requestInfo?.headers);
      const fingerprint = (state.fingerprint = credentialFingerprint(ctx, deps.fingerprintKey));
      if (!tool.readOnly && ctx.readOnly) {
        return fail('read_only', `${tool.name} changes Azure DevOps data, but this session is read-only (ADO_MCP_READ_ONLY or X-ADO-Read-Only).`);
      }
      const bridge = createBridge(server, extra, deps.config, redact);
      const destructive = tool.destructive === true;
      if (destructive && !ctx.allowDestructive && !bridge.supportsElicitation) {
        return fail(
          'confirmation_required',
          `${tool.name} needs the user's confirmation and this client cannot ask for it. Do not retry. Tell the user they can allow destructive calls for this session with the X-ADO-Allow-Destructive: true header (ADO_ALLOW_DESTRUCTIVE=true in stdio mode).`,
        );
      }
      const gate = { open: !destructive || ctx.allowDestructive, writing: false };
      if (destructive && ctx.allowDestructive) state.confirmation = 'preapproved';
      // Past this point a write could still be running when the client gives up, and the agent would retry it.
      const writeDeadline = started + deps.timing.clientTimeoutMs - deps.timing.writeReserveMs;
      const tooSlow = (): AdoError =>
        new AdoError(
          'network',
          `Azure DevOps took ${Math.round((Date.now() - started) / 1000)} s to load what ${tool.name} would change, leaving too little time to finish before the client gives up on the call. Nothing was changed; call the tool again.`,
        );
      const confirm = async (action: string): Promise<void> => {
        if (gate.open) return;
        // Measured inside exclusive(), because waiting for another question also uses up the call's time.
        const answer = await memory.exclusive(async () => {
          const promptMs = writeDeadline - Date.now();
          if (promptMs < deps.timing.minPromptMs) return 'late' as const;
          const accepted = await bridge
            .confirm(`${action}\n\nGo ahead? This runs in Azure DevOps as ${memory.user ?? 'you'}.`, promptMs)
            .catch(() => false);
          return accepted ? ('yes' as const) : ('no' as const);
        });
        if (answer === 'late') throw tooSlow();
        if (extra.signal.aborted) throw new AdoError('declined', 'The client cancelled the call while the user was deciding; nothing was changed.');
        if (answer === 'no') throw new AdoError('declined', `The user did not confirm: ${action} Nothing was changed.`);
        gate.open = true;
        state.confirmation = 'elicited';
      };
      const client = new AdoClient(ctx, deps.negotiator, {
        timeoutMs: deps.config.requestTimeoutMs,
        fetchFn: deps.fetchFn,
        maxResponseBytes: deps.config.maxResponseBytes,
        signal: extra.signal,
        redact,
        beforeWrite: destructive
          ? (what) => {
              if (!gate.open) throw new AdoError('server', `${tool.name} tried ${what} before the user confirmed. This is a bug in the tool; nothing was changed.`);
              if (gate.writing) return;
              if (Date.now() > writeDeadline) throw tooSlow();
              gate.writing = true;
            }
          : undefined,
      });
      const resolver = (state.resolver = new ContextResolver(client, bridge, deps.catalogCache, fingerprint, memory, { write: !tool.readOnly }));
      const value = await tool.handler(args, { ctx, client, resolver, config: deps.config, confirm });
      return success(redactStrings(witportalntext(value, resolver.lastScope), redact));
    } catch (error) {
      if (error instanceof DisambiguationRequired) {
        state.outcome = 'disambiguation';
        return success(redactStrings(error.payload, redact));
      }
      if (error instanceof AdoError) return fail(error.kind, error.message);
      if (error instanceof CallerContextError) {
        return fail(error.httpStatus === 401 ? 'credential' : error.httpStatus === 403 ? 'permission' : 'bad_request', error.message);
      }
      return fail('server', error instanceof Error ? error.message : String(error));
    }
  };

  const result = await execute();
  deps.audit(redactStrings({
    event: 'tool_call',
    tool: tool.name,
    user: memory.user ?? (state.fingerprint ? `fp:${state.fingerprint.slice(0, 12)}` : undefined),
    collection: state.resolver?.lastScope?.collection,
    project: state.resolver?.lastScope?.project,
    outcome: state.outcome,
    ms: Date.now() - started,
    args: Object.keys(args).sort(),
    values: auditedValues(args, redact),
    confirmation: state.outcome === 'ok' ? state.confirmation : undefined,
  }, redact));
  return result;
}

export function rootName(uri: string): string | undefined {
  try {
    const path = decodeURIComponent(new URL(uri).pathname).replace(/[\\/]+$/, '');
    return path.split(/[\\/]/).pop() || undefined;
  } catch {
    return undefined;
  }
}

// Tool modules import quoted() from the registry; it lives in src/util so the context resolver can use it too.
export { quoted } from '../util/quoted.js';

const CHOICE_TIMEOUT_MS = 120_000;

// `elicitation: {}` comes from clients that predate the form/url split and means form mode.
function supportsFormElicitation(elicitation: unknown): boolean {
  if (!elicitation || typeof elicitation !== 'object') return false;
  const modes = elicitation as { form?: unknown; url?: unknown };
  return modes.form !== undefined || modes.url === undefined;
}

export function createBridge(server: McpServer, extra: ToolExtra, config: ServerConfig, redact: (text: string) => string = (text) => text): ClientBridge {
  const capabilities = server.server.getClientCapabilities();
  // Stateless HTTP cannot carry server-to-client requests, so elicitation and roots are off there.
  const interactive = !config.stateless;
  const elicit = async (message: string, field: string, property: Record<string, unknown>, timeout = CHOICE_TIMEOUT_MS): Promise<unknown> => {
    const result = await extra.sendRequest(
      {
        method: 'elicitation/create',
        params: {
          message: redact(message),
          requestedSchema: {
            type: 'object',
            properties: { [field]: property } as never,
            required: [field],
          },
        },
      },
      ElicitResultSchema,
      { timeout, signal: extra.signal },
    );
    return result.action === 'accept' ? result.content?.[field] : undefined;
  };
  return {
    supportsElicitation: interactive && supportsFormElicitation(capabilities?.elicitation),
    supportsRoots: interactive && Boolean(capabilities?.roots),
    async elicitChoice(message, field, options) {
      const safe = options.map(redact);
      // Unique display labels keep a redacted choice reversible even when several names become ***.
      const labels = safe.some((value, index) => value !== options[index]) ? safe.map((value, index) => `${index + 1}. ${value}`) : options;
      const value = await elicit(message, field, { type: 'string', title: field, enum: labels });
      return typeof value === 'string' ? options[labels.indexOf(value)] : undefined;
    },
    async elicitText(message, field) {
      const value = await elicit(message, field, { type: 'string', title: field, minLength: 1 });
      return typeof value === 'string' ? value : undefined;
    },
    async confirm(message, timeoutMs) {
      return (await elicit(message, 'confirm', { type: 'boolean', title: 'Confirm', description: 'Tick to go ahead; leave unticked to cancel.' }, timeoutMs)) === true;
    },
    async listRootNames() {
      try {
        const result = await extra.sendRequest({ method: 'roots/list' }, ListRootsResultSchema, { timeout: 10_000 });
        return result.roots.map((root) => rootName(root.uri)).filter((name): name is string => Boolean(name));
      } catch {
        return [];
      }
    },
  };
}
