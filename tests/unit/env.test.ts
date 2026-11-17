import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, TOOLSETS } from '../../src/config/env.js';

const base = { ADO_DEFAULT_SERVER_URL: 'https://devops.example.com/tfs/' };

function failuresOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.failures;
    throw error;
  }
  return [];
}

describe('loadConfig', () => {
  it('defaults to Streamable HTTP with every toolset and derives the allowed host', () => {
    const config = loadConfig(base);
    expect(config.transport).toBe('http');
    expect(config.defaultServerUrl).toBe('https://devops.example.com/tfs');
    expect(config.allowedHosts).toEqual(['devops.example.com']);
    expect([...config.toolsets]).toEqual([...TOOLSETS]);
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 8080,
      path: '/mcp',
      readOnly: false,
      stateless: false,
      requestTimeoutMs: 30_000,
      sessionIdleMs: 1_800_000,
      maxResponseBytes: 10_485_760,
      maxSessions: 200,
      maxSessionsPerUser: 10,
      authFailureLimit: 20,
      clientTimeoutMs: 60_000,
      auditLog: true,
    });
    expect(config.hostAliases.size).toBe(0);
    expect(config.trustProxy).toBeUndefined();
  });

  it('parses host aliases and service limits', () => {
    const config = loadConfig({
      ...base,
      ADO_HOST_ALIASES: 'legacy-devops:8080=devops.example.com, LEGACY-DEVOPS=devops.example.com',
      ADO_MAX_RESPONSE_BYTES: '1048576',
      ADO_MCP_MAX_SESSIONS: '50',
      ADO_MCP_MAX_SESSIONS_PER_USER: '3',
      ADO_MCP_AUTH_FAILURE_LIMIT: '5',
      ADO_MCP_TRUST_PROXY: 'loopback',
      ADO_MCP_AUDIT_LOG: 'false',
    });
    expect([...config.hostAliases]).toEqual([['legacy-devops:8080', 'devops.example.com'], ['legacy-devops', 'devops.example.com']]);
    expect(config).toMatchObject({ maxResponseBytes: 1_048_576, maxSessions: 50, maxSessionsPerUser: 3, authFailureLimit: 5, trustProxy: 'loopback', auditLog: false });
  });

  it('parses explicit settings', () => {
    const config = loadConfig({
      ...base,
      ADO_ALLOWED_HOSTS: 'devops.example.com, ado25.example.com',
      ADO_MCP_TOOLSETS: 'workitems,pullrequests',
      ADO_MCP_READ_ONLY: 'true',
      ADO_MCP_ALLOWED_ORIGINS: 'https://chat.example.com/',
      ADO_MCP_HTTP_TOKEN: 'a'.repeat(32),
      ADO_MCP_PORT: '9090',
      ADO_MCP_STATELESS: '1',
      ADO_FORCE_API_VERSION: '6.0',
      ADO_MCP_CLIENT_TIMEOUT_MS: '120000',
    });
    expect(config.allowedHosts).toEqual(['devops.example.com', 'ado25.example.com']);
    expect([...config.toolsets]).toEqual(['workitems', 'pullrequests']);
    expect(config.allowedOrigins).toEqual(['https://chat.example.com']);
    expect(config).toMatchObject({ readOnly: true, port: 9090, stateless: true, forceApiVersion: '6.0', clientTimeoutMs: 120_000 });
  });

  it('refuses a shared PAT over HTTP', () => {
    expect(failuresOf({ ...base, ADO_PAT: 'shared' }).join('\n')).toMatch(/must not be set when ADO_MCP_TRANSPORT=http/);
  });

  it('requires a server URL and a PAT over stdio', () => {
    const failures = failuresOf({ ADO_MCP_TRANSPORT: 'stdio' }).join('\n');
    expect(failures).toMatch(/ADO_DEFAULT_SERVER_URL is required/);
    expect(failures).toMatch(/ADO_PAT or ADO_COLLECTION_PATS is required/);
  });

  it('accepts stdio credentials', () => {
    const config = loadConfig({
      ...base,
      ADO_MCP_TRANSPORT: 'stdio',
      ADO_PAT: 'p',
      ADO_COLLECTIONS: 'DemoCollection, LegacyCollection',
      ADO_DEFAULT_PROJECT: 'DemoProject',
    });
    expect(config.stdio).toEqual({
      pat: 'p',
      collections: ['DemoCollection', 'LegacyCollection'],
      collectionPats: undefined,
      defaultProject: 'DemoProject',
      allowDestructive: false,
    });
  });

  it.each([
    [{ ADO_MCP_HTTP_TOKEN: 'short' }, /at least 32 characters/],
    [{ ADO_MCP_TOOLSETS: 'workitems,bogus' }, /Unknown toolset "bogus"/],
    [{ ADO_DEFAULT_SERVER_URL: 'http://tfs.local/tfs' }, /must use https/],
    [{ ADO_MCP_PATH: '/healthz' }, /must not be \/healthz/],
    [{ ADO_MCP_TRANSPORT: 'sse' }, /must be "http" or "stdio"/],
    [{ ADO_FORCE_API_VERSION: '7' }, /must look like 6\.0 or 7\.2/],
    [{ ADO_HOST_ALIASES: 'legacy-devops' }, /must look like legacy-devops:8080=devops\.example\.com/],
    [{ ADO_HOST_ALIASES: 'legacy-devops=evil.example.com' }, /must be listed in ADO_ALLOWED_HOSTS/],
    [{ ADO_MAX_RESPONSE_BYTES: '1000' }, />= 65536/],
    [{ ADO_ALLOW_DESTRUCTIVE: 'true' }, /stdio only/],
    [{ ADO_MCP_TRUST_PROXY: 'true' }, /hop count/],
    [{ ADO_MCP_TRUST_PROXY: '0.0.0.0/0' }, /hop count/],
    [{ ADO_MCP_TRUST_PROXY: '::/0' }, /hop count/],
    [{ ADO_MCP_TRUST_PROXY: '10.0.0.0/8, 0.0.0.0/0' }, /hop count/],
    [{ ADO_MCP_CLIENT_TIMEOUT_MS: '20000' }, /integer >= 30000/],
  ])('rejects invalid setting %o', (override, pattern) => {
    expect(failuresOf({ ...base, ...override }).join('\n')).toMatch(pattern);
  });

  it('allows plain http only when explicitly enabled', () => {
    const config = loadConfig({ ADO_DEFAULT_SERVER_URL: 'http://127.0.0.1:5000/tfs', ADO_ALLOW_INSECURE_HTTP: 'true' });
    expect(config.allowedHosts).toEqual(['127.0.0.1']);
  });
});