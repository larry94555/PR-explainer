import {
  applyRating,
  createRatings,
  formatLiked,
  formatLikedByKind,
  KIND_GROUPS,
  likedShare,
  MAX_RATINGS,
  MIN_RATINGS_FOR_SHARE,
  modelLiked,
  parseRatings,
  parseRatingsExport,
  RATINGS_KEY,
  ratingsExport,
  ratingsFileName,
  sameModel,
  toRating,
  type Rating,
  type RatingStorage,
  type RatingUpdate,
} from '../src/ratings';

/** A fake chrome.storage.local that copies values in and out as Chrome does. */
function fakeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = structuredClone(initial);
  const storage: RatingStorage & { data: Record<string, unknown> } = {
    data,
    get: vi.fn(async (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
    ),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, structuredClone(items));
    }),
  };
  return storage;
}

const KEY = 'a'.repeat(64);

const update = (over: Partial<RatingUpdate> = {}): RatingUpdate => ({
  id: 'answer-1',
  rating: 'up',
  model: 'qwen2.5-coder:7b',
  kind: 'click',
  length: 412,
  elapsedMs: 1830,
  key: KEY,
  ratedAt: 1_700_000_000_000,
  ...over,
});

describe('toRating', () => {
  it('keeps only the rating fields, never the code or the answer', () => {
    const given = {
      ...update({ cached: true }),
      explanation: { what: 'Adds two numbers', why: 'x', concerns: 'y' },
      context: 'const sum = a + b;',
      answer: 'Adds two numbers',
    };
    const rating = toRating(given)!;
    expect(rating).toEqual({
      id: 'answer-1',
      rating: 'up',
      model: 'qwen2.5-coder:7b',
      kind: 'click',
      length: 412,
      elapsedMs: 1830,
      key: KEY,
      cached: true,
      ratedAt: 1_700_000_000_000,
    });
    const saved = JSON.stringify(rating);
    expect(saved).not.toContain('a + b');
    expect(saved).not.toContain('Adds two numbers');
  });

  it('refuses a rating with a field missing or wrong', () => {
    expect(toRating(update())).not.toBeNull();
    expect(toRating(update({ rating: null }))).toBeNull();
    expect(toRating({ ...update(), rating: 'meh' })).toBeNull();
    expect(toRating(update({ id: '' }))).toBeNull();
    expect(toRating(update({ model: '' }))).toBeNull();
    expect(toRating({ ...update(), kind: 'guess' })).toBeNull();
    expect(toRating(update({ length: -1 }))).toBeNull();
    expect(toRating(update({ elapsedMs: Number.NaN }))).toBeNull();
    expect(toRating(null)).toBeNull();
    expect(toRating('up')).toBeNull();
  });

  it('leaves out a key that is not a hash', () => {
    expect(toRating(update({ key: 'const x = 1' }))).not.toHaveProperty('key');
    expect(toRating(update({ key: undefined }))).not.toHaveProperty('key');
  });

  it('accepts every kind of answer', () => {
    for (const kind of ['click', 'hover', 'ahead', 'hunk', 'chat'] as const) {
      expect(toRating(update({ kind }))?.kind).toBe(kind);
    }
  });
});

describe('parseRatings', () => {
  it('reads a saved list and skips anything not a rating', () => {
    expect(parseRatings(undefined)).toEqual([]);
    expect(parseRatings('nope')).toEqual([]);
    expect(parseRatings([update(), { id: 'x' }, update({ id: 'answer-2' })])).toHaveLength(2);
  });
});

