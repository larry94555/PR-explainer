// The context window to run the model with (PR 6.2): the user's Context size
// setting, or, when that is 0 (automatic), what the model's own settings ask
// for, else its trained size, capped at AUTO_CONTEXT_TOKENS. Every request
// passes the result to Ollama as num_ctx, so explanations and chat run with
// the same window (a change of window makes Ollama reload the model) and the
// prompt budget matches what the model really gets.
//
// Automatic sizes are looked up once per server and model with /api/show and
// remembered while the service worker runs. A failed lookup is not
// remembered: the request goes ahead with the fallback, and the next one
// asks again.
//
// The same /api/show reply says whether the model can think (PR 9.5), so the
// context size and the thinking check share one lookup per server and model:
// with Context size on automatic, checking whether the model thinks costs no
// extra round trip.

import type { RoundTripLog } from '../net/roundTrips';
import type { Settings } from '../settings';
import {
  thinkingSupport,
  type LlmClient,
  type ModelContext,
  type ThinkingSupport,
  type ThinkValue,
} from './types';

/**
 * The most an automatic size uses. Bigger windows cost memory and time on a
 * laptop; users who want more can set it.
 */
export const AUTO_CONTEXT_TOKENS = 4096;

/** Used when the server cannot say: Ollama's own default for most models. */
export const FALLBACK_CONTEXT_TOKENS = 4096;

/** Room left for the reply's framing and the estimate's rough edges. */
export const PROMPT_MARGIN_TOKENS = 32;

/**
 * The window for `settings`. `onLookup` is called when the answer is not
 * already known and the server is asked, so a click's trace (PR 9.1) can
 * show the lookup only when it ran. That request is recorded in
 * `roundTrips` (PR 9.2).
 */
export type ContextSizer = (
  settings: Settings,
  signal?: AbortSignal,
  onLookup?: () => void,
  roundTrips?: RoundTripLog,
) => Promise<number>;

/**
 * Whether the model in `settings` can think, and which `think` values it
 * accepts (PR 9.5, see thinkingSupport): null when it cannot think,
 * undefined when the server does not say (an older Ollama) or could not be
 * asked. Takes the same arguments as ContextSizer.
 */
export type ThinkingCheck = (
  settings: Settings,
  signal?: AbortSignal,
  onLookup?: () => void,
  roundTrips?: RoundTripLog,
) => Promise<ThinkingSupport | null | undefined>;

export interface ModelLookup {
  contextTokens: ContextSizer;
  thinking: ThinkingCheck;
}

/** The context sizer and thinking check, sharing one /api/show lookup per server and model. */
export function createModelLookup(
  createClient: (settings: Settings, options?: { roundTrips?: RoundTripLog }) => LlmClient,
): ModelLookup {
  const known = new Map<string, ModelContext>();
  // The model's details, from memory or the server. Throws when the server cannot say.
  const details = async (
    settings: Settings,
    signal?: AbortSignal,
    onLookup?: () => void,
    roundTrips?: RoundTripLog,
  ): Promise<ModelContext> => {
    const key = `${settings.llmUrl} ${settings.model}`;
    const remembered = known.get(key);
    if (remembered !== undefined) return remembered;
    onLookup?.();
    const found = await createClient(settings, { roundTrips }).modelContext(settings.model, {
      signal,
    });
    known.set(key, found);
    return found;
  };
  return {
    contextTokens: async (settings, signal, onLookup, roundTrips) => {
      if (settings.contextTokens > 0) return settings.contextTokens;
      try {
        const { maxTokens, configuredTokens } = await details(
          settings,
          signal,
          onLookup,
          roundTrips,
        );
        return Math.min(
          configuredTokens ?? AUTO_CONTEXT_TOKENS,
          maxTokens ?? Number.POSITIVE_INFINITY,
        );
      } catch {
        return FALLBACK_CONTEXT_TOKENS;
      }
    },
    thinking: async (settings, signal, onLookup, roundTrips) => {
      if (!settings.model) return undefined;
      try {
        return thinkingSupport(await details(settings, signal, onLookup, roundTrips));
      } catch {
        // Not knowing only means `think` is not sent; the request goes ahead.
        return undefined;
      }
    },
  };
}

export function createContextSizer(
  createClient: (settings: Settings, options?: { roundTrips?: RoundTripLog }) => LlmClient,
): ContextSizer {
  return createModelLookup(createClient).contextTokens;
}

/** Named thinking levels, least first, as Ollama names them. */
const THINK_LEVELS = ['low', 'medium', 'high', 'max'];

/**
 * The `think` option for a request (PR 9.5), for a model that can think:
 * false (answer directly) unless the Let the model think setting is on, in
 * which case true, so the thinking comes back in its own field.
 *
 * When the server says which values the model accepts, only those are sent.
 * A model that cannot turn thinking off (such as gpt-oss, which takes only
 * "low", "medium" or "high") is sent its lowest level instead of false, and
 * nothing (its own default) instead of true when it does not accept true.
 * When the server does not say, true and false are sent, which most
 * reasoning models accept.
 *
 * Left out for any other model, or when it is not known, so an older Ollama
 * or a model without thinking gets the request it always did.
 */
export function thinkOption(
  support: ThinkingSupport | null | undefined,
  letModelThink: boolean,
): ThinkValue | undefined {
  if (!support) return undefined;
  const { values } = support;
  if (!values) return letModelThink;
  if (letModelThink) return values.includes(true) ? true : undefined;
  if (values.includes(false)) return false;
  const levels = values.filter((v): v is string => typeof v === 'string');
  const rank = (level: string) => {
    const at = THINK_LEVELS.indexOf(level);
    return at === -1 ? THINK_LEVELS.length : at;
  };
  return levels.sort((a, b) => rank(a) - rank(b))[0];
}

/** The tokens a prompt may use in a `contextTokens` window with room for the reply. */
export function promptBudget(contextTokens: number, maxResponseTokens: number): number {
  return contextTokens - maxResponseTokens - PROMPT_MARGIN_TOKENS;
}
