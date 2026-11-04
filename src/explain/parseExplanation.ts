// Splits the model's reply into the three sections the popup shows. Local
// models do not always follow the format, so this copes with:
// - heading levels other than ##, bold headings (**Concerns**), headings
//   with a colon or a number ("1. What it does:"), and text on the same line
//   as a bold or colon heading ("**Concerns:** none");
// - text before the first heading, and <think> blocks from reasoning models;
// - missing sections, and a reply with no headings at all (all of it goes
//   under "What it does");
// - a reply cut off at the answer limit (PR 8.4): the section it stopped in
//   ends with "…", and the sections it never reached say so instead of
//   pretending the model had nothing to add.

export interface Explanation {
  what: string;
  why: string;
  concerns: string;
  /** True when the reply hit the answer limit and stopped early (PR 8.4). */
  cutOff?: boolean;
}

export interface ParseOptions {
  /** The model stopped because it hit the answer limit (Ollama's done_reason "length"). */
  cutOff?: boolean;
}

export type SectionKey = 'what' | 'why' | 'concerns';

export const NO_CONCERNS = 'None found.';
export const NO_REASON = 'The model did not say.';
export const NO_ANSWER = 'The model gave an empty answer.';
/** In place of a section the answer was cut off before (PR 8.4). */
export const CUT_OFF_BEFORE = 'Cut off before this part.';
/** Added to the end of the section the answer was cut off in. */
export const CUT_OFF_MARK = ' …';

const SECTION_ORDER: readonly SectionKey[] = ['what', 'why', 'concerns'];

// Heading names, lowercased, with straight apostrophes. Several wordings map
// to the same section. src/popup/sectionProgress.ts keeps its own copy for
// the content script (PR 9.13); tests/sectionProgress.test.ts checks they match.
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

// Matches a heading line and captures the heading name and any text after it.
// The name must be followed by the end of the line, a colon, or closing bold,
// so a sentence such as "What it does is..." is not taken as a heading.
export const HEADING = new RegExp(
  '^\\s*(?:#{1,6}\\s*)?(?:\\*\\*|__)?\\s*(?:\\d+[.)]\\s*)?' +
    `(${Object.keys(HEADING_NAMES)
      .sort((a, b) => b.length - a.length)
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')})` +
    '\\s*(?::\\s*(?:\\*\\*|__)?|(?:\\*\\*|__)\\s*:?|(?=$))\\s*(.*)$',
  'i',
);

// Returns the section a line starts, and the text after the heading, or null
// when the line is not a heading.
function matchHeading(line: string): { key: SectionKey; rest: string } | null {
  const match = HEADING.exec(line);
  if (!match) return null;
  const name = match[1]!.toLowerCase().replace('’', "'");
  const key = HEADING_NAMES[name];
  return key ? { key, rest: match[2]!.trim() } : null;
}

export function parseExplanation(reply: string, options: ParseOptions = {}): Explanation {
  // A reply cut off inside a <think> block has no closing tag; drop the rest.
  const text = reply.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
  const sections: Partial<Record<SectionKey, string[]>> = {};
  const preamble: string[] = [];
  let current: string[] = preamble;
  // The section the reply ended in: the last heading, or "what" if none.
  let last: SectionKey = 'what';

  for (const line of text.split(/\r?\n/)) {
    const heading = matchHeading(line);
    if (heading) {
      // A repeated heading adds to the same section.
      current = sections[heading.key] ??= [];
      last = heading.key;
      if (heading.rest) current.push(heading.rest);
    } else {
      current.push(line);
    }
  }

  const join = (lines: string[] | undefined) => (lines ?? []).join('\n').trim();
  const intro = join(preamble);
  const what = join(sections.what);
  // Text before the first heading is usually filler ("Sure! Here is...") when
  // the model did write a "What it does" section, and the whole answer when
  // it did not.
  const found: Record<SectionKey, string> = {
    what: what || intro,
    why: join(sections.why),
    concerns: join(sections.concerns),
  };
  if (options.cutOff) {
    // Sections after the one it stopped in were never reached. A section the
    // model skipped before that point keeps the usual text below.
    const stoppedAt = SECTION_ORDER.indexOf(last);
    for (const key of SECTION_ORDER.slice(stoppedAt)) {
      if (!found[key]) found[key] = CUT_OFF_BEFORE;
      else if (key === last) found[key] += CUT_OFF_MARK;
    }
  }
  return {
    what: found.what || NO_ANSWER,
    why: found.why || NO_REASON,
    concerns: found.concerns || NO_CONCERNS,
    ...(options.cutOff && { cutOff: true }),
  };
}
