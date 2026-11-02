// Connects the chat panel to the model (PR 5.3). The popup's Ask a question
// button opens the panel with a ChatSession (src/chat/chatSession.ts); each
// question the user sends is answered by streaming the session's message list
// to the service worker, and the answer is written into the panel as it
// arrives.
//
// - A finished answer is recorded in the session, so the next question
//   builds on it.
// - Stop ends the request. Any text the model wrote stays in the panel and is
//   recorded with the question, so a follow-up can refer to it; a stop before
//   any text records nothing.
// - A failed request shows the message and fix in the panel and records
//   nothing, so the user can just ask again.
// In every case the panel is ready for the next question. Closing the panel
// stops a request that is still running; the session stays, so asking again
// about the same code carries on the conversation.
//
// The parts that talk to Chrome and draw the panel are passed in, so the
// tests can use fakes.

import { describeRequestError } from '../clickHandler';
import type { ChatMessage } from '../llm/types';
import type { ChatStream } from '../messaging/client';
import type { ChatPanel, ChatPanelMessage, ChatPanelOptions, ChatSubject } from './chatPanel';
import { ChatSession, formatExplanation, type ChatSeed, type ChatSessions } from './chatSession';

export interface ChatFlowDeps {
  /** Streams the model's answer to `messages`, calling `onChunk` with each piece. */
  ask(messages: ChatMessage[], onChunk: (text: string) => void): ChatStream;
  /** Opens the chat panel, closing any other one. */
  openPanel(options: ChatPanelOptions): ChatPanel;
}

/** Shown when the model finished without writing anything. */
export const EMPTY_ANSWER = {
  message: 'The model finished without writing an answer.',
  fix: 'Ask again, or pick another model on the PR Explainer settings page.',
};

/**
 * The session to chat in for `seed`. The PR's session is reused while it is
 * about the same code and explanation, so closing and reopening the chat
 * carries on the conversation. Asking about other code (or after Regenerate)
 * starts a new one; PR 5.4 keeps the conversation across lines instead.
 * Without a PR name the session is not kept.
 */
export function chatSessionFor(
  sessions: ChatSessions,
  pr: string | undefined,
  seed: ChatSeed,
): ChatSession {
  if (pr === undefined) return new ChatSession(seed);
  const existing = sessions.get(pr);
  const same =
    existing?.context === seed.context &&
    formatExplanation(existing.explanation) === formatExplanation(seed.explanation);
  return same ? existing : sessions.restart(pr, seed);
}

/** The panel's first messages: the explanation, then every earlier turn. */
export function panelMessages(session: ChatSession): ChatPanelMessage[] {
  return [
    { role: 'assistant', text: formatExplanation(session.explanation) },
    ...session.turns.flatMap((turn): ChatPanelMessage[] => [
      { role: 'user', text: turn.question },
      { role: 'assistant', text: turn.answer },
    ]),
  ];
}

/** Opens the chat panel for `session` and answers each question sent in it. */
export function startChat(
  deps: ChatFlowDeps,
  session: ChatSession,
  subject: ChatSubject,
): ChatPanel {
  interface Pending {
    question: string;
    reply: string;
    view: ReturnType<ChatPanel['addMessage']>;
    stream?: ChatStream;
  }
  // The answer being written, if any. Each request checks it is still the
  // pending one, so a stopped request cannot write into the panel.
  let pending: Pending | undefined;

  const finish = () => {
    pending = undefined;
    panel.setBusy(false);
  };

  const send = (question: string) => {
    const messages = session.messagesFor(question);
    const turn: Pending = { question, reply: '', view: panel.addMessage('assistant', '') };
    pending = turn;
    panel.setBusy(true);
    const current = () => pending === turn;
    const stream = deps.ask(messages, (chunk) => {
      if (!current()) return;
      turn.reply += chunk;
      turn.view.update(turn.reply);
    });
    turn.stream = stream;
    stream.result.then(
      (result) => {
        if (!current()) return;
        finish();
        if (result.status === 'failed') return turn.view.showError(result.message, result.fix);
        if (!session.addTurn(question, result.answer)) {
          return turn.view.showError(EMPTY_ANSWER.message, EMPTY_ANSWER.fix);
        }
        turn.view.update(result.answer);
      },
      (error: unknown) => {
        if (!current()) return;
        finish();
        const { message, fix } = describeRequestError(error);
        turn.view.showError(message, fix);
      },
    );
  };

  const stop = () => {
    const turn = pending;
    if (!turn) return;
    finish();
    turn.stream?.stop();
    turn.view.showStopped();
    session.addTurn(turn.question, turn.reply);
  };

  const panel = deps.openPanel({
    subject,
    messages: panelMessages(session),
    onSend: send,
    onStop: stop,
    onClose: () => {
      const turn = pending;
      pending = undefined;
      turn?.stream?.stop();
    },
  });
  return panel;
}
