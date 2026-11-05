import {
  CACHE_INDEX_KEY,
  CACHE_STORAGE_KEY,
  createExplainCache,
  DEFAULT_MAX_BYTES,
  entryStorageKey,
  explainCacheKey,
  type CachedExplanation,
  type SessionStorageLike,
} from '../src/explain/explainCache';
import { createExplainHandler } from '../src/explain/explainHandler';
import { buildExplainPrompt } from '../src/explain/explainPrompt';
import type { ChatStreamEnd, LlmClient } from '../src/llm/types';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';

/** An in-memory chrome.storage.session that copies values like Chrome does. */
function fakeSession(): SessionStorageLike & {
  data: Record<string, unknown>;
  writes: string[][];
  bytes: () => number;
} {
  const data: Record<string, unknown> = {};
  const writes: string[][] = [];
  return {
    data,
    // The keys of each set() call, in order.
    writes,
    // What Chrome counts against its quota: each key plus its value as JSON.
    bytes: () =>
      Object.entries(data).reduce(
        (sum, [k, v]) => sum + new TextEncoder().encode(k + JSON.stringify(v)).length,
        0,
      ),
    get: async (keys) =>
      Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
    set: async (items) => {
      writes.push(Object.keys(items));
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    },
    remove: async (keys) => {
      for (const k of keys) delete data[k];
    },
  };
}

/** The keys the index lists, least recently used first. */
const indexKeys = (storage: { data: Record<string, unknown> }) =>
  (storage.data[CACHE_INDEX_KEY] as [string][]).map((row) => row[0]);

function entry(what: string, model = 'qwen2.5-coder:7b'): CachedExplanation {
  return {
    explanation: { what, why: 'Because.', concerns: 'None found.' },
    model,
    elapsedMs: 9800,
    savedAt: 1_700_000_000_000,
  };
}

describe('explainCacheKey', () => {
  const parts = {
    pr: 'owner/repo#17',
    model: 'qwen2.5-coder:7b',
    temperature: 0.2,
    maxResponseTokens: 1024,
    messages: buildExplainPrompt('File: a.ts\n+x'),
  };

  it('is a fixed-length hex hash that stays the same for the same input', async () => {
    const key = await explainCacheKey(parts);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await explainCacheKey({ ...parts })).toBe(key);
  });

  it('changes with the PR, the model, the generation settings, or the prompt', async () => {
    const key = await explainCacheKey(parts);
    const others = [
      { ...parts, pr: 'owner/repo#18' },
      { ...parts, model: 'llama3.2:3b' },
      { ...parts, temperature: 0.7 },
      { ...parts, maxResponseTokens: 2048 },
      // New code around the line (a new commit).
      { ...parts, messages: buildExplainPrompt('File: a.ts\n+y') },
      // Same code, new instructions (a later build changed the prompt).
      {
        ...parts,
        messages: [{ role: 'system' as const, content: 'New rules.' }, ...parts.messages.slice(1)],
      },
    ];
    for (const other of others) expect(await explainCacheKey(other)).not.toBe(key);
  });

  it('changes when Let the model think is on, and stays as before when it is off (PR 9.5)', async () => {
    const key = await explainCacheKey(parts);
    expect(await explainCacheKey({ ...parts, letModelThink: false })).toBe(key);
    expect(await explainCacheKey({ ...parts, letModelThink: true })).not.toBe(key);
  });

  it('does not mix up parts that run together', async () => {
    expect(await explainCacheKey({ ...parts, pr: 'a', model: 'bc' })).not.toBe(
      await explainCacheKey({ ...parts, pr: 'ab', model: 'c' }),
    );
  });
});

