// Loads the model ahead of the first click (PR 8.3). Loading a 7B model can
// take 5 to 20 seconds, and Ollama unloads it after 5 idle minutes by default,
// so without this the first explanation of a review often pays for the load.
//
// When a PR's Files changed tab opens, the content script sends a `warmup`
// request and the service worker runs warmUp: if the model is not already in
// memory (GET /api/ps), it sends Ollama a request with no messages, which
// loads the model and keeps it for the Keep model loaded setting. It runs
// once per tab and PR, and never shows an error: if it fails, the first
// click simply loads the model as before.
//
// The model is loaded with the window the first explanation will most likely
// ask for (PR 8.5, src/llm/numCtx.ts), since a different num_ctx would make
// Ollama load it again on that click.
//
// Opening the chat sends a warm-up `for: 'chat'` (PR 9.14), which loads the
// Chat model the same way, with the window chat questions use (the whole
// context size, since chat does not size its window to each prompt), so the
// first question does not pay for loading it. It does nothing when chat uses
// the same model as explanations, which the page's own warm-up loaded.
//
// Either way it notes the window the model is loaded with (PR 9.7,
// src/llm/loadedWindow.ts): the one /api/ps reports, or the one it loaded the
// model with, so the first click does not ask /api/ps again.

import { createRoundTripLog, type RoundTripLog, type RoundTripSink } from '../net/roundTrips';
import { chatSettings, hasOwnChatModel, type Settings } from '../settings';
import type { ContextSizer } from './contextSize';
import type { LoadedWindowMemory, LoadedWindowTicket } from './loadedWindow';
import { startingNumCtx } from './numCtx';
import { isSameModel, type LlmClient } from './types';

/**
 * What a warm-up did:
 * - repeat: this tab already warmed up for this PR.
 * - off: Keep model loaded is 0, so loading early would be undone at once.
 * - no-model: no model is picked yet.
 * - same-model: a chat warm-up, but chat uses the explanation model (PR 9.14).
 * - already-loaded: Ollama had the model in memory, so nothing was sent.
 * - loaded: the model was loaded.
 * - failed: Ollama could not be reached or could not load the model.
 */
export type WarmupOutcome =
  'repeat' | 'off' | 'no-model' | 'same-model' | 'already-loaded' | 'loaded' | 'failed';

export interface WarmupPayload {
  /** The PR whose diffs were opened, as "owner/repo#17". */
  pr: string;
  /**
   * Groups the warm-up's round trips with the page's own (the PR
   * description) in the debug log (PR 9.7).
   */
  debugId?: string;
  /**
   * Which model to load (PR 9.14): the explanation model (the default, when
   * a PR's diffs open) or the Chat model (when the chat opens).
   */
  for?: 'explain' | 'chat';
}

export interface WarmupResult {
  outcome: WarmupOutcome;
}

export interface WarmupDeps {
  getSettings(): Promise<Settings>;
  createClient(
    settings: Pick<Settings, 'llmUrl'>,
    options?: { roundTrips?: RoundTripLog },
  ): LlmClient;
  /**
   * The automatic context size (src/llm/contextSize.ts). Without it, the
   * model is loaded with the server's default window unless one is set.
   */
  contextTokens?: ContextSizer;
  /** Where to say what happened. Defaults to console.info. */
  log?: (message: string) => void;
  /** Gets each round trip as it starts, runs and ends, for the debug log (PR 9.3, 9.4). */
  onRoundTrip?: RoundTripSink;
  /** The window the model was last run with (PR 9.7), shared with explanations. */
  loadedWindow?: LoadedWindowMemory;
}

export interface Warmup {
  /** Warms up the model for `pr` in `tabId` (no tab: every call counts). Never throws. */
  warmUp(tabId: number | undefined, payload: WarmupPayload): Promise<WarmupResult>;
  /** Forgets a closed tab. */
  forgetTab(tabId: number): void;
  /**
   * The round trips of each warm-up still running (PR 9.2), so a click that
   * comes while the model loads can show what it waited behind.
   */
  inFlight(): RoundTripLog[];
}

/** Whether `loaded` (names from /api/ps) has `model`; "llama3" is listed as "llama3:latest". */
export function isModelLoaded(loaded: readonly string[], model: string): boolean {
  return loaded.some((name) => isSameModel(name, model));
}

