// @vitest-environment node
// PR 9.3: the service worker keeps every round trip in a debug log.
import {
  clearWhenTurnedOff,
  createDebugLog,
  DEBUG_LOG_KEY,
  DEBUG_LOG_LIMIT,
  DEBUG_LOG_PORT,
  listenForDebugLogPorts,
  pageEntries,
  workerEntry,
  type SessionStorageLike,
  type StorageChangedLike,
} from '../src/debug/debugLog';
import type { DebugEntryInput, DebugLogPortMessage, DebugRunningEntry } from '../src/debug/types';
import type { PortLike, PortRuntime } from '../src/messaging/protocol';
import { createRoundTripLog } from '../src/net/roundTrips';
import type { RoundTrip } from '../src/trace/types';

/** An in-memory chrome.storage.session; it outlives each log made on it, like the real one. */
function fakeSession(): SessionStorageLike & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
    set: async (items) => {
      // Stored as a copy, like Chrome does.
      Object.assign(data, structuredClone(items));
    },
  };
}

function trip(overrides: Partial<RoundTrip> = {}): RoundTrip {
  return {
    target: 'ollama',
    method: 'POST',
    endpoint: 'localhost:11434/api/chat',
    purpose: 'explanation',
    cause: 'click',
    startMs: 0,
    durationMs: 10,
    status: 'done',
    bytesSent: 100,
    bytesReceived: 200,
    ...overrides,
  };
}

function input(n: number): DebugEntryInput {
  return { kind: 'round-trip', group: `g${n}`, cause: 'click', at: n, trip: trip() };
}

function setup(on = true) {
  const storage = fakeSession();
  const state = { on };
  const log = createDebugLog({ storage, isOn: async () => state.on });
  return { storage, state, log };
}

describe('debug log (PR 9.3)', () => {
  it('adds entries in order with increasing ids and reads them back', async () => {
    const { log } = setup();
    await log.add([input(1), input(2)]);
    await log.add([input(3)]);
    const entries = await log.read();
    expect(entries.map((e) => [e.id, e.group])).toEqual([
      [1, 'g1'],
      [2, 'g2'],
      [3, 'g3'],
    ]);
  });

  it('keeps entries added at the same time in the order they came', async () => {
    const { log } = setup();
    await Promise.all([log.add([input(1)]), log.add([input(2)]), log.add([input(3)])]);
    expect((await log.read()).map((e) => e.group)).toEqual(['g1', 'g2', 'g3']);
  });

  it(`drops the oldest entry after ${DEBUG_LOG_LIMIT}`, async () => {
    const { log } = setup();
    for (let n = 1; n <= DEBUG_LOG_LIMIT + 5; n++) await log.add([input(n)]);
    const entries = await log.read();
    expect(entries).toHaveLength(DEBUG_LOG_LIMIT);
    expect(entries[0]!.group).toBe('g6');
    expect(entries.at(-1)!.id).toBe(DEBUG_LOG_LIMIT + 5);
  });

  it('is read back after the service worker restarts, and ids carry on', async () => {
    const { storage, log } = setup();
    await log.add([input(1), input(2)]);
    // A new worker: a new log on the same session storage.
    const again = createDebugLog({ storage, isOn: async () => true });
    expect((await again.read()).map((e) => e.group)).toEqual(['g1', 'g2']);
    const [added] = await again.add([input(3)]);
    expect(added!.id).toBe(3);
  });

  it('sends each new entry to every listener until it stops listening', async () => {
    const { log } = setup();
    const heard: DebugLogPortMessage[] = [];
    const stop = log.listen((message) => heard.push(message));
    await log.add([input(1), input(2)]);
    stop();
    await log.add([input(3)]);
    expect(heard.map((m) => m.type === 'entry' && m.entry.group)).toEqual(['g1', 'g2']);
  });

  it('a listener that throws does not stop the others or the log', async () => {
    const { log } = setup();
    const heard: DebugLogPortMessage[] = [];
    log.listen(() => {
      throw new Error('closed');
    });
    log.listen((message) => heard.push(message));
    await log.add([input(1)]);
    expect(heard).toHaveLength(1);
    expect(await log.read()).toHaveLength(1);
  });

  it('clears the log, tells the listeners, and never reuses an id', async () => {
    const { log } = setup();
    const heard: DebugLogPortMessage[] = [];
    log.listen((message) => heard.push(message));
    await log.add([input(1), input(2)]);
    await log.clear();
    expect(await log.read()).toEqual([]);
    expect(heard.at(-1)).toEqual({ type: 'cleared' });
    const [next] = await log.add([input(3)]);
    expect(next!.id).toBe(3);
  });

  it('keeps nothing when the setting is off', async () => {
    const { storage, log } = setup(false);
    const listener = vi.fn();
    log.listen(listener);
    await expect(log.add([input(1)])).resolves.toEqual([]);
    expect(storage.data).toEqual({});
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps nothing when the setting cannot be read', async () => {
    const storage = fakeSession();
    const log = createDebugLog({
      storage,
      isOn: async () => {
        throw new Error('storage is gone');
      },
    });
    await log.add([input(1)]);
    expect(storage.data).toEqual({});
  });

  it('turning the setting off clears the log; other changes do not', async () => {
    const { log } = setup();
    let fire: Parameters<StorageChangedLike['addListener']>[0] = () => {};
    clearWhenTurnedOff({ addListener: (l) => void (fire = l) }, log);
    await log.add([input(1)]);

    fire({ 'settings.model': { newValue: 'x' } }, 'sync');
    fire({ 'settings.debugWindow': { newValue: false } }, 'local');
    fire({ 'settings.debugWindow': { newValue: true } }, 'sync');
    expect(await log.read()).toHaveLength(1);

    fire({ 'settings.debugWindow': { newValue: false } }, 'sync');
    expect(await log.read()).toEqual([]);
    await log.add([input(2)]);
    // Removing the stored value goes back to the default, off.
    fire({ 'settings.debugWindow': {} }, 'sync');
    expect(await log.read()).toEqual([]);
  });

  it('drops the oldest half when session storage is full', async () => {
    const storage = fakeSession();
    const set = storage.set;
    storage.set = async (items) => {
      const { entries } = items[DEBUG_LOG_KEY] as { entries: unknown[] };
      if (entries.length > 4) throw new Error('QUOTA_BYTES quota exceeded');
      await set(items);
    };
    const log = createDebugLog({ storage, isOn: async () => true });
    for (let n = 1; n <= 4; n++) await log.add([input(n)]);
    await log.add([input(5)]);
    // Five did not fit, so the oldest three of five were dropped.
    expect((await log.read()).map((e) => e.group)).toEqual(['g4', 'g5']);
  });
});

