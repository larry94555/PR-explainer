// Explanation cache: remembers finished explanations so clicking the same line
// again shows the answer at once instead of asking the local model again.
//
// It lives in the service worker and is stored in chrome.storage.session,
// which survives the service worker going idle but is cleared when the
// browser closes. All entries sit under one storage key, oldest first. When
// there are more than `maxEntries`, the oldest are dropped. A hit moves the
// entry to the end, so lines the user keeps coming back to stay longest.
//
// An entry's key is a SHA-256 hash of the PR, the model, and the context
// block sent to the model (the file, the line, and the code around it). Any
// change to the code around the line, such as a new commit that edits it,
// gives a new key, so a stale explanation is never shown for changed code.
//
// The cache must never break an explanation: callers treat a failing read as
// a miss and ignore a failing write.

import type { Explanation } from './parseExplanation';

/** The parts of chrome.storage.session the cache uses. */
export interface SessionStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** What is saved for one explanation. */
export interface CachedExplanation {
  explanation: Explanation;
  /** The model that wrote it, as Ollama named it. */
  model: string;
  /** How long the model took to write it, in milliseconds. */
  elapsedMs: number;
  /** When it was saved (Date.now()). */
  savedAt: number;
}

interface Entry extends CachedExplanation {
  key: string;
}

export const CACHE_STORAGE_KEY = 'explainCache';
export const DEFAULT_MAX_ENTRIES = 100;

export interface ExplainCache {
  get(key: string): Promise<CachedExplanation | null>;
  set(key: string, value: CachedExplanation): Promise<void>;
}

export interface CacheKeyParts {
  /** The PR, such as "larry94555/PR-explainer#17". */
  pr: string;
  model: string;
  /** The context block from formatContext (src/lineContext.ts). */
  context: string;
}

/** A short, fixed-length key for one explanation (hex SHA-256). */
export async function explainCacheKey({ pr, model, context }: CacheKeyParts): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([pr, model, context]));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function isEntry(value: unknown): value is Entry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Entry>;
  const e = v.explanation as Partial<Explanation> | undefined;
  return (
    typeof v.key === 'string' &&
    typeof v.model === 'string' &&
    typeof v.elapsedMs === 'number' &&
    typeof v.savedAt === 'number' &&
    typeof e === 'object' &&
    e !== null &&
    typeof e.what === 'string' &&
    typeof e.why === 'string' &&
    typeof e.concerns === 'string'
  );
}

export function createExplainCache(
  storage: SessionStorageLike,
  { maxEntries = DEFAULT_MAX_ENTRIES }: { maxEntries?: number } = {},
): ExplainCache {
  // Reads and writes run one after another, so two answers finishing at the
  // same moment cannot overwrite each other's entry.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  const read = async (): Promise<Entry[]> => {
    const raw = (await storage.get([CACHE_STORAGE_KEY]))[CACHE_STORAGE_KEY];
    // Anything unexpected (an older format, a broken value) is dropped.
    return Array.isArray(raw) ? raw.filter(isEntry) : [];
  };
  const write = (entries: Entry[]) =>
    storage.set({ [CACHE_STORAGE_KEY]: entries.slice(-Math.max(1, maxEntries)) });

  return {
    get: (key) =>
      serial(async () => {
        const entries = await read();
        const index = entries.findIndex((e) => e.key === key);
        if (index < 0) return null;
        const [entry] = entries.splice(index, 1);
        // Move it to the newest end. If this write fails the hit still counts.
        await write([...entries, entry!]).catch(() => {});
        const { explanation, model, elapsedMs, savedAt } = entry!;
        return { explanation, model, elapsedMs, savedAt };
      }),
    set: (key, value) =>
      serial(async () => {
        const entries = (await read()).filter((e) => e.key !== key);
        await write([...entries, { key, ...value }]);
      }),
  };
}