export function createWarmup(deps: WarmupDeps): Warmup {
  const log = deps.log ?? ((message: string) => console.info(message));
  // The PRs each tab has warmed up for.
  const seen = new Map<number, Set<string>>();
  // Warm-ups in progress, by server and model, so two tabs opening PRs at the
  // same time share one load.
  const running = new Map<string, Promise<WarmupOutcome>>();
  const logs = new Set<RoundTripLog>();

  async function load(
    settings: Settings,
    roundTrips: RoundTripLog,
    forChat: boolean,
  ): Promise<WarmupOutcome> {
    const { model, keepAliveMinutes } = settings;
    let ticket: LoadedWindowTicket | undefined;
    try {
      const client = deps.createClient(settings, { roundTrips });
      // Taken as /api/ps is sent, so a click sent after it wins.
      ticket = deps.loadedWindow?.start(settings, undefined);
      const running = await client.runningModels();
      const found = running.find((m) => isSameModel(m.name, model));
      if (found) {
        log(`[PR Explainer] warm-up: ${model} is already loaded`);
        // Older Ollama versions do not say, which forgets.
        ticket?.done(found.contextTokens);
        return 'already-loaded';
      }
      // Chat questions run with the whole context size (src/chat/chatHandler.ts).
      const auto = async () => {
        if (!deps.contextTokens) return undefined;
        const size = await deps.contextTokens(settings, undefined, undefined, roundTrips);
        return forChat ? size : startingNumCtx(size);
      };
      const window = settings.contextTokens > 0 ? settings.contextTokens : await auto();
      const started = Date.now();
      // A click sent while the model loads takes a newer ticket, so this
      // load ending later does not overwrite what the click says.
      ticket = deps.loadedWindow?.start(settings, window);
      await client.loadModel(model, {
        keepAliveMinutes,
        ...(window !== undefined && { contextTokens: window }),
      });
      ticket?.done();
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      log(`[PR Explainer] warm-up: loaded ${model} in ${seconds} s`);
      return 'loaded';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[PR Explainer] warm-up: could not load ${model} (${message})`);
      ticket?.failed();
      return 'failed';
    }
  }

  async function warmUp(tabId: number | undefined, payload: WarmupPayload): Promise<WarmupResult> {
    const forChat = payload?.for === 'chat';
    let pr = typeof payload?.pr === 'string' ? payload.pr : '';
    if (!forChat && tabId !== undefined && seen.get(tabId)?.has(pr)) return { outcome: 'repeat' };
    let settings: Settings;
    try {
      settings = await deps.getSettings();
    } catch {
      return { outcome: 'failed' };
    }
    if (settings.keepAliveMinutes === 0) return { outcome: 'off' };
    if (!settings.model) return { outcome: 'no-model' };
    if (forChat) {
      if (!hasOwnChatModel(settings)) return { outcome: 'same-model' };
      settings = chatSettings(settings);
      // Counted apart from the page's, and again when another Chat model is picked.
      pr = `chat ${settings.model} ${pr}`;
    }
    // Marked before loading, so a second request while this one runs is a repeat.
    if (tabId !== undefined) {
      if (seen.get(tabId)?.has(pr)) return { outcome: 'repeat' };
      seen.set(tabId, (seen.get(tabId) ?? new Set()).add(pr));
    }
    // A chat warm-up loads with another window, so it does not share a page's load.
    const key = `${settings.llmUrl} ${settings.model}${forChat ? ' chat' : ''}`;
    let loading = running.get(key);
    if (!loading) {
      const group = typeof payload.debugId === 'string' ? payload.debugId.slice(0, 100) : '';
      const roundTrips = createRoundTripLog('warmup', Date.now, {
        ...(group && { group }),
        onUpdate: deps.onRoundTrip,
      });
      logs.add(roundTrips);
      loading = load(settings, roundTrips, forChat).finally(() => {
        running.delete(key);
        logs.delete(roundTrips);
      });
      running.set(key, loading);
    }
    return { outcome: await loading };
  }

  return { warmUp, forgetTab: (tabId) => void seen.delete(tabId), inFlight: () => [...logs] };
}
