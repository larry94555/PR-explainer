// The prompt that explains every changed line of a diff hunk in one request
// (PR 10.5). One request per line reads the same instructions and the same
// code around it again for each line, and Ollama has a fixed cost per
// request, so the background queue asks about a whole hunk at once: the
// instructions and the hunk once, then a numbered list of the lines, each
// answered in a short fixed format that parseHunkExplanation.ts splits.
//
// Each line's answer is saved under the key a click on that line uses (the
// single-line prompt's key, see src/explain/hunkHandler.ts), so this prompt
// itself is never a cache key. Clicks, hover and Regenerate still ask about
// one line with explainPrompt.ts.

import type { ChatMessage } from '../llm/types';
import { SECTION_HEADINGS, descriptionBlock, type PrInfo } from './explainPrompt';

/** The most lines one hunk request asks about; a bigger hunk is split into parts. */
export const MAX_HUNK_LINES = 15;

/** The answer limit for a hunk request: a little for the framing, then a line's limit per line. */
export const HUNK_ANSWER_BASE_TOKENS = 40;

export function hunkAnswerTokens(lines: number, maxResponseTokens: number): number {
  return HUNK_ANSWER_BASE_TOKENS + Math.max(1, lines) * maxResponseTokens;
}

/** Splits `items` into parts of at most `max`, in order. */
export function splitHunkLines<T>(items: readonly T[], max = MAX_HUNK_LINES): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += max) parts.push(items.slice(i, i + max));
  return parts;
}

export const HUNK_SYSTEM_PROMPT = [
  'You are a senior engineer helping review a GitHub pull request. You get its title and',
  'description, a section of its diff, and a numbered list of changed lines from that section.',
  'Explain each numbered line on its own. Use the title and description for why the change needs it.',
  '',
  'For every numbered line, in order, answer in exactly this format:',
  '### [1]',
  `${SECTION_HEADINGS.what}: One short sentence.`,
  `${SECTION_HEADINGS.why}: One short sentence.`,
  `${SECTION_HEADINGS.concerns}: At most two short points separated by "; ", most important first:`,
  'bugs, edge cases, security, or performance. If there are none, write "None found."',
  '',
  'Be brief. Do not repeat the code. Nothing before the first line, no summary.',
].join('\n');

/** A changed line to explain, as it goes in the numbered list. */
export interface HunkPromptLine {
  /** Its number in the new file. */
  line: number;
  /** The line diff style, such as "+const a = 1;". */
  code: string;
}

export interface HunkPromptInput {
  /** The section of the diff: file, hunk header and the lines around the ones to explain. */
  text: string;
  lines: readonly HunkPromptLine[];
  prInfo?: PrInfo;
}

/** The numbered list, such as "[1] line 12: +const a = 1;". */
export function numberedLines(lines: readonly HunkPromptLine[]): string[] {
  return lines.map((l, i) => `[${i + 1}] line ${l.line}: ${l.code}`);
}

/**
 * The messages for one hunk request: the PR, the diff section, then the
 * numbered lines. Everything but the list is the same for two parts of one
 * hunk, so Ollama can reuse its work on the second.
 */
export function buildHunkPrompt({ text, lines, prInfo }: HunkPromptInput): ChatMessage[] {
  const title = prInfo?.title.trim() ?? '';
  const description = descriptionBlock(prInfo?.description ?? '');
  const pr =
    title || description
      ? [
          ...(title ? [`Pull request title: ${title}`] : []),
          'Pull request description:' + (description ? '' : ' (none)'),
          ...(description ? [description] : []),
          '',
        ]
      : [];
  const count = lines.length;
  return [
    { role: 'system', content: HUNK_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        ...pr,
        '```',
        text.trimEnd(),
        '```',
        '',
        'Lines to explain:',
        ...numberedLines(lines),
        '',
        `Explain each of the ${count} numbered ${count === 1 ? 'line' : 'lines'}.`,
      ].join('\n'),
    },
  ];
}
