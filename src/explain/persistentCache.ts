// Saved answers (PR 10.9): explanations kept on this computer after Chrome
// closes, so a PR prefetched once stays done the next day.
//
// The session cache (src/explain/explainCache.ts) lives in
// chrome.storage.session, which Chrome clears when it closes. This module
// keeps a second copy of each answer in IndexedDB, in the service worker,
// under the same cache key. The key is a hash of the exact prompt, so it
// follows the code: a new commit that changes a line gives a new key, and an
// answer for code that no longer exists is never shown, only left to age out.
//
// createLayeredCache puts the two together behind the ExplainCache interface
// the handlers already use: a read tries the session cache first, then
// IndexedDB (copying a hit back into the session cache, so the next read is
// quick); a save writes both.
//
// Two limits bound the space:
// - Keep answers for (days), a setting (7 by default). An answer not used for
//   that long is removed when the service worker starts, and is a miss if it
//   is read before then. 0 keeps nothing on disk: answers last only until
//   Chrome closes, as before this PR.
// - A size, `maxBytes` (50 MB): when a save passes it, the least recently
//   used answers are removed first.
//
// IndexedDB must never break an explanation: a failure to open, read or
// write is a miss or is ignored, and the session cache still works.

import type { CachedExplanation, ExplainCache, ListedExplanation } from './explainCache';
import type { Explanation } from './parseExplanation';

export const DB_NAME = 'pr-explainer';
export const DB_VERSION = 1;
export const STORE = 'answers';
/** The index on when each answer was last used, oldest first. */
const BY_USED = 'usedAt';
/** 50 MB, about 50,000 answers. */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
export const DAY_MS = 24 * 60 * 60 * 1000;

type Lookup = { status: 'fresh'; record: AnswerRecord } | { status: 'expired' | 'missing' | 'off' };

/** One saved answer, as IndexedDB holds it. */
interface AnswerRecord {
  key: string;
  /** The PR it was saved for. */
  pr: string;
  value: CachedExplanation;
  /** Its size, counted as the key plus the answer as JSON. */
  size: number;
  /** When it was last saved or read (Date.now()). */
  usedAt: number;
}

export interface PersistentCache {
  /** The saved answer and its PR, or null for a miss (or any failure). */
  get(key: string): Promise<{ value: CachedExplanation; pr: string } | null>;
  /**
   * For an answer the session cache already has (review on #68): checks it
   * against Keep answers for, using the same last-used time as `get`, and
   * counts the read as a use. `expired` means it must not be shown, and is
   * removed from disk; `off` means Keep answers for is 0, so the session
   * cache alone decides; `missing` means there is no copy on disk (or
   * IndexedDB failed), and the session cache's answer stands.
   *
   * `lastUsed` is when the session cache last used it. With no copy on disk
   * (already pruned, or IndexedDB failing) the answer is judged by it against
   * the same setting and clock, so a pruned answer is not shown from the
   * session cache after the worker restarts or the setting is lowered.
   */
  touch(key: string, lastUsed: number): Promise<'fresh' | 'expired' | 'missing' | 'off'>;
  /** Saves an answer, unless Keep answers for is 0. Failures are ignored. */
  set(key: string, value: CachedExplanation, pr: string): Promise<void>;
  /**
   * Removes answers not used for Keep answers for days (every answer when it
   * is 0). Returns how many were removed. Failures are ignored.
   */
  prune(): Promise<number>;
  /** Removes one saved answer. Failures are ignored. */
  remove(key: string): Promise<void>;
  /** Removes every saved answer. */
  clear(): Promise<void>;
}

export interface PersistentCacheOptions {
  /** The IndexedDB factory: `indexedDB` in the service worker, a fake in tests. */
  indexedDB: IDBFactory;
  /** Keep answers for (days), read when it is needed so a save applies at once. */
  keepDays: () => Promise<number>;
  maxBytes?: number;
  now?: () => number;
}

const encoder = new TextEncoder();
const sizeOf = (key: string, value: CachedExplanation) =>
  encoder.encode(key).length + encoder.encode(JSON.stringify(value)).length;

function isExplanation(value: unknown): value is Explanation {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<Explanation>;
  return typeof e.what === 'string' && typeof e.why === 'string' && typeof e.concerns === 'string';
}

