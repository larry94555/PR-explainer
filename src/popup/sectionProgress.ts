// Reads a reply that is still arriving, so the popup can show each section as
// soon as it is finished (PR 9.13). A section is finished once the model has
// started a later section's heading: it writes What it does, then Why it's
// needed, then Concerns.
//
// The content script must share no code with the service worker (one shared
// module would turn content.js into an ES module that Chrome cannot run as a
// content script; see tests/networkGuard.test.ts), so this keeps its own copy
// of the heading matcher in src/explain/parseExplanation.ts, and gives each
// finished section the same text parseExplanation would. The final answer
// still comes from the service worker's parse. tests/sectionProgress.test.ts
// checks the two agree.

export type SectionKey = 'what' | 'why' | 'concerns';

export const SECTION_ORDER: readonly SectionKey[] = ['what', 'why', 'concerns'];

// The same as in parseExplanation.ts.
export const HEADING_NAMES: Record<string, SectionKey> = {
  'what it does': 'what',
  'what this does': 'what',
  "why it's needed": 'why',
  'why it is needed': 'why',
  'why it’s needed': 'why',
  why: 'why',
  concerns: 'concerns',
  'potential concerns': 'concerns',
};

// The same as in parseExplanation.ts.
export const HEADING = new RegExp(
  '^\\s*(?:#{1,6}\\s*)?(?:\\*\\*|__)?\\s*(?:\\d+[.)]\\s*)?' +
    `(${Object.keys(HEADING_NAMES)
      .sort((a, b) => b.length - a.length)
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')})` +
    '\\s*(?::\\s*(?:\\*\\*|__)?|(?:\\*\\*|__)\\s*:?|(?=$))\\s*(.*)$',
  'i',
);

// The text parseExplanation shows for a section the model skipped.
const SKIPPED: Record<SectionKey, string> = {
  what: 'The model gave an empty answer.',
  why: 'The model did not say.',
  concerns: 'None found.',
};

/** What a reply still being written holds so far. */
export interface SectionProgress {
  /**
   * The finished sections, in order, with the text parseExplanation would
   * show for each (a skipped one gets its usual "did not say" text).
   */
  finished: Array<{ key: SectionKey; markdown: string }>;
  /** The section being written now, and what is written of it (may be empty). */
  writing: { key: SectionKey; markdown: string };
}

/**
 * Splits a reply that is still arriving into its finished sections and the
 * one being written. Text before any heading is not finished: it may turn
 * out to be filler before "What it does". A heading counts as soon as its
 * name is written ("## Why").
 */
export function sectionProgress(reply: string): SectionProgress {
  const text = reply.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
  const lines: Partial<Record<SectionKey, string[]>> = {};
  const preamble: string[] = [];
  let current = preamble;
  // The furthest section a heading has started, -1 before any heading.
  let reached = -1;
  for (const line of text.split(/\r?\n/)) {
    const match = HEADING.exec(line);
    const key = match && HEADING_NAMES[match[1]!.toLowerCase().replace('’', "'")];
    if (key) {
      current = lines[key] ??= [];
      reached = Math.max(reached, SECTION_ORDER.indexOf(key));
      const rest = match[2]!.trim();
      if (rest) current.push(rest);
    } else current.push(line);
  }
  const join = (part: string[] | undefined) => (part ?? []).join('\n').trim();
  const written = (key: SectionKey) =>
    key === 'what' ? join(lines.what) || join(preamble) : join(lines[key]);
  const done = SECTION_ORDER.slice(0, Math.max(0, reached));
  const writingKey = SECTION_ORDER[Math.max(0, reached)]!;
  return {
    finished: done.map((key) => ({ key, markdown: written(key) || SKIPPED[key] })),
    writing: { key: writingKey, markdown: written(writingKey) },
  };
}
