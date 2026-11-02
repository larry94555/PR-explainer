import { chatSessionFor, EMPTY_ANSWER, panelMessages, startChat } from '../src/chat/chatFlow';
import type { ChatResult } from '../src/chat/chatHandler';
import {
  CHAT_PANEL_ID,
  currentChatPanel,
  openChatPanel,
  STOPPED_EMPTY,
  STOPPED_NOTE,
} from '../src/chat/chatPanel';
import {
  ChatSession,
  ChatSessions,
  formatExplanation,
  type ChatSeed,
} from '../src/chat/chatSession';
import { SAMPLE_CONTEXT } from '../src/explain/sampleContext';
import type { ChatMessage } from '../src/llm/types';
import { RequestError } from '../src/messaging/client';

const SEED: ChatSeed = {
  context: SAMPLE_CONTEXT,
  explanation: {
    what: 'Defines the host names that count as this laptop.',
    why: 'The settings page only accepts a local LLM address.',
    concerns: '- `[::1]` needs brackets in a URL.',
  },
};
const SUBJECT = { filePath: 'src/settings.ts', startLine: 14 };
const MODEL = 'qwen2.5-coder:7b';

/** One request the fake service worker is answering; the test decides how it ends. */
interface FakeRequest {
  messages: ChatMessage[];
  chunk(text: string): void;
  resolve(result: ChatResult): void;
  reject(error: unknown): void;
  stop: ReturnType<typeof vi.fn>;
}

/** Opens the real chat panel with a mocked client. */
function setup(session = new ChatSession(SEED)) {
  const requests: FakeRequest[] = [];
  const ask = vi.fn((messages: ChatMessage[], onChunk: (text: string) => void) => {
    let resolve!: (result: ChatResult) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<ChatResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    result.catch(() => {});
    const stop = vi.fn();
    requests.push({ messages, chunk: onChunk, resolve, reject, stop });
    return { result, stop };
  });
  const panel = startChat(
    { ask, openPanel: (options) => openChatPanel(options) },
    session,
    SUBJECT,
  );
  return { session, panel, ask, requests, last: () => requests.at(-1)! };
}

function root(): ShadowRoot {
  return document.getElementById(CHAT_PANEL_ID)!.shadowRoot!;
}

function send(question: string): void {
  const input = root().querySelector<HTMLTextAreaElement>('.input')!;
  input.value = question;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
  );
}

const shown = () =>
  [...root().querySelectorAll<HTMLElement>('.message')].map((el) => el.textContent);
const lastAnswer = () => [...root().querySelectorAll<HTMLElement>('.message')].at(-1)!;
const sendDisabled = () => root().querySelector<HTMLButtonElement>('.send')!.disabled;
const stopButton = () => root().querySelector<HTMLButtonElement>('.stop')!;
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  currentChatPanel()?.close();
  document.body.innerHTML = '';
});

