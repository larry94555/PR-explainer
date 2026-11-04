// The prompt that asks the model to explain one diff line, or a block of
// selected lines (PR 4.4). The content script
// sends the plain-text context block (formatContext in src/lineContext.ts) and
// this file wraps it in a system prompt and a user message.
//
// The service worker builds the prompt from text, not from a LineContext,
// because lineContext.ts is part of the content script and the content script
// must not share runtime imports with other entries (see src/content.ts).

import type { ChatMessage } from '../llm/types';

// The three headings the model is asked for. parseExplanation looks for the
// same names.
export const SECTION_HEADINGS = {
  what: 'What it does',
  why: "Why it's needed",
  concerns: 'Concerns',
} as const;

// One sentence per section (PR 9.8): writing the answer is the biggest part
// of the wait once thinking is off, so the answer is kept to about 60 to 100
// tokens.
//
// One system prompt for a clicked line and a selected block, so it is the
// same text on every click (PR 8.5): Ollama reuses the work for the start of
// a prompt that matches the previous one, so everything that stays the same
// within a PR comes first and the clicked code comes last.
export const EXPLAIN_SYSTEM_PROMPT = [
  'You are a senior engineer helping review a GitHub pull request. You get its title and',
  'description, code from the file, and the diff lines to explain: one clicked line, or a',
  'selected block to explain as a whole. Use the title and description for why the change needs it.',
  '',
  'Answer in Markdown with exactly these level-2 headings, in this order:',
  `## ${SECTION_HEADINGS.what}`,
  'One short sentence.',
  `## ${SECTION_HEADINGS.why}`,
  'One short sentence.',
  `## ${SECTION_HEADINGS.concerns}`,
  'At most two one-line bullets, most important first: bugs, edge cases, security, or',
  'performance. If there are none, write "None found."',
  '',
  'Be brief. Do not repeat the code. No other headings, no summary.',
].join('\n');

// formatSelection (src/lineContext.ts) starts its second line with this. The
// content script cannot share code with the service worker, so the text is
// kept in both files and a test checks they agree.
export const SELECTION_LINE_PREFIX = 'Selection: ';

/** True when `contextText` is a selected block rather than one clicked line. */
export function isSelectionContext(contextText: string): boolean {
  return contextText.split('\n', 2)[1]?.startsWith(SELECTION_LINE_PREFIX) === true;
}

/** The PR's title and description (PR 6.1), as read by src/prMetadata.ts. */
export interface PrInfo {
  title: string;
  description: string;
}

// The part of the user message that says what the PR is for. Empty when
// neither the title nor the description is known. The description is the
// PR author's text, so it is fenced off as something to read, not obey.
function prSection(title: string, description: string): string[] {
  if (!title && !description) return [];
  return [
    ...(title ? [`Pull request title: ${title}`] : []),
    'Pull request description:' + (description ? '' : ' (none)'),
    ...(description ? [description] : []),
    '',
  ];
}

/**
 * Lines from the full file at the PR's head commit (PR 6.3, read by
 * src/fileContext.ts): the function or block around the clicked code, or a
 * window of lines when there is no block.
 */
export interface FileContext {
  kind: 'block' | 'window';
  /** The file's line number of `lines[0]`. */
  startLine: number;
  lines: string[];
  /** The clicked line or selected block, as line numbers in the file. */
  focusStart: number;
  focusEnd: number;
  /** How many of the first lines open the block (its signature). 0 for a window. */
  headerLines: number;
}

/** The heading over the file context in the prompt. */
export function fileContextHeading(context: FileContext, first: number, last: number): string {
  const where = `lines ${first} to ${last} of the file at the PR's head commit`;
  const what =
    context.kind === 'block'
      ? 'The function or block the code is in'
      : 'The lines around the code in the full file';
  return `${what} (${where}):`;
}

/**
 * The file context as it goes in the prompt, with only the lines from index
 * `from` to index `to` (inclusive) of `context.lines`, plus the block's
 * opening, which is always kept. Lines left out are replaced with a note.
 * The clicked code is not marked here (PR 8.5), so two clicks in the same
 * function send the same text and Ollama can reuse it; the diff after it
 * says which line was clicked.
 */
export function fileContextSection(
  context: FileContext,
  from = 0,
  to = context.lines.length - 1,
): string {
  const { lines, startLine } = context;
  const header = Math.min(context.headerLines, lines.length);
  const kept = (i: number) => i < header || (i >= from && i <= to);
  const out: string[] = [];
  let gap = 0;
  lines.forEach((line, i) => {
    if (!kept(i)) {
      gap++;
      return;
    }
    if (gap) out.push(`(${gap} ${gap === 1 ? 'line' : 'lines'} left out)`);
    gap = 0;
    out.push(line);
  });
  if (gap) out.push(`(${gap} ${gap === 1 ? 'line' : 'lines'} left out)`);
  const last = startLine + lines.length - 1;
  return [fileContextHeading(context, startLine, last), '```', ...out, '```'].join('\n');
}

/** The description as it goes in the prompt: inside a block it cannot close early. */
export function descriptionBlock(description: string): string {
  const text = description.trim();
  return text
    ? ['<description>', text.replaceAll('</description>', ''), '</description>'].join('\n')
    : '';
}

/** The pieces of an explain prompt, which src/explain/fitPrompt.ts may cut to fit. */
export interface ExplainPromptParts {
  /** The context block from formatContext or formatSelection. */
  context: string;
  /** The PR's title, or ''. */
  title: string;
  /** descriptionBlock() of the PR's description, a note that it was left out, or ''. */
  description: string;
  /** fileContextSection() of the file context (PR 6.3), or ''. */
  fileContext?: string;
  /**
   * Whether the context is a selected block. Left out, it is read from
   * `context`; fitPrompt sets it when measuring the prompt without the context.
   */
  selection?: boolean;
}

/**
 * Puts the pieces together into the system prompt and the user message:
 * the PR, then the file, then the diff around the code, then what to explain.
 * Two clicks in the same PR share everything up to the file, and two clicks
 * in the same function share the file too.
 */
export function assembleExplainPrompt(parts: ExplainPromptParts): ChatMessage[] {
  const selection = parts.selection ?? isSelectionContext(parts.context);
  return [
    { role: 'system', content: EXPLAIN_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        ...prSection(parts.title, parts.description),
        ...(parts.fileContext ? [parts.fileContext, ''] : []),
        '```',
        parts.context.trimEnd(),
        '```',
        '',
        selection ? 'Explain the selected lines as a whole.' : 'Explain the clicked line.',
      ].join('\n'),
    },
  ];
}

// The messages for one explain request, uncut. `contextText` is formatContext
// or formatSelection output; `pr` is the PR's title and description, when
// known, and `file` the lines around the code in the full file (PR 6.3).
export function buildExplainPrompt(
  contextText: string,
  pr?: PrInfo,
  file?: FileContext,
): ChatMessage[] {
  return assembleExplainPrompt({
    context: contextText,
    title: pr?.title.trim() ?? '',
    description: descriptionBlock(pr?.description ?? ''),
    fileContext: file ? fileContextSection(file) : '',
  });
}
