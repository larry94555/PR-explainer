import {
  applyRating,
  createRatings,
  MAX_RATINGS,
  parseRatings,
  RATINGS_KEY,
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
