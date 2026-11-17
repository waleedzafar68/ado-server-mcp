import type { AdoClient } from '../ado/ado-client.js';
import { AdoError, DisambiguationRequired, type DisambiguationOption, type DisambiguationPayload } from '../ado/errors.js';
import type { TtlCache } from '../util/ttl-cache.js';
import { quoted } from '../util/quoted.js';
import { remoteServerUrl, sshHostMatches } from './caller-context.js';
import { parseGitRemoteUrl, type ParsedRemote } from './git-remote-parser.js';
import { SessionMemory } from './session-memory.js';

export interface ClientBridge {
  readonly supportsElicitation: boolean;
  readonly supportsRoots: boolean;
  elicitChoice(message: string, field: string, options: string[]): Promise<string | undefined>;
  elicitText(message: string, field: string): Promise<string | undefined>;
  confirm(message: string, timeoutMs: number): Promise<boolean>;
  listRootNames(): Promise<string[]>;
}

export const NO_BRIDGE: ClientBridge = {
  supportsElicitation: false,
  supportsRoots: false,
  elicitChoice: async () => undefined,
  elicitText: async () => undefined,
  confirm: async () => false,
  listRootNames: async () => [],
};

export interface ScopeInput {
  collection?: string;
  project?: string;
  repository?: string;
  gitRemoteUrl?: string;
}

export interface ScopeNeeds {
  project?: boolean;
  repository?: boolean;
}

export interface ResolvedScope {
  serverUrl: string;
  collection: string;
  project?: string;
  repository?: string;
  sources: string[];
}

export interface RepoRef {
  name: string;
  project: string;
}

export interface ResolverOptions {
  // The calling tool changes data, so a remote on a host that is not allowed is refused instead of ignored.
  write?: boolean;
}

interface CollectionPick {
  collection: string;
  project?: string;
  repository?: string;
  source: string;
}

interface Pick {
  value: string;
  source: string;
}

interface Answer {
  value: string;
  remembered: boolean;
}

const MAX_OPTIONS = 50;

const same = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

const unique = (values: string[]): string[] => [...new Map(values.map((value) => [value.toLowerCase(), value])).values()];

export class ContextResolver {
  lastScope: { collection: string; project?: string; repository?: string; sources: string[] } | undefined;

  constructor(
    private readonly client: AdoClient,
    private readonly bridge: ClientBridge,
    private readonly cache: TtlCache<unknown>,
    private readonly fingerprint: string,
    private readonly memory: SessionMemory = new SessionMemory(),
    private readonly options: ResolverOptions = {},
  ) {}

