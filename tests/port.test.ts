// PR 11.5: a page with background work keeps a port open to the service
// worker, opens it again when Chrome closes it, and hears when the worker
// has restarted.
import type { PortLike, PortRuntime } from '../src/messaging/protocol';
import { listenForWorkerPorts, serveWorkerPort, WORKER_PORT } from '../src/messaging/workerPort';
import {
  createWorkerPort,
  WORKER_BEAT_MS,
  WORKER_MAX_RECONNECTS,
  WORKER_PORT_NAME,
  WORKER_RECONNECT_MS,
} from '../src/workerPort';

/** One end of a port, with the other end's controls. */
function fakePort(name: string = WORKER_PORT_NAME) {
  const messages: ((message: unknown) => void)[] = [];
  const disconnects: (() => void)[] = [];
  const posted: unknown[] = [];
  let closed = false;
  const port: PortLike & { posted: unknown[]; closed(): boolean } = {
    name,
    posted,
    closed: () => closed,
    sender: { id: 'ext', tab: { id: 3 } } as PortLike['sender'],
    postMessage: (message) => {
      if (closed) throw new Error('closed');
      posted.push(message);
    },
    disconnect: () => {
      closed = true;
    },
    onMessage: { addListener: (l) => messages.push(l) },
    onDisconnect: { addListener: (l) => disconnects.push(l) },
  };
  return {
    port,
    /** The worker says hello. */
    hello: (worker: string, restored = 0) =>
      messages.forEach((l) => l({ type: 'hello', worker, restored })),
    /** Chrome closes it (the worker stopped). */
    drop: () => {
      closed = true;
      disconnects.forEach((l) => l());
    },
  };
}

/** A content script's runtime: each connect makes a new fake port. */
function fakeRuntime() {
  const ports: ReturnType<typeof fakePort>[] = [];
  let fail = false;
  return {
    ports,
    failNext: () => (fail = true),
    runtime: {
      connect: ({ name }: { name: string }) => {
        if (fail) throw new Error('Extension context invalidated.');
        const p = fakePort(name);
        ports.push(p);
        return p.port;
      },
    },
    open: () => ports.filter((p) => !p.port.closed()),
  };
}

function setup() {
  const rt = fakeRuntime();
  const state = { work: true };
  const restarts: number[] = [];
  const port = createWorkerPort({
    runtime: rt.runtime,
    hasWork: () => state.work,
    onRestart: (n) => restarts.push(n),
  });
  return { ...rt, state, restarts, port };
}

