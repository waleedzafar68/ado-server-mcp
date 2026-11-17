import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallerContext } from './context/caller-context.js';
import { SessionMemory } from './context/session-memory.js';
import type { AppDeps } from './deps.js';
import { buildInstructions } from './prompts/instructions.js';
import { registerPrompts } from './prompts/workflows.js';
import { ALL_TOOLS } from './tools/index.js';
import { registerTools, selectTools } from './tools/registry.js';

export const SERVER_NAME = 'ado-server-mcp';
export const SERVER_VERSION = '0.1.0';

export interface SessionOptions {
  // The caller's context at initialize; X-ADO-Toolsets and X-ADO-Read-Only then shape tools/list.
  ctx?: CallerContext;
  memory?: SessionMemory;
}

export function createMcpServer(deps: AppDeps, options: SessionOptions = {}): McpServer {
  const memory = options.memory ?? new SessionMemory();
  const tools = selectTools(ALL_TOOLS, deps.config, options.ctx);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: buildInstructions(deps.config, tools.length) },
  );
  registerTools(server, tools, deps, memory);
  registerPrompts(server, deps);
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    memory.invalidateRoots();
  });
  return server;
}
