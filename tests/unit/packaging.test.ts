import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig, TOOLSETS } from '../../src/config/env.js';

const root = new URL('../../', import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, root), 'utf8');
const lines = (file: string): string[] => read(file).split(/\r?\n/).map((line) => line.trim());

function parseDotEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]!] = match[2]!;
  }
  return env;
}

describe('packaging', () => {
  it('ships an .env.example that loads in HTTP mode and holds no PAT', () => {
    const env = parseDotEnv(read('.env.example'));
    expect(env.ADO_PAT).toBeUndefined();
    expect(env.ADO_COLLECTION_PATS).toBeUndefined();
    expect(env.ADO_ALLOW_DESTRUCTIVE).toBeUndefined();
    expect(loadConfig(env)).toMatchObject({
      transport: 'http',
      host: '0.0.0.0',
      port: 8080,
      path: '/mcp',
      allowedHosts: ['devops.example.com'],
      readOnly: false,
      stateless: false,
      maxSessions: 200,
      maxSessionsPerUser: 10,
      auditLog: true,
    });
  });

  it('builds a non-root image with a health check and no TLS bypass', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/^FROM node:22-bookworm-slim AS build\r?$/m);
    expect(dockerfile).toMatch(/^USER node\r?$/m);
    expect(dockerfile).toMatch(/^HEALTHCHECK /m);
    expect(dockerfile).toMatch(/ADO_MCP_HOST=0\.0\.0\.0/);
    expect(dockerfile).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
    const compose = read('docker-compose.yml');
    expect(compose).toMatch(/NODE_EXTRA_CA_CERTS/);
    expect(compose).toMatch(/- "127\.0\.0\.1:8080:8080"/);
  });

  it('keeps secrets, certificates and build output out of the image and the repo', () => {
    expect(lines('.dockerignore')).toEqual(expect.arrayContaining(['.env', 'node_modules', 'dist', '.git', 'certs', 'tests']));
    expect(lines('.gitignore')).toEqual(expect.arrayContaining(['.env', 'certs/']));
  });

  it('documents every caller header, toolset and supported client', () => {
    const readme = read('README.md');
    for (const header of [
      'Authorization: Bearer', 'X-ADO-MCP-Token', 'X-ADO-Collection', 'X-ADO-Collections', 'X-ADO-Collection-PATs', 'X-ADO-Default-Project',
      'X-ADO-Default-Repository', 'X-ADO-Git-Remote', 'X-ADO-Server-URL', 'X-ADO-Read-Only', 'X-ADO-Toolsets', 'X-ADO-Allow-Destructive',
    ]) {
      expect(readme, `README is missing ${header}`).toContain(header);
    }
    for (const toolset of ['context', ...TOOLSETS]) expect(readme).toContain(`\`${toolset}\``);
    for (const client of ['.cursor/mcp.json', 'claude mcp add', '.codex/config.toml', '.vscode/mcp.json']) expect(readme).toContain(client);
  });

  it('sends the PAT only in Authorization and explains destructive calls without prompts', () => {
    const readme = read('README.md');
    expect(readme).not.toContain('X-ADO-PAT');
    expect(readme).toMatch(/X-ADO-Allow-Destructive[^\n]*client's own approval/);
  });

  it('documents every environment variable the server reads', () => {
    const readme = read('README.md');
    const names = new Set([...read('src/config/env.ts').matchAll(/env\.(ADO_[A-Z_]+)/g)].map((match) => match[1]!));
    expect(names.size).toBeGreaterThanOrEqual(28);
    for (const name of names) expect(readme, `README is missing ${name}`).toContain(name);
  });
});
