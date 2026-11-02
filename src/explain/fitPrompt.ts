// Builds an explain prompt that fits the model's context window (PR 6.2).
//
// What is kept, most important first: the instructions and the PR title, the
// clicked line or selected block, the lines around it, and the PR
// description. When the whole prompt is over the budget, the description is
// cut first (at a word break), then the lines around the code, farthest from
// the clicked code first. The instructions and the clicked code are never
// cut; when they alone do not fit, fitToBudget throws PromptTooLargeError.

import type { ChatMessage } from '../llm/types';
import {
  assembleExplainPrompt,
  descriptionBlock,
  isSelectionContext,
  type ExplainPromptParts,
  type PrInfo,
} from './explainPrompt';
import { estimateTokens, fitToBudget, type BudgetPart } from './tokenBudget';

// Copies of SURROUNDING_HEADING and CLICKED_MARK in src/lineContext.ts (the
// content script cannot share code with the service worker); a test checks
// they agree. The selection headings come from formatSelection.
export const SURROUNDING_HEADING = 'Surrounding diff (the clicked line starts with >):';
export const CLICKED_MARK = '>';
const BEFORE_SELECTION = 'Lines before the selection:';
const SELECTED = 'Selected lines:';
const AFTER_SELECTION = 'Lines after the selection:';

// Tokens each message costs on top of its text (role markers and the like).
const MESSAGE_OVERHEAD = 8;

export const NOTES = {
  description: '(left out to fit the context size)',
  before: (n: number) => `(${n} earlier ${n === 1 ? 'line' : 'lines'} left out)`,
  after: (n: number) => `(${n} later ${n === 1 ? 'line' : 'lines'} left out)`,
  descriptionCut: '… (description trimmed)',
};

export const PART_LABELS = {
  instructions: 'instructions',
  code: 'lines around the code',
  description: 'PR description',
} as const;

/**
 * A context block split around the code it is about: `lead` (file, clicked
 * line, headings), `before` and `after` (the lines around the code, which may
 * be cut), and `middle` (the clicked line or the selected block).
 */
export interface ContextLayout {
  lead: string[];
  before: string[];
  middle: string[];
  after: string[];
}

/**
 * Splits a formatContext or formatSelection block. Returns null for text in
 * neither shape (such as a hand-written context in the dev console), which
 * is then sent whole.
 */
export function parseContext(text: string): ContextLayout | null {
  const lines = text.trimEnd().split('\n');
  const isHeader = (line: string | undefined) => line?.startsWith('@@') === true;

  const surrounding = lines.indexOf(SURROUNDING_HEADING);
  if (surrounding >= 0) {
    const start = surrounding + 1 + (isHeader(lines[surrounding + 1]) ? 1 : 0);
    const clicked = lines.findIndex((l, i) => i >= start && l.startsWith(CLICKED_MARK));
    if (clicked < 0) return null;
    return {
      lead: lines.slice(0, start),
      before: lines.slice(start, clicked),
      middle: [lines[clicked]!],
      after: lines.slice(clicked + 1),
    };
  }

  const beforeAt = lines.indexOf(BEFORE_SELECTION);
  const selectedAt = lines.indexOf(SELECTED);
  const afterAt = lines.indexOf(AFTER_SELECTION);
  if (beforeAt < 0 || selectedAt < beforeAt || afterAt < selectedAt) return null;
  const start = beforeAt + 1 + (isHeader(lines[beforeAt + 1]) ? 1 : 0);
  // formatSelection puts a blank line before each heading.
  const beforeEnd = lines[selectedAt - 1] === '' ? selectedAt - 1 : selectedAt;
  return {
    lead: lines.slice(0, start),
    before: lines.slice(start, Math.max(start, beforeEnd)),
    middle: lines.slice(Math.max(start, beforeEnd), afterAt + 1),
    after: lines.slice(afterAt + 1),
  };
}

