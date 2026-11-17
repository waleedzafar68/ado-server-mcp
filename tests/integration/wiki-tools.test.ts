import { afterEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness, type HarnessOptions } from '../helpers/harness.js';

describe('wiki tools', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function start(options: HarnessOptions = {}, wikiCount = 1): Promise<Harness> {
    h = await startHarness({ ...options, env: { ADO_DEFAULT_PROJECT: 'DemoProject', ...options.env } });
    const mock = h.mock;
    mock.on('GET', /\/DemoProject\/_apis\/wiki\/wikis$/, () => ({
      json: { value: Array.from({ length: wikiCount }, (_, i) => i === 0
        ? { id: 'w1', name: 'DemoProject.wiki', type: 'projectWiki', mappedPath: '/', versions: [{ version: 'wikiMaster' }] }
        : { id: `w${i + 1}`, name: `w${i + 1}` }) },
    }));
    mock.on('GET', /\/_apis\/wiki\/wikis\/(?:w1|DemoProject\.wiki)\/pages$/, (r) => {
      if (r.query.get('recursionLevel')) {
        return { json: { path: '/', isParentPage: true, subPages: [{ path: '/Runbooks', isParentPage: true, subPages: [{ path: '/Runbooks/MCP', isParentPage: false }] }] } };
      }
      const path = r.query.get('path');
      if (path === '/Missing') return { status: 404, json: { message: 'Wiki page not found.' } };
      return { json: { id: 4, path: path === '/Runbooks/Alias' ? '/Runbooks/MCP' : path, content: '# MCP\nline 2\nline 3' }, headers: { ETag: '"etag-1"' } };
    });
    mock.on('PUT', /\/_apis\/wiki\/wikis\/w1\/pages$/, (r) => {
      const ifMatch = r.headers['if-match'];
      if (r.query.get('path') === '/Runbooks/MCP' && !ifMatch) {
        return { status: 409, json: { message: 'The page \'/Runbooks/MCP\' specified in the add operation already exists in the wiki. Please specify a new page path.' } };
      }
      if (r.query.get('path') === '/Runbooks/Old' && !ifMatch) {
        return { status: 400, json: { message: 'The page \'/Runbooks/Old\' specified in the add operation already exists in the wiki.' } };
      }
      if (r.query.get('path') === '/Runbooks/Branch') {
        return { status: 400, json: { message: 'The wiki version \'release/1.0\' does not exist.' } };
      }
      if (r.query.get('path') === '/Runbooks/Stale') {
        return { status: 412, json: { message: 'The page has changed since the supplied eTag.' } };
      }
      return { status: ifMatch ? 200 : 201, json: { id: 5, path: r.query.get('path') }, headers: { ETag: '"etag-2"' } };
    });
    return h;
  }

  it('lists wikis and flattens the page tree', async () => {
    const harness = await start();
    expect((await harness.call('list_wikis')).json.wikis[0]).toMatchObject({ id: 'w1', name: 'DemoProject.wiki', type: 'projectWiki' });
    const pages = await harness.call('list_wiki_pages', { wiki: 'DemoProject.wiki' });
    expect(pages.json.pages).toEqual([{ path: '/', isParentPage: true }, { path: '/Runbooks', isParentPage: true }, { path: '/Runbooks/MCP', isParentPage: false }]);
    expect(harness.mock.requestsTo(/\/pages$/, 'GET').at(-1)?.query.get('recursionLevel')).toBe('full');
  });

  it('caps the wiki list by top and reports whether the local cap truncated it', async () => {
    const harness = await start({}, 125);
    const capped = await harness.call('list_wikis');
    expect(capped.json).toMatchObject({ count: 100, truncated: true });
    expect(capped.json.wikis).toHaveLength(100);
    const complete = await harness.call('list_wikis', { top: 125 });
    expect(complete.json).toMatchObject({ count: 125, truncated: false });
    expect(complete.json.wikis).toHaveLength(125);
    const atMaximum = await harness.call('list_wikis', { top: 1000 });
    expect(atMaximum.json).toMatchObject({ count: 125, truncated: false });
    expect((await harness.call('list_wikis', { top: 1001 })).text).toContain('expected number to be <=1000');
  });

  it('applies the maximum top locally and reports truncation', async () => {
    const harness = await start({}, 1100);
    const result = await harness.call('list_wikis', { top: 1000 });
    expect(result.json).toMatchObject({ count: 1000, truncated: true });
    expect(result.json.wikis).toHaveLength(1000);
  });

  it('reads a page with its eTag', async () => {
    const harness = await start();
    const { json } = await harness.call('get_wiki_page', { wiki: 'DemoProject.wiki', path: '/Runbooks/MCP', startLine: 2 });
    expect(json).toMatchObject({ path: '/Runbooks/MCP', eTag: '"etag-1"', text: 'line 2\nline 3', totalLines: 3 });
    expect(harness.mock.requestsTo(/\/pages$/, 'GET').at(-1)?.query.get('includeContent')).toBe('true');
  });

  it('creates pages and updates existing pages with the supplied If-Match eTag', async () => {
    const harness = await start();
    expect((await harness.call('create_or_update_wiki_page', { wiki: 'DemoProject.wiki', path: '/Runbooks/New', content: '# New' })).json).toEqual({ path: '/Runbooks/New', created: true, eTag: '"etag-2"' });
    const updated = await harness.call('create_or_update_wiki_page', { wiki: 'DemoProject.wiki', path: '/Runbooks/Alias', content: '# MCP v2', eTag: 'caller-etag', comment: 'Update runbook' });
    expect(updated.json).toEqual({ path: '/Runbooks/MCP', created: false, eTag: '"etag-2"' });
    const request = harness.mock.requestsTo(/\/pages$/, 'PUT').at(-1);
    expect(request?.headers['if-match']).toBe('caller-etag');
    expect(request?.query.get('comment')).toBe('Update runbook');
    expect(request?.body).toEqual({ content: '# MCP v2' });
  });

  it('explains how to resolve an overwrite conflict while preserving unrelated bad requests', async () => {
    const harness = await start();
    const result = await harness.call('create_or_update_wiki_page', { wiki: 'DemoProject.wiki', path: '/Runbooks/MCP', content: 'oops' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[conflict\].*get_wiki_page/);
    const viaBadRequest = await harness.call('create_or_update_wiki_page', { wiki: 'DemoProject.wiki', path: '/Runbooks/Old', content: 'oops' });
    expect(viaBadRequest.text).toMatch(/^\[conflict\].*already exists.*get_wiki_page/);
    const otherBadRequest = await harness.call('create_or_update_wiki_page', { wiki: 'DemoProject.wiki', path: '/Runbooks/Branch', content: 'x' });
    expect(otherBadRequest.text).toMatch(/^\[bad_request\].*The wiki version/);
    const staleTag = await harness.call('create_or_update_wiki_page', { wiki: 'DemoProject.wiki', path: '/Runbooks/Stale', content: 'x', eTag: 'stale' });
    expect(staleTag.text).toMatch(/^\[conflict\].*get_wiki_page/);
  });

  it('loads canonical wiki and replaced page metadata before asking, then performs no write when declined', async () => {
    const harness = await start({ env: { ADO_ALLOW_DESTRUCTIVE: 'false' }, elicit: (field) => (field === 'confirm' ? 'false' : undefined) });
    await harness.call('create_or_update_wiki_page', { wiki: 'w1', path: '/Runbooks/Alias', content: '# MCP v2\nmore', eTag: 'supplied-etag' });
    expect(harness.elicitations[0]?.message).toMatch(/^Replace wiki page "\/Runbooks\/MCP" in "DemoProject\.wiki" \("DemoProject"\) with 2 lines of new content\./);
    const requests = harness.mock.requests.filter((request) => /\/_apis\/wiki\/wikis/.test(request.path));
    expect(requests.map((request) => request.method)).toEqual(['GET', 'GET']);
    expect(requests[1]?.query.get('path')).toBe('/Runbooks/Alias');
    expect(harness.mock.requestsTo(/\/pages$/, 'PUT')).toHaveLength(0);
  });

  it('does not ask or write when the target page is missing', async () => {
    const harness = await start({ env: { ADO_ALLOW_DESTRUCTIVE: 'false' }, elicit: (field) => (field === 'confirm' ? 'true' : undefined) });
    const result = await harness.call('create_or_update_wiki_page', { wiki: 'w1', path: '/Missing', content: '# New', eTag: 'stale-etag' });
    expect(result.text).toMatch(/^\[not_found\]/);
    expect(harness.elicitations).toHaveLength(0);
    expect(harness.mock.requestsTo(/\/pages$/, 'PUT')).toHaveLength(0);
  });

  it('loads the containing wiki before asking to create a new page', async () => {
    const harness = await start({ env: { ADO_ALLOW_DESTRUCTIVE: 'false' }, elicit: (field) => (field === 'confirm' ? 'false' : undefined) });
    await harness.call('create_or_update_wiki_page', { wiki: 'w1', path: '/Runbooks/New', content: '# New' });
    expect(harness.elicitations[0]?.message).toMatch(/^Create wiki page "\/Runbooks\/New" in "DemoProject\.wiki" \("DemoProject"\) with 1 lines\./);
    const requests = harness.mock.requests.filter((request) => /\/_apis\/wiki\/wikis/.test(request.path));
    expect(requests.map((request) => request.method)).toEqual(['GET']);
    expect(harness.mock.requestsTo(/\/pages$/, 'PUT')).toHaveLength(0);
  });
});