describe('entries for the debug log (PR 9.3)', () => {
  it("records each of the service worker's round trips as it ends, in its group", async () => {
    const storage = fakeSession();
    const debug = createDebugLog({ storage, isOn: async () => true });
    let t = 5_000;
    const roundTrips = createRoundTripLog('click', () => t, {
      group: 'click-1',
      onUpdate: (ended, log) => {
        if (ended.status !== 'running') void debug.add([workerEntry(ended, log)]);
      },
    });
    t += 20;
    const response = await roundTrips.record(
      'http://localhost:11434/api/chat',
      { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) },
      async () => {
        t += 100;
        return new Response(JSON.stringify({ message: { content: 'Hello' }, done: true }) + '\n');
      },
    );
    // Not logged until the reply has been read.
    expect(await debug.read()).toEqual([]);
    await response.text();
    const [entry] = await debug.read();
    expect(entry).toMatchObject({
      kind: 'round-trip',
      group: 'click-1',
      cause: 'click',
      at: 5_020,
      trip: {
        purpose: 'explanation',
        status: 'done',
        startMs: 20,
        durationMs: 100,
        messages: [{ role: 'user', content: 'hi' }],
        reply: 'Hello',
      },
    });
  });

  it("turns the content script's message into the click's trace and its GitHub round trips", () => {
    const github = trip({
      target: 'github',
      method: 'GET',
      endpoint: 'github.com/o/r/blob/main/a.ts',
      purpose: 'file at head',
      startMs: 40,
      bytesSent: 0,
    });
    const task = {
      key: 'find-code',
      label: 'Find the code',
      source: 'page',
      startMs: 0,
      durationMs: 3,
    };
    const entries = pageEntries({
      group: 'click-1',
      at: 1_000,
      where: 'a.ts:12',
      roundTrips: [github, trip()],
      tasks: [task],
    });
    expect(entries).toEqual([
      {
        kind: 'trace',
        group: 'click-1',
        cause: 'click',
        at: 1_000,
        where: 'a.ts:12',
        tasks: [task],
      },
      {
        kind: 'round-trip',
        group: 'click-1',
        cause: 'click',
        at: 1_040,
        where: 'a.ts:12',
        trip: { ...github, cause: 'click' },
      },
    ]);
  });

  it('leaves out anything not in the expected shape', () => {
    expect(pageEntries(null)).toEqual([]);
    expect(pageEntries({ group: 'g', at: 'now', roundTrips: [], tasks: [] })).toEqual([]);
    const entries = pageEntries({
      group: 'g',
      at: 1,
      roundTrips: [
        { target: 'github', endpoint: 'x' },
        'junk',
        trip({ target: 'github', status: 'odd' as never }),
      ],
      tasks: [{ key: 'k' }, null],
    });
    expect(entries).toEqual([]);
  });
});

