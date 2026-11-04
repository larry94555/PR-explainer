import {
  HUNK_ANSWER_BASE_TOKENS,
  HUNK_SYSTEM_PROMPT,
  MAX_HUNK_LINES,
  buildHunkPrompt,
  hunkAnswerTokens,
  numberedLines,
  splitHunkLines,
} from '../src/explain/hunkPrompt';

const SECTION = [
  'File: src/settings.ts (TypeScript)',
  '@@ -38,6 +38,9 @@ export const TEMPERATURE_RANGE = { min: 0, max: 2 } as const;',
  ' export const MAX_RESPONSE_TOKENS_RANGE = { min: 1, max: 32768 } as const;',
  '+// Code never leaves the laptop, so only loopback addresses are accepted.',
  "+const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);",
  ' export interface SettingsIssue {',
].join('\n');

const LINES = [
  { line: 40, code: '+// Code never leaves the laptop, so only loopback addresses are accepted.' },
  { line: 41, code: "+const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);" },
];

describe('the hunk prompt', () => {
  it('sends the PR, the diff section once, then the numbered lines', () => {
    const messages = buildHunkPrompt({
      text: SECTION,
      lines: LINES,
      prInfo: { title: 'Only accept a local LLM server', description: 'Keeps code local.' },
    });
    expect(messages[0]).toEqual({ role: 'system', content: HUNK_SYSTEM_PROMPT });
    expect(messages[1]!.content).toMatchSnapshot();
    expect(messages[1]!.content.split(SECTION)).toHaveLength(2);
  });

  it('numbers the lines from 1 with their line in the new file', () => {
    expect(numberedLines(LINES)).toEqual([
      '[1] line 40: +// Code never leaves the laptop, so only loopback addresses are accepted.',
      "[2] line 41: +const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);",
    ]);
    const one = buildHunkPrompt({ text: SECTION, lines: LINES.slice(0, 1) })[1]!.content;
    expect(one).toMatch(/Explain each of the 1 numbered line\.$/);
    // No PR section when nothing about the PR is known.
    expect(one.startsWith('```')).toBe(true);
  });

  it('asks for the same headings a single-line answer has, under "### [n]"', () => {
    expect(HUNK_SYSTEM_PROMPT).toContain('### [1]');
    for (const heading of ['What it does:', "Why it's needed:", 'Concerns:']) {
      expect(HUNK_SYSTEM_PROMPT).toContain(heading);
    }
  });

  it('splits a hunk into parts of at most 15 lines', () => {
    const lines = Array.from({ length: 32 }, (_, i) => i);
    const parts = splitHunkLines(lines);
    expect(MAX_HUNK_LINES).toBe(15);
    expect(parts.map((p) => p.length)).toEqual([15, 15, 2]);
    expect(parts.flat()).toEqual(lines);
    expect(splitHunkLines(lines.slice(0, 15))).toHaveLength(1);
    expect(splitHunkLines([])).toEqual([]);
  });

  it('lets the answer grow with the number of lines', () => {
    expect(hunkAnswerTokens(1, 120)).toBe(HUNK_ANSWER_BASE_TOKENS + 120);
    expect(hunkAnswerTokens(15, 120)).toBe(HUNK_ANSWER_BASE_TOKENS + 15 * 120);
    expect(hunkAnswerTokens(0, 120)).toBe(HUNK_ANSWER_BASE_TOKENS + 120);
  });
});
