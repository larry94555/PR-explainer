// The service worker's `explain` handler: reads the settings, sends the
// prompt to the local LLM, and parses the reply into three sections.
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

export interface ExplainDeps {
  getSettings(): Promise<Settings>;
  createClient(settings: Settings): LlmClient;
  platform: Platform;
}

export function createExplainHandler(deps: ExplainDeps) {
  return async (payload: ExplainPayload): Promise<ExplainResult> => {
    if (typeof payload?.context !== 'string' || !payload.context.trim()) {
      throw new Error('explain needs a non-empty context');
    }
    const settings = await deps.getSettings();
    try {
      const reply = await deps.createClient(settings).chat(buildExplainPrompt(payload.context), {
        model: settings.model,
        temperature: settings.temperature,
        maxResponseTokens: settings.maxResponseTokens,
      });
      return { status: 'done', explanation: parseExplanation(reply.content), model: reply.model };
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
