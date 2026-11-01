// Splits the model's reply into the three sections the popup shows. Local
// models do not always follow the format, so this copes with:
// - heading levels other than ##, bold headings (**Concerns**), headings
//   with a colon or a number ("1. What it does:"), and text on the same line
//   as a bold or colon heading ("**Concerns:** none");
// - text before the first heading, and <think> blocks from reasoning models;
// - missing sections, and a reply with no headings at all (all of it goes
//   under "What it does").

export interface Explanation {
  what: string;
  why: string;
  concerns: string;
}

export type SectionKey = keyof Explanation;

export const NO_CONCERNS = 'None found.';
export const NO_REASON = 'The model did not say.';
export const NO_ANSWER = 'The model gave an empty answer.';

// Heading names, lowercased, with straight apostrophes. Several wordings map
// to the same section.
const HEADING_NAMES: Record<string, SectionKey> = {
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
const HEADING = new RegExp(
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

export function parseExplanation(reply: string): Explanation {
  const text = reply.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const sections: Partial<Record<SectionKey, string[]>> = {};
  const preamble: string[] = [];
  let current: string[] = preamble;

  for (const line of text.split(/\r?\n/)) {
    const heading = matchHeading(line);
    if (heading) {
      // A repeated heading adds to the same section.
      current = sections[heading.key] ??= [];
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
  return {
    what: what || intro || NO_ANSWER,
    why: join(sections.why) || NO_REASON,
    concerns: join(sections.concerns) || NO_CONCERNS,
  };
}
