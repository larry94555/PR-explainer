// Explanation cache: remembers finished explanations so clicking the same line
// again shows the answer at once instead of asking the local model again.
//
// It lives in the service worker and is stored in chrome.storage.session,
// which survives the service worker going idle but is cleared when the
// browser closes. Each answer is stored under its own key
// (`explainCache.entry.<key>`), and a small index under one key
// (`explainCache.index`) lists every answer's key, PR, size and when it was
// last used, least recently used first. So saving an answer writes that
// answer and the index, never every answer (PR 10.2), and a whole PR's worth
// of answers fits.
//
// The limit is a size, `maxBytes` (about 8 MB of the 10 MB Chrome allows,
// which the debug log shares), counted the way Chrome counts it: the length
// of each key plus its value as JSON. When a save passes it, the least
// recently used answers are removed first, and answers from the PR being
// saved (the one open now) only after every other PR's. A hit counts as a
// use, so lines the user keeps coming back to stay longest.
//
// Before PR 10.2 every answer sat in one array under `explainCache`. Those
// entries are moved over the first time the cache is used, and the old key is
// removed. They have no PR, so they go before any newer answer.
//
// An entry's key is a SHA-256 hash of everything that shapes the answer: the
// PR, the model, the temperature and response limit from the settings, and
// the full prompt sent to the model (the instructions plus the file, the
// line, and the code around it). Any change to those, such as a new commit
// that edits the code around the line, a new setting, or a new prompt in a
// later build, gives a new key, so a stale explanation is never shown.
//
// The cache must never break an explanation: callers treat a failing read as
// a miss and ignore a failing write.

import type { ChatMessage } from '../llm/types';
import type { Explanation } from './parseExplanation';

/** The parts of chrome.storage.session the cache uses. */
export interface SessionStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
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
  /**
   * Written by background work (Explain ahead, one line or a whole hunk)
   * rather than for a click or hover, so the popup says "Prefetched" (PR 10.7).
   */
  prefetched?: true;
}

/** An answer as the cache lists it (the debug helper). */
export interface ListedExplanation extends CachedExplanation {
  key: string;
  /** The PR it was saved for ("" for one moved over from the old format). */
  pr: string;
  /** Its size in storage, in bytes. */
  size: number;
  /** When it was last saved or read (Date.now()). */
  usedAt: number;
}

/** The format before PR 10.2: every answer in one array under this key. */
export const CACHE_STORAGE_KEY = 'explainCache';
/** The index: one row per answer, least recently used first. */
export const CACHE_INDEX_KEY = 'explainCache.index';
/** Each answer is stored under this prefix plus its cache key. */
export const CACHE_ENTRY_PREFIX = 'explainCache.entry.';
/** About 8 MB of the 10 MB chrome.storage.session allows (about 5,000 answers). */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export const entryStorageKey = (key: string) => CACHE_ENTRY_PREFIX + key;

export interface ExplainCache {
  get(key: string): Promise<CachedExplanation | null>;
  /**
   * Saves an answer. `pr` is the PR it belongs to, the one open now: its
   * answers are the last to be removed when the cache is full.
   */
  set(key: string, value: CachedExplanation, pr?: string): Promise<void>;
  /** Every answer, least recently used first. */
  list(): Promise<ListedExplanation[]>;
}

export interface CacheKeyParts {
  /** The PR, such as "larry94555/PR-explainer#17". */
  pr: string;
  model: string;
  temperature: number;
  maxResponseTokens: number;
  /** The prompt sent to the model (buildExplainPrompt). */
  messages: ChatMessage[];
  /**
   * The Let the model think setting (PR 9.5). Only added to the key when on,
   * so answers saved before it existed (thinking stripped) still hit.
   */
  letModelThink?: boolean;
}

