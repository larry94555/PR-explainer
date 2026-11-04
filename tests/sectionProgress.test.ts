import * as parser from '../src/explain/parseExplanation';
import { parseExplanation } from '../src/explain/parseExplanation';
import * as progress from '../src/popup/sectionProgress';
import { sectionProgress } from '../src/popup/sectionProgress';

const keys = (reply: string) => sectionProgress(reply).finished.map((s) => s.key);
const text = (reply: string, key: string) =>
  sectionProgress(reply).finished.find((s) => s.key === key)?.markdown;

describe('sectionProgress (PR 9.13)', () => {
  it('finishes nothing before the second heading', () => {
    expect(keys('')).toEqual([]);
    expect(keys('Sure! Here is')).toEqual([]);
    expect(keys('## What it does\nAdds a loop.')).toEqual([]);
    expect(sectionProgress('## What it does\nAdds a loop.').writing).toEqual({
      key: 'what',
      markdown: 'Adds a loop.',
    });
  });

  it('finishes a section once the next heading has started, even half written', () => {
    const reply = '## What it does\nAdds a loop.\n\n## Why';
    expect(keys(reply)).toEqual(['what']);
    expect(text(reply, 'what')).toBe('Adds a loop.');
    expect(sectionProgress(reply).writing).toEqual({ key: 'why', markdown: '' });
    // "## Wh" is not a heading yet.
    expect(keys('## What it does\nAdds a loop.\n\n## Wh')).toEqual([]);
  });

  it('finishes the first two once Concerns starts, with bold and colon headings', () => {
    const reply =
      "**What it does:** Adds a loop.\n**Why it's needed:** The server is slow.\n**Concerns:** No";
    expect(keys(reply)).toEqual(['what', 'why']);
    expect(text(reply, 'why')).toBe('The server is slow.');
    expect(sectionProgress(reply).writing).toEqual({ key: 'concerns', markdown: 'No' });
  });

  it('takes text before the first heading as What it does when that heading is missing', () => {
    const reply = 'Adds a loop.\n\n## Why it is needed\nSlow';
    expect(keys(reply)).toEqual(['what']);
    expect(text(reply, 'what')).toBe('Adds a loop.');
  });

  it('marks a skipped section finished, with the usual text', () => {
    const reply = '## What it does\nAdds a loop.\n## Concerns\n';
    expect(keys(reply)).toEqual(['what', 'why']);
    expect(text(reply, 'why')).toBe(parser.NO_REASON);
  });

  it('ignores headings inside thinking', () => {
    expect(keys('<think>## What it does\n## Concerns\nhmm')).toEqual([]);
    expect(keys('<think>## Concerns</think>## What it does\nA.\n## Why\n')).toEqual(['what']);
  });
});

describe('sectionProgress agrees with parseExplanation', () => {
  it('uses the same heading names and pattern', () => {
    expect(progress.HEADING_NAMES).toEqual(parser.HEADING_NAMES);
    expect(progress.HEADING.source).toBe(parser.HEADING.source);
    expect(progress.HEADING.flags).toBe(parser.HEADING.flags);
  });

  const REPLIES = [
    "## What it does\nAdds a `retry` loop.\n\n- tries **three** times\n\n## Why it's needed\nThe server is slow.\n\n## Concerns\n- None found.",
    'Sure! Here it is.\n\n### What it does:\nAdds a loop.\n### Why it’s needed:\nSlow.\n### Potential concerns\nNo backoff.',
    '**What it does:** Adds a loop.\n**Why:** Slow.\n**Concerns:** none',
    '1. What it does\nAdds a loop.\n2. Why it is needed\nSlow.\n3. Concerns\nNone.',
    'Adds a loop with no headings at all.\n## Concerns\n- Blocks.',
    '<think>## What it does\nhmm</think>\n## What it does\nA.\n## Why\nB.\n## Concerns\nC.',
  ];

  it.each(REPLIES)(
    'gives each finished section the text the final parse shows, at every point: %#',
    (reply) => {
      for (let end = 0; end <= reply.length; end++) {
        const soFar = reply.slice(0, end);
        const parsed = parseExplanation(soFar);
        for (const { key, markdown } of sectionProgress(soFar).finished) {
          expect(markdown).toBe(parsed[key]);
          // A finished section does not change as the rest is written.
          expect(markdown).toBe(parseExplanation(reply)[key]);
        }
      }
    },
  );
});
