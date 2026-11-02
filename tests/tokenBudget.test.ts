import { describe, expect, it, vi } from 'vitest';
import {
  estimateTokens,
  fitToBudget,
  PromptTooLargeError,
  type BudgetPart,
} from '../src/explain/tokenBudget';

// Samples with their real token counts. The counts are from the cl100k
// tokenizer (the gpt-tokenizer npm package), a stand-in for the code models
// people run in Ollama, whose tokenizers split code in much the same way.
const SAMPLES: Array<{ name: string; tokens: number; text: string }> = [
  {
    name: 'TypeScript',
    tokens: 56,
    text: [
      'export function promptBudget(contextTokens: number, maxResponseTokens: number): number {',
      '  return contextTokens - maxResponseTokens - PROMPT_MARGIN_TOKENS;',
      '}',
      '',
      'const known = new Map<string, number>();',
      'if (settings.contextTokens > 0) return settings.contextTokens;',
    ].join('\n'),
  },
  {
    name: 'Python',
    tokens: 58,
    text: [
      'def retry(fn, attempts=3, delay=0.2):',
      '    for attempt in range(attempts):',
      '        try:',
      '            return fn()',
      '        except ConnectionError as error:',
      '            if attempt == attempts - 1:',
      '                raise',
      '            time.sleep(delay * 2 ** attempt)',
    ].join('\n'),
  },
  {
    name: 'a diff',
    tokens: 100,
    text: [
      '@@ -38,6 +38,9 @@ export const TEMPERATURE_RANGE = { min: 0, max: 2 } as const;',
      ' export const MAX_RESPONSE_TOKENS_RANGE = { min: 1, max: 32768 } as const;',
      '+// Code never leaves the laptop, so only loopback addresses are accepted.',
      ">+const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);",
      ' export interface SettingsIssue {',
    ].join('\n'),
  },
  {
    name: 'prose',
    tokens: 43,
    text:
      'Local models often have small context windows, from 4k to 8k tokens. Too much context ' +
      'gives errors or silently cut prompts, so the extension measures the prompt and trims ' +
      'the least important parts first.',
  },
  {
    name: 'JSON',
    tokens: 47,
    text: '{"model": "qwen2.5-coder:7b", "options": {"temperature": 0.2, "num_predict": 1024, "num_ctx": 4096}, "stream": true}',
  },
];

describe('estimateTokens', () => {
  it.each(SAMPLES)('is a little over the real count for $name', ({ text, tokens }) => {
    const estimate = estimateTokens(text);
    // Never under, so a prompt that fits by the estimate really fits, and
    // not so far over that it wastes much of a small context.
    expect(estimate).toBeGreaterThanOrEqual(tokens);
    expect(estimate).toBeLessThanOrEqual(tokens * 1.5);
  });

  it('is 0 for empty text and grows with the text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('const x = 1;')).toBeLessThan(
      estimateTokens('const x = 1;\nconst y = 2;'),
    );
  });

  it('counts other alphabets at two tokens a character', () => {
    expect(estimateTokens('héllo')).toBe(4); // "h", "é", "llo"
    expect(estimateTokens('日本')).toBe(4);
  });
});

const part = (label: string, text: string, extra: Partial<BudgetPart> = {}): BudgetPart => ({
  label,
  text,
  ...extra,
});
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('fitToBudget', () => {
  it('keeps everything when it fits', () => {
    const parts = [part('a', words(5)), part('b', words(5), { floor: '' })];
    const fitted = fitToBudget(parts, 1000);
    expect(fitted.texts).toEqual([words(5), words(5)]);
    expect(fitted.trimmed).toEqual([]);
    expect(fitted.tokens).toBe(estimateTokens(words(5)) * 2);
  });

  it('never cuts a part without a floor', () => {
    const required = part('code', words(20));
    const optional = part('description', words(20), { floor: '' });
    const fitted = fitToBudget([required, optional], estimateTokens(words(20)) + 3);
    expect(fitted.texts[0]).toBe(words(20));
    expect(fitted.texts[1]).toBe('');
    expect(fitted.trimmed).toEqual(['description']);
  });

  it('cuts the least important part first, and the next only when that is not enough', () => {
    const size = estimateTokens(words(10));
    const parts = [
      part('instructions', words(10)),
      part('nearby', words(10), { floor: 'n' }),
      part('description', words(10), { floor: 'd' }),
    ];
    // Room for everything but the description.
    let fitted = fitToBudget(parts, size * 2 + 1);
    expect(fitted.texts).toEqual([words(10), words(10), 'd']);
    expect(fitted.trimmed).toEqual(['description']);
    // Less room: both are cut, most important listed first.
    fitted = fitToBudget(parts, size + 2);
    expect(fitted.texts).toEqual([words(10), 'n', 'd']);
    expect(fitted.trimmed).toEqual(['nearby', 'description']);
  });

  it('asks a part to shrink to what is left before cutting it to its floor', () => {
    // Each word is two tokens ("word" and its number).
    const shrink = vi.fn((max: number) => words(Math.floor(max / 2)));
    const parts = [part('fixed', words(10)), part('nearby', words(20), { floor: '', shrink })];
    const budget = estimateTokens(words(10)) + 12;
    const fitted = fitToBudget(parts, budget);
    expect(shrink).toHaveBeenCalledWith(12);
    expect(fitted.texts[1]).toBe(words(6));
    expect(fitted.tokens).toBeLessThanOrEqual(budget);
  });

  it('uses the floor when a shrink comes back too long', () => {
    const parts = [
      part('fixed', words(10)),
      part('x', words(20), { floor: 'f', shrink: () => words(20) }),
    ];
    expect(fitToBudget(parts, estimateTokens(words(10)) + 5).texts[1]).toBe('f');
  });

  it('throws a clear error when even the parts that must stay do not fit', () => {
    const parts = [part('code', words(50)), part('nearby', words(50), { floor: '' })];
    let caught: unknown;
    try {
      fitToBudget(parts, 10);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PromptTooLargeError);
    expect(caught).toMatchObject({ needed: estimateTokens(words(50)), budget: 10 });
    expect((caught as Error).message).toBe(
      `The prompt needs about ${estimateTokens(words(50))} tokens, but only 10 are available.`,
    );
  });
});