describe('applyRating', () => {
  const first = toRating(update())!;

  it('adds a new rating last', () => {
    const second = update({ id: 'answer-2', rating: 'down' });
    expect(applyRating([first], second).map((r) => [r.id, r.rating])).toEqual([
      ['answer-1', 'up'],
      ['answer-2', 'down'],
    ]);
  });

  it('changes a rating: the new one replaces the old and goes last', () => {
    const other = toRating(update({ id: 'answer-2' }))!;
    const changed = applyRating([first, other], update({ rating: 'down', ratedAt: 2 }));
    expect(changed.map((r) => [r.id, r.rating])).toEqual([
      ['answer-2', 'up'],
      ['answer-1', 'down'],
    ]);
  });

  it('takes a rating back when it is null', () => {
    expect(applyRating([first], update({ rating: null }))).toEqual([]);
  });

  it('keeps the 1,000 newest', () => {
    const many: Rating[] = Array.from({ length: MAX_RATINGS }, (_, i) =>
      toRating(update({ id: `answer-${i}` }))!,
    );
    const next = applyRating(many, update({ id: 'newest' }));
    expect(next).toHaveLength(MAX_RATINGS);
    expect(next[0]!.id).toBe('answer-1');
    expect(next.at(-1)!.id).toBe('newest');
  });
});

describe('createRatings', () => {
  it('saves a rating in chrome.storage.local with the right fields and no code or text', async () => {
    const storage = fakeStorage();
    const ratings = createRatings(storage);
    const kept = await ratings.rate({
      ...update(),
      // Even if a caller passed the answer, it is not saved.
      ...({ explanation: { what: 'secret answer' }, context: 'secret code' } as object),
    });
    expect(kept).toBe(1);
    expect(storage.data[RATINGS_KEY]).toEqual([toRating(update())]);
    const saved = JSON.stringify(storage.data);
    expect(saved).not.toContain('secret');
  });

  it('changes a rating, and takes it back', async () => {
    const storage = fakeStorage();
    const ratings = createRatings(storage);
    await ratings.rate(update());
    await ratings.rate(update({ rating: 'down' }));
    expect((await ratings.list()).map((r) => r.rating)).toEqual(['down']);
    expect(await ratings.rate(update({ rating: null }))).toBe(0);
    expect(await ratings.list()).toEqual([]);
  });

  it('writes one change at a time, so ratings sent together are all kept', async () => {
    const storage = fakeStorage();
    const ratings = createRatings(storage);
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => ratings.rate(update({ id: `answer-${i}` }))),
    );
    expect((await ratings.list()).map((r) => r.id)).toEqual([
      'answer-0',
      'answer-1',
      'answer-2',
      'answer-3',
      'answer-4',
    ]);
  });

  it('refuses a rating that is not valid and saves nothing', async () => {
    const storage = fakeStorage();
    const ratings = createRatings(storage);
    await expect(ratings.rate({ ...update(), kind: 'guess' } as never)).rejects.toThrow(
      'Not a valid rating.',
    );
    expect(storage.set).not.toHaveBeenCalled();
    // The next one still goes through.
    await ratings.rate(update());
    expect(await ratings.list()).toHaveLength(1);
  });

  it('Clear ratings empties the list', async () => {
    const storage = fakeStorage({ [RATINGS_KEY]: [update(), update({ id: 'answer-2' })] });
    const ratings = createRatings(storage);
    expect(await ratings.list()).toHaveLength(2);
    await ratings.clear();
    expect(storage.data[RATINGS_KEY]).toEqual([]);
    expect(await ratings.list()).toEqual([]);
  });
});

