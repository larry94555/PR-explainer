// The window the model was last loaded with (PR 9.7), so a click does not
// ask Ollama's /api/ps before every explanation.
//
// Ollama loads a model with the num_ctx of the request that loads it, and
// keeps it until a request asks for another one (PR 8.5). Every request the
// service worker sends (an explanation, a chat question or a warm-up) says
// which window it used, so the service worker already knows the answer /api/ps
// would give. It keeps one window per server and model, since with a Chat
// model of its own (PR 9.14) two models can be loaded at once. It forgets a
// model's window when it cannot be sure:
// - a request failed or was stopped, since Ollama may not have loaded it;
// - a request was sent without a window, so the server picked its own;
// - the service worker restarted (this is kept in memory only).
// Then the next explanation asks /api/ps once, as before.
//
// Requests can overlap (a click while the warm-up still loads the model, or
// a chat question while an explanation runs), and the last to start is the
// one Ollama loads the model for. So each request takes a ticket when it is
// sent, and only the newest ticket for that model changes what is
// remembered: an older request that ends later, well or badly, is ignored.
//
// If Ollama unloaded the model in the meantime (Keep model loaded ran out),
// the next request loads it again with the remembered window, which is what
// the last request used, so nothing is lost.

import type { Settings } from '../settings';

type Target = Pick<Settings, 'llmUrl' | 'model'>;

/** One request's part in what is remembered. Only the newest request's counts. */
export interface LoadedWindowTicket {
  /**
   * The request finished: the model is loaded with its window, or with
   * `loaded` when the request found out which (a warm-up's /api/ps).
   */
  done(loaded?: number): void;
  /** The request failed or was stopped: the window is no longer known. */
  failed(): void;
}

export interface LoadedWindowMemory {
  /** The window the model in `settings` was last loaded with, or undefined when not known. */
  known(settings: Target): number | undefined;
  /**
   * Called as a request is sent with `window` (undefined: the server's
   * default). Its ticket records how it ended, unless a newer one was sent.
   */
  start(settings: Target, window: number | undefined): LoadedWindowTicket;
  /** Forgets the window, so the next explanation asks /api/ps. */
  forget(): void;
}

export function createLoadedWindowMemory(): LoadedWindowMemory {
  // One window per server and model (PR 9.14): with a Chat model of its own,
  // explanations and chat run two models, each loaded with its own window.
  const windows = new Map<string, number>();
  // Counts requests sent, per server and model; a ticket counts only while
  // it is the newest for its model.
  const newest = new Map<string, number>();
  let sent = 0;
  const keyOf = (settings: Target) => `${settings.llmUrl} ${settings.model}`;
  return {
    known(settings) {
      if (!settings.model) return undefined;
      return windows.get(keyOf(settings));
    },
    start(settings, window) {
      const key = keyOf(settings);
      const ticket = ++sent;
      newest.set(key, ticket);
      const isNewest = () => newest.get(key) === ticket;
      return {
        done(loaded = window) {
          if (!isNewest()) return;
          if (settings.model && Number.isInteger(loaded) && loaded! > 0) windows.set(key, loaded!);
          else windows.delete(key);
        },
        failed() {
          if (isNewest()) windows.delete(key);
        },
      };
    },
    forget() {
      newest.clear();
      windows.clear();
    },
  };
}
