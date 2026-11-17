import { readdirSync, readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { createDeps } from '../../src/deps.js';
import { createMcpServer } from '../../src/server.js';
import { contractEnv, replay, type ContractFixture } from './contract-format.js';

const dir = new URL('./', import.meta.url);
const fixtures = readdirSync(dir)
  .filter((file) => file.endsWith('.json'))
  .map((file) => JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as ContractFixture);

const API_VERSION = { 'server-2020': '6.0', 'server-25h2': '7.2' } as const;
const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length);

describe('recorded Azure DevOps Server contracts', () => {
  if (fixtures.length === 0) it.skip('no recordings yet: run npm run record:contracts against your own approved server and review the fixture', () => undefined);

  for (const fixture of fixtures) {
    it(`${fixture.flavor} (recorded ${fixture.recordedAt.slice(0, 10)}): every call replays and the invariants hold`, async () => {
      const recorded = replay(fixture);
      const deps = createDeps(loadConfig(contractEnv(fixture.serverUrl, fixture.collections, 'replay-pat')), recorded.fetch);
      const server = createMcpServer(deps, { ctx: deps.contextFor() });
      const client = new Client({ name: 'contracts', version: '1.0.0' });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      await client.connect(clientSide);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const results = new Map<string, any>();
        for (const call of fixture.calls) {
          const result = await client.callTool({ name: call.tool, arguments: call.args });
          const text = (result.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? '').join('\n');
          expect(result.isError, `${call.label} (${call.tool}): ${text}`).toBeFalsy();
          results.set(call.label, JSON.parse(text));
        }
        expect(recorded.misses, 'requests the recording never saw: re-record after changing request shapes').toEqual([]);

        expect(results.get('whoami').collections[0]).toMatchObject({
          collection: fixture.collections[0],
          status: 'authenticated',
          apiVersion: API_VERSION[fixture.flavor],
        });

        const tail = results.get('log-tail');
        expect(lineCount(tail.text)).toBe(tail.endLine - tail.startLine + 1);
        expect(tail).toMatchObject({ endLine: tail.totalLines, truncated: false });
        expect(tail.endLine - tail.startLine + 1).toBe(Math.min(20, tail.totalLines));

        const head = results.get('log-head');
        expect(head).toMatchObject({ startLine: 1, endLine: Math.min(3, head.totalLines) });
        expect(head.text).toBe((fixture.facts.logHead ?? []).join('\n'));

        const items = results.get('tfvc-items');
        if (items) expect(items.items.every((item: { path: string }) => item.path.startsWith('$/'))).toBe(true);

        const file = results.get('tfvc-file');
        if (file) expect(file.binary === true || (typeof file.text === 'string' && file.text.length > 0), `tfvc-file ${file.path}: neither text nor binary`).toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }
});
