#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig } from './config/env.js';
import { createDeps } from './deps.js';
import { createHttpApp } from './http/app.js';
import { startupWarnings } from './http/security.js';
import { createMcpServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const deps = createDeps(config);

  if (config.transport === 'stdio') {
    const server = createMcpServer(deps, { ctx: deps.contextFor() });
    await server.connect(new StdioServerTransport());
    console.error('ado-server-mcp: stdio transport ready');
    return;
  }

  for (const warning of startupWarnings(config)) console.error(`ado-server-mcp: WARNING: ${warning}`);
  const http = createHttpApp(deps);
  const listener = http.app.listen(config.port, config.host, (error?: Error) => {
    if (error) {
      console.error(`ado-server-mcp: cannot listen on ${config.host}:${config.port}: ${error.message}`);
      process.exit(1);
    }
    console.error(`ado-server-mcp: listening on http://${config.host}:${config.port}${config.path}`);
  });

  const shutdown = async (): Promise<void> => {
    // Stop accepting connections before cleaning sessions and connecting transports.
    const stopped = new Promise<void>((resolve) => listener.close(() => resolve()));
    setTimeout(() => process.exit(0), 5000).unref();
    await http.close();
    await stopped;
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`ado-server-mcp: invalid configuration\n- ${error.failures.join('\n- ')}`);
    process.exit(2);
  }
  console.error('ado-server-mcp: fatal error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
