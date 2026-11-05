// Content script side of the worker port (PR 11.5, see WorkerPortName in
// src/messaging/protocol.ts). While this tab has background work (Explain
// ahead has lines running or waiting), it keeps a port open to the service
// worker and sends a `beat` every WORKER_BEAT_MS, which keeps Chrome from
// stopping the worker in the middle of a whole-PR prefetch.
//
// If Chrome stops the worker anyway (it can, and chrome://serviceworker-internals
// can), the port closes. It is opened again at once, which starts the worker
// again, and the worker's `hello` names a different run of it: `onRestart`
// then hears how many jobs it put back, so Explain ahead carries on without
// waiting for a click or a scroll. Once the work is done the port is closed
// at the next beat, so an idle tab never keeps the worker running.
//
// It imports types only, as the content script cannot share runtime code
// with the service worker (see src/content.ts).

import type { PortLike, PortRuntime, WorkerPortName } from './messaging/protocol';

/** The worker port's name; protocol.ts makes TypeScript check it matches the worker's. */
export const WORKER_PORT_NAME: WorkerPortName = 'pr-explainer:worker';

/** How often a beat is sent. Chrome stops a worker after about 30 seconds without events. */
export const WORKER_BEAT_MS = 20_000;

/** How long to wait before opening a closed port again. */
export const WORKER_RECONNECT_MS = 100;

/** How many times in a row a port may close before a hello before it is given up on. */
export const WORKER_MAX_RECONNECTS = 5;

export interface WorkerPortDeps {
  runtime: Pick<PortRuntime, 'connect'>;
  /** True while this tab has background work in the service worker's queue. */
  hasWork(): boolean;
  /** The worker was stopped and started again; `restored` jobs were put back. */
  onRestart(restored: number): void;
  beatMs?: number;
  reconnectMs?: number;
}

export interface WorkerPort {
  /** Call when work may have started: opens the port if there is work. */
  update(): void;
  /** Closes the port for good (the page is going away). */
  stop(): void;
  /** True while the port is open. */
  connected(): boolean;
}

function isHello(message: unknown): message is { type: 'hello'; worker: string; restored: number } {
  if (typeof message !== 'object' || message === null) return false;
  const { type, worker, restored } = message as Record<string, unknown>;
  return type === 'hello' && typeof worker === 'string' && typeof restored === 'number';
}

export function createWorkerPort(deps: WorkerPortDeps): WorkerPort {
  const beatMs = deps.beatMs ?? WORKER_BEAT_MS;
  const reconnectMs = deps.reconnectMs ?? WORKER_RECONNECT_MS;
  let port: PortLike | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  // The run of the worker last heard from.
  let worker: string | undefined;
  // Chrome closed the port (rather than this page), so the worker may have restarted.
  let lost = false;
  // Ports closed in a row without a hello.
  let failures = 0;
  // The extension was reloaded or stopped: connect throws for good.
  let dead = false;

  const close = () => {
    clearInterval(beat);
    beat = undefined;
    const open = port;
    port = undefined;
    try {
      open?.disconnect();
    } catch {
      // Already closed.
    }
  };

  const connect = () => {
    clearTimeout(reconnect);
    reconnect = undefined;
    if (dead || port) return;
    let opened: PortLike;
    try {
      opened = deps.runtime.connect({ name: WORKER_PORT_NAME });
    } catch {
      // "Extension context invalidated": this page's script is an orphan.
      dead = true;
      return;
    }
    port = opened;
    opened.onMessage.addListener((message) => {
      if (port !== opened || !isHello(message)) return;
      failures = 0;
      const before = worker;
      worker = message.worker;
      const restarted = lost && before !== undefined && before !== message.worker;
      lost = false;
      if (restarted) deps.onRestart(message.restored);
    });
    opened.onDisconnect.addListener(() => {
      if (port !== opened) return;
      // Chrome closed it: the worker was stopped. Open it again, which
      // starts the worker, even if the work just failed with it.
      clearInterval(beat);
      beat = undefined;
      port = undefined;
      lost = true;
      failures += 1;
      if (failures <= WORKER_MAX_RECONNECTS) reconnect = setTimeout(connect, reconnectMs);
    });
    beat = setInterval(() => {
      if (!deps.hasWork()) {
        close();
        return;
      }
      try {
        opened.postMessage({ type: 'beat' });
      } catch {
        // onDisconnect follows.
      }
    }, beatMs);
  };

  return {
    update() {
      if (!port && !reconnect && deps.hasWork()) {
        failures = 0;
        connect();
      }
    },
    stop() {
      dead = true;
      clearTimeout(reconnect);
      reconnect = undefined;
      close();
    },
    connected: () => port !== undefined,
  };
}