  async resolve(input: ScopeInput, needs: ScopeNeeds = {}): Promise<ResolvedScope> {
    const ctx = this.client.caller;
    const sources: string[] = [];
    let serverUrl = ctx.serverUrl;
    let collection = input.collection;
    let project = input.project;
    let repository = input.repository;
    if (collection) sources.push('collection:argument');
    if (project) sources.push('project:argument');
    if (repository) sources.push('repository:argument');

    let parsed: ParsedRemote | undefined;
    let how = 'gitRemoteUrl';
    if (input.gitRemoteUrl) {
      parsed = parseGitRemoteUrl(input.gitRemoteUrl, ctx.collections);
      if (!parsed) {
        throw new AdoError(
          'bad_request',
          `${quoted(input.gitRemoteUrl)} is not an Azure DevOps Server git remote (expected .../{collection}/{project}/_git/{repository}).`,
        );
      }
    } else if (ctx.gitRemote && !collection && !project && !repository) {
      // The header comes from client configuration, so an unparseable value is ignored rather than failing every call.
      parsed = parseGitRemoteUrl(ctx.gitRemote, ctx.collections);
      how = 'git-remote-header';
    }

    if (parsed) {
      const home = new URL(ctx.serverUrl).host;
      // Why the remote's server can't be used, and what the caller can do about it.
      let foreign: { host: string; reason: string; fix: string } | undefined;
      const pinnedElsewhere = (host: string) => ({
        host,
        reason: `but X-ADO-Server-URL pins this connection to ${home}`,
        fix: "Use a connection whose X-ADO-Server-URL is the remote's server",
      });
      if (parsed.serverUrl) {
        const remote = remoteServerUrl(parsed.serverUrl, ctx);
        const host = new URL(parsed.serverUrl).host;
        if (!remote) foreign = { host, reason: 'which this MCP server may not call', fix: 'Ask the server admin to add the host to ADO_HOST_ALIASES' };
        else if (!ctx.serverUrlPinned) {
          if (!input.collection || same(input.collection, parsed.collection)) serverUrl = remote;
        }
        // A pinned server stays, so the remote must be on it; otherwise its names would be used on another server.
        else if (new URL(remote).host !== home) foreign = pinnedElsewhere(host);
      } else if (parsed.sshHost && !sshHostMatches(parsed.sshHost, ctx.serverUrl, ctx)) {
        foreign = ctx.serverUrlPinned
          ? pinnedElsewhere(parsed.sshHost)
          : { host: parsed.sshHost, reason: "which is not this connection's server", fix: "Use the repository's HTTPS remote, or ask the server admin to map the SSH host in ADO_HOST_ALIASES" };
      }
      if (foreign) {
        const instead =
          how === 'git-remote-header'
            ? `or name the collection and project in the call (the X-ADO-Git-Remote header is then ignored) if ${home} is really meant`
            : `or pass collection and project without gitRemoteUrl if ${home} is really meant`;
        if (this.options.write) {
          throw new AdoError(
            'bad_request',
            `The git remote points at ${quoted(foreign.host)}, ${foreign.reason}, so it will not change data in a same-named project on ${home}. ${foreign.fix}, ${instead}.`,
          );
        }
        sources.push('serverUrl:remote-ignored');
      }
      if (!collection) {
        collection = parsed.collection;
        sources.push(`collection:${how}`);
      }
      if (same(collection, parsed.collection)) {
        if (!project) {
          project = parsed.project;
          sources.push(`project:${how}`);
        }
        if (!repository && same(project, parsed.project)) {
          repository = parsed.repository;
          sources.push(`repository:${how}`);
        }
      }
    }

    if (needs.repository && !repository && !input.collection && !input.project && ctx.defaultRepository) {
      repository = ctx.defaultRepository;
      sources.push('repository:default');
    }

    if (!collection) {
      const picked = await this.pickCollection(serverUrl, project, repository);
      const how = picked.source.slice(picked.source.indexOf(':') + 1);
      collection = picked.collection;
      sources.push(picked.source);
      if (!project && picked.project) {
        project = picked.project;
        sources.push(`project:${how}`);
      }
      if (!repository && picked.repository && needs.repository) {
        repository = picked.repository;
        sources.push(`repository:${how}`);
      }
    }

    if ((needs.project || needs.repository) && !project) {
      const picked = await this.pickProject(serverUrl, collection, repository);
      project = picked.value;
      sources.push(picked.source);
    }

    if (needs.repository && !repository && project) {
      const picked = await this.pickRepository(serverUrl, collection, project);
      repository = picked.value;
      sources.push(picked.source);
    }

    this.lastScope = { collection, project, repository, sources };
    return { serverUrl, collection, project, repository, sources };
  }

  // Empty when the PAT cannot list collections (it is scoped to one collection) and none are configured.
  async availableCollections(serverUrl: string): Promise<string[]> {
    const configured = this.client.caller.collections;
    if (configured.length > 0) return configured;
    try {
      const listed = await this.cached(`collections|${serverUrl}`, () => this.client.listServerCollections(serverUrl));
      return listed.filter((name) => !this.memory.refusedCollections.has(name.toLowerCase()));
    } catch (error) {
      if (error instanceof AdoError && ['auth', 'credential', 'permission'].includes(error.kind)) return [];
      throw error;
    }
  }

  async projects(serverUrl: string, collection: string): Promise<string[]> {
    return this.cached(`projects|${serverUrl}|${collection}`, async () => {
      const { items } = await this.client.getAllPages<{ name: string }>({
        serverUrl,
        collection,
        path: '_apis/projects',
        area: 'core',
        query: { $top: 500 },
      });
      return items.map((project) => project.name);
    });
  }

  async repositories(serverUrl: string, collection: string): Promise<RepoRef[]> {
    return this.cached(`repositories|${serverUrl}|${collection}`, async () => {
      const data = await this.client.get<{ value?: Array<{ name: string; project?: { name?: string } }> }>({
        serverUrl,
        collection,
        path: '_apis/git/repositories',
        area: 'git',
      });
      return (data.value ?? []).map((repo) => ({ name: repo.name, project: repo.project?.name ?? '' }));
    });
  }

