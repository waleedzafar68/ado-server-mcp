import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { FailureLimiter, gatewayGuard, originGuard, sessionFingerprint, startupWarnings } from '../../src/http/security.js';

async function serve(app: express.Express, fn: (url: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

function appWith(...guards: express.RequestHandler[]): express.Express {
  const app = express();
  app.post('/mcp', ...guards, (_req, res) => { res.json({ ok: true }); });
  return app;
}

describe('originGuard', () => {
  it('allows requests without Origin and listed origins, rejects others', async () => {
    await serve(appWith(originGuard(['https://chat.example.com'])), async (url) => {
      expect((await fetch(`${url}/mcp`, { method: 'POST' })).status).toBe(200);
      expect((await fetch(`${url}/mcp`, { method: 'POST', headers: { Origin: 'https://chat.example.com' } })).status).toBe(200);
      const denied = await fetch(`${url}/mcp`, { method: 'POST', headers: { Origin: 'https://evil.example.com' } });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
    });
  });
});

describe('gatewayGuard', () => {
  const token = 't'.repeat(40);
  it('is a no-op without a configured token', async () => {
    await serve(appWith(gatewayGuard(undefined)), async (url) => {
      expect((await fetch(`${url}/mcp`, { method: 'POST' })).status).toBe(200);
    });
  });
  it('requires the exact token in X-ADO-MCP-Token and reports failures', async () => {
    let failures = 0;
    await serve(appWith(gatewayGuard(token, () => failures++)), async (url) => {
      const missing = await fetch(`${url}/mcp`, { method: 'POST' });
      expect(missing.status).toBe(401);
      expect(missing.headers.get('www-authenticate')).toBeNull();
      expect((await fetch(`${url}/mcp`, { method: 'POST', headers: { 'X-ADO-MCP-Token': 'wrong' } })).status).toBe(401);
      expect((await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
      expect((await fetch(`${url}/mcp`, { method: 'POST', headers: { 'X-ADO-MCP-Token': token } })).status).toBe(200);
    });
    expect(failures).toBe(3);
  });
});

describe('sessionFingerprint', () => {
  it('depends on credential headers only', () => {
    const key = randomBytes(32);
    const a = sessionFingerprint({ authorization: 'Bearer one', 'user-agent': 'a' }, key);
    expect(sessionFingerprint({ authorization: 'Bearer one', 'user-agent': 'b' }, key)).toBe(a);
    expect(sessionFingerprint({ authorization: 'Bearer two' }, key)).not.toBe(a);
    expect(sessionFingerprint({ authorization: 'Bearer one', 'x-ado-mcp-token': 'g' }, key)).not.toBe(a);
    expect(a).not.toContain('one');
  });
});

describe('FailureLimiter', () => {
  it('blocks a key after the limit and forgets old failures', () => {
    const limiter = new FailureLimiter(2, 1000);
    limiter.record('ip', 0);
    expect(limiter.blocked('ip', 10)).toBe(false);
    limiter.record('ip', 20);
    expect(limiter.blocked('ip', 30)).toBe(true);
    expect(limiter.blocked('other', 30)).toBe(false);
    expect(limiter.blocked('ip', 1500)).toBe(false);
  });
});

describe('startupWarnings', () => {
  it('warns when a non-loopback server has no gateway token or proxy setting', () => {
    const base = { ADO_DEFAULT_SERVER_URL: 'https://devops.example.com/tfs' };
    expect(startupWarnings(loadConfig(base))).toEqual([]);
    const exposed = startupWarnings(loadConfig({ ...base, ADO_MCP_HOST: '0.0.0.0' })).join('\n');
    expect(exposed).toMatch(/ADO_MCP_HTTP_TOKEN is not set/);
    expect(exposed).toMatch(/ADO_MCP_TRUST_PROXY is not set/);
    expect(startupWarnings(loadConfig({ ...base, ADO_MCP_HOST: '0.0.0.0', ADO_MCP_HTTP_TOKEN: 'x'.repeat(32), ADO_MCP_TRUST_PROXY: 'false' }))).toEqual([]);
  });
});
