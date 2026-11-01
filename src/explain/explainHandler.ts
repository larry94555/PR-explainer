// The service worker's `explain` handler: reads the settings, streams the
// prompt's reply from the local LLM (passing each piece to `onChunk` so the
// popup can show it as it arrives), and parses the full reply into three
// sections at the end.
//
// LLM failures come back as a result with a message and a fix (from
// describeLlmError) instead of a thrown error, because the messaging layer
// only carries an error's name and message, and the popup (PR 3.4) needs the
// fix too.

import { describeLlmError, type Platform } from '../llm/describeLlmError';
import type { LlmClient } from '../llm/types';
import type { Settings } from '../settings';
import { buildExplainPrompt } from './explainPrompt';
import { parseExplanation, type Explanation } from './parseExplanation';

export interface ExplainPayload {
  /** The context block from formatContext (src/lineContext.ts). */
  context: string;
}

export type ExplainResult =
  | { status: 'done'; explanation: Explanation; model: string }
  | { status: 'failed'; message: string; fix: string };

export interface ExplainStreamOptions {
  /** Called with each piece of the reply as the model writes it. */
  onChunk?(text: string): void;
  /** Cancels the request (the popup's Stop button, or the popup closing). */
  signal?: AbortSignal;
}

export interface ExplainDeps {
  getSettings(): Promise<Settings>;
  createClient(settings: Settings): LlmClient;
  platform: Platform;
}

export function createExplainHandler(deps: ExplainDeps) {
  return async (
    payload: ExplainPayload,
    { onChunk, signal }: ExplainStreamOptions = {},
  ): Promise<ExplainResult> => {
    if (typeof payload?.context !== 'string' || !payload.context.trim()) {
      throw new Error('explain needs a non-empty context');
    }
    const settings = await deps.getSettings();
    try {
      const stream = deps.createClient(settings).chatStream(buildExplainPrompt(payload.context), {
        model: settings.model,
        temperature: settings.temperature,
        maxResponseTokens: settings.maxResponseTokens,
        signal,
      });
      let content = '';
      let next = await stream.next();
      while (!next.done) {
        content += next.value;
        onChunk?.(next.value);
        next = await stream.next();
      }
      return { status: 'done', explanation: parseExplanation(content), model: next.value.model };
    } catch (error) {
      const { message, fix } = describeLlmError(error, {
        url: settings.llmUrl,
        model: settings.model,
        platform: deps.platform,
      });
      return { status: 'failed', message, fix };
    }
  };
}
