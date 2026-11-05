// Service worker side of the worker port (PR 11.5, see WorkerPortName in
// protocol.ts). A content script with background work keeps the port open
// and sends `beat` now and then; each message keeps Chrome from stopping
// the worker. Each new port is answered with `hello`, naming this run of the
// worker and how many jobs it put back, so a page whose worker was stopped
// can carry on at once.

import type { PortLike, PortRuntime, WorkerPortMessage, WorkerPortName } from './protocol';

export const WORKER_PORT: WorkerPortName = 'pr-explainer:worker';

export interface WorkerPortDeps {
  /** Names this run of the worker (a new one each time it starts). */
  worker: string;
  /** How many jobs this run put back, once it knows. */
  restored(): Promise<number>;
}

/** Answers one worker port. Exported for the tests. */
export function serveWorkerPort(port: PortLike, deps: WorkerPortDeps): void {
  let open = true;
  port.onDisconnect.addListener(() => {
    open = false;
  });
  // A beat needs no answer: receiving it is what keeps the worker running.
  port.onMessage.addListener(() => {});
  void deps
    .restored()
    .catch(() => 0)
    .then((restored) => {
      if (!open) return;
      const hello: WorkerPortMessage = { type: 'hello', worker: deps.worker, restored };
      try {
        port.postMessage(hello);
      } catch {
        // The page went away meanwhile.
      }
    });
}

/** Answers worker ports from our own extension's content scripts. */
export function listenForWorkerPorts(runtime: PortRuntime, deps: WorkerPortDeps): void {
  runtime.onConnect.addListener((port) => {
    if (port.name !== WORKER_PORT || port.sender?.id !== runtime.id) return;
    serveWorkerPort(port, deps);
  });
}
