import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { AdoError } from '../../src/ado/errors.js';
import {
  assertSingleHeaders,
  buildCallerContext,
  buildStdioCallerContext,
  CallerContextError,
  credentialFingerprint,
  parseCollectionPats,
  redactSecrets,
  remoteServerUrl,
  resolvePat,
  sshHostMatches,
} from '../../src/context/caller-context.js';

const config = loadConfig({
  ADO_DEFAULT_SERVER_URL: 'https://devops.example.com/tfs',
  ADO_ALLOWED_HOSTS: 'devops.example.com,ado25.example.com',
});
const bearer = (pat: string) => ({ authorization: `Bearer ${pat}` });

function contextError(fn: () => unknown): CallerContextError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CallerContextError) return error;
    throw error;
  }
  throw new Error('expected CallerContextError');
}

describe('parseCollectionPats', () => {
  it.each([
    ['DemoCollection=patA, LegacyCollection=patB'],
    ['{"DemoCollection":"patA","LegacyCollection":"patB"}'],
    [Buffer.from('{"DemoCollection":"patA","LegacyCollection":"patB"}').toString('base64')],
  ])('parses %s', (raw) => {
    const pats = parseCollectionPats(raw);
    expect(pats.get('democollection')).toEqual({ name: 'DemoCollection', pat: 'patA' });
    expect(pats.get('legacycollection')).toEqual({ name: 'LegacyCollection', pat: 'patB' });
  });

  it('rejects malformed entries', () => {
    expect(() => parseCollectionPats('DemoCollection')).toThrow(CallerContextError);
    expect(() => parseCollectionPats('{"DemoCollection":""}')).toThrow(CallerContextError);
  });
});

describe('buildCallerContext', () => {
  it('merges collections from every header and keeps order', () => {
    const ctx = buildCallerContext(
      {
        ...bearer('global-pat-123'),
        'x-ado-collection': 'DemoCollection',
        'x-ado-collections': 'democollection, LegacyCollection',
        'x-ado-collection-pats': 'Archive=archive-pat-1',
        'x-ado-default-project': 'DemoProject',
      },
      config,
    );
    expect(ctx.serverUrl).toBe('https://devops.example.com/tfs');
    expect(ctx.serverUrlPinned).toBe(false);
    expect(ctx.collections).toEqual(['DemoCollection', 'LegacyCollection', 'Archive']);
    expect(ctx.defaultProject).toBe('DemoProject');
    expect(resolvePat(ctx, 'archive')).toBe('archive-pat-1');
    expect(resolvePat(ctx, 'LegacyCollection')).toBe('global-pat-123');
  });

  it('accepts the PAT as Bearer or Basic only', () => {
    expect(buildCallerContext(bearer('pat-bearer'), config).globalPat).toBe('pat-bearer');
    const basic = `Basic ${Buffer.from(':pat-basic').toString('base64')}`;
    expect(buildCallerContext({ authorization: basic }, config).globalPat).toBe('pat-basic');
    const missing = contextError(() => buildCallerContext({}, config));
    expect(missing.httpStatus).toBe(401);
    expect(missing.message).toMatch(/Authorization: Bearer/);
    expect(contextError(() => buildCallerContext({ authorization: 'Negotiate abc' }, config)).httpStatus).toBe(401);
  });

  it('reads the repository, toolset and destructive-call headers', () => {
    const remote = 'https://devops.example.com/tfs/DemoCollection/DemoProject/_git/ado-server-mcp';
    const ctx = buildCallerContext(
      {
        ...bearer('p'),
        'x-ado-git-remote': remote,
        'x-ado-default-repository': 'ado-server-mcp',
        'x-ado-toolsets': 'pullrequests, builds',
        'x-ado-allow-destructive': 'true',
      },
      config,
    );
    expect(ctx).toMatchObject({ gitRemote: remote, defaultRepository: 'ado-server-mcp', allowDestructive: true });
    expect([...(ctx.toolsets ?? [])]).toEqual(['pullrequests', 'builds']);
    expect(buildCallerContext(bearer('p'), config)).toMatchObject({ toolsets: undefined, allowDestructive: false });
    expect(contextError(() => buildCallerContext({ ...bearer('p'), 'x-ado-toolsets': 'wiki,bogus' }, config)).message).toMatch(/Unknown toolset in X-ADO-Toolsets/);
  });

  it('accepts an allowlisted server override', () => {
    const ctx = buildCallerContext({ ...bearer('p'), 'x-ado-server-url': 'https://ado25.example.com/tfs/' }, config);
    expect(ctx).toMatchObject({ serverUrl: 'https://ado25.example.com/tfs', serverUrlPinned: true });
  });

  it.each([
    ['https://evil.example.com/tfs', 403],
    ['http://devops.example.com/tfs', 403],
    ['https://user:pw@devops.example.com/tfs', 403],
  ])('rejects server override %s', (url, status) => {
    expect(contextError(() => buildCallerContext({ ...bearer('p'), 'x-ado-server-url': url }, config)).httpStatus).toBe(status);
  });

  it('requires a PAT', () => {
    expect(contextError(() => buildCallerContext({ 'x-ado-collections': 'DemoCollection' }, config)).httpStatus).toBe(401);
  });

  it('rejects repeated single-value headers, including ones Node already joined', () => {
    expect(() => buildCallerContext({ ...bearer('p'), 'x-ado-server-url': ['https://a.example', 'https://b.example'] }, config)).toThrow(/only once/);
    expect(() => buildCallerContext({ ...bearer('p'), 'x-ado-default-project': 'DemoProject, DemoService' }, config)).toThrow(/only once/);
  });

  it('honours the per-caller read-only header', () => {
    expect(buildCallerContext({ ...bearer('p'), 'x-ado-read-only': 'true' }, config).readOnly).toBe(true);
    expect(buildCallerContext(bearer('p'), config).readOnly).toBe(false);
  });

  it('rejects non-boolean read-only and allow-destructive headers', () => {
    const on = contextError(() => buildCallerContext({ ...bearer('p'), 'x-ado-read-only': 'on' }, config));
    expect(on.httpStatus).toBe(400);
    expect(on.message).toMatch(/X-ADO-Read-Only must be true or false/);
    expect(buildCallerContext({ ...bearer('p'), 'x-ado-read-only': 'false' }, config).readOnly).toBe(false);
    const maybe = contextError(() => buildCallerContext({ ...bearer('p'), 'x-ado-allow-destructive': 'maybe' }, config));
    expect(maybe.httpStatus).toBe(400);
    expect(maybe.message).toMatch(/X-ADO-Allow-Destructive must be true or false/);
    expect(buildCallerContext({ ...bearer('p'), 'x-ado-allow-destructive': 'yes' }, config).allowDestructive).toBe(true);
  });

  it('fails with a credential error when no PAT covers a collection', () => {
    const ctx = buildCallerContext({ 'x-ado-collection-pats': 'DemoCollection=only-demo-pat' }, config);
    expect(() => resolvePat(ctx, 'LegacyCollection')).toThrow(AdoError);
  });
});

