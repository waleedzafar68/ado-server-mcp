import { z } from 'zod';
import { DEFAULT_MAX_CHARS, HARD_MAX_CHARS, windowText } from '../ado/bounded.js';
import type { AdoClient } from '../ado/ado-client.js';
import { AdoError } from '../ado/errors.js';
import type { ResolvedScope } from '../context/context-resolver.js';
import { scopeShape, seg, targetOf, topArg } from './common.js';
import { defineTool, quoted, type AnyTool } from './registry.js';

interface ApiWiki {
  id: string;
  name: string;
  type?: string;
  mappedPath?: string;
  repositoryId?: string;
  versions?: Array<{ version?: string }>;
}

interface ApiWikiPage {
  id?: number;
  path?: string;
  content?: string;
  isParentPage?: boolean;
  subPages?: ApiWikiPage[];
}

const wikiArg = z.string().min(1).describe('Wiki name or id (see list_wikis), e.g. "DemoProject.wiki".');
const pagePathArg = z.string().min(1).describe('Page path, e.g. "/Runbooks/MCP".');

function flattenPages(root: ApiWikiPage, limit: number): { pages: Array<{ path?: string; isParentPage: boolean }>; truncated: boolean } {
  const pages: Array<{ path?: string; isParentPage: boolean }> = [];
  const stack: ApiWikiPage[] = [root];
  while (stack.length > 0) {
    const page = stack.pop();
    if (!page) break;
    if (pages.length === limit) return { pages, truncated: true };
    pages.push({ path: page.path, isParentPage: page.isParentPage === true });
    for (const child of [...(page.subPages ?? [])].reverse()) stack.push(child);
  }
  return { pages, truncated: false };
}

async function loadWikis(client: AdoClient, scope: ResolvedScope): Promise<ApiWiki[]> {
  const data = await client.get<{ value?: ApiWiki[] }>({
    ...targetOf(scope),
    path: '_apis/wiki/wikis',
    area: 'wiki',
  });
  return data.value ?? [];
}

const listWikis = defineTool({
  name: 'list_wikis',
  toolset: 'wiki',
  title: 'List wikis',
  description: 'Lists the project wiki and code wikis of a project.',
  readOnly: true,
  input: { ...scopeShape, top: topArg(100, 1000) },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const allWikis = await loadWikis(client, scope);
    const wikis = allWikis.slice(0, args.top).map((wiki) => ({
      id: wiki.id,
      name: wiki.name,
      type: wiki.type,
      mappedPath: wiki.mappedPath,
      repositoryId: wiki.repositoryId,
      versions: (wiki.versions ?? []).map((version) => version.version),
    }));
    return { project: scope.project, count: wikis.length, truncated: allWikis.length > args.top, wikis };
  },
});

const listWikiPages = defineTool({
  name: 'list_wiki_pages',
  toolset: 'wiki',
  title: 'List wiki pages',
  description: 'Lists the page tree of a wiki below a path as a flat list of page paths.',
  readOnly: true,
  input: {
    ...scopeShape,
    wiki: wikiArg,
    path: z.string().default('/'),
    recursionLevel: z.enum(['oneLevel', 'full']).default('full'),
    top: topArg(500, 5000),
  },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const root = await client.get<ApiWikiPage>({
      ...targetOf(scope),
      path: `_apis/wiki/wikis/${seg(args.wiki)}/pages`,
      area: 'wiki',
      query: { path: args.path, recursionLevel: args.recursionLevel },
    });
    const { pages, truncated } = flattenPages(root, args.top);
    return { wiki: args.wiki, count: pages.length, truncated, pages };
  },
});