describe('explain cache', () => {
  /** A clock that moves 1 ms per call, so every use has its own time. */
  const clock = (start = 5_000) => {
    let t = start;
    return () => t++;
  };
  /**
   * A size limit that fits `n` of the answers these tests save (keys of up to
   * 6 letters, short sections) with the index, but not one more.
   */
  const limitFor = async (n: number) => {
    const storage = fakeSession();
    const cache = createExplainCache(storage);
    for (let i = 0; i < n; i++) await cache.set(`xxxxx${i}`, entry('Three.'), 'o/r#1');
    return storage.bytes() + 20;
  };

  it('returns null on a miss and the saved answer on a hit', async () => {
    const cache = createExplainCache(fakeSession());
    expect(await cache.get('k1')).toBeNull();
    await cache.set('k1', entry('One.'), 'o/r#1');
    expect(await cache.get('k1')).toEqual(entry('One.'));
    expect(await cache.get('k2')).toBeNull();
  });

  it('stores each answer under its own key, and a save writes only that answer and the index', async () => {
    const storage = fakeSession();
    const cache = createExplainCache(storage);
    await cache.set('k1', entry('One.'), 'o/r#1');
    await cache.set('k2', entry('Two.'), 'o/r#1');
    expect(storage.writes.at(-1)!.sort()).toEqual([CACHE_INDEX_KEY, entryStorageKey('k2')].sort());
    expect(storage.data[entryStorageKey('k1')]).toEqual(entry('One.'));
    expect(storage.data[entryStorageKey('k2')]).toEqual(entry('Two.'));
    expect(storage.data[CACHE_STORAGE_KEY]).toBeUndefined();
    const [row] = storage.data[CACHE_INDEX_KEY] as unknown[][];
    expect(row).toEqual(['k1', 'o/r#1', expect.any(Number), expect.any(Number)]);
  });

  it('a hit updates its last-used time and writes only the index', async () => {
    const storage = fakeSession();
    const cache = createExplainCache(storage, { now: clock(100) });
    await cache.set('k1', entry('One.'), 'o/r#1');
    await cache.set('k2', entry('Two.'), 'o/r#1');
    const writes = storage.writes.length;
    await cache.get('k1');
    expect(storage.writes.slice(writes)).toEqual([[CACHE_INDEX_KEY]]);
    expect(storage.data[CACHE_INDEX_KEY]).toEqual([
      ['k2', 'o/r#1', expect.any(Number), 101],
      ['k1', 'o/r#1', expect.any(Number), 102],
    ]);
  });

  it('replaces an answer saved again under the same key', async () => {
    const storage = fakeSession();
    const cache = createExplainCache(storage);
    await cache.set('k1', entry('Old.'), 'o/r#1');
    await cache.set('k1', entry('New.'), 'o/r#1');
    expect(await cache.get('k1')).toEqual(entry('New.'));
    expect(indexKeys(storage)).toEqual(['k1']);
  });

  it('removes the least recently used answers past the size limit', async () => {
    const storage = fakeSession();
    const cache = createExplainCache(storage, { maxBytes: await limitFor(2), now: clock() });
    await cache.set('k1', entry('One.'), 'o/r#1');
    await cache.set('k2', entry('Two.'), 'o/r#1');
    await cache.set('k3', entry('Three.'), 'o/r#1');
    expect(indexKeys(storage)).toEqual(['k2', 'k3']);
    expect(storage.data).not.toHaveProperty(entryStorageKey('k1'));
    expect(await cache.get('k1')).toBeNull();
    expect(storage.bytes()).toBeLessThanOrEqual(await limitFor(2));
  });

  it('keeps an answer that was just used when the limit is reached', async () => {
    const storage = fakeSession();
    const cache = createExplainCache(storage, { maxBytes: await limitFor(2), now: clock() });
    await cache.set('k1', entry('One.'), 'o/r#1');
    await cache.set('k2', entry('Two.'), 'o/r#1');
    await cache.get('k1');
    await cache.set('k3', entry('Three.'), 'o/r#1');
    expect(await cache.get('k1')).not.toBeNull();
    expect(await cache.get('k2')).toBeNull();
  });

  it("removes other PRs' answers before the open PR's, even if they were used more recently", async () => {
    const storage = fakeSession();
    const cache = createExplainCache(storage, { maxBytes: await limitFor(2), now: clock() });
    await cache.set('open1', entry('One.'), 'o/r#1');
    await cache.set('closed', entry('Two.'), 'o/r#2');
    await cache.set('open2', entry('Three.'), 'o/r#1');
    expect(indexKeys(storage)).toEqual(['open1', 'open2']);
    // With no other PR left, the open PR's oldest goes, never the one being saved.
    await cache.set('open3', entry('Four.'), 'o/r#1');
    expect(indexKeys(storage)).toEqual(['open2', 'open3']);
  });

  it("makes room before saving, so a write never passes Chrome's 10 MB quota on the way", async () => {
    const QUOTA = 10 * 1024 * 1024;
    const storage = fakeSession();
    const { set } = storage;
    // Like Chrome: a write that would leave more than the quota in storage fails.
    storage.set = async (items) => {
      const after = { ...storage.data, ...items };
      const total = Object.entries(after).reduce(
        (sum, [k, v]) => sum + new TextEncoder().encode(k + JSON.stringify(v)).length,
        0,
      );
      if (total > QUOTA) throw new Error('QUOTA_BYTES quota exceeded');
      await set(items);
    };
    const cache = createExplainCache(storage, { now: clock() });
    const MB = 1024 * 1024;
    // About 8 MB of answers already saved, from another PR.
    for (let i = 0; i < 8; i++) await cache.set(`old${i}`, entry('o'.repeat(MB - 400)), 'o/r#2');
    expect(storage.bytes()).toBeGreaterThan(7.9 * MB);
    const big = entry('n'.repeat(3 * MB));
    await cache.set('new', big, 'o/r#1');
    expect(await cache.get('new')).toEqual(big);
    // The oldest went, and the index lists exactly what is stored.
    expect(indexKeys(storage)).toEqual(['old3', 'old4', 'old5', 'old6', 'old7', 'new']);
    expect(Object.keys(storage.data).sort()).toEqual(
      [CACHE_INDEX_KEY, ...indexKeys(storage).map(entryStorageKey)].sort(),
    );
    expect(storage.bytes()).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  });

  it('a save that fails after making room leaves the index naming only stored answers', async () => {
    const storage = fakeSession();
    const cache = createExplainCache(storage, { maxBytes: await limitFor(2), now: clock() });
    await cache.set('k1', entry('One.'), 'o/r#1');
    await cache.set('k2', entry('Two.'), 'o/r#1');
    const { set } = storage;
    storage.set = async (items) => {
      if (entryStorageKey('k3') in items) throw new Error('quota');
      await set(items);
    };
    await expect(cache.set('k3', entry('Three.'), 'o/r#1')).rejects.toThrow('quota');
    expect(indexKeys(storage)).toEqual(['k2']);
    expect(Object.keys(storage.data).sort()).toEqual(
      [CACHE_INDEX_KEY, entryStorageKey('k2')].sort(),
    );
    storage.set = set;
    expect(await cache.get('k2')).not.toBeNull();
    expect(await cache.get('k3')).toBeNull();
  });

  it('does not keep an answer too big to ever fit', async () => {
    const storage = fakeSession();
    const cache = createExplainCache(storage, { maxBytes: await limitFor(2) });
    await cache.set('k1', entry('One.'), 'o/r#1');
    await cache.set('big', entry('x'.repeat(1000)), 'o/r#1');
    expect(await cache.get('big')).toBeNull();
    expect(await cache.get('k1')).not.toBeNull();
  });

  it('keeps 2,000 answers of about 1 KB under the default limit, and stays under a smaller one', async () => {
    const answer = (i: number) => entry(`Line ${i}: ${'a'.repeat(900)}`);
    const storage = fakeSession();
    const cache = createExplainCache(storage);
    for (let i = 0; i < 2000; i++) await cache.set(`k${i}`, answer(i), 'o/r#1');
    expect(indexKeys(storage)).toHaveLength(2000);
    expect(storage.bytes()).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(await cache.get('k0')).toEqual(answer(0));

    const small = fakeSession();
    const limited = createExplainCache(small, { maxBytes: 500_000 });
    for (let i = 0; i < 2000; i++) await limited.set(`k${i}`, answer(i), `o/r#${i % 3}`);
    expect(small.bytes()).toBeLessThanOrEqual(500_000);
    expect(indexKeys(small).length).toBeGreaterThan(300);
    // Every answer the index lists is stored, and nothing else is.
    expect(Object.keys(small.data).sort()).toEqual(
      [CACHE_INDEX_KEY, ...indexKeys(small).map(entryStorageKey)].sort(),
    );
    expect(await limited.get('k1999')).toEqual(answer(1999));
  }, 20_000);

  it('keeps both answers when two are saved at the same moment', async () => {
    const cache = createExplainCache(fakeSession());
    await Promise.all([cache.set('k1', entry('One.')), cache.set('k2', entry('Two.'))]);
    expect(await cache.get('k1')).not.toBeNull();
    expect(await cache.get('k2')).not.toBeNull();
  });

  it('moves answers in the old single-key format over once and removes the old key', async () => {
    const storage = fakeSession();
    storage.data[CACHE_STORAGE_KEY] = [
      { key: 'old1', ...entry('One.') },
      { key: 'old2', ...entry('Two.') },
      { key: 'broken', explanation: 'not an object' },
    ];
    const cache = createExplainCache(storage, { now: clock(10_000) });
    expect(await cache.get('old1')).toEqual(entry('One.'));
    expect(storage.data).not.toHaveProperty(CACHE_STORAGE_KEY);
    expect(storage.data[entryStorageKey('old2')]).toEqual(entry('Two.'));
    expect(indexKeys(storage)).toEqual(['old2', 'old1']);
    expect(await cache.get('broken')).toBeNull();

    // Moved over once: a new cache on the same storage does not do it again.
    const writes = storage.writes.length;
    const again = createExplainCache(storage);
    expect(await again.get('old2')).toEqual(entry('Two.'));
    expect(storage.writes.slice(writes)).toEqual([[CACHE_INDEX_KEY]]);
  });

  it('removes moved-over answers (they have no PR) before newer ones', async () => {
    const storage = fakeSession();
    storage.data[CACHE_STORAGE_KEY] = [{ key: 'old', ...entry('One.') }];
    const cache = createExplainCache(storage, { maxBytes: await limitFor(2), now: clock() });
    await cache.set('new1', entry('Two.'), 'o/r#1');
    await cache.set('new2', entry('Three.'), 'o/r#1');
    expect(indexKeys(storage)).toEqual(['new1', 'new2']);
  });

  it('ignores stored values in an unexpected shape', async () => {
    const storage = fakeSession();
    storage.data[CACHE_INDEX_KEY] = [['k1', 'o/r#1', 10, 1], 'garbage', ['k2']];
    storage.data[entryStorageKey('k1')] = { explanation: 'not an object' };
    const cache = createExplainCache(storage);
    expect(await cache.get('k1')).toBeNull();
    expect(await cache.get('k2')).toBeNull();
    // The broken answer is forgotten.
    expect(storage.data[CACHE_INDEX_KEY]).toEqual([]);
    await cache.set('k3', entry('Three.'), 'o/r#1');
    expect(await cache.get('k3')).toEqual(entry('Three.'));

    const garbage = fakeSession();
    garbage.data[CACHE_INDEX_KEY] = 'garbage';
    garbage.data[CACHE_STORAGE_KEY] = 'garbage';
    const fresh = createExplainCache(garbage);
    await fresh.set('k1', entry('One.'));
    expect(await fresh.get('k1')).toEqual(entry('One.'));
    expect(garbage.data).not.toHaveProperty(CACHE_STORAGE_KEY);
  });

  it('a hit whose answer is missing from storage is a miss', async () => {
    const storage = fakeSession();
    const cache = createExplainCache(storage);
    await cache.set('k1', entry('One.'), 'o/r#1');
    delete storage.data[entryStorageKey('k1')];
    expect(await cache.get('k1')).toBeNull();
    expect(indexKeys(storage)).toEqual([]);
  });

  it('keeps working after a storage call fails', async () => {
    const storage = fakeSession();
    const cache = createExplainCache(storage);
    const { get, set, remove } = storage;
    storage.get = () => Promise.reject(new Error('broken'));
    await expect(cache.get('k1')).rejects.toThrow('broken');
    storage.get = get;
    storage.set = () => Promise.reject(new Error('quota'));
    await expect(cache.set('k1', entry('One.'))).rejects.toThrow('quota');
    // A failed save is not listed in the index.
    expect(await cache.get('k1')).toBeNull();
    storage.set = set;
    await cache.set('k1', entry('One.'));
    // A failed write on a hit still returns the answer.
    storage.set = () => Promise.reject(new Error('quota'));
    expect(await cache.get('k1')).toEqual(entry('One.'));
    storage.set = set;
    // A failed removal of old answers does not fail the save.
    storage.remove = () => Promise.reject(new Error('broken'));
    const small = createExplainCache(storage, { maxBytes: await limitFor(1) });
    await small.set('k2', entry('Two.'));
    expect(await small.get('k2')).toEqual(entry('Two.'));
    storage.remove = remove;
  });

  it('lists every answer with its PR, size and last use, least recently used first', async () => {
    const cache = createExplainCache(fakeSession(), { now: clock(1) });
    await cache.set('k1', entry('One.'), 'o/r#1');
    await cache.set('k2', entry('Two.'), 'o/r#2');
    await cache.get('k1');
    expect(await cache.list()).toEqual([
      { key: 'k2', pr: 'o/r#2', size: expect.any(Number), usedAt: 2, ...entry('Two.') },
      { key: 'k1', pr: 'o/r#1', size: expect.any(Number), usedAt: 3, ...entry('One.') },
    ]);
  });
});

