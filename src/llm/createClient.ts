// Builds the LlmClient for the user's current settings. Callers use this
// instead of constructing OllamaClient, so adding another server type later
// only changes this file.

import type { Settings } from '../settings';
import { OllamaClient, type FetchLike } from './ollamaClient';
import type { LlmClient } from './types';

export function createLlmClient(settings: Pick<Settings, 'llmUrl'>, fetch?: FetchLike): LlmClient {
  return new OllamaClient({ baseUrl: settings.llmUrl, fetch });
}