  private async pickCollection(serverUrl: string, project?: string, repository?: string): Promise<CollectionPick> {
    const candidates = await this.availableCollections(serverUrl);
    const first = candidates[0];
    if (candidates.length === 1 && first) return { collection: first, source: 'collection:only-configured' };
    if (candidates.length === 0) {
      const answer = await this.ask(
        {
          missing: 'collection',
          message:
            'No collection was given and this PAT cannot list collections on the server (it is probably scoped to one collection). Which collection should be used? Pass `collection`, or add X-ADO-Collections to the MCP client configuration.',
          options: [],
        },
        [],
        'collection',
        async (typed) => {
          await this.client.profile({ serverUrl, collection: typed });
        },
      );
      return { collection: answer.value, source: answer.remembered ? 'collection:remembered' : 'collection:asked' };
    }

    let failed: string[] = [];
    if (project || repository) {
      const search = await this.collectionsContaining(serverUrl, candidates, project, repository);
      failed = search.failed;
      const matches = search.matches;
      const distinct = unique(matches.map((match) => match.collection));
      const only = distinct[0];
      if (distinct.length === 1 && only) {
        const exact = matches.length === 1 ? matches[0] : undefined;
        return { collection: only, project: exact?.project, repository: exact?.repository, source: 'collection:cross-collection-search' };
      }
      if (distinct.length > 1) {
        const what = repository ? `Repository ${quoted(repository)}` : `Project ${quoted(project)}`;
        const answer = await this.ask(
          { missing: 'collection', message: `${what} exists in more than one collection. Which collection should be used?`, options: matches },
          distinct,
          'collection',
        );
        const chosen = matches.filter((match) => same(match.collection, answer.value));
        const exact = chosen.length === 1 ? chosen[0] : undefined;
        return {
          collection: answer.value,
          project: exact?.project,
          repository: exact?.repository,
          source: answer.remembered ? 'collection:remembered' : 'collection:asked',
        };
      }
    }

    const fromRoots = await this.matchRootsAcrossCollections(serverUrl, candidates);
    const rootCollections = unique(fromRoots.map((match) => match.collection));
    const rootCollection = rootCollections[0];
    if (rootCollections.length === 1 && rootCollection) {
      const exact = fromRoots.length === 1 ? fromRoots[0] : undefined;
      return { collection: rootCollection, project: exact?.project, repository: exact?.repository, source: 'collection:mcp-roots' };
    }

    const target = repository ? `repository ${quoted(repository)}` : `project ${quoted(project)}`;
    const reason = !(project || repository)
      ? 'Several Azure DevOps collections are available and no repository context was detected.'
      : failed.length > 0
        ? `No collection that could be searched contains ${target}; these collections could not be searched: ${failed.map((name) => quoted(name)).join(', ')} (the PAT may not be valid there).`
        : `None of your collections contains ${target}.`;
    const answer = await this.ask(
      {
        missing: 'collection',
        message: `${reason} Which collection should be used? (Tip: pass gitRemoteUrl from \`git remote get-url origin\`.)`,
        options: await this.collectionOptions(serverUrl, candidates),
      },
      candidates,
      'collection',
    );
    return { collection: answer.value, source: answer.remembered ? 'collection:remembered' : 'collection:asked' };
  }

  private async pickProject(serverUrl: string, collection: string, repository?: string): Promise<Pick> {
    if (repository) {
      const owners = (await this.repositories(serverUrl, collection)).filter((repo) => same(repo.name, repository));
      const owner = owners[0];
      if (owners.length === 1 && owner) return { value: owner.project, source: 'project:repository-lookup' };
      if (owners.length > 1) {
        const answer = await this.ask(
          {
            missing: 'project',
            message: `Repository ${quoted(repository)} exists in several projects of ${quoted(collection)}. Which project should be used?`,
            options: owners.map((repo) => ({ collection, project: repo.project, repository: repo.name })),
          },
          owners.map((repo) => repo.project),
          `project|${collection}`,
        );
        return { value: answer.value, source: answer.remembered ? 'project:remembered' : 'project:asked' };
      }
    }

    const projects = await this.projects(serverUrl, collection);
    const fallback = this.client.caller.defaultProject;
    const defaultMatch = fallback ? projects.find((name) => same(name, fallback)) : undefined;
    if (defaultMatch) return { value: defaultMatch, source: 'project:default' };

    const rootProjects = unique((await this.matchRoots(serverUrl, collection)).flatMap((match) => (match.project ? [match.project] : [])));
    const rootProject = rootProjects[0];
    if (rootProjects.length === 1 && rootProject) return { value: rootProject, source: 'project:mcp-roots' };

    const onlyProject = projects[0];
    if (projects.length === 1 && onlyProject) return { value: onlyProject, source: 'project:only-project' };

    const answer = await this.ask(
      { missing: 'project', message: `Which project in collection ${quoted(collection)} should be used?`, options: projects.map((name) => ({ collection, project: name })) },
      projects,
      `project|${collection}`,
    );
    return { value: answer.value, source: answer.remembered ? 'project:remembered' : 'project:asked' };
  }

  private async pickRepository(serverUrl: string, collection: string, project: string): Promise<Pick> {
    const repos = (await this.repositories(serverUrl, collection)).filter((repo) => same(repo.project, project));
    const roots = await this.rootNames();
    const fromRoots = repos.filter((repo) => roots.some((root) => same(root, repo.name)));
    const rootRepo = fromRoots[0];
    if (fromRoots.length === 1 && rootRepo) return { value: rootRepo.name, source: 'repository:mcp-roots' };
    const onlyRepo = repos[0];
    if (repos.length === 1 && onlyRepo) return { value: onlyRepo.name, source: 'repository:only-repository' };
    const answer = await this.ask(
      {
        missing: 'repository',
        message: `Which repository in ${quoted(`${collection}/${project}`)} should be used?`,
        options: repos.map((repo) => ({ collection, project, repository: repo.name })),
      },
      repos.map((repo) => repo.name),
      `repository|${collection}|${project}`,
    );
    return { value: answer.value, source: answer.remembered ? 'repository:remembered' : 'repository:asked' };
  }

