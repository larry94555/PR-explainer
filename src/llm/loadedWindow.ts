// The window the model was last loaded with (PR 9.7), so a click does not
// ask Ollama's /api/ps before every explanation.
//
// Ollama loads a model with the num_ctx of the request that loads it, and
// keeps it until a request asks for another one (PR 8.5). Every request the
// service worker sends (an explanation, a chat question or a warm-up) says
// which window it used, so the service worker already knows the answer /api/ps
// would give. It forgets when it cannot be sure:
// - the settings name another server or model than the one remembered;
// - a request failed or was stopped, since Ollama may not have loaded it;
// - a request was sent without a window, so the server picked its own;
// - the service worker restarted (this is kept in memory only).
// Then the next explanation asks /api/ps once, as before.
//
// If Ollama unloaded the model in the meantime (Keep model loaded ran out),
// the next request loads it again with the remembered window, which is what
// the last request used, so nothing is lost.

import type { Settings } from '../settings';

type Target = Pick<Settings, 'llmUrl' | 'model'>;

export interface LoadedWindowMemory {
  /** The window the model in `settings` was last loaded with, or undefined when not known. */
  known(settings: Target): number | undefined;
  /** Records the window a request just used. Undefined (the server's default) forgets. */
  remember(settings: Target, window: number | undefined): void;
  /** Forgets the window, so the next explanation asks /api/ps. */
  forget(): void;
}

export function createLoadedWindowMemory(): LoadedWindowMemory {
  let last: { llmUrl: string; model: string; window: number } | undefined;
  return {
    known(settings) {
      if (!last || !settings.model) return undefined;
      return last.llmUrl === settings.llmUrl && last.model === settings.model
        ? last.window
        : undefined;
    },
    remember(settings, window) {
      last =
        settings.model && Number.isInteger(window) && window! > 0
          ? { llmUrl: settings.llmUrl, model: settings.model, window: window! }
          : undefined;
    },
    forget() {
      last = undefined;
    },
  };
}
