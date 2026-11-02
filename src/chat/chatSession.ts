// The record of one chat about the code (Milestone 5). A chat starts from an
// explanation the popup has shown: the session keeps the code context that
// was sent to the model, the explanation it gave, and the questions and
// answers that follow, and builds the message list the LLM is sent for the
// next question. It has no UI and does not talk to the LLM; the chat panel
// (PR 5.2) and the streaming hookup (PR 5.3) use it.
//
// The sessions live in the content script, so a conversation lasts as long as
// the tab and is never written to storage. That also means this file must not
// share runtime imports with the service worker (see src/content.ts): it only
// imports types, and keeps its own copy of the section headings, which a test
// checks against src/explain/explainPrompt.ts.

import type { Explanation } from '../explain/parseExplanation';
import type { ChatMessage } from '../llm/types';

export const CHAT_SYSTEM_PROMPT = [
  'You are a senior software engineer helping a colleague review a GitHub pull request.',
  'You already explained some code from the diff to them. Answer their follow-up questions about it.',
  'Use the code, the surrounding diff, and the earlier conversation. If the answer depends on code you',
  'were not shown, say so instead of guessing.',
  '',
  'Answer in Markdown. Be concise and specific, and use fenced code blocks for code.',
].join('\n');

// The headings the explain prompt asks for (SECTION_HEADINGS in
// src/explain/explainPrompt.ts). The explanation is replayed to the model in
// the same shape it was written in.
export const EXPLANATION_HEADINGS: Record<keyof Explanation, string> = {
  what: 'What it does',
  why: "Why it's needed",
  concerns: 'Concerns',
};

/** Where a chat starts: the code the popup explained and what the model said. */
export interface ChatSeed {
  /** The context block from formatContext or formatSelection (src/lineContext.ts). */
  context: string;
  /** The explanation shown in the popup. */
  explanation: Explanation;
}

/** One finished question and answer. */
export interface ChatTurn {
  question: string;
  answer: string;
}

/** The model's explanation as Markdown, with the three headings it was asked for. */
export function formatExplanation(explanation: Explanation): string {
  return (Object.keys(EXPLANATION_HEADINGS) as (keyof Explanation)[])
    .map((key) => `## ${EXPLANATION_HEADINGS[key]}\n${explanation[key].trim()}`)
    .join('\n\n');
}

export class ChatSession {
  readonly context: string;
  readonly explanation: Explanation;
  readonly #turns: ChatTurn[] = [];

  constructor(seed: ChatSeed) {
    if (typeof seed.context !== 'string' || !seed.context.trim()) {
      throw new Error('A chat needs the code context it is about');
    }
    this.context = seed.context;
    this.explanation = { ...seed.explanation };
  }

  /** The finished questions and answers, oldest first. */
  get turns(): readonly ChatTurn[] {
    return this.#turns.map((turn) => ({ ...turn }));
  }

  /**
   * The messages to send the model to answer `question`: the system prompt,
   * the code (as the first user message), the explanation (as the model's
   * reply to it), every earlier turn, and then the question. Nothing is
   * recorded, so a request that fails or is stopped before it says anything
   * leaves the session as it was.
   */
  messagesFor(question: string): ChatMessage[] {
    const asked = cleanQuestion(question);
    const messages: ChatMessage[] = [
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          'Explain this code from a pull request diff.',
          '',
          '```',
          this.context.trimEnd(),
          '```',
        ].join('\n'),
      },
      { role: 'assistant', content: formatExplanation(this.explanation) },
    ];
    for (const turn of this.#turns) {
      messages.push({ role: 'user', content: turn.question });
      messages.push({ role: 'assistant', content: turn.answer });
    }
    messages.push({ role: 'user', content: asked });
    return messages;
  }

  /**
   * Records a question and the model's answer, so later questions can build
   * on it. A stopped reply can be recorded with the text it got so far; an
   * empty answer is not recorded, since the model said nothing to build on.
   * Returns whether the turn was recorded.
   */
  addTurn(question: string, answer: string): boolean {
    const asked = cleanQuestion(question);
    const said = answer.trim();
    if (!said) return false;
    this.#turns.push({ question: asked, answer: said });
    return true;
  }
}

function cleanQuestion(question: string): string {
  const asked = question.trim();
  if (!asked) throw new Error('A chat question cannot be empty');
  return asked;
}

/**
 * The chats open in one tab, one per PR. Asking for the same PR again gives
 * back the same session, so a conversation carries on when the chat panel is
 * closed and opened again.
 */
export class ChatSessions {
  readonly #byPr = new Map<string, ChatSession>();

  /** The PR's session, if one was started. */
  get(pr: string): ChatSession | undefined {
    return this.#byPr.get(pr);
  }

  /**
   * The PR's session, started from `seed` if there is none yet. An existing
   * session is reused as it is and `seed` is ignored.
   */
  sessionFor(pr: string, seed: ChatSeed): ChatSession {
    let session = this.#byPr.get(pr);
    if (!session) {
      session = new ChatSession(seed);
      this.#byPr.set(pr, session);
    }
    return session;
  }
}