  private async collectionsContaining(
    serverUrl: string,
    candidates: string[],
    project?: string,
    repository?: string,
  ): Promise<{ matches: DisambiguationOption[]; failed: string[] }> {
    const failed: string[] = [];
    const perCollection = await Promise.all(
      candidates.map(async (collection): Promise<DisambiguationOption[]> => {
        try {
          if (repository) {
            return (await this.repositories(serverUrl, collection))
              .filter((repo) => same(repo.name, repository) && (!project || same(repo.project, project)))
              .map((repo) => ({ collection, project: repo.project, repository: repo.name }));
          }
          return (await this.projects(serverUrl, collection)).filter((name) => same(name, project)).map((name) => ({ collection, project: name }));
        } catch (error) {
          if (!(error instanceof AdoError)) throw error;
          failed.push(collection);
          return [];
        }
      }),
    );
    return { matches: perCollection.flat(), failed: candidates.filter((collection) => failed.includes(collection)) };
  }

  private async collectionOptions(serverUrl: string, candidates: string[]): Promise<DisambiguationOption[]> {
    return Promise.all(
      candidates.slice(0, MAX_OPTIONS).map(async (collection): Promise<DisambiguationOption> => {
        try {
          return { collection, projects: (await this.projects(serverUrl, collection)).slice(0, 25) };
        } catch (error) {
          const unauthorized = error instanceof AdoError && (error.kind === 'auth' || error.kind === 'credential');
          return { collection, note: unauthorized ? 'Your PAT is not valid for this collection.' : 'Projects could not be listed.' };
        }
      }),
    );
  }

  private rootNames(): Promise<string[]> {
    if (!this.bridge.supportsRoots) return Promise.resolve([]);
    return this.memory.rootNames(() => this.bridge.listRootNames());
  }

  private async matchRoots(serverUrl: string, collection: string): Promise<DisambiguationOption[]> {
    const roots = await this.rootNames();
    if (roots.length === 0) return [];
    const repos = (await this.repositories(serverUrl, collection))
      .filter((repo) => roots.some((root) => same(root, repo.name)))
      .map((repo) => ({ collection, project: repo.project, repository: repo.name }));
    const projects = (await this.projects(serverUrl, collection))
      .filter((name) => roots.some((root) => same(root, name)))
      .map((name) => ({ collection, project: name }));
    return [...repos, ...projects];
  }

  private async matchRootsAcrossCollections(serverUrl: string, candidates: string[]): Promise<DisambiguationOption[]> {
    if ((await this.rootNames()).length === 0) return [];
    const perCollection = await Promise.all(
      candidates.map((collection) => this.matchRoots(serverUrl, collection).catch((): DisambiguationOption[] => [])),
    );
    return perCollection.flat();
  }

  // With no values to choose from, a typed answer must pass `validate` before it is remembered.
  private ask(
    request: { missing: DisambiguationPayload['missing']; message: string; options: DisambiguationOption[] },
    values: string[],
    memoryKey: string,
    validate?: (typed: string) => Promise<void>,
  ): Promise<Answer> {
    const choices = unique(values).slice(0, MAX_OPTIONS);
    const pick = (answer: string | undefined): string | undefined =>
      choices.length > 0 ? choices.find((choice) => same(choice, answer)) : answer?.trim() || undefined;

    return this.memory.exclusive(async () => {
      const remembered = pick(this.memory.recall(memoryKey));
      if (remembered) return { value: remembered, remembered: true };
      if (this.bridge.supportsElicitation) {
        const answer = await (choices.length > 0
          ? this.bridge.elicitChoice(request.message, request.missing, choices)
          : this.bridge.elicitText(request.message, request.missing)
        ).catch(() => undefined);
        const value = pick(answer);
        if (value) {
          if (choices.length === 0) await validate?.(value);
          this.memory.remember(memoryKey, value);
          return { value, remembered: false };
        }
      }
      throw new DisambiguationRequired({
        status: 'disambiguation_required',
        missing: request.missing,
        message: `${request.message} Ask the user, then call the tool again with \`${request.missing}\` set.`,
        options: request.options.slice(0, MAX_OPTIONS),
      });
    });
  }

  private async cached<T>(key: string, factory: () => Promise<T>): Promise<T> {
    return (await this.cache.getOrCreate(`${this.fingerprint}|${key.toLowerCase()}`, factory)) as T;
  }
}