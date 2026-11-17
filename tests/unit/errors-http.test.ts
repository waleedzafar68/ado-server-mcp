import { describe, expect, it } from 'vitest';
import { AdoError, extractAdoMessage } from '../../src/ado/errors.js';
import { basicAuth, httpError, isAuthFailure, mapFetchError, readLimited, redirectError, safeSegment } from '../../src/ado/http.js';

describe('extractAdoMessage', () => {
  it('reads the message from an Azure DevOps error envelope', () => {
    expect(extractAdoMessage('{"$id":"1","message":"TF401027: You need the Git \'CreateRepository\' permission.","typeKey":"GitNeedsPermissionException"}'))
      .toBe("TF401027: You need the Git 'CreateRepository' permission.");
  });
  it('falls back to bounded raw text', () => {
    expect(extractAdoMessage('x'.repeat(600))).toHaveLength(500);
    expect(extractAdoMessage('   ')).toBe('The response body was empty.');
  });
});

describe('http helpers', () => {
  it('builds Basic auth with an empty user name', () => {
    expect(basicAuth('abc')).toBe(`Basic ${Buffer.from(':abc').toString('base64')}`);
  });

  it.each([
    [401, 'application/json', '', true],
    [203, 'text/html', '', true],
    [302, '', '/tfs/_signin?realm=devops.example.com', true],
    [307, '', 'https://lb2.example.com/tfs/DemoCollection/_apis/projects', false],
    [200, 'text/html; charset=utf-8', '', true],
    [200, 'application/json', '', false],
    [403, 'application/json', '', false],
    [200, 'text/plain', '', false],
  ])('isAuthFailure(%i, %s, %s) is %s', (status, contentType, location, expected) => {
    expect(isAuthFailure(status, contentType, location)).toBe(expected);
  });

  it('reports other redirects without following them', () => {
    const error = redirectError(307, 'https://lb2.example.com/tfs/DemoCollection/_apis/projects', 'GET _apis/projects');
    expect(error.kind).toBe('server');
    expect(error.message).toMatch(/lb2\.example\.com/);
    expect(redirectError(302, '/tfs/elsewhere', 'GET x').message).toMatch(/same server/);
  });

  it('reads bodies up to the byte limit', async () => {
    expect(await readLimited(new Response('hello'), 10, 'GET x')).toBe('hello');
  });

  it('stops reading an endless body once the limit is passed', async () => {
    const endless = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024)); } });
    const error = await readLimited(new Response(endless), 4096, 'GET _apis/build/builds/900/logs/7').catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'too_large' });
    expect((error as Error).message).toMatch(/ADO_MAX_RESPONSE_BYTES/);
  });

  it('rejects a declared length over the limit without reading', async () => {
    const response = new Response(
      new ReadableStream({
        pull() {
          throw new Error('body was read');
        },
      }),
      { headers: { 'content-length': '100' } },
    );
    await expect(readLimited(response, 10, 'GET x')).rejects.toMatchObject({ kind: 'too_large' });
  });

  it('encodes path segments and rejects dot segments', () => {
    expect(safeSegment('LEGACY PRODUCT')).toBe('LEGACY%20PRODUCT');
    expect(safeSegment(42)).toBe('42');
    for (const bad of ['', '.', '..']) expect(() => safeSegment(bad)).toThrow(AdoError);
  });

  it('maps TLS failures to an actionable tls error', () => {
    const error = mapFetchError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } }), 'https://devops.example.com/tfs/DemoCollection');
    expect(error).toBeInstanceOf(AdoError);
    expect(error.kind).toBe('tls');
    expect(error.message).toMatch(/NODE_EXTRA_CA_CERTS/);
  });

  it('maps timeouts and connection errors to network errors', () => {
    const timeout = mapFetchError(Object.assign(new Error('aborted'), { name: 'TimeoutError' }), 'https://devops.example.com/tfs');
    expect(timeout.kind).toBe('network');
    expect(timeout.message).toMatch(/did not answer in time/);
    const refused = mapFetchError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'https://devops.example.com/tfs');
    expect(refused.message).toMatch(/ECONNREFUSED/);
  });

  it.each([
    [401, 'auth'],
    [403, 'permission'],
    [404, 'not_found'],
    [409, 'conflict'],
    [412, 'conflict'],
    [400, 'bad_request'],
    [500, 'server'],
  ])('maps HTTP %i to %s', (status, kind) => {
    expect(httpError(status, 'msg', 'GET _apis/x').kind).toBe(kind);
  });
});