// Answer ratings (PR 11.11): a 👍 or 👎 on a finished answer, kept in
// chrome.storage.local under `ratings` as a local, private record of how good
// the answers were, to set against the speed numbers (PR 11.12 shows them
// next to the Speed test).
//
// A rating says which model wrote the answer, what kind of answer it was
// (src/explain's click, hover, ahead or whole hunk; chat is kept for the
// chat panel), how long the answer was and how long the model took, and the
// answer's cache key. It never holds the code or the answer itself: `toRating`
// copies only those fields, whatever it is given. Nothing is sent anywhere.
//
// Each answer shown gets its own id, so changing a rating replaces it and
// taking it back (pressing the same button again) removes it. The 1,000
// newest are kept. The service worker owns the list (src/background.ts): the
// page sends each rating there, so ratings from several tabs are written one
// at a time and none is lost.

/** What kind of answer was rated. */
export type AnswerKind = 'click' | 'hover' | 'ahead' | 'hunk' | 'chat';

export const ANSWER_KINDS: readonly AnswerKind[] = ['click', 'hover', 'ahead', 'hunk', 'chat'];

export type RatingValue = 'up' | 'down';

/** One saved rating. No code, no answer text. */
export interface Rating {
  /** The answer's own id, so rating it again replaces this rating. */
  id: string;
  rating: RatingValue;
  /** The model that wrote the answer, as Ollama named it. */
  model: string;
  kind: AnswerKind;
  /** The answer's length in characters. */
  length: number;
  /** How long the model took to write it, in milliseconds. */
  elapsedMs: number;
  /** The answer's cache key (a SHA-256 hash), when it has one. */
  key?: string;
  /** True when the answer shown came from the cache. */
  cached?: boolean;
  /** When it was rated (Date.now()). */
  ratedAt: number;
}

/** What the page sends: a rating, or `rating: null` to take one back. */
export type RatingUpdate = Omit<Rating, 'rating'> & { rating: RatingValue | null };

export const RATINGS_KEY = 'ratings';
/** The newest this many are kept. */
export const MAX_RATINGS = 1000;

/** The part of chrome.storage.local the ratings use. */
export interface RatingStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Only the fields a rating keeps, checked, or null when one is missing or
 * wrong. Anything else it is given (such as the answer) is left behind.
 */
export function toRating(value: unknown): Rating | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<Rating>;
  if (typeof v.id !== 'string' || !v.id || v.id.length > 100) return null;
  if (v.rating !== 'up' && v.rating !== 'down') return null;
  if (typeof v.model !== 'string' || !v.model) return null;
  if (!ANSWER_KINDS.includes(v.kind as AnswerKind)) return null;
  if (!isCount(v.length) || !isCount(v.elapsedMs) || !isCount(v.ratedAt)) return null;
  return {
    id: v.id,
    rating: v.rating,
    model: v.model.slice(0, 200),
    kind: v.kind as AnswerKind,
    length: Math.round(v.length),
    elapsedMs: Math.round(v.elapsedMs),
    ...(typeof v.key === 'string' && /^[0-9a-f]{1,128}$/.test(v.key) && { key: v.key }),
    ...(v.cached === true && { cached: true }),
    ratedAt: v.ratedAt,
  };
}

/** The saved ratings, oldest first, leaving out any that are not valid. */
export function parseRatings(value: unknown): Rating[] {
  if (!Array.isArray(value)) return [];
  return value.map(toRating).filter((r): r is Rating => r !== null);
}

/**
 * `list` with `update` applied: its rating replaces any with the same id (and
 * goes last, as the newest), or is removed when `rating` is null. The newest
 * MAX_RATINGS are kept.
 */
export function applyRating(list: readonly Rating[], update: RatingUpdate): Rating[] {
  const others = list.filter((r) => r.id !== update.id);
  if (update.rating === null) return others;
  const rating = toRating(update);
  if (!rating) return others;
  return [...others, rating].slice(-MAX_RATINGS);
}

export interface Ratings {
  /** Saves, changes or takes back one rating, and returns how many are kept. */
  rate(update: RatingUpdate): Promise<number>;
  /** Every rating, oldest first. */
  list(): Promise<Rating[]>;
  /** Removes every rating (the settings page's Clear ratings). */
  clear(): Promise<void>;
}

/** The ratings in `storage`, written one change at a time. */
export function createRatings(storage: RatingStorage): Ratings {
  // Each change waits for the one before, so none overwrites another.
  let last: Promise<unknown> = Promise.resolve();
  const queued = <T>(change: () => Promise<T>): Promise<T> => {
    const next = last.then(change, change);
    last = next.catch(() => {});
    return next;
  };
  const list = async () => parseRatings((await storage.get([RATINGS_KEY]))[RATINGS_KEY]);
  return {
    rate: (update) =>
      queued(async () => {
        if (update.rating !== null && !toRating(update)) throw new Error('Not a valid rating.');
        const next = applyRating(await list(), update);
        await storage.set({ [RATINGS_KEY]: next });
        return next.length;
      }),
    list: () => queued(list),
    clear: () => queued(() => storage.set({ [RATINGS_KEY]: [] })),
  };
}
