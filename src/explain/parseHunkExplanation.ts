// Splits the reply to a hunk request (PR 10.5, src/explain/hunkPrompt.ts)
// into one explanation per numbered line. Each line's part starts with a
// heading such as "### [2]" and is read by parseExplanation, so the headings
// may be written in any of the ways it accepts ("What it does:", "**Why**").
//
// A line's part is only used when it is complete enough to show: it must
// have its "What it does" and "Why it's needed" sections. A line with no
// part, or a part that cannot be read, is null, and goes back into the queue
// as a single-line job. Parts may come in any order; a number given twice
// keeps the first. When the reply was cut off at the answer limit, the last
// part may have stopped midway, so it is left out too.

import {
  HEADING,
  HEADING_NAMES,
  parseExplanation,
  type Explanation,
  type SectionKey,
} from './parseExplanation';

// "### [2]", "[2]", "**[2]**", "### 2", "2." on a line of its own. The
// bracketed form may be followed by more text ("[2] line 14: +foo"), since
// models often repeat the list's line.
const PART_HEADING =
  /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:\[(\d+)\](?:\*\*|__)?.*|(\d+)[.):]?\s*(?:\*\*|__)?\s*)$/;

function partNumber(line: string): number | null {
  const match = PART_HEADING.exec(line);
  const digits = match?.[1] ?? match?.[2];
  return digits ? Number(digits) : null;
}

function sectionsIn(body: string): Set<SectionKey> {
  const found = new Set<SectionKey>();
  for (const line of body.split(/\r?\n/)) {
    const match = HEADING.exec(line);
    const key = match && HEADING_NAMES[match[1]!.toLowerCase().replace('’', "'")];
    if (key) found.add(key);
  }
  return found;
}

/**
 * One explanation per line, in the order of the numbered list (`count`
 * lines), or null for a line whose part is missing or cannot be read.
 */
export function parseHunkExplanation(
  reply: string,
  count: number,
  options: { cutOff?: boolean } = {},
): (Explanation | null)[] {
  const text = reply.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
  const parts: { n: number; lines: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const n = partNumber(line);
    if (n !== null) parts.push({ n, lines: [] });
    else parts.at(-1)?.lines.push(line);
  }
  // The part the reply stopped in may be missing its end.
  if (options.cutOff) parts.pop();
  const out: (Explanation | null)[] = Array.from({ length: count }, () => null);
  for (const { n, lines } of parts) {
    if (n < 1 || n > count || out[n - 1]) continue;
    const body = lines.join('\n');
    const found = sectionsIn(body);
    if (!found.has('what') || !found.has('why')) continue;
    out[n - 1] = parseExplanation(body);
  }
  return out;
}
