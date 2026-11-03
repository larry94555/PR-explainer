// Builds the LlmClient for the user's current settings. Callers use this
// instead of constructing OllamaClient, so adding another server type later
// only changes this file.

import type { RoundTripLog } from '../net/roundTrips';
import type { Settings } from '../settings';
import { OllamaClient, type FetchLike } from './ollamaClient';
import type { LlmClient } from './types';

/** `roundTrips` records each request the client makes (PR 9.2). */
export function createLlmClient(
  settings: Pick<Settings, 'llmUrl'>,
  options: { fetch?: FetchLike; roundTrips?: RoundTripLog } = {},
): LlmClient {
  return new OllamaClient({ baseUrl: settings.llmUrl, ...options });
}