describe('how often answers were liked (PR 11.12)', () => {
  let n = 0;
  const rated = (
    model: string,
    up: number,
    down: number,
    kind: Rating['kind'] = 'click',
  ): Rating[] =>
    [...Array(up + down)].map((_, i) => ({
      id: `r${n++}`,
      rating: i < up ? 'up' : 'down',
      model,
      kind,
      length: 100,
      elapsedMs: 900,
      ratedAt: n,
    }));

  const list = [
    ...rated('qwen2.5-coder:7b', 6, 2, 'click'),
    ...rated('qwen2.5-coder:7b', 1, 1, 'hover'),
    ...rated('qwen2.5-coder:7b', 1, 0, 'ahead'),
    ...rated('qwen2.5-coder:7b', 1, 3, 'hunk'),
    ...rated('qwen2.5-coder:7b', 2, 0, 'chat'),
    ...rated('qwen2.5-coder:1.5b', 3, 1),
  ];

  it('counts the 👍 for one model, of every kind or of some', () => {
    expect(likedShare(list, 'qwen2.5-coder:7b')).toEqual({ liked: 11, total: 17 });
    expect(likedShare(list, 'qwen2.5-coder:7b', ['hunk'])).toEqual({ liked: 1, total: 4 });
    expect(likedShare(list, 'qwen2.5-coder:1.5b')).toEqual({ liked: 3, total: 4 });
    expect(likedShare(list, 'llama3.2:3b')).toEqual({ liked: 0, total: 0 });
    expect(likedShare([], 'qwen2.5-coder:7b')).toEqual({ liked: 0, total: 0 });
  });

  it('splits by kind, with click, hover and ahead counted as one line', () => {
    expect(KIND_GROUPS.map((k) => k.label)).toEqual(['Line', 'Whole hunk', 'Chat']);
    expect(modelLiked(list, 'qwen2.5-coder:7b')).toEqual({
      all: { liked: 11, total: 17 },
      byKind: [
        { label: 'Line', share: { liked: 8, total: 11 } },
        { label: 'Whole hunk', share: { liked: 1, total: 4 } },
        { label: 'Chat', share: { liked: 2, total: 2 } },
      ],
    });
    // Kinds with no ratings are left out.
    expect(modelLiked(list, 'qwen2.5-coder:1.5b').byKind).toEqual([
      { label: 'Line', share: { liked: 3, total: 4 } },
    ]);
  });

  it(`shows the share from ${MIN_RATINGS_FOR_SHARE} ratings, and a dash with the count under that`, () => {
    expect(MIN_RATINGS_FOR_SHARE).toBe(10);
    expect(formatLiked({ liked: 0, total: 0 })).toBe('–');
    expect(formatLiked({ liked: 9, total: 9 })).toBe('– (9)');
    expect(formatLiked({ liked: 7, total: 10 })).toBe('70% (10)');
    expect(formatLiked({ liked: 11, total: 17 })).toBe('65% (17)');
    expect(formatLiked({ liked: 0, total: 12 })).toBe('0% (12)');
    expect(formatLikedByKind(modelLiked(list, 'qwen2.5-coder:7b'))).toBe(
      'Line 73% (11) · Whole hunk – (4) · Chat – (2)',
    );
  });

  it('treats a model name without a tag as its :latest', () => {
    expect(sameModel('llama3', 'llama3:latest')).toBe(true);
    expect(sameModel('llama3:latest', 'llama3')).toBe(true);
    expect(sameModel('llama3:8b', 'llama3')).toBe(false);
    expect(likedShare(rated('llama3', 2, 0), 'llama3:latest')).toEqual({ liked: 2, total: 2 });
  });
});

describe('Export ratings (PR 11.12)', () => {
  const now = new Date(Date.UTC(2026, 10, 5, 7, 0));
  const saved = [toRating(update())!, toRating(update({ id: 'answer-2', rating: 'down' }))!];

  it('names the file by the date', () => {
    expect(ratingsFileName(now)).toBe('pr-explainer-ratings-2026-11-05.json');
  });

  it('saves the ratings with what the file is, and reads them back', () => {
    const file = ratingsExport(saved, now);
    expect(file).toEqual({
      app: 'pr-explainer',
      kind: 'ratings',
      version: 1,
      exportedAt: '2026-11-05T07:00:00.000Z',
      ratings: saved,
    });
    expect(parseRatingsExport(JSON.parse(JSON.stringify(file)))).toEqual(saved);
  });

  it('holds only the rating fields, never an answer', () => {
    const withText = { ...saved[0]!, answer: 'secret', code: 'const x = 1;' } as Rating;
    const text = JSON.stringify(ratingsExport([withText], now));
    expect(text).not.toContain('secret');
    expect(text).not.toContain('const x');
  });

  it('reads a bare list too, leaving out ratings that are not valid', () => {
    expect(parseRatingsExport([saved[0], { id: 'x', rating: 'meh' }])).toEqual([saved[0]]);
  });

  it('refuses a file that is not a ratings file', () => {
    for (const bad of [null, 3, 'text', { answers: [] }]) {
      expect(() => parseRatingsExport(bad)).toThrow('This is not a ratings file.');
    }
  });
});
