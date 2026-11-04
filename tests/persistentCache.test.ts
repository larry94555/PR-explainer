import { IDBFactory } from 'fake-indexeddb';
import {
  createExplainCache,
  type CachedExplanation,
  type SessionStorageLike,
} from '../src/explain/explainCache';
import {
  createLayeredCache,
  createPersistentCache,
  DAY_MS,
  DB_NAME,
  DEFAULT_MAX_BYTES,
} from '../src/explain/persistentCache';

const answer = (what: string, extra: Partial<CachedExplanation> = {}): CachedExplanation => ({
  explanation: { what, why: 'Because.', concerns: 'None.' },
  model: 'qwen2.5-coder:1.5b',
  elapsedMs: 4200,
  savedAt: 1,
  ...extra,
});

/** chrome.storage.session in memory. Recreating it is Chrome closing. */
function memorySession(): SessionStorageLike & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
    set: async (items) => void Object.assign(data, items),
    remove: async (keys) => keys.forEach((k) => delete data[k]),
  };
}

function setup({ days = 7, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const indexedDB = new IDBFactory();
  let time = 1_000 * DAY_MS;
  const settings = { days };
  const options = {
    indexedDB,
    keepDays: async () => settings.days,
    maxBytes,
    now: () => time,
  };
  return {
    indexedDB,
    settings,
    advance: (ms: number) => void (time += ms),
    /** The cache as the service worker builds it, with a new session (Chrome started). */
    start: () => {
      const session = memorySession();
      const disk = createPersistentCache(options);
      const cache = createLayeredCache(createExplainCache(session, { now: () => time }), disk);
      return { session, disk, cache };
    },
  };
}

/** The size the disk counts for an answer saved under `key`. */
const sizeOf = (key: string, value: CachedExplanation) =>
  new TextEncoder().encode(key).length + new TextEncoder().encode(JSON.stringify(value)).length;

describe('saved answers (PR 10.9)', () => {
  it('saves an answer and reads it back after Chrome restarts', async () => {
    const env = setup();
    const first = env.start();
    await first.cache.set('k1', answer('Adds two numbers.'), 'o/r#1');
    expect(await first.cache.get('k1')).toEqual(answer('Adds two numbers.'));

    // A new session cache and a new worker, the same disk.
    const second = env.start();
    expect(second.session.data).toEqual({});
    expect(await second.cache.get('k1')).toEqual(answer('Adds two numbers.'));
    expect(await second.cache.get('missing')).toBeNull();
  });

  it('keeps Prefetched, and only the fields the popup needs', async () => {
    const env = setup();
    const { cache } = env.start();
    const value = { ...answer('x', { prefetched: true }), extra: 'not saved' } as CachedExplanation;
    await cache.set('k', value, 'o/r#1');
    expect(await env.start().cache.get('k')).toEqual(answer('x', { prefetched: true }));
  });

  it('checks the session cache first, and copies a disk hit into it with its PR', async () => {
    const env = setup();
    await env.start().cache.set('k', answer('on disk'), 'o/r#2');

    const { session, disk, cache } = env.start();
    const diskGet = vi.spyOn(disk, 'get');
    expect(await cache.get('k')).toEqual(answer('on disk'));
    expect(diskGet).toHaveBeenCalledTimes(1);
    // Now in the session cache, under its PR.
    expect(session.data['explainCache.index']).toEqual([
      ['k', 'o/r#2', expect.any(Number), expect.any(Number)],
    ]);

    expect(await cache.get('k')).toEqual(answer('on disk'));
    expect(diskGet).toHaveBeenCalledTimes(1);
  });

  it('removes answers not used for Keep answers for days when the worker starts', async () => {
    const env = setup({ days: 7 });
    const { cache } = env.start();
    await cache.set('old', answer('old'), 'o/r#1');
    env.advance(3 * DAY_MS);
    await cache.set('recent', answer('recent'), 'o/r#1');
    env.advance(5 * DAY_MS);
    // "old" was last used 8 days ago, "recent" 5 days ago.
    const { disk } = env.start();
    expect(await disk.prune()).toBe(1);
    expect(await disk.get('old')).toBeNull();
    expect(await disk.get('recent')).toMatchObject({ value: answer('recent'), pr: 'o/r#1' });
  });

  it('a read counts as a use, and an answer past the limit is a miss before it is pruned', async () => {
    const env = setup({ days: 7 });
    const { disk } = env.start();
    await disk.set('used', answer('used'), 'p');
    await disk.set('unused', answer('unused'), 'p');
    env.advance(6 * DAY_MS);
    expect(await disk.get('used')).not.toBeNull();
    env.advance(2 * DAY_MS);
    expect(await disk.get('unused')).toBeNull();
    expect(await disk.get('used')).not.toBeNull();
    expect(await disk.prune()).toBe(0);
  });

  it('drops the least recently used answers past the size limit', async () => {
    const one = sizeOf('k0', answer('answer 0'));
    const env = setup({ maxBytes: one * 3 });
    const { disk } = env.start();
    for (const i of [0, 1, 2]) {
      await disk.set(`k${i}`, answer(`answer ${i}`), 'p');
      env.advance(1000);
    }
    // k0 is used again, so k1 is now the least recently used.
    expect(await disk.get('k0')).not.toBeNull();
    env.advance(1000);
    await disk.set('k3', answer('answer 3'), 'p');
    expect(await disk.get('k1')).toBeNull();

    // A new worker counts the size from the database and keeps to the limit.
    const again = env.start().disk;
    env.advance(1000);
    await again.set('k4', answer('answer 4'), 'p');
    expect(await again.get('k2')).toBeNull();
    for (const key of ['k0', 'k3', 'k4']) expect(await again.get(key)).not.toBeNull();
  });

  it('saving the same key again replaces it without counting it twice', async () => {
    const one = sizeOf('a', answer('answer a'));
    const env = setup({ maxBytes: one * 2 });
    const { disk } = env.start();
    await disk.set('a', answer('answer a'), 'p');
    await disk.set('b', answer('answer b'), 'p');
    await disk.set('b', answer('answer b'), 'p');
    await disk.set('b', answer('answer b'), 'p');
    expect(await disk.get('a')).not.toBeNull();
    expect(await disk.get('b')).not.toBeNull();
  });

  it('does not keep an answer too big to ever fit', async () => {
    const env = setup({ maxBytes: 100 });
    const { disk } = env.start();
    await disk.set('big', answer('x'.repeat(200)), 'p');
    expect(await disk.get('big')).toBeNull();
  });

  it('keeps nothing on disk when Keep answers for is 0, and removes what was saved', async () => {
    const env = setup({ days: 7 });
    await env.start().cache.set('before', answer('before'), 'p');
    env.settings.days = 0;

    const { cache, disk } = env.start();
    await cache.set('after', answer('after'), 'p');
    // Still answered for this session, from the session cache.
    expect(await cache.get('after')).toEqual(answer('after'));
    expect(await disk.get('after')).toBeNull();
    expect(await disk.get('before')).toBeNull();
    expect(await disk.prune()).toBe(1);

    // Chrome restarts: nothing is left.
    env.settings.days = 7;
    const next = env.start();
    expect(await next.cache.get('after')).toBeNull();
    expect(await next.cache.get('before')).toBeNull();
  });

  it('Clear saved answers empties both the session cache and the disk', async () => {
    const env = setup();
    const { cache, session } = env.start();
    await cache.set('k1', answer('one'), 'o/r#1');
    await cache.set('k2', answer('two'), 'o/r#2');
    await cache.clear();
    expect(session.data).toEqual({});
    expect(await cache.list()).toEqual([]);
    expect(await cache.get('k1')).toBeNull();
    expect(await env.start().cache.get('k2')).toBeNull();

    // Both keep working afterwards.
    await cache.set('k3', answer('three'), 'o/r#1');
    expect(await cache.get('k3')).toEqual(answer('three'));
    expect(await env.start().cache.get('k3')).toEqual(answer('three'));
  });

  it('treats a failing IndexedDB as a miss, and the session cache still works', async () => {
    const broken = {
      open: () => {
        throw new Error('IndexedDB is off');
      },
    } as unknown as IDBFactory;
    const disk = createPersistentCache({ indexedDB: broken, keepDays: async () => 7 });
    const cache = createLayeredCache(createExplainCache(memorySession()), disk);
    await expect(cache.set('k', answer('x'), 'p')).resolves.toBeUndefined();
    expect(await cache.get('k')).toEqual(answer('x'));
    expect(await disk.get('k')).toBeNull();
    expect(await disk.prune()).toBe(0);
  });

  it('treats a failing settings read or a broken record as a miss', async () => {
    const env = setup();
    const failing = createPersistentCache({
      indexedDB: env.indexedDB,
      keepDays: async () => {
        throw new Error('storage failed');
      },
    });
    await expect(failing.set('k', answer('x'), 'p')).resolves.toBeUndefined();
    expect(await failing.get('k')).toBeNull();

    // A record in an unexpected shape (hand-edited, or from a later version).
    const { disk } = env.start();
    await disk.set('k', answer('x'), 'p');
    await new Promise<void>((resolve, reject) => {
      const open = env.indexedDB.open(DB_NAME);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('answers', 'readwrite');
        tx.objectStore('answers').put({ key: 'k', value: 'garbage' });
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
      };
    });
    expect(await disk.get('k')).toBeNull();
    await disk.set('k', answer('y'), 'p');
    expect(await disk.get('k')).toMatchObject({ value: answer('y') });
  });

  it('keeps both answers when two are saved at the same moment', async () => {
    const env = setup();
    const { disk } = env.start();
    await Promise.all([disk.set('a', answer('a'), 'p'), disk.set('b', answer('b'), 'p')]);
    expect(await env.start().disk.get('a')).not.toBeNull();
    expect(await env.start().disk.get('b')).not.toBeNull();
  });
});
