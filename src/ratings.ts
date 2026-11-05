// Answer ratings (PR 11.11): a 👍 or 👎 on a finished answer, kept in
// chrome.storage.local under `ratings` as a local, private record of how good
// the answers were, to set against the speed numbers. PR 11.12 shows the
// share of 👍 for each model next to its Speed test time (likedShare and
// formatLiked below), and Export ratings saves them as a file that
// `npm run bench -- --ratings <file>` reads.
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

// --- How often each model's answers were liked (PR 11.12) ---

/** How many of a model's rated answers got 👍, out of how many were rated. */
export interface LikedShare {
  liked: number;
  total: number;
}

/** Below this many ratings the share is too rough to show, so it is a dash. */
export const MIN_RATINGS_FOR_SHARE = 10;

/**
 * The kinds the Speed test and the bench report split the share by. Click,
 * hover and Explain ahead all write the same one-line answer, so they count
 * as one: Line.
 */
export const KIND_GROUPS: readonly { label: string; kinds: readonly AnswerKind[] }[] = [
  { label: 'Line', kinds: ['click', 'hover', 'ahead'] },
  { label: 'Whole hunk', kinds: ['hunk'] },
  { label: 'Chat', kinds: ['chat'] },
];

/**
 * Whether two model names are the same model: Ollama adds ":latest" to a name
 * given without a tag, so "llama3" and "llama3:latest" are one model. (The
 * same rule as isSameModel in src/llm/types.ts, kept here so `npm run bench`
 * can load this file on its own.)
 */
export function sameModel(a: string, b: string): boolean {
  return a === b || a === `${b}:latest` || b === `${a}:latest`;
}

/** The share of 👍 among `model`'s ratings, of the given kinds or of every kind. */
export function likedShare(
  ratings: readonly Rating[],
  model: string,
  kinds?: readonly AnswerKind[],
): LikedShare {
  let liked = 0;
  let total = 0;
  for (const r of ratings) {
    if (!sameModel(r.model, model) || (kinds && !kinds.includes(r.kind))) continue;
    total++;
    if (r.rating === 'up') liked++;
  }
  return { liked, total };
}

/** A model's share overall and for each kind group that has ratings. */
export interface ModelLiked {
  all: LikedShare;
  byKind: { label: string; share: LikedShare }[];
}

export function modelLiked(ratings: readonly Rating[], model: string): ModelLiked {
  return {
    all: likedShare(ratings, model),
    byKind: KIND_GROUPS.map(({ label, kinds }) => ({
      label,
      share: likedShare(ratings, model, kinds),
    })).filter((k) => k.share.total > 0),
  };
}

/**
 * "80% (12)": the share of 👍 and the number of ratings. Under
 * MIN_RATINGS_FOR_SHARE it is "– (4)", and "–" with none.
 */
export function formatLiked({ liked, total }: LikedShare): string {
  if (total === 0) return '–';
  if (total < MIN_RATINGS_FOR_SHARE) return `– (${total})`;
  return `${Math.round((liked / total) * 100)}% (${total})`;
}

/** "Line 75% (8) · Whole hunk – (4)": the share for each kind that has ratings. */
export function formatLikedByKind(liked: ModelLiked): string {
  return liked.byKind.map((k) => `${k.label} ${formatLiked(k.share)}`).join(' · ');
}

// --- Export ratings (PR 11.12) ---

/** What Export ratings saves, and what `npm run bench -- --ratings <file>` reads. */
export interface RatingsExport {
  app: 'pr-explainer';
  kind: 'ratings';
  version: 1;
  exportedAt: string;
  ratings: Rating[];
}

export function ratingsExport(ratings: readonly Rating[], now: Date): RatingsExport {
  return {
    app: 'pr-explainer',
    kind: 'ratings',
    version: 1,
    exportedAt: now.toISOString(),
    ratings: parseRatings(ratings),
  };
}

/** The file name Export ratings suggests, such as pr-explainer-ratings-2026-11-05.json. */
export function ratingsFileName(now: Date): string {
  return `pr-explainer-ratings-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * The ratings in an exported file (or a bare list of ratings), leaving out
 * any that are not valid. Throws when it is neither.
 */
export function parseRatingsExport(value: unknown): Rating[] {
  if (Array.isArray(value)) return parseRatings(value);
  if (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as RatingsExport).ratings)
  )
    return parseRatings((value as RatingsExport).ratings);
  throw new Error('This is not a ratings file. Save one with Export ratings on the settings page.');
}