describe('assertSingleHeaders', () => {
  it('rejects duplicate Authorization and X-ADO-* names in rawHeaders', () => {
    const dupAuth = contextError(() =>
      assertSingleHeaders(['Authorization', 'Bearer a', 'authorization', 'Bearer b']),
    );
    expect(dupAuth.httpStatus).toBe(400);
    expect(dupAuth.message).toMatch(/authorization header only once/);
    expect(dupAuth.message).not.toContain('Bearer');
    const dupCollections = contextError(() =>
      assertSingleHeaders(['Authorization', 'Bearer a', 'X-ADO-Collections', 'A', 'x-ado-collections', 'B']),
    );
    expect(dupCollections.httpStatus).toBe(400);
    expect(dupCollections.message).toMatch(/X-ADO-\* header only once/);
  });

  it('allows duplicate non-ADO headers', () => {
    expect(() => assertSingleHeaders(['Authorization', 'Bearer a', 'Accept', 'x', 'accept', 'y'])).not.toThrow();
  });
});

describe('remoteServerUrl', () => {
  const aliased = loadConfig({ ADO_DEFAULT_SERVER_URL: 'https://devops.example.com/tfs', ADO_HOST_ALIASES: 'legacy-devops:8080=devops.example.com' });
  it('maps aliased internal hosts and drops hosts that are not allowed', () => {
    expect(remoteServerUrl('http://legacy-devops:8080/tfs', aliased)).toBe('https://devops.example.com/tfs');
    expect(remoteServerUrl('https://devops.example.com/tfs/', aliased)).toBe('https://devops.example.com/tfs');
    expect(remoteServerUrl('http://otherhost:8080/tfs', aliased)).toBeUndefined();
    expect(remoteServerUrl('not a url', aliased)).toBeUndefined();
    expect(sshHostMatches('devops.example.com', 'https://devops.example.com/tfs', aliased)).toBe(true);
    expect(sshHostMatches('LEGACY-DEVOPS', 'https://devops.example.com/tfs', aliased)).toBe(true);
    expect(sshHostMatches('othertfs', 'https://devops.example.com/tfs', aliased)).toBe(false);
  });
});

describe('fingerprints and redaction', () => {
  const key = randomBytes(32);
  it('changes when credentials change', () => {
    const a = buildCallerContext(bearer('pat-aaaaaaaa'), config);
    const b = buildCallerContext(bearer('pat-bbbbbbbb'), config);
    expect(credentialFingerprint(a, key)).toBe(credentialFingerprint(buildCallerContext(bearer('pat-aaaaaaaa'), config), key));
    expect(credentialFingerprint(a, key)).not.toBe(credentialFingerprint(b, key));
    expect(credentialFingerprint(a, key)).not.toContain('pat-aaaaaaaa');
  });

  it('removes PATs and auth headers from text', () => {
    const ctx = buildCallerContext({ ...bearer('super-secret-pat'), 'x-ado-collection-pats': 'DemoCollection=other-secret-pat' }, config);
    expect(redactSecrets('a super-secret-pat b other-secret-pat c Basic OnN1cGVyLXNlY3JldA==', ctx)).toBe('a *** b *** c Basic ***');
  });
});

describe('buildStdioCallerContext', () => {
  it('builds the caller from stdio environment variables', () => {
    const stdio = loadConfig({
      ADO_MCP_TRANSPORT: 'stdio',
      ADO_DEFAULT_SERVER_URL: 'https://devops.example.com/tfs',
      ADO_PAT: 'stdio-pat',
      ADO_COLLECTIONS: 'DemoCollection',
      ADO_COLLECTION_PATS: 'LegacyCollection=p2017',
      ADO_DEFAULT_PROJECT: 'DemoProject',
    });
    const ctx = buildStdioCallerContext(stdio);
    expect(ctx.collections).toEqual(['DemoCollection', 'LegacyCollection']);
    expect(resolvePat(ctx, 'LegacyCollection')).toBe('p2017');
    expect(ctx.defaultProject).toBe('DemoProject');
  });
});