const getWikiPage = defineTool({
  name: 'get_wiki_page',
  toolset: 'wiki',
  title: 'Read wiki page',
  description: 'Reads the markdown of a wiki page (line-windowed) and returns its eTag, which is needed to update the page safely.',
  readOnly: true,
  input: {
    ...scopeShape,
    wiki: wikiArg,
    path: pagePathArg,
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    maxChars: z.number().int().min(1).max(HARD_MAX_CHARS).default(DEFAULT_MAX_CHARS),
  },
  async handler(args, { client, resolver }) {
    const scope = await resolver.resolve(args, { project: true });
    const response = await client.request<ApiWikiPage>({
      ...targetOf(scope),
      method: 'GET',
      path: `_apis/wiki/wikis/${seg(args.wiki)}/pages`,
      area: 'wiki',
      query: { path: args.path, includeContent: true },
    });
    const window = windowText(response.data.content ?? '', { startLine: args.startLine, endLine: args.endLine, maxChars: args.maxChars });
    return { wiki: args.wiki, path: response.data.path ?? args.path, eTag: response.headers.get('etag') ?? undefined, ...window };
  },
});

const createOrUpdateWikiPage = defineTool({
  name: 'create_or_update_wiki_page',
  toolset: 'wiki',
  title: 'Create or update wiki page',
  description: 'Creates a wiki page, or replaces an existing page when you pass the eTag from get_wiki_page (this prevents overwriting someone else’s change).',
  readOnly: false,
  destructive: true,
  idempotent: true,
  input: {
    ...scopeShape,
    wiki: wikiArg,
    path: pagePathArg,
    content: z.string().describe('Full markdown content of the page.'),
    eTag: z.string().min(1).optional().describe('eTag from get_wiki_page; required to update an existing page.'),
    comment: z.string().optional().describe('Commit comment for the wiki change.'),
  },
  async handler(args, { client, resolver, confirm }) {
    const scope = await resolver.resolve(args, { project: true });
    const wikis = await loadWikis(client, scope);
    const wiki = wikis.find((item) => item.id.toLowerCase() === args.wiki.toLowerCase() || item.name.toLowerCase() === args.wiki.toLowerCase());
    if (!wiki) throw new AdoError('not_found', `Wiki ${quoted(args.wiki)} was not found in ${quoted(scope.project)}.`);

    let path = args.path;
    if (args.eTag) {
      const existing = await client.get<ApiWikiPage>({
        ...targetOf(scope),
        path: `_apis/wiki/wikis/${seg(wiki.id)}/pages`,
        area: 'wiki',
        query: { path: args.path },
      });
      if (!existing.path) throw new AdoError('not_found', `Wiki page ${quoted(args.path)} was not found in ${quoted(wiki.name)}.`);
      path = existing.path;
    }

    const lines = args.content.split('\n').length;
    await confirm(
      args.eTag
        ? `Replace wiki page ${quoted(path)} in ${quoted(wiki.name)} (${quoted(scope.project)}) with ${lines} lines of new content.`
        : `Create wiki page ${quoted(path)} in ${quoted(wiki.name)} (${quoted(scope.project)}) with ${lines} lines.`,
    );
    try {
      const response = await client.request<ApiWikiPage>({
        ...targetOf(scope),
        method: 'PUT',
        path: `_apis/wiki/wikis/${seg(wiki.id)}/pages`,
        area: 'wiki',
        query: { path, comment: args.comment },
        body: { content: args.content },
        headers: args.eTag ? { 'If-Match': args.eTag } : undefined,
      });
      return { path: response.data.path ?? path, created: response.status === 201, eTag: response.headers.get('etag') ?? undefined };
    } catch (error) {
      const conflict =
        error instanceof AdoError &&
        (error.kind === 'conflict' || (error.kind === 'bad_request' && /already exists|eTag/i.test(error.message)));
      if (conflict) {
        throw new AdoError('conflict', `${error.message} Call get_wiki_page for the current eTag and content, merge your change, then retry with eTag.`, error.status);
      }
      throw error;
    }
  },
});

export const wikiTools: AnyTool[] = [listWikis, listWikiPages, getWikiPage, createOrUpdateWikiPage];