function isRecord(value: unknown): value is AnswerRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<AnswerRecord>;
  const v = r.value as Partial<CachedExplanation> | undefined;
  return (
    typeof r.key === 'string' &&
    typeof r.pr === 'string' &&
    typeof r.size === 'number' &&
    typeof r.usedAt === 'number' &&
    typeof v === 'object' &&
    v !== null &&
    typeof v.model === 'string' &&
    typeof v.elapsedMs === 'number' &&
    typeof v.savedAt === 'number' &&
    isExplanation(v.explanation)
  );
}

/** The fields of an answer that are saved, as the session cache keeps them. */
const pick = ({
  explanation,
  model,
  elapsedMs,
  savedAt,
  prefetched,
}: CachedExplanation): CachedExplanation => ({
  explanation: { what: explanation.what, why: explanation.why, concerns: explanation.concerns },
  model,
  elapsedMs,
  savedAt,
  ...(prefetched === true && { prefetched }),
});

/** An IDBRequest as a promise. */
function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** Resolves once a transaction has been written. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' }).createIndex(BY_USED, 'usedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked'));
  });
}

export function createPersistentCache({
  indexedDB,
  keepDays,
  maxBytes = DEFAULT_MAX_BYTES,
  now = Date.now,
}: PersistentCacheOptions): PersistentCache {
  // Opened once, on first use. A failed open is tried again on the next use.
  let opening: Promise<IDBDatabase> | null = null;
  const db = () => {
    opening ??= openDb(indexedDB).then(
      (opened) => {
        // Chrome can close it (for example when the disk is cleared); open again next time.
        opened.onclose = () => (opening = null);
        return opened;
      },
      (error: unknown) => {
        opening = null;
        throw error;
      },
    );
    return opening;
  };

  // Writes run one after another, so the total below stays right.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  // The size of every saved answer, counted once from the database and then
  // kept up to date by each write, so a save does not read every answer.
  let total: number | null = null;
  const loadTotal = async (database: IDBDatabase): Promise<number> => {
    if (total !== null) return total;
    const records = await done(database.transaction(STORE).objectStore(STORE).getAll());
    total = records.reduce((sum: number, r: unknown) => sum + (isRecord(r) ? r.size : 0), 0);
    return total;
  };

  /** Whether an answer last used at `usedAt` is past Keep answers for `days`. */
  const expired = (usedAt: number, days: number) => days <= 0 || usedAt < now() - days * DAY_MS;

  /** Deletes the oldest used answers until the total fits `limit`. Returns how many. */
  const trimTo = async (database: IDBDatabase, limit: number, keep: string): Promise<number> => {
    let size = await loadTotal(database);
    if (size <= limit) return 0;
    const tx = database.transaction(STORE, 'readwrite');
    const wrote = committed(tx);
    let removed = 0;
    const cursorRequest = tx.objectStore(STORE).index(BY_USED).openCursor();
    await new Promise<void>((resolve, reject) => {
      cursorRequest.onerror = () => reject(cursorRequest.error);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || size <= limit) return resolve();
        const record: unknown = cursor.value;
        if (!isRecord(record) || record.key !== keep) {
          size -= isRecord(record) ? record.size : 0;
          removed += 1;
          cursor.delete();
        }
        cursor.continue();
      };
    });
    await wrote;
    total = size;
    return removed;
  };

  /**
   * Reads an answer and counts it as a use: a read moves it to the most
   * recently used end, so answers you keep coming back to stay longest. An
   * answer past Keep answers for, or a broken record, is removed.
   */
  const use = (key: string, lastUsed?: number): Promise<Lookup> =>
    serial(async (): Promise<Lookup> => {
      let days: number;
      try {
        days = await keepDays();
      } catch {
        return { status: 'missing' };
      }
      if (days <= 0) return { status: 'off' };
      // No copy on disk to go by: the session cache's last use decides.
      const notOnDisk = (): Lookup =>
        lastUsed !== undefined && expired(lastUsed, days)
          ? { status: 'expired' }
          : { status: 'missing' };
      try {
        const database = await db();
        const tx = database.transaction(STORE, 'readwrite');
        const wrote = committed(tx);
        const store = tx.objectStore(STORE);
        const record: unknown = await done(store.get(key));
        if (!isRecord(record)) {
          // A broken record is removed; a missing one changes nothing.
          if (record !== undefined) {
            store.delete(key);
            total = null;
          }
          await wrote;
          return notOnDisk();
        }
        if (expired(record.usedAt, days)) {
          store.delete(key);
          if (total !== null) total -= record.size;
          await wrote;
          return { status: 'expired' };
        }
        store.put({ ...record, usedAt: now() });
        await wrote;
        return { status: 'fresh', record };
      } catch {
        return notOnDisk();
      }
    });

  return {
    get: async (key) => {
      const found = await use(key);
      return found.status === 'fresh'
        ? { value: pick(found.record.value), pr: found.record.pr }
        : null;
    },
    touch: async (key, lastUsed) => (await use(key, lastUsed)).status,
    set: (key, value, pr) =>
      serial(async () => {
        try {
          if ((await keepDays()) <= 0) return;
          const saved = pick(value);
          const size = sizeOf(key, saved);
          // An answer that could never fit on its own is not kept.
          if (size > maxBytes) return;
          const database = await db();
          await loadTotal(database);
          const tx = database.transaction(STORE, 'readwrite');
          const wrote = committed(tx);
          const store = tx.objectStore(STORE);
          const old: unknown = await done(store.get(key));
          const record: AnswerRecord = { key, pr, value: saved, size, usedAt: now() };
          store.put(record);
          await wrote;
          total = (total ?? 0) - (isRecord(old) ? old.size : 0) + size;
          await trimTo(database, maxBytes, key);
        } catch {
          // Only the session cache has it; the next save of the same answer tries again.
          total = null;
        }
      }),
    prune: () =>
      serial(async () => {
        try {
          const days = await keepDays();
          const database = await db();
          const tx = database.transaction(STORE, 'readwrite');
          const wrote = committed(tx);
          const store = tx.objectStore(STORE);
          let removed: number;
          if (days <= 0) {
            removed = await done(store.count());
            store.clear();
          } else {
            // Oldest used first, up to the first one still in use.
            const cutoff = now() - days * DAY_MS;
            removed = 0;
            const cursorRequest = store.index(BY_USED).openCursor();
            await new Promise<void>((resolve, reject) => {
              cursorRequest.onerror = () => reject(cursorRequest.error);
              cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (!cursor || !(Number(cursor.key) < cutoff)) return resolve();
                cursor.delete();
                removed += 1;
                cursor.continue();
              };
            });
          }
          await wrote;
          total = null;
          return removed;
        } catch {
          total = null;
          return 0;
        }
      }),
    remove: (key) =>
      serial(async () => {
        try {
          const database = await db();
          const tx = database.transaction(STORE, 'readwrite');
          const wrote = committed(tx);
          tx.objectStore(STORE).delete(key);
          await wrote;
        } finally {
          // Counted again from the database on the next save.
          total = null;
        }
      }).catch(() => {}),
    clear: () =>
      serial(async () => {
        const database = await db();
        const tx = database.transaction(STORE, 'readwrite');
        const wrote = committed(tx);
        tx.objectStore(STORE).clear();
        await wrote;
        total = 0;
      }),
  };
}

