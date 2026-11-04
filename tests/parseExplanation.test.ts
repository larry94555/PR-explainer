import {
  CUT_OFF_BEFORE,
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

  it('parses a one-sentence answer per section (PR 9.8)', () => {
    const reply = [
      '## What it does',
      'Lists the host names that count as this computer.',
      "## Why it's needed",
      'Settings reject LLM servers on other machines.',
      '## Concerns',
      '- `0.0.0.0` is not accepted.',
    ].join('\n');
    expect(parseExplanation(reply, { cutOff: false })).toEqual({
      what: 'Lists the host names that count as this computer.',
      why: 'Settings reject LLM servers on other machines.',
      concerns: '- `0.0.0.0` is not accepted.',
    });
    const none = reply.replace(/## Concerns[\s\S]*/, '## Concerns\nNone found.');
    expect(parseExplanation(none).concerns).toBe(NO_CONCERNS);
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

  describe('a reply cut off at the answer limit (PR 8.4)', () => {
    it('marks the section it stopped in and the sections it never reached', () => {
      const reply = "## What it does\nLists the hosts.\n## Why it's needed\nSettings only accept";
      expect(parseExplanation(reply, { cutOff: true })).toEqual({
        what: 'Lists the hosts.',
        why: 'Settings only accept …',
        concerns: CUT_OFF_BEFORE,
        cutOff: true,
      });
    });

    it('marks a reply cut off in the first section', () => {
      expect(parseExplanation('## What it does\nLists the', { cutOff: true })).toEqual({
        what: 'Lists the …',
        why: CUT_OFF_BEFORE,
        concerns: CUT_OFF_BEFORE,
        cutOff: true,
      });
    });

    it('marks a reply cut off in the middle of a concerns list', () => {
      const reply = '## What it does\nA.\n## Why it’s needed\nB.\n## Concerns\n- One.\n- Tw';
      expect(parseExplanation(reply, { cutOff: true })).toEqual({
        what: 'A.',
        why: 'B.',
        concerns: '- One.\n- Tw …',
        cutOff: true,
      });
    });

    it('says a section was cut off when it stopped right after the heading', () => {
      const reply = "## What it does\nA.\n## Why it's needed\n";
      const result = parseExplanation(reply, { cutOff: true });
      expect(result.why).toBe(CUT_OFF_BEFORE);
      expect(result.concerns).toBe(CUT_OFF_BEFORE);
    });

    it('keeps the usual text for a section the model skipped before it stopped', () => {
      const reply = '## What it does\nA.\n## Concerns\n- One';
      expect(parseExplanation(reply, { cutOff: true })).toEqual({
        what: 'A.',
        why: NO_REASON,
        concerns: '- One …',
        cutOff: true,
      });
    });

    it('marks a reply with no headings, and one cut off while thinking', () => {
      expect(parseExplanation('Lists the', { cutOff: true }).what).toBe('Lists the …');
      expect(parseExplanation('<think>First I will', { cutOff: true })).toEqual({
        what: CUT_OFF_BEFORE,
        why: CUT_OFF_BEFORE,
        concerns: CUT_OFF_BEFORE,
        cutOff: true,
      });
    });

    it('does not mark a reply that finished', () => {
      const reply = '## What it does\nA.';
      expect(parseExplanation(reply, { cutOff: false })).not.toHaveProperty('cutOff');
      expect(parseExplanation(reply).why).toBe(NO_REASON);
    });
  });
});