describe('explain handler with the cache', () => {
  const SETTINGS: Settings = { ...DEFAULT_SETTINGS, model: 'qwen2.5-coder:7b' };
  const REPLY = "## What it does\nAdds one.\n## Why it's needed\nTests.\n## Concerns\nNone.";

  function setup(settings: Settings = SETTINGS) {
    const storage = fakeSession();
    let time = 1000;
    const chatStream = vi.fn(async function* (): AsyncGenerator<string, ChatStreamEnd, undefined> {
      time += 9800; // the model takes 9.8 s
      yield REPLY;
      return { model: settings.model, doneReason: 'stop', timings: { totalMs: 9_700 } };
    });
    const client: LlmClient = {
      listModels: vi.fn(),
      loadedModels: vi.fn(),
      loadedContextTokens: vi.fn(async () => undefined),
      runningModels: vi.fn(async () => []),
      loadModel: vi.fn(),
      modelContext: vi.fn(),
      chat: vi.fn(),
      chatStream,
    };
    let current = settings;
    const handler = createExplainHandler({
      getSettings: async () => current,
      createClient: () => client,
      platform: 'windows',
      cache: createExplainCache(storage),
      now: () => time,
    });
    return {
      handler,
      chatStream,
      storage,
      useSettings: (next: Settings) => (current = next),
    };
  }

  const payload = { context: 'File: a.ts\n+x', pr: 'owner/repo#17' };

  it('asks the model on a miss, then answers from the cache with the first time taken', async () => {
    const { handler, chatStream } = setup();
    const first = await handler(payload);
    expect(first).toMatchObject({ status: 'done', model: 'qwen2.5-coder:7b' });
    expect(first).not.toHaveProperty('cached');
    // Where the time went is only shown for an answer from the model (PR 8.1).
    expect(first).toHaveProperty('timings', { totalMs: 9_700 });

    const onChunk = vi.fn();
    const second = await handler(payload, { onChunk });
    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(onChunk).not.toHaveBeenCalled();
    expect(second).toEqual({
      ...first,
      timings: undefined,
      cached: { elapsedMs: 9800, savedAt: 10_800, kind: 'click' },
      // A cached answer's trace has no model task (PR 9.1).
      trace: expect.objectContaining({ totalMs: 0 }),
    });
    const keys = second.trace!.tasks.map((t) => t.key);
    expect(keys).toContain('cache');
    expect(keys).not.toContain('model');
  });

  it("marks an answer Explain ahead wrote as prefetched, and a click's not (PR 10.7)", async () => {
    const { handler, chatStream } = setup();
    await handler({ ...payload, cause: 'ahead' });
    const click = await handler(payload);
    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(click).toMatchObject({ cached: { elapsedMs: 9800, prefetched: true } });
    // Regenerate writes it again for the click, so it is no longer prefetched.
    await handler({ ...payload, fresh: true });
    const again = await handler(payload);
    expect(again.status === 'done' && again.cached).toEqual({
      elapsedMs: expect.any(Number),
      savedAt: expect.any(Number),
      kind: 'click',
    });
    // Explain on hover is not background work.
    await handler({ ...payload, context: 'File: a.ts\n+y', cause: 'hover' });
    const hovered = await handler({ ...payload, context: 'File: a.ts\n+y' });
    expect(hovered.status === 'done' && hovered.cached).not.toHaveProperty('prefetched');
  });

  it('saves what wrote each answer and returns its cache key, for ratings (PR 11.11)', async () => {
    const { handler } = setup();
    const fresh = await handler(payload);
    // The key is a SHA-256 hash, the same for the cached answer.
    const key = fresh.status === 'done' ? fresh.key : undefined;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const click = await handler(payload);
    expect(click).toMatchObject({ key, cached: { kind: 'click' } });
    for (const cause of ['hover', 'ahead'] as const) {
      const context = `File: a.ts\n+${cause}`;
      await handler({ ...payload, context, cause });
      expect(await handler({ ...payload, context })).toMatchObject({ cached: { kind: cause } });
    }
  });

  it('returns no cache key when the answer is not cached', async () => {
    const { handler } = setup();
    expect(await handler({ context: payload.context })).not.toHaveProperty('key');
  });

  it("saves the answer under the request's PR, so it is the open PR's (PR 10.2)", async () => {
    const { handler, storage } = setup();
    await handler(payload);
    expect(storage.data[CACHE_INDEX_KEY]).toEqual([
      [expect.any(String), 'owner/repo#17', expect.any(Number), expect.any(Number)],
    ]);
  });

  it('misses for a different model', async () => {
    const { handler, chatStream, useSettings } = setup();
    await handler(payload);
    useSettings({ ...SETTINGS, model: 'llama3.2:3b' });
    const result = await handler(payload);
    expect(chatStream).toHaveBeenCalledTimes(2);
    expect(result).not.toHaveProperty('cached');
  });

  it('misses when the temperature or response limit changed, and hits when they did not', async () => {
    const { handler, chatStream, useSettings } = setup();
    await handler(payload);
    useSettings({ ...SETTINGS, temperature: 0.8 });
    expect(await handler(payload)).not.toHaveProperty('cached');
    useSettings({ ...SETTINGS, maxResponseTokens: 2048 });
    expect(await handler(payload)).not.toHaveProperty('cached');
    expect(chatStream).toHaveBeenCalledTimes(3);
    // Back to the first settings (a fresh copy): the first answer is still there.
    useSettings({ ...SETTINGS });
    expect(await handler(payload)).toHaveProperty('cached');
    expect(chatStream).toHaveBeenCalledTimes(3);
  });

  it('misses when the code around the line changed (a new commit)', async () => {
    const { handler, chatStream } = setup();
    await handler(payload);
    await handler({ ...payload, context: 'File: a.ts\n+x + 1' });
    expect(chatStream).toHaveBeenCalledTimes(2);
  });

  it('misses for the same code in another PR', async () => {
    const { handler, chatStream } = setup();
    await handler(payload);
    await handler({ ...payload, pr: 'owner/repo#18' });
    expect(chatStream).toHaveBeenCalledTimes(2);
  });

  it('misses when the PR description changed, and hits when it did not (PR 6.1)', async () => {
    const { handler, chatStream } = setup();
    const prInfo = { title: 'Add retries', description: 'Retry failed calls.' };
    await handler({ ...payload, prInfo });
    expect(await handler({ ...payload, prInfo: { ...prInfo } })).toHaveProperty('cached');
    await handler({ ...payload, prInfo: { ...prInfo, description: 'Retry twice.' } });
    expect(chatStream).toHaveBeenCalledTimes(2);
  });

  it('Regenerate (fresh) skips the cache and saves the new answer', async () => {
    const { handler, chatStream } = setup();
    await handler(payload);
    const fresh = await handler({ ...payload, fresh: true });
    expect(chatStream).toHaveBeenCalledTimes(2);
    expect(fresh).not.toHaveProperty('cached');
    const after = await handler(payload);
    expect(chatStream).toHaveBeenCalledTimes(2);
    expect(after).toMatchObject({ cached: { savedAt: 20_600 } });
  });

  it('does not cache failures or requests without a PR', async () => {
    const { handler, chatStream, storage } = setup();
    chatStream.mockImplementationOnce(async function* () {
      yield* [];
      throw new Error('fetch failed');
    });
    expect(await handler(payload)).toMatchObject({ status: 'failed' });
    await handler({ context: payload.context });
    expect(storage.data[CACHE_INDEX_KEY]).toBeUndefined();
    await handler(payload);
    expect(chatStream).toHaveBeenCalledTimes(3);
  });

  it('still answers when the cache storage fails', async () => {
    const { handler, storage } = setup();
    storage.get = () => Promise.reject(new Error('broken'));
    storage.set = () => Promise.reject(new Error('broken'));
    expect(await handler(payload)).toMatchObject({ status: 'done' });
  });
});
