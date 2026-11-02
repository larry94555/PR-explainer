// Keeps a prompt inside the model's context window (PR 6.2). Local models
// often have small windows (2k to 8k tokens), and Ollama silently drops the
// start of a prompt that does not fit, so the prompt is measured and cut
// before it is sent.
//
// estimateTokens is a rough count with no tokenizer: the extension does not
// know which model the user runs, and each model splits text differently. It
// is meant to come out a little high for code and prose, so a prompt that
// fits by the estimate also fits for real.
//
// fitToBudget takes the prompt's parts, most important first, and cuts the
// least important ones until the total fits: each part says how far it may be
// cut (its floor) and how to cut it part of the way (shrink).

/**
 * About how many tokens `text` is. Words cost one token per six letters,
 * numbers one per three digits, and each symbol or line break one token;
 * spaces between words are free. Other alphabets cost two per character.
 * On this repo's code and docs it comes out 5% to 40% over a real tokenizer's
 * count, and never under (see tests/tokenBudget.test.ts).
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(/[A-Za-z]+|\d+|\s+|[^\sA-Za-z\d]/gu)) {
    const first = piece.charCodeAt(0);
    if (/[A-Za-z]/.test(piece[0]!)) tokens += Math.ceil(piece.length / 6);
    else if (first >= 48 && first <= 57) tokens += Math.ceil(piece.length / 3);
    else if (/\s/.test(piece[0]!)) {
      // A newline, or a run of indentation, is a token of its own; a single
      // space joins the word after it.
      if (piece.includes('\n') || piece.length > 1) tokens += 1;
    } else tokens += first < 128 ? 1 : 2;
  }
  return tokens;
}

export interface BudgetPart {
  /** What the part is, for the "trimmed" list, such as "PR description". */
  label: string;
  text: string;
  /**
   * The part cut as far as it may go. Leave it out for a part that must be
   * sent whole (the clicked code, the instructions).
   */
  floor?: string;
  /**
   * The longest form of the part within `maxTokens`, never shorter than the
   * floor. Without it, a part that has to be cut goes straight to its floor.
   */
  shrink?(maxTokens: number): string;
}

export interface FittedParts {
  /** The text to send for each part, in the order the parts were given. */
  texts: string[];
  /** The estimated total of `texts`. */
  tokens: number;
  /** Labels of the parts that were cut, most important first. */
  trimmed: string[];
}

/** Even every part cut to its floor is over the budget. */
export class PromptTooLargeError extends Error {
  override name = 'PromptTooLargeError';
  constructor(
    /** Estimated tokens with every part at its floor. */
    readonly needed: number,
    readonly budget: number,
  ) {
    super(`The prompt needs about ${needed} tokens, but only ${budget} are available.`);
  }
}

/**
 * Cuts `parts` (most important first) until their estimated total is within
 * `budget` tokens, starting from the least important. Throws
 * PromptTooLargeError when even the floors do not fit.
 */
export function fitToBudget(parts: BudgetPart[], budget: number): FittedParts {
  const texts = parts.map((p) => p.text);
  const sizes = texts.map(estimateTokens);
  let total = sum(sizes);
  const cut = new Set<number>();
  if (total > budget) {
    const needed = sum(parts.map((p) => estimateTokens(p.floor ?? p.text)));
    if (needed > budget) throw new PromptTooLargeError(needed, budget);
    for (let i = parts.length - 1; i >= 0 && total > budget; i--) {
      const part = parts[i]!;
      if (part.floor === undefined) continue;
      const allowed = sizes[i]! - (total - budget);
      let text = part.shrink && allowed > 0 ? part.shrink(allowed) : part.floor;
      // A shrink that overshoots, or would grow the part, falls back to the floor.
      if (estimateTokens(text) > Math.max(allowed, 0)) text = part.floor;
      if (text === texts[i]) continue;
      const size = estimateTokens(text);
      total += size - sizes[i]!;
      texts[i] = text;
      sizes[i] = size;
      cut.add(i);
    }
  }
  return {
    texts,
    tokens: total,
    trimmed: parts.filter((_, i) => cut.has(i)).map((p) => p.label),
  };
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
