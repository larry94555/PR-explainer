import { parseHunkExplanation } from '../src/explain/parseHunkExplanation';

const part = (n: number, what: string) =>
  [
    `### [${n}]`,
    `What it does: ${what}`,
    "Why it's needed: Because.",
    'Concerns: None found.',
  ].join('\n');

describe('parseHunkExplanation', () => {
  it('splits a full reply into one explanation per line, in order', () => {
    const reply = [part(1, 'Adds a comment.'), part(2, 'Lists the local hosts.')].join('\n\n');
    expect(parseHunkExplanation(reply, 2)).toEqual([
      { what: 'Adds a comment.', why: 'Because.', concerns: 'None found.' },
      { what: 'Lists the local hosts.', why: 'Because.', concerns: 'None found.' },
    ]);
  });

  it('gives null for a line the reply left out', () => {
    const reply = [part(1, 'One.'), part(3, 'Three.')].join('\n');
    const out = parseHunkExplanation(reply, 3);
    expect(out.map((e) => e?.what ?? null)).toEqual(['One.', null, 'Three.']);
  });

  it('places parts that come out of order by their number', () => {
    const reply = [part(2, 'Two.'), part(1, 'One.')].join('\n');
    expect(parseHunkExplanation(reply, 2).map((e) => e?.what)).toEqual(['One.', 'Two.']);
  });

  it('leaves out the part the reply was cut off in', () => {
    const reply = [part(1, 'One.'), '### [2]', 'What it does: Starts to'].join('\n');
    expect(parseHunkExplanation(reply, 2, { cutOff: true }).map((e) => e?.what ?? null)).toEqual([
      'One.',
      null,
    ]);
    // Even one that looks whole, since its last section may have stopped midway.
    const whole = [part(1, 'One.'), part(2, 'Two.')].join('\n');
    expect(parseHunkExplanation(whole, 2, { cutOff: true })[1]).toBeNull();
  });

  it('cannot read a part without its What and Why, nor numbers outside the list', () => {
    const reply = [
      '### [1]',
      'Some text with no headings.',
      part(2, 'Two.'),
      part(5, 'Five.'),
      part(2, 'Two again.'),
    ].join('\n');
    expect(parseHunkExplanation(reply, 2).map((e) => e?.what ?? null)).toEqual([null, 'Two.']);
  });

  it('reads other ways models write the headings, and ignores text before the first and thinking', () => {
    const reply = [
      '<think>Let me look.</think>Sure, here they are.',
      '**[1]** line 40: +foo',
      '**What it does:** One.',
      "**Why it's needed:** Why one.",
      '1.',
      '## What it does',
      'Bad: this "1." heading repeats line 1, so it is ignored.',
      '## Why',
      'x',
      '2)',
      '## What it does',
      'Two.',
      "## Why it's needed",
      'Why two.',
      '## Concerns',
      '- Might be slow.',
    ].join('\n');
    const out = parseHunkExplanation(reply, 2);
    expect(out[0]).toEqual({ what: 'One.', why: 'Why one.', concerns: 'None found.' });
    expect(out[1]).toEqual({ what: 'Two.', why: 'Why two.', concerns: '- Might be slow.' });
  });

  it('gives all nulls for a reply with no parts', () => {
    expect(parseHunkExplanation('I cannot help with that.', 2)).toEqual([null, null]);
  });
});