/** A short, fixed-length key for one explanation (hex SHA-256). */
export async function explainCacheKey(parts: CacheKeyParts): Promise<string> {
  const { pr, model, temperature, maxResponseTokens, messages, letModelThink } = parts;
  const prompt = messages.map(({ role, content }) => [role, content]);
  const data = new TextEncoder().encode(
    JSON.stringify([
      pr,
      model,
      temperature,
      maxResponseTokens,
      prompt,
      ...(letModelThink ? ['think'] : []),
    ]),
  );
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function isCached(value: unknown): value is CachedExplanation {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<CachedExplanation>;
  const e = v.explanation as Partial<Explanation> | undefined;
  return (
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

const pick = ({
  explanation,
  model,
  elapsedMs,
  savedAt,
  prefetched,
}: CachedExplanation): CachedExplanation => ({
  explanation,
  model,
  elapsedMs,
  savedAt,
  ...(prefetched === true && { prefetched }),
});

/** One index row, stored as a short array so the index stays small. */
type Row = [key: string, pr: string, size: number, usedAt: number];

function isRow(value: unknown): value is Row {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string' &&
    typeof value[2] === 'number' &&
    Number.isFinite(value[2]) &&
    typeof value[3] === 'number'
  );
}

const encoder = new TextEncoder();
/** Bytes of a string as UTF-8, which is how Chrome counts storage. */
const bytes = (text: string) => encoder.encode(text).length;
/** What one stored item counts against the limit: its key plus its value as JSON. */
const itemBytes = (key: string, value: unknown) => bytes(key) + bytes(JSON.stringify(value));
/** What a row adds to the index (its JSON and the comma before the next). */
const rowBytes = (row: Row) => bytes(JSON.stringify(row)) + 1;
/** The index's own size with no rows: its key and "[]". */
const INDEX_BASE_BYTES = bytes(CACHE_INDEX_KEY) + 2;

/**
 * Removes rows until the answers and the index together fit in `maxBytes`:
 * least recently used first, every other PR's before `openPr`'s, and never
 * `keep` (the answer being saved). Returns the rows kept and the rows removed.
 */
function trim(
  rows: Row[],
  { maxBytes, openPr, keep }: { maxBytes: number; openPr: string; keep: string },
): { kept: Row[]; removed: Row[] } {
  let total = INDEX_BASE_BYTES;
  for (const row of rows) total += row[2] + rowBytes(row);
  if (total <= maxBytes) return { kept: rows, removed: [] };
  const candidates = [
    ...rows.filter((r) => r[1] !== openPr),
    ...rows.filter((r) => r[1] === openPr && r[0] !== keep),
  ];
  const removed = new Set<Row>();
  for (const row of candidates) {
    if (total <= maxBytes) break;
    removed.add(row);
    total -= row[2] + rowBytes(row);
  }
  return { kept: rows.filter((r) => !removed.has(r)), removed: [...removed] };
}

/** An entry of the format before PR 10.2. */
function isOldEntry(value: unknown): value is CachedExplanation & { key: string } {
  return isCached(value) && typeof (value as { key?: unknown }).key === 'string';
}

export function createExplainCache(
  storage: SessionStorageLike,
  { maxBytes = DEFAULT_MAX_BYTES, now = Date.now }: { maxBytes?: number; now?: () => number } = {},
): ExplainCache {
  // Reads and writes run one after another, so two answers finishing at the
  // same moment cannot overwrite each other's index.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  // The index, read once and then kept in memory: only this cache writes it.
  // It is replaced only after a write succeeds, so it never lists an answer
  // that was not saved.
  let index: Row[] | null = null;

  /** Moves answers saved in the old single-key format over, then removes the old key. */
  const migrate = async (rows: Row[], old: unknown): Promise<Row[]> => {
    const known = new Set(rows.map((r) => r[0]));
    const entries = (Array.isArray(old) ? old.filter(isOldEntry) : []).filter(
      (e) => !known.has(e.key),
    );
    const items: Record<string, unknown> = {};
    const t = now();
    // Oldest first, and older than any answer saved since.
    const moved = entries.map((e, i): Row => {
      const value = pick(e);
      items[entryStorageKey(e.key)] = value;
      return [e.key, '', itemBytes(entryStorageKey(e.key), value), t - (entries.length - i)];
    });
    const { kept, removed } = trim([...moved, ...rows], { maxBytes, openPr: '', keep: '' });
    for (const row of removed) delete items[entryStorageKey(row[0])];
    await storage.set({ ...items, [CACHE_INDEX_KEY]: kept });
    await storage.remove([CACHE_STORAGE_KEY, ...removed.map((r) => entryStorageKey(r[0]))]);
    return kept;
  };

  const load = async (): Promise<Row[]> => {
    if (index) return index;
    const raw = await storage.get([CACHE_INDEX_KEY, CACHE_STORAGE_KEY]);
    const stored = raw[CACHE_INDEX_KEY];
    // A broken index is dropped; its answers can no longer be found.
    let rows = Array.isArray(stored) ? stored.filter(isRow) : [];
    if (raw[CACHE_STORAGE_KEY] !== undefined) rows = await migrate(rows, raw[CACHE_STORAGE_KEY]);
    index = rows;
    return rows;
  };

  const writeIndex = async (rows: Row[]) => {
    await storage.set({ [CACHE_INDEX_KEY]: rows });
    index = rows;
  };

  return {
    get: (key) =>
      serial(async () => {
        const rows = await load();
        const at = rows.findIndex((r) => r[0] === key);
        if (at < 0) return null;
        const storageKey = entryStorageKey(key);
        const value = (await storage.get([storageKey]))[storageKey];
        const rest = rows.filter((_, i) => i !== at);
        if (!isCached(value)) {
          // Missing or broken: forget it so the next click asks the model.
          await writeIndex(rest).catch(() => {});
          return null;
        }
        const [, pr, size] = rows[at]!;
        // Move it to the most recently used end. If this write fails the hit still counts.
        await writeIndex([...rest, [key, pr, size, now()]]).catch(() => {});
        return pick(value);
      }),
    set: (key, value, pr = '') =>
      serial(async () => {
        const rows = await load();
        const storageKey = entryStorageKey(key);
        const saved = pick(value);
        const size = itemBytes(storageKey, saved);
        const row: Row = [key, pr, size, now()];
        // An answer that could never fit on its own is not kept.
        if (INDEX_BASE_BYTES + rowBytes(row) + size > maxBytes) return;
        const { kept, removed } = trim([...rows.filter((r) => r[0] !== key), row], {
          maxBytes,
          openPr: pr,
          keep: key,
        });
        if (removed.length > 0) {
          // Make room before saving: Chrome checks its quota on every write,
          // so saving first could pass 10 MB for a moment and fail although
          // the answer fits once the old ones are gone. The index stops
          // listing them first, so it never names a removed answer, and a
          // failed removal only leaves unused space.
          await writeIndex(kept.filter((r) => r !== row));
          await storage.remove(removed.map((r) => entryStorageKey(r[0]))).catch(() => {});
        }
        await storage.set({ [storageKey]: saved, [CACHE_INDEX_KEY]: kept });
        index = kept;
      }),
    list: () =>
      serial(async () => {
        const rows = await load();
        const values = await storage.get(rows.map((r) => entryStorageKey(r[0])));
        return rows.flatMap(([key, pr, size, usedAt]) => {
          const value = values[entryStorageKey(key)];
          return isCached(value) ? [{ key, pr, size, usedAt, ...pick(value) }] : [];
        });
      }),
  };
}
