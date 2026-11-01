import {
  NO_ANSWER,
  NO_CONCERNS,
  NO_REASON,
  parseExplanation,
} from '../src/explain/parseExplanation';

describe('parseExplanation', () => {
  it('splits a well-formed reply into the three sections', () => {
    const reply = [
      '## What it does',
      'Lists the loopback host names.',
      '',
      "## Why it's needed",
      'Settings only accept local LLM servers.',
      '',
      '## Concerns',
      '- `0.0.0.0` is not included.',
      '- IPv6 needs brackets.',
    ].join('\n');
    expect(parseExplanation(reply)).toEqual({
      what: 'Lists the loopback host names.',
      why: 'Settings only accept local LLM servers.',
      concerns: '- `0.0.0.0` is not included.\n- IPv6 needs brackets.',
    });
  });

  it('says "None found." when Concerns is missing or empty', () => {
    expect(parseExplanation('## What it does\nA.\n## Why it’s needed\nB.').concerns).toBe(
      NO_CONCERNS,
    );
    expect(parseExplanation('## What it does\nA.\n## Concerns\n\n').concerns).toBe(NO_CONCERNS);
  });

  it('fills in a missing "Why it\'s needed"', () => {
    expect(parseExplanation('## What it does\nA.\n## Concerns\nC.').why).toBe(NO_REASON);
  });

  it.each([
    ['# level 1', '# What it does\nA.\n# Why it is needed\nB.\n# Concerns\nC.'],
    ['### level 3', "### What it does\nA.\n### Why it's needed\nB.\n### Concerns\nC."],
    ['bold', "**What it does**\nA.\n**Why it's needed**\nB.\n**Concerns**\nC."],
    ['bold with a colon', "**What it does:**\nA.\n**Why it's needed:**\nB.\n**Concerns:**\nC."],
    ['numbered', "1. What it does:\nA.\n2. Why it's needed:\nB.\n3. Concerns:\nC."],
    ['mixed case', "## WHAT IT DOES\nA.\n## why it's needed\nB.\n## concerns\nC."],
    [
      'Windows line endings',
      "## What it does\r\nA.\r\n## Why it's needed\r\nB.\r\n## Concerns\r\nC.",
    ],
  ])('accepts %s headings', (_, reply) => {
    expect(parseExplanation(reply)).toEqual({ what: 'A.', why: 'B.', concerns: 'C.' });
  });

  it('keeps text written on the same line as a bold or colon heading', () => {
    const reply = "**What it does:** A.\n**Why it's needed**: B.\nConcerns: None.";
    expect(parseExplanation(reply)).toEqual({ what: 'A.', why: 'B.', concerns: 'None.' });
  });

  it('does not take a sentence that starts like a heading as a heading', () => {
    const reply = '## What it does\nWhat it does is check the host.\n## Concerns\nC.';
    expect(parseExplanation(reply).what).toBe('What it does is check the host.');
  });

  it('drops filler before the first heading and <think> blocks', () => {
    const reply = [
      '<think>The user wants three sections.\n## Concerns\nnot this</think>',
      'Sure! Here is the explanation.',
      '## What it does',
      'A.',
      '## Concerns',
      'C.',
    ].join('\n');
    expect(parseExplanation(reply)).toEqual({ what: 'A.', why: NO_REASON, concerns: 'C.' });
  });

  it('puts all text under "What it does" when there are no headings', () => {
    const reply = 'This line lists the loopback hosts.\n\nIt is used by validation.';
    expect(parseExplanation(reply)).toEqual({
      what: 'This line lists the loopback hosts.\n\nIt is used by validation.',
      why: NO_REASON,
      concerns: NO_CONCERNS,
    });
  });

  it('uses the text before the headings when "What it does" is missing', () => {
    const reply = "Lists the hosts.\n## Why it's needed\nB.";
    expect(parseExplanation(reply).what).toBe('Lists the hosts.');
  });

  it('handles an empty reply', () => {
    expect(parseExplanation('  ')).toEqual({
      what: NO_ANSWER,
      why: NO_REASON,
      concerns: NO_CONCERNS,
    });
  });
});
