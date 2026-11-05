// Builds the LlmClient for the user's current settings. Callers use this
// instead of constructing a client, so the choice of server lives only here:
// Ollama, or with Model server on Chrome built-in (PR 11.13), Chrome's
// built-in model, which the service worker reaches through an offscreen
// document when Chrome does not give it the Prompt API (`chromeAi`).

import type { RoundTripLog } from '../net/roundTrips';
import type { Settings } from '../settings';
import { ChromeAiClient } from './chromeAiClient';
import { OllamaClient, type FetchLike } from './ollamaClient';
import type { LlmClient } from './types';

/** `roundTrips` records each request the client makes (PR 9.2). */
export function createLlmClient(
  settings: Pick<Settings, 'llmUrl'> & Partial<Pick<Settings, 'modelServer'>>,
  options: { fetch?: FetchLike; roundTrips?: RoundTripLog; chromeAi?: () => LlmClient } = {},
): LlmClient {
  if (settings.modelServer === 'chrome')
    return (options.chromeAi ?? (() => new ChromeAiClient()))();
  return new OllamaClient({
    baseUrl: settings.llmUrl,
    ...(options.fetch && { fetch: options.fetch }),
    ...(options.roundTrips && { roundTrips: options.roundTrips }),
  });
}