describe('the worker port, in the content script (PR 11.5)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses the name the service worker listens for', () => {
    expect(WORKER_PORT_NAME).toBe(WORKER_PORT);
  });

  it('opens one port while there is work, and beats so Chrome keeps the worker running', () => {
    const env = setup();
    env.state.work = false;
    env.port.update();
    expect(env.ports).toHaveLength(0);
    env.state.work = true;
    env.port.update();
    env.port.update();
    expect(env.ports).toHaveLength(1);
    expect(env.port.connected()).toBe(true);
    vi.advanceTimersByTime(WORKER_BEAT_MS * 2);
    expect(env.ports[0]!.port.posted).toEqual([{ type: 'beat' }, { type: 'beat' }]);
  });

  it('closes the port at the next beat once its work is done', () => {
    const env = setup();
    env.port.update();
    env.state.work = false;
    vi.advanceTimersByTime(WORKER_BEAT_MS);
    expect(env.ports[0]!.port.closed()).toBe(true);
    expect(env.port.connected()).toBe(false);
    // Closed by the page: not opened again.
    vi.advanceTimersByTime(WORKER_BEAT_MS * 3);
    expect(env.ports).toHaveLength(1);
    expect(env.ports[0]!.port.posted).toEqual([]);
  });

  it('reconnects after Chrome closes the port and says the worker restarted', () => {
    const env = setup();
    env.port.update();
    env.ports[0]!.hello('run-1');
    expect(env.restarts).toEqual([]);
    // Chrome stops the worker, and with it the work that was in flight.
    env.state.work = false;
    env.ports[0]!.drop();
    expect(env.port.connected()).toBe(false);
    vi.advanceTimersByTime(WORKER_RECONNECT_MS);
    expect(env.ports).toHaveLength(2);
    env.ports[1]!.hello('run-2', 12);
    expect(env.restarts).toEqual([12]);
    // With no work left, it closes at the next beat.
    vi.advanceTimersByTime(WORKER_BEAT_MS);
    expect(env.open()).toHaveLength(0);
  });

  it('does not report a restart for a hello from the same worker or after closing itself', () => {
    const env = setup();
    env.port.update();
    env.ports[0]!.hello('run-1');
    env.ports[0]!.drop();
    vi.advanceTimersByTime(WORKER_RECONNECT_MS);
    // The port closed but the worker kept running.
    env.ports[1]!.hello('run-1');
    expect(env.restarts).toEqual([]);
    // Closed by the page when idle; the worker then restarted on its own.
    env.state.work = false;
    vi.advanceTimersByTime(WORKER_BEAT_MS);
    env.state.work = true;
    env.port.update();
    env.ports[2]!.hello('run-2', 3);
    expect(env.restarts).toEqual([]);
  });

  it('gives up after closing again and again without a hello, and when the extension is gone', () => {
    const env = setup();
    env.port.update();
    for (let i = 0; i <= WORKER_MAX_RECONNECTS; i++) {
      env.ports.at(-1)!.drop();
      vi.advanceTimersByTime(WORKER_RECONNECT_MS);
    }
    expect(env.ports).toHaveLength(WORKER_MAX_RECONNECTS + 1);
    expect(env.port.connected()).toBe(false);
    // New work tries again.
    env.port.update();
    expect(env.ports).toHaveLength(WORKER_MAX_RECONNECTS + 2);

    const gone = setup();
    gone.failNext();
    expect(() => gone.port.update()).not.toThrow();
    expect(gone.port.connected()).toBe(false);
  });

  it('stop closes the port for good', () => {
    const env = setup();
    env.port.update();
    env.port.stop();
    expect(env.ports[0]!.port.closed()).toBe(true);
    env.port.update();
    vi.advanceTimersByTime(WORKER_BEAT_MS);
    expect(env.ports).toHaveLength(1);
  });
});

describe('the worker port, in the service worker (PR 11.5)', () => {
  it('answers each port with hello, naming this run and the jobs it restored', async () => {
    const p = fakePort(WORKER_PORT);
    let restored!: (n: number) => void;
    serveWorkerPort(p.port, {
      worker: 'run-2',
      restored: () => new Promise<number>((resolve) => (restored = resolve)),
    });
    expect(p.port.posted).toEqual([]);
    restored(12);
    await Promise.resolve();
    await Promise.resolve();
    expect(p.port.posted).toEqual([{ type: 'hello', worker: 'run-2', restored: 12 }]);
  });

  it('sends nothing to a port that closed first, and says 0 when the restore failed', async () => {
    const closed = fakePort(WORKER_PORT);
    serveWorkerPort(closed.port, { worker: 'w', restored: async () => 1 });
    closed.drop();
    const failed = fakePort(WORKER_PORT);
    serveWorkerPort(failed.port, {
      worker: 'w',
      restored: async () => {
        throw new Error('no');
      },
    });
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(closed.port.posted).toEqual([]);
    expect(failed.port.posted).toEqual([{ type: 'hello', worker: 'w', restored: 0 }]);
  });

  it('answers only its own extension, on its own port name', async () => {
    const listeners: ((port: PortLike) => void)[] = [];
    const runtime: PortRuntime = {
      id: 'ext',
      connect: () => fakePort().port,
      onConnect: { addListener: (l) => listeners.push(l) },
    };
    listenForWorkerPorts(runtime, { worker: 'w', restored: async () => 0 });
    const ours = fakePort(WORKER_PORT);
    const other = fakePort('pr-explainer:explain');
    const stranger = fakePort(WORKER_PORT);
    stranger.port.sender = { id: 'someone-else' } as PortLike['sender'];
    for (const p of [ours, other, stranger]) listeners.forEach((l) => l(p.port));
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(ours.port.posted).toHaveLength(1);
    expect(other.port.posted).toEqual([]);
    expect(stranger.port.posted).toEqual([]);
  });
});
