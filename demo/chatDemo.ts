// Static demo for the chat panel (`npm run demo:chat`). Uses fake data only:
// no extension APIs and no LLM. Each question gets a canned answer that
// streams in word by word, so auto-scroll and the busy state can be checked.

import { openChatPanel, type ChatPanelMessage, type ChatSubject } from '../src/chat/chatPanel';

const EXPLANATION = [
  '**What it does:** Retries the `fetch` call up to three times, waiting longer each time.',
  '',
  "**Why it's needed:** The Ollama server can take a moment to load a model.",
  '',
  '**Concerns:** `attempt` is never reset between calls.',
].join('\n');

const CONVERSATION: ChatPanelMessage[] = [
  { role: 'assistant', text: EXPLANATION },
  { role: 'user', text: 'How would I unit test this?' },
  {
    role: 'assistant',
    text: [
      'Use fake timers so the test does not wait for real delays:',
      '',
      '```ts',
      "it('retries three times', async () => {",
      '  vi.useFakeTimers();',
      "  const fn = vi.fn().mockRejectedValue(new Error('down'));",
      '  const result = retry(fn);',
      '  await vi.runAllTimersAsync();',
      "  await expect(result).rejects.toThrow('down');",
      '  expect(fn).toHaveBeenCalledTimes(4);',
      '});',
      '```',
      '',
      '- The first call plus **three** retries makes 4 calls.',
      '- `runAllTimersAsync` skips the 200, 400, and 800 ms waits.',
    ].join('\n'),
  },
];

const UNSAFE: ChatPanelMessage[] = [
  {
    role: 'assistant',
    text: 'This reply tries to run code: <img src=x onerror="alert(\'pwned\')"> and <script>alert(1)</script>',
  },
  { role: 'user', text: '<b>Is this bold?</b> It should not be.' },
  { role: 'assistant', text: '[A link that goes nowhere](javascript:alert(1))' },
];

const ANSWERS = [
  'Good question. The loop stops after `attempt >= 3`, so a failing call is tried **four** times in total: once, then three retries.',
  'You could pass the limit in:\n\n```ts\nexport async function retry<T>(fn: () => Promise<T>, max = 3): Promise<T> {\n  // ...\n}\n```\n\nThen a test can use `max = 0` to check that no retry happens.',
  'Here is a longer answer so you can watch the list scroll.\n\n1. Read the clicked line.\n2. Read the lines around it.\n3. Check the hunk header.\n4. Look at the tests.\n5. Look for callers.\n6. Decide whether the retry belongs here.\n\nThat covers it.',
];

const status = document.querySelector('#status')!;
let answered = 0;

function open(subject: ChatSubject, messages: ChatPanelMessage[]): void {
  const chat = openChatPanel({
    subject,
    messages,
    onClose: () => (status.textContent = 'Last event: closed'),
    onSend: (question) => {
      status.textContent = `Last event: sent "${question}"`;
      const words = ANSWERS[answered++ % ANSWERS.length]!.split(/(?<=\s)/);
      const answer = chat.addMessage('assistant', '');
      chat.setBusy(true);
      let shown = 0;
      let timer: ReturnType<typeof setInterval> | undefined;
      // Like a real model, it "thinks" for a moment before the first word,
      // so the answer's timer (PR 8.1) can be seen ticking.
      setTimeout(() => {
        timer = setInterval(() => {
          if (!chat.isOpen) return clearInterval(timer);
          shown++;
          answer.update(words.slice(0, shown).join(''));
          if (shown >= words.length) {
            clearInterval(timer);
            chat.setBusy(false);
            status.textContent = 'Last event: answer finished';
          }
        }, 60);
      }, 1500);
    },
  });
  chat.focus();
  status.textContent = 'Last event: opened';
}

document
  .querySelector('#open-conversation')!
  .addEventListener('click', () =>
    open({ filePath: 'src/llm/retry.ts', startLine: 12, endLine: 18 }, CONVERSATION),
  );
document
  .querySelector('#open-line')!
  .addEventListener('click', () =>
    open({ filePath: 'src/llm/retry.ts', startLine: 15 }, [
      { role: 'assistant', text: EXPLANATION },
    ]),
  );
document
  .querySelector('#open-unsafe')!
  .addEventListener('click', () =>
    open({ filePath: 'src/popup/renderMarkdown.ts', startLine: 3 }, UNSAFE),
  );
