const ROOTS_TTL_MS = 5 * 60_000;

export class SessionMemory {
  // Display name or account of the PAT owner, set when the session is admitted (Task 10). Used by the audit log.
  user?: string;
  // Lowercased collections that refused this PAT during admission (Task 10). They are not offered as choices.
  refusedCollections: ReadonlySet<string> = new Set();
  private readonly answers = new Map<string, string>();
  private roots: { names: Promise<string[]>; at: number } | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  recall(key: string): string | undefined {
    return this.answers.get(key.toLowerCase());
  }

  remember(key: string, value: string): void {
    this.answers.set(key.toLowerCase(), value);
  }

  // Runs one question at a time, so parallel tool calls in a session never ask the same thing twice.
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  rootNames(load: () => Promise<string[]>, now = Date.now()): Promise<string[]> {
    if (!this.roots || now - this.roots.at > ROOTS_TTL_MS) this.roots = { names: load().catch(() => []), at: now };
    return this.roots.names;
  }

  invalidateRoots(): void {
    this.roots = undefined;
  }
}