import {
  CHAT_SYSTEM_PROMPT,
  ChatSession,
  ChatSessions,
  EXPLANATION_HEADINGS,
  formatExplanation,
  type ChatSeed,
} from '../src/chat/chatSession';
import { SECTION_HEADINGS } from '../src/explain/explainPrompt';
import { SAMPLE_CONTEXT } from '../src/explain/sampleContext';

const SEED: ChatSeed = {
  context: SAMPLE_CONTEXT,
  explanation: {
    what: 'Defines the host names that count as this laptop.',
    why: 'The settings page only accepts a local LLM address.',
    concerns: '- `[::1]` needs brackets in a URL.',
  },
};

const EXPLANATION_TEXT = [
  '## What it does',
  'Defines the host names that count as this laptop.',
  '',
  "## Why it's needed",
  'The settings page only accepts a local LLM address.',
  '',
  '## Concerns',
  '- `[::1]` needs brackets in a URL.',
].join('\n');

describe('ChatSession', () => {
  it('starts from an explanation with no turns', () => {
    const session = new ChatSession(SEED);
    expect(session.context).toBe(SAMPLE_CONTEXT);
    expect(session.explanation).toEqual(SEED.explanation);
    expect(session.turns).toEqual([]);
  });

  it('refuses to start without code context', () => {
    expect(() => new ChatSession({ ...SEED, context: '  \n' })).toThrow(/code context/);
  });

  it('keeps its own copy of the explanation', () => {
    const explanation = { ...SEED.explanation };
    const session = new ChatSession({ context: SAMPLE_CONTEXT, explanation });
    explanation.what = 'changed';
    expect(session.explanation.what).toBe(SEED.explanation.what);
  });

  it('builds the exact message list for the first question', () => {
    const session = new ChatSession({ ...SEED, context: `${SAMPLE_CONTEXT}\n\n` });
    expect(session.messagesFor('  How would I unit test this?\n')).toEqual([
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Explain this code from a pull request diff.\n\n\`\`\`\n${SAMPLE_CONTEXT}\n\`\`\``,
      },
      { role: 'assistant', content: EXPLANATION_TEXT },
      { role: 'user', content: 'How would I unit test this?' },
    ]);
  });

  it('includes earlier turns, oldest first, before the new question', () => {
    const session = new ChatSession(SEED);
    expect(session.addTurn('How would I unit test this?', 'Call isLocal with each host.')).toBe(
      true,
    );
    expect(session.addTurn('Can you show that in Vitest?', '```ts\nit(...)\n```')).toBe(true);

    const messages = session.messagesFor('What about IPv6?');
    expect(messages.slice(3)).toEqual([
      { role: 'user', content: 'How would I unit test this?' },
      { role: 'assistant', content: 'Call isLocal with each host.' },
      { role: 'user', content: 'Can you show that in Vitest?' },
      { role: 'assistant', content: '```ts\nit(...)\n```' },
      { role: 'user', content: 'What about IPv6?' },
    ]);
    expect(session.turns).toEqual([
      { question: 'How would I unit test this?', answer: 'Call isLocal with each host.' },
      { question: 'Can you show that in Vitest?', answer: '```ts\nit(...)\n```' },
    ]);
  });

  it('does not record anything when only building messages (a failed or stopped request)', () => {
    const session = new ChatSession(SEED);
    session.messagesFor('First try');
    expect(session.turns).toEqual([]);
    expect(session.messagesFor('Second try').at(-1)).toEqual({
      role: 'user',
      content: 'Second try',
    });
    expect(session.messagesFor('Second try')).toHaveLength(4);
  });

  it('does not record a turn with an empty answer', () => {
    const session = new ChatSession(SEED);
    expect(session.addTurn('Why?', '   ')).toBe(false);
    expect(session.turns).toEqual([]);
  });

  it('rejects an empty question', () => {
    const session = new ChatSession(SEED);
    expect(() => session.messagesFor(' \n')).toThrow(/empty/);
    expect(() => session.addTurn('', 'answer')).toThrow(/empty/);
  });

  it('does not let callers change the recorded turns', () => {
    const session = new ChatSession(SEED);
    session.addTurn('Q', 'A');
    const turns = session.turns as { question: string; answer: string }[];
    turns[0]!.answer = 'changed';
    turns.push({ question: 'x', answer: 'y' });
    expect(session.turns).toEqual([{ question: 'Q', answer: 'A' }]);
  });
});

describe('formatExplanation', () => {
  it('uses the same headings as the explain prompt', () => {
    expect(EXPLANATION_HEADINGS).toEqual(SECTION_HEADINGS);
  });

  it('writes the three sections in order, trimmed', () => {
    expect(
      formatExplanation({ what: ' Does a thing.\n', why: 'Because.', concerns: 'None found.' }),
    ).toBe(
      "## What it does\nDoes a thing.\n\n## Why it's needed\nBecause.\n\n## Concerns\nNone found.",
    );
  });
});

describe('ChatSessions', () => {
  it('has no session for a PR until one is started', () => {
    expect(new ChatSessions().get('owner/repo#1')).toBeUndefined();
  });

  it('reuses one session per PR', () => {
    const sessions = new ChatSessions();
    const first = sessions.sessionFor('owner/repo#1', SEED);
    first.addTurn('Q', 'A');

    const again = sessions.sessionFor('owner/repo#1', {
      context: 'File: other.ts',
      explanation: { what: 'other', why: 'other', concerns: 'other' },
    });
    expect(again).toBe(first);
    expect(again.context).toBe(SAMPLE_CONTEXT);
    expect(again.turns).toHaveLength(1);
    expect(sessions.get('owner/repo#1')).toBe(first);
  });

  it('keeps a separate session for each PR', () => {
    const sessions = new ChatSessions();
    const one = sessions.sessionFor('owner/repo#1', SEED);
    const two = sessions.sessionFor('owner/repo#2', SEED);
    expect(two).not.toBe(one);
    one.addTurn('Q', 'A');
    expect(two.turns).toEqual([]);
  });

  it('does not keep a session that failed to start', () => {
    const sessions = new ChatSessions();
    expect(() => sessions.sessionFor('owner/repo#1', { ...SEED, context: '' })).toThrow();
    expect(sessions.get('owner/repo#1')).toBeUndefined();
  });
});
