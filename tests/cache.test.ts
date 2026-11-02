import {
  CACHE_STORAGE_KEY,
  createExplainCache,
  explainCacheKey,
  type CachedExplanation,
  type SessionStorageLike,
} from '../src/explain/explainCache';
import { createExplainHandler } from '../src/explain/explainHandler';
import type { ChatStreamEnd, LlmClient } from '../src/llm/types';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';

/** An in-memory chrome.storage.session that copies values like Chrome does. */
function fakeSession(): SessionStorageLike & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (keys) =>
      Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    },
  };
}

function entry(what: string, model = 'qwen2.5-coder:7b'): CachedExplanation {
  return {
    explanation: { what, why: 'Because.', concerns: 'None found.' },
    model,
    elapsedMs: 9800,
    savedAt: 1_700_000_000_000,
  };
}

describe('explainCacheKey', () => {
  const parts = { pr: 'owner/repo#17', model: 'qwen2.5-coder:7b', context: 'File: a.ts\n+x' };

  it('is a fixed-length hex hash that stays the same for the same input', async () => {
    const key = await explainCacheKey(parts);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await explainCacheKey({ ...parts })).toBe(key);
  });

  it('changes with the PR, the model, or the code around the line', async () => {
    const key = await explainCacheKey(parts);
    expect(await explainCacheKey({ ...parts, pr: 'owner/repo#18' })).not.toBe(key);
    expect(await explainCacheKey({ ...parts, model: 'llama3.2:3b' })).not.toBe(key);
    expect(await explainCacheKey({ ...parts, context: 'File: a.ts\n+y' })).not.toBe(key);
  });

  it('does not mix up parts that run together', async () => {
    expect(await explainCacheKey({ pr: 'a', model: 'bc', context: 'd' })).not.toBe(
      await explainCacheKey({ pr: 'ab', model: 'c', context: 'd' }),
    );
  });
});

describe('explain cache', () => {
  it('returns null on a miss and the saved answer on a hit', async () => {
    const cache = createExplainCache(fakeSession());
    expect(await cache.get('k1')).toBeNull();
    await cache.set('k1', entry('One.'));
    expect(await cache.get('k1')).toEqual(entry('One.'));
    expect(await cache.get('k2')).toBeNull();
  });

  it('replaces an entry saved again under the same key', async () => {
    const storage = fakeSession();
    const cache = createExplainCache(storage);
    await cache.set('k1', entry('Old.'));
    await cache.set('k1', entry('New.'));
    expect(await cache.get('k1')).toEqual(entry('New.'));
    expect(storage.data[CACHE_STORAGE_KEY]).toHaveLength(1);
  });

  it('drops the oldest entries past the size limit', async () => {
    const cache = createExplainCache(fakeSession(), { maxEntries: 2 });
    await cache.set('k1', entry('One.'));
    await cache.set('k2', entry('Two.'));
    await cache.set('k3', entry('Three.'));
    expect(await cache.get('k1')).toBeNull();
    expect(await cache.get('k2')).not.toBeNull();
    expect(await cache.get('k3')).not.toBeNull();
  });

  it('keeps an entry that was just used when the limit is reached', async () => {
    const cache = createExplainCache(fakeSession(), { maxEntries: 2 });
    await cache.set('k1', entry('One.'));
    await cache.set('k2', entry('Two.'));
    await cache.get('k1');
    await cache.set('k3', entry('Three.'));
    expect(await cache.get('k1')).not.toBeNull();
    expect(await cache.get('k2')).toBeNull();
  });

  it('keeps both entries when two answers are saved at the same moment', async () => {
    const cache = createExplainCache(fakeSession());
    await Promise.all([cache.set('k1', entry('One.')), cache.set('k2', entry('Two.'))]);
    expect(await cache.get('k1')).not.toBeNull();
    expect(await cache.get('k2')).not.toBeNull();
  });

  it('ignores stored values in an unexpected shape', async () => {
    const storage = fakeSession();
    storage.data[CACHE_STORAGE_KEY] = [{ key: 'k1', explanation: 'not an object' }, 42];
    const cache = createExplainCache(storage);
    expect(await cache.get('k1')).toBeNull();
    storage.data[CACHE_STORAGE_KEY] = 'garbage';
    await cache.set('k2', entry('Two.'));
    expect(await cache.get('k2')).toEqual(entry('Two.'));
  });

  it('keeps working after a storage call fails', async () => {
    const storage = fakeSession();
    const cache = createExplainCache(storage);
    const realSet = storage.set;
    storage.set = () => Promise.reject(new Error('quota'));
    await expect(cache.set('k1', entry('One.'))).rejects.toThrow('quota');
    storage.set = realSet;
    await cache.set('k1', entry('One.'));
    expect(await cache.get('k1')).toEqual(entry('One.'));
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
      return { model: settings.model, doneReason: 'stop' };
    });
    const client: LlmClient = { listModels: vi.fn(), chat: vi.fn(), chatStream };
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

    const onChunk = vi.fn();
    const second = await handler(payload, { onChunk });
    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(onChunk).not.toHaveBeenCalled();
    expect(second).toEqual({
      ...first,
      cached: { elapsedMs: 9800, savedAt: 10_800 },
    });
  });

  it('misses for a different model', async () => {
    const { handler, chatStream, useSettings } = setup();
    await handler(payload);
    useSettings({ ...SETTINGS, model: 'llama3.2:3b' });
    const result = await handler(payload);
    expect(chatStream).toHaveBeenCalledTimes(2);
    expect(result).not.toHaveProperty('cached');
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
    expect(storage.data[CACHE_STORAGE_KEY]).toBeUndefined();
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
