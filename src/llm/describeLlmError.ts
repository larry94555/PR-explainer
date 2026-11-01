// Turns a failed LLM call into words a user can act on: what went wrong and
// how to fix it. The client (ollamaClient.ts) says *what* failed with an
// LlmError kind; this file says *what to do about it*.
//
// Commands in a fix are wrapped in backticks so a page can show them as code.

import { LlmError } from './types';

export type Platform = 'windows' | 'mac' | 'other';

export interface ErrorContext {
  /** The server address that was called, for example "http://localhost:11434". */
  url?: string;
  /** The model that was asked for, used in the `ollama pull` hint. */
  model?: string;
  /** Picks the right OLLAMA_ORIGINS command. Defaults to "other". */
  platform?: Platform;
}

export interface ErrorDescription {
  /** One sentence: what went wrong. */
  message: string;
  /** One or two sentences: what to do about it. */
  fix: string;
}

const ORIGINS_VALUE = 'chrome-extension://*';

/** Guesses the platform from a user agent string, for the OLLAMA_ORIGINS hint. */
export function detectPlatform(userAgent: string): Platform {
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(userAgent)) return 'mac';
  return 'other';
}

function originsFix(platform: Platform): string {
  switch (platform) {
    case 'windows':
      return (
        `In Command Prompt, run \`setx OLLAMA_ORIGINS "${ORIGINS_VALUE}"\`, ` +
        'then quit Ollama from the system tray and open it again.'
      );
    case 'mac':
      return (
        `In Terminal, run \`launchctl setenv OLLAMA_ORIGINS "${ORIGINS_VALUE}"\`, ` +
        'then quit Ollama from the menu bar and open it again.'
      );
    default:
      return `Set \`OLLAMA_ORIGINS=${ORIGINS_VALUE}\` for Ollama and restart it.`;
  }
}

/** A short message and a fix for any error thrown by an LlmClient. */
export function describeLlmError(error: unknown, context: ErrorContext = {}): ErrorDescription {
  const where = context.url ? ` at ${context.url}` : '';
  if (!(error instanceof LlmError)) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      message: `Something went wrong: ${detail}`,
      fix: 'Try again. If it keeps happening, check that Ollama is running.',
    };
  }

  switch (error.kind) {
    case 'connection':
      return {
        message: `Ollama is not running${where}.`,
        fix:
          'Start Ollama (open the Ollama app, or run `ollama serve`), then try again. ' +
          'If Ollama uses another port, fix the URL.',
      };
    case 'model-not-found': {
      const model = context.model?.trim();
      return model
        ? {
            message: `The model "${model}" is not installed.`,
            fix: `Run \`ollama pull ${model}\`, then click Refresh.`,
          }
        : {
            message: 'That model is not installed.',
            fix: 'Run `ollama pull <model>`, then click Refresh.',
          };
    }
    case 'origin-blocked':
      return {
        message: 'Ollama blocked the request from this extension.',
        fix: originsFix(context.platform ?? 'other'),
      };
    case 'no-model':
      return {
        message: 'No model is selected.',
        fix: 'Choose a model in the list. If the list is empty, click Refresh.',
      };
    case 'bad-response':
      return {
        message: `The server${where} did not reply the way Ollama does.`,
        fix: 'Check that the URL points to Ollama (the default is `http://localhost:11434`).',
      };
    case 'http':
      return {
        message: `Ollama returned an error: ${error.message}`,
        fix: 'Check the Ollama logs for details, then try again.',
      };
    case 'aborted':
      return { message: 'The request was cancelled.', fix: 'Try again.' };
  }
}