/**
 * The cache the handlers use (PR 10.9): the session cache first, then the
 * answers saved on disk. `list` (the debug helper) lists the session cache.
 */
export function createLayeredCache(session: ExplainCache, disk: PersistentCache): ExplainCache {
  return {
    get: async (key) => {
      // Keep answers for applies to the session cache too (review on #68):
      // a session hit is checked against the disk's last use, or the session
      // cache's own when the disk has no copy, and counts as a use on disk.
      // So an answer past the limit is not shown just because Chrome stayed
      // open, or because the worker restarted and pruned it from disk.
      const lastUsed = await session.lastUsed(key).catch(() => null);
      if (lastUsed !== null) {
        if ((await disk.touch(key, lastUsed)) === 'expired') {
          await session.remove(key).catch(() => {});
          return null;
        }
        const hit = await session.get(key).catch(() => null);
        if (hit) return hit;
      }
      const saved = await disk.get(key);
      if (!saved) return null;
      // Back into the session cache, so the next read does not reach the disk.
      await session.set(key, saved.value, saved.pr).catch(() => {});
      return saved.value;
    },
    set: async (key, value, pr = '') => {
      await Promise.all([session.set(key, value, pr), disk.set(key, value, pr)]);
    },
    lastUsed: (key) => session.lastUsed(key),
    remove: async (key) => {
      await Promise.all([session.remove(key), disk.remove(key)]);
    },
    list: (): Promise<ListedExplanation[]> => session.list(),
    clear: async () => {
      await Promise.all([session.clear(), disk.clear()]);
    },
  };
}