describe('chat flow', () => {
  it('opens the panel with the explanation, about the clicked code', () => {
    setup();
    expect(root().querySelector('.subject')!.textContent).toBe('src/settings.tsline 14');
    expect(shown()).toEqual([
      expect.stringContaining('Defines the host names that count as this laptop.'),
    ]);
  });

  it('sends the code and the explanation with the first question, and streams the answer', async () => {
    const { session, last } = setup();
    send('How would I unit test this?');

    const { messages } = last();
    expect(messages[1]!.content).toContain(SAMPLE_CONTEXT.trimEnd());
    expect(messages[2]).toEqual({
      role: 'assistant',
      content: formatExplanation(SEED.explanation),
    });
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'How would I unit test this?' });
    expect(sendDisabled()).toBe(true);
    expect(root().querySelector('.chat')!.getAttribute('data-busy')).toBe('true');

    last().chunk('Use **fake');
    last().chunk(' timers**.');
    expect(lastAnswer().querySelector('strong')!.textContent).toBe('fake timers');

    last().resolve({ status: 'done', answer: 'Use **fake timers**.', model: MODEL });
    await flush();
    expect(root().querySelector('.chat')!.getAttribute('data-busy')).toBe('false');
    expect(session.turns).toEqual([
      { question: 'How would I unit test this?', answer: 'Use **fake timers**.' },
    ]);
  });

  it('includes earlier turns in a follow-up question', async () => {
    const { last } = setup();
    send('How would I unit test this?');
    last().resolve({ status: 'done', answer: 'Use fake timers.', model: MODEL });
    await flush();

    send('Can you show that in Jest?');
    expect(last().messages.slice(3)).toEqual([
      { role: 'user', content: 'How would I unit test this?' },
      { role: 'assistant', content: 'Use fake timers.' },
      { role: 'user', content: 'Can you show that in Jest?' },
    ]);
  });

  it('Stop ends the request, keeps the text so far, and the next question builds on it', async () => {
    const { session, last, requests } = setup();
    send('Explain the regex');
    last().chunk('It matches');
    stopButton().click();

    expect(requests[0]!.stop).toHaveBeenCalledOnce();
    expect(lastAnswer().textContent).toBe(`It matches${STOPPED_NOTE}`);
    expect(session.turns).toEqual([{ question: 'Explain the regex', answer: 'It matches' }]);

    // What the stopped request sends later changes nothing.
    requests[0]!.chunk(' localhost');
    requests[0]!.reject(new RequestError('Stopped by the user', 'AbortError'));
    await flush();
    expect(lastAnswer().textContent).toBe(`It matches${STOPPED_NOTE}`);

    expect(root().querySelector('.chat')!.getAttribute('data-busy')).toBe('false');
    send('Go on');
    expect(requests).toHaveLength(2);
    expect(last().messages.at(-2)).toEqual({ role: 'assistant', content: 'It matches' });
  });

  it('Stop before any text records nothing', () => {
    const { session } = setup();
    send('Explain the regex');
    stopButton().click();
    expect(lastAnswer().textContent).toBe(STOPPED_EMPTY);
    expect(session.turns).toEqual([]);
  });

  it('shows a failed answer with its fix, records nothing, and lets the user ask again', async () => {
    const { session, last, requests } = setup();
    send('Explain the regex');
    last().resolve({ status: 'failed', message: 'Ollama is not running.', fix: 'Start it.' });
    await flush();

    expect(lastAnswer().dataset.status).toBe('failed');
    expect(lastAnswer().querySelector('.error-message')!.textContent).toBe(
      'Ollama is not running.',
    );
    expect(lastAnswer().querySelector('.fix')!.textContent).toBe('Start it.');
    expect(session.turns).toEqual([]);

    send('Explain the regex');
    expect(requests).toHaveLength(2);
    expect(last().messages.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  it('shows a friendly error when the service worker cannot be reached', async () => {
    const { session, last } = setup();
    send('Explain the regex');
    last().reject(
      new RequestError('Could not reach the service worker: Extension context invalidated.'),
    );
    await flush();
    expect(lastAnswer().textContent).toContain('Extension context invalidated');
    expect(lastAnswer().textContent).toContain('Reload this page');
    expect(session.turns).toEqual([]);
    expect(sendDisabled()).toBe(true); // Empty box, but no longer busy.
    expect(root().querySelector('.chat')!.getAttribute('data-busy')).toBe('false');
  });

  it('says so when the model finishes without an answer', async () => {
    const { session, last } = setup();
    send('Explain the regex');
    last().resolve({ status: 'done', answer: '  ', model: MODEL });
    await flush();
    expect(lastAnswer().textContent).toBe(EMPTY_ANSWER.message + EMPTY_ANSWER.fix);
    expect(session.turns).toEqual([]);
  });

  it('closing the panel stops the request', () => {
    const { panel, last } = setup();
    send('Explain the regex');
    panel.close();
    expect(last().stop).toHaveBeenCalledOnce();
  });

  it('reopening shows the earlier turns', async () => {
    const first = setup();
    send('How would I unit test this?');
    first.last().resolve({ status: 'done', answer: 'Use fake timers.', model: MODEL });
    await flush();
    first.panel.close();

    setup(first.session);
    expect(shown()).toHaveLength(3);
    expect(shown().slice(1)).toEqual(['How would I unit test this?', 'Use fake timers.']);
    expect(panelMessages(first.session)[0]!.text).toBe(formatExplanation(SEED.explanation));
  });
});

describe('chatSessionFor', () => {
  it('reuses the PR session for the same code and explanation', () => {
    const sessions = new ChatSessions();
    const one = chatSessionFor(sessions, 'o/r#1', SEED);
    expect(
      chatSessionFor(sessions, 'o/r#1', { ...SEED, explanation: { ...SEED.explanation } }),
    ).toBe(one);
  });

  it('starts a new session for other code or a regenerated explanation', () => {
    const sessions = new ChatSessions();
    const one = chatSessionFor(sessions, 'o/r#1', SEED);
    const other = chatSessionFor(sessions, 'o/r#1', { ...SEED, context: 'File: b.ts\n+x' });
    expect(other).not.toBe(one);
    expect(sessions.get('o/r#1')).toBe(other);
    const regenerated = { ...SEED, explanation: { ...SEED.explanation, what: 'New.' } };
    expect(chatSessionFor(sessions, 'o/r#1', regenerated)).not.toBe(other);
  });

  it('does not keep a session without a PR', () => {
    const sessions = new ChatSessions();
    expect(chatSessionFor(sessions, undefined, SEED)).not.toBe(
      chatSessionFor(sessions, undefined, SEED),
    );
  });
});