/** The block with only the `keepBefore` lines nearest the code before it, and `keepAfter` after. */
export function renderContext(
  layout: ContextLayout,
  keepBefore: number,
  keepAfter: number,
): string {
  const { lead, before, middle, after } = layout;
  const cutBefore = before.length - keepBefore;
  const cutAfter = after.length - keepAfter;
  return [
    ...lead,
    ...(cutBefore > 0 ? [NOTES.before(cutBefore)] : []),
    ...before.slice(cutBefore),
    ...middle,
    ...after.slice(0, keepAfter),
    ...(cutAfter > 0 ? [NOTES.after(cutAfter)] : []),
  ].join('\n');
}

// The context as a budget part: whole, cut down line by line (farthest from
// the code first), or, at its floor, with no lines around the code.
function contextPart(text: string): BudgetPart {
  const layout = parseContext(text);
  if (!layout) return { label: PART_LABELS.code, text };
  return {
    label: PART_LABELS.code,
    text,
    floor: renderContext(layout, 0, 0),
    shrink(maxTokens) {
      let b = layout.before.length;
      let a = layout.after.length;
      let result = renderContext(layout, b, a);
      while (estimateTokens(result) > maxTokens && (b > 0 || a > 0)) {
        // Before-line b and after-line a are b and a lines from the code.
        if (b >= a) b--;
        else a--;
        result = renderContext(layout, b, a);
      }
      return result;
    },
  };
}

// The description as a budget part: whole, cut at a word break, or left out.
function descriptionPart(description: string): BudgetPart {
  const block = descriptionBlock;
  return {
    label: PART_LABELS.description,
    text: block(description),
    floor: NOTES.description,
    shrink(maxTokens) {
      // The longest cut that fits, found by halving the range of lengths.
      let low = 0;
      let high = description.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (estimateTokens(block(cutAt(description, mid))) <= maxTokens) low = mid;
        else high = mid - 1;
      }
      return low > 0 ? block(cutAt(description, low)) : NOTES.description;
    },
  };
}

// The first `length` characters, back to the last word break, with a note.
function cutAt(text: string, length: number): string {
  if (length >= text.length) return text;
  const head = text.slice(0, length);
  const space = head.search(/\s\S*$/);
  const cut = (space > 0 ? head.slice(0, space) : head).trimEnd();
  return cut ? `${cut} ${NOTES.descriptionCut}` : '';
}

/** What "Show prompt" shows under an explanation. */
export interface PromptReport {
  /** The messages as sent, one after another. */
  text: string;
  /** Estimated tokens in the prompt. */
  tokens: number;
  /** Tokens the prompt may use: the context size less room for the reply. */
  budget: number;
  /** The context size the model was run with. */
  contextTokens: number;
  /** What was cut to fit, such as "PR description". Empty when nothing was. */
  trimmed: string[];
}

export interface FittedPrompt {
  messages: ChatMessage[];
  tokens: number;
  trimmed: string[];
}

/** Estimated tokens for a list of messages, with a little for each message's framing. */
export function estimateMessages(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + estimateTokens(m.content) + MESSAGE_OVERHEAD, 0);
}

/**
 * The explain prompt for `contextText` and `pr`, cut to fit `budget` tokens.
 * Throws PromptTooLargeError when the instructions and the code alone are
 * over it.
 */
export function buildFittedExplainPrompt(
  contextText: string,
  pr: PrInfo | undefined,
  budget: number,
): FittedPrompt {
  const title = pr?.title.trim() ?? '';
  const description = pr?.description.trim() ?? '';
  // The instructions part is everything that is not cut: the whole prompt
  // without the context and the description, measured once.
  // Measured with the system prompt the real context gets: a selection's is longer.
  const bare = assembleExplainPrompt({
    context: '',
    title,
    description: '',
    selection: isSelectionContext(contextText),
  });
  const parts: BudgetPart[] = [
    { label: PART_LABELS.instructions, text: bare.map((m) => m.content).join('\n') },
    contextPart(contextText),
    ...(description ? [descriptionPart(description)] : []),
  ];
  const overhead = bare.length * MESSAGE_OVERHEAD;
  const fitted = fitToBudget(parts, budget - overhead);
  const prompt: ExplainPromptParts = {
    context: fitted.texts[1]!,
    title,
    description: fitted.texts[2] ?? '',
  };
  const messages = assembleExplainPrompt(prompt);
  return { messages, tokens: estimateMessages(messages), trimmed: fitted.trimmed };
}
