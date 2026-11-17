import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../../src/config/env.js';
import type { CallerContext } from '../../src/context/caller-context.js';
import { createDeps } from '../../src/deps.js';
import { createMcpServer } from '../../src/server.js';
import { MockAdoServer, type Flavor, type MockCollection } from '../fixtures/mock-ado-server.js';

export interface HarnessOptions {
  flavor?: Flavor;
  env?: Record<string, string>;
  // For the boolean confirm form of destructive tools, field is 'confirm' and the answer 'true' accepts.
  elicit?: (field: string, values: string[], message: string) => string | undefined;
  roots?: string[];
  optionsBlocked?: boolean;
  collections?: MockCollection[];
  // Shapes tools/list the way X-ADO-Toolsets / X-ADO-Read-Only do over HTTP.
  caller?: Partial<Pick<CallerContext, 'toolsets' | 'readOnly'>>;
}

export interface ToolCall {
  isError: boolean;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

export interface Harness {
  mock: MockAdoServer;
  client: Client;
  elicitations: Array<{ message: string; field: string; values: string[] }>;
  call(name: string, args?: Record<string, unknown>): Promise<ToolCall>;
  close(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const mock = new MockAdoServer({ flavor: options.flavor ?? '2020', optionsBlocked: options.optionsBlocked, collections: options.collections });
  await mock.start();
  const config = loadConfig({
    ADO_MCP_TRANSPORT: 'stdio',
    ADO_DEFAULT_SERVER_URL: mock.serverUrl,
    ADO_ALLOW_INSECURE_HTTP: 'true',
    ADO_PAT: 'pat-demo',
    ADO_COLLECTIONS: 'DemoCollection',
    // Domain tests pre-approve destructive calls; a test that checks a confirmation message sets ADO_ALLOW_DESTRUCTIVE=false and passes elicit.
    ADO_ALLOW_DESTRUCTIVE: 'true',
    ADO_MCP_AUDIT_LOG: 'false',
    ...options.env,
  });
  const deps = createDeps(config);
  const server = createMcpServer(deps, options.caller ? { ctx: { ...deps.contextFor(), ...options.caller } } : {});
  const client = new Client(
    { name: 'harness', version: '1.0.0' },
    {
      capabilities: {
        ...(options.elicit ? { elicitation: { form: {} } } : {}),
        ...(options.roots ? { roots: { listChanged: false } } : {}),
      },
    },
  );

  const elicitations: Harness['elicitations'] = [];
  const elicit = options.elicit;
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const params = request.params as { message: string; requestedSchema: { properties: Record<string, { type?: string; enum?: string[] }> } };
      const [field, schema] = Object.entries(params.requestedSchema.properties)[0] ?? ['value', {}];
      const values = schema.enum ?? [];
      elicitations.push({ message: params.message, field, values });
      const choice = elicit(field, values, params.message);
      if (choice === undefined) return { action: 'decline' as const };
      return { action: 'accept' as const, content: { [field]: schema.type === 'boolean' ? choice === 'true' : choice } };
    });
  }
  const roots = options.roots;
  if (roots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: roots.map((name) => ({ uri: `file:///E:/work/${encodeURIComponent(name)}`, name })),
    }));
  }

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);

  return {
    mock,
    client,
    elicitations,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? '').join('\n');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { isError: result.isError === true, text, json };
    },
    async close() {
      await client.close();
      await server.close();
      await mock.stop();
    },
  };
}