function running(id: string, reply = ''): DebugRunningEntry {
  return {
    kind: 'round-trip',
    group: id.split(':')[0]!,
    cause: 'click',
    at: 1,
    trip: trip({ id, status: 'running', reply }),
  };
}

describe('round trips still running (PR 9.4)', () => {
  it('sends a running round trip to listeners without storing it, until it ends', async () => {
    const { log, storage } = setup();
    const heard: DebugLogPortMessage[] = [];
    log.listen((m) => heard.push(m));
    await log.progress(running('g1:1', 'Hel'));
    await log.progress(running('g1:1', 'Hello'));
    expect(heard.map((m) => m.type)).toEqual(['running', 'running']);
    expect((await log.snapshot()).running).toEqual([
      expect.objectContaining({ trip: expect.objectContaining({ reply: 'Hello' }) }),
    ]);
    expect(storage.data[DEBUG_LOG_KEY]).toBeUndefined();
    await log.add([{ ...running('g1:1'), trip: trip({ id: 'g1:1', reply: 'Hello!' }) }]);
    expect((await log.snapshot()).running).toEqual([]);
  });

  it('drops an update that comes after its round trip ended', async () => {
    const { log } = setup();
    const heard: DebugLogPortMessage[] = [];
    log.listen((m) => heard.push(m));
    await log.add([{ ...running('g1:1'), trip: trip({ id: 'g1:1' }) }]);
    await log.progress(running('g1:1', 'late'));
    expect(heard.map((m) => m.type)).toEqual(['entry']);
    expect((await log.snapshot()).running).toEqual([]);
  });

  it('keeps nothing and sends nothing while the setting is off, and Clear forgets them', async () => {
    const { log, state } = setup(false);
    const heard: DebugLogPortMessage[] = [];
    log.listen((m) => heard.push(m));
    await log.progress(running('g1:1'));
    expect(heard).toEqual([]);
    state.on = true;
    await log.progress(running('g1:2'));
    await log.clear();
    expect((await log.snapshot()).running).toEqual([]);
  });

  it('ignores a round trip that is not running or has no id', async () => {
    const { log } = setup();
    await log.progress({ ...running('g1:1'), trip: trip({ id: 'g1:1' }) });
    await log.progress({ ...running('g1:2'), trip: trip({ status: 'running' }) });
    expect((await log.snapshot()).running).toEqual([]);
  });
});

describe('debug log port (PR 9.3)', () => {
  function fakePort(url: string | undefined, name: string = DEBUG_LOG_PORT) {
    const sent: unknown[] = [];
    let onDisconnect = () => {};
    const port: PortLike = {
      name,
      sender: { id: 'ext', ...(url !== undefined && { url }) },
      postMessage: (m) => sent.push(m),
      disconnect: vi.fn(),
      onMessage: { addListener: () => {} },
      onDisconnect: { addListener: (l) => void (onDisconnect = l) },
    };
    return { port, sent, close: () => onDisconnect() };
  }

  function serve() {
    const { log } = setup();
    let listener: (port: PortLike) => void = () => {};
    const runtime: PortRuntime = {
      id: 'ext',
      connect: () => {
        throw new Error('not used');
      },
      onConnect: { addListener: (l) => void (listener = l) },
    };
    listenForDebugLogPorts(runtime, log);
    return { log, connect: (port: PortLike) => listener(port) };
  }

  it('sends the log, then each new entry and each clear, to the debug window until it closes', async () => {
    const { log, connect } = serve();
    const window = fakePort('chrome-extension://ext/debug.html');
    connect(window.port);
    await log.add([input(1)]);
    await log.clear();
    window.close();
    await log.add([input(2)]);
    expect(window.sent).toEqual([
      { type: 'snapshot', entries: [], running: [] },
      { type: 'entry', entry: expect.objectContaining({ id: 1, group: 'g1' }) },
      { type: 'cleared' },
    ]);
  });

  it('starts a window that connects late with the whole log and the round trips running (PR 9.4)', async () => {
    const { log, connect } = serve();
    await log.add([input(1)]);
    await log.progress(running('g2:1'));
    const window = fakePort('chrome-extension://ext/debug.html');
    connect(window.port);
    await log.read();
    expect(window.sent).toEqual([
      {
        type: 'snapshot',
        entries: [expect.objectContaining({ id: 1 })],
        running: [expect.objectContaining({ trip: expect.objectContaining({ id: 'g2:1' }) })],
      },
    ]);
  });

  it("refuses a GitHub page's content script and ignores other ports", async () => {
    const { log, connect } = serve();
    const page = fakePort('https://github.com/o/r/pull/1/files');
    const other = fakePort('chrome-extension://ext/debug.html', 'pr-explainer:explain');
    connect(page.port);
    connect(other.port);
    await log.add([input(1)]);
    expect(page.port.disconnect).toHaveBeenCalled();
    expect(page.sent).toEqual([]);
    expect(other.sent).toEqual([]);
  });
});
