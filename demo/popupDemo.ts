// Static demo for the popup (`npm run demo:popup`). Uses fake data only: no
// extension APIs and no LLM, so each state can be checked by eye. Ask a
// question opens the real chat flow (src/chat/chatFlow.ts) with a fake model
// that streams canned answers word by word; a question with "fail" in it
// gets an error instead.

import type { ChatResult } from '../src/chat/chatHandler';
import { openChatPanel } from '../src/chat/chatPanel';
import { startChat } from '../src/chat/chatFlow';
import { ChatSession } from '../src/chat/chatSession';
import { describeLlmError } from '../src/llm/describeLlmError';
import type { ChatMessage } from '../src/llm/types';
import { LlmError } from '../src/llm/types';
import { openPopup } from '../src/popup/popup';
import type { Explanation } from '../src/explain/parseExplanation';

const MODEL = 'qwen2.5-coder:7b';

const SAMPLE: Explanation = {
  what:
    'Retries the `fetch` call up to **three** times, waiting a little longer each time.\n\n' +
    '- First retry after 200 ms\n- Second after 400 ms\n- Third after 800 ms',
  why: 'The Ollama server can take a moment to load a model, so the *first* request often fails.',
  concerns:
    '1. A request that fails for a real reason (bad URL) now takes over a second to report.\n' +
    '2. `attempt` is never reset, so:\n\n```ts\nawait retry(fn); // second call starts at attempt 3\n```',
};

const UNSAFE: Explanation = {
  what: 'This reply tries to run code: <img src=x onerror="alert(\'pwned\')"> and <script>alert(1)</script>',
  why: '[A link that goes nowhere](javascript:alert(1)) and <b>raw bold HTML</b> show as text.',
  concerns: '<iframe src="https://example.com"></iframe>',
};

const LINES: Array<[string, string]> = [
  [' ', 'export async function retry<T>(fn: () => Promise<T>): Promise<T> {'],
  ['-', '  return fn();'],
  ['+', '  for (let attempt = 0; ; attempt++) {'],
  ['+', '    try {'],
  ['+', '      return await fn();'],
  ['+', '    } catch (error) {'],
  ['+', '      if (attempt >= 3) throw error;'],
  ['+', '      await sleep(200 * 2 ** attempt);'],
  ['+', '    }'],
  ['+', '  }'],
  [' ', '}'],
];

const ANSWERS = [
  'Use fake timers, so the test does not wait for the real delays:\n\n```ts\n' +
    "it('retries three times', async () => {\n  vi.useFakeTimers();\n" +
    "  const fn = vi.fn().mockRejectedValue(new Error('down'));\n  const result = retry(fn);\n" +
    "  await vi.runAllTimersAsync();\n  await expect(result).rejects.toThrow('down');\n" +
    '  expect(fn).toHaveBeenCalledTimes(4);\n});\n```\n\n' +
    '- The first call plus **three** retries makes 4 calls.',
  'In Jest the same test uses `jest.useFakeTimers()` and `jest.runAllTimersAsync()`:\n\n```ts\n' +
    "test('retries three times', async () => {\n  jest.useFakeTimers();\n" +
    "  const fn = jest.fn().mockRejectedValue(new Error('down'));\n" +
    '  const result = retry(fn);\n  await jest.runAllTimersAsync();\n' +
    "  await expect(result).rejects.toThrow('down');\n});\n```",
];

/** A fake model: streams a canned answer word by word, until stopped. */
function fakeAsk(messages: ChatMessage[], onChunk: (text: string) => void) {
  const question = messages.at(-1)!.content;
  const earlier = messages.filter((m) => m.role === 'user').length - 2;
  const words = ANSWERS[earlier % ANSWERS.length]!.split(/(?<=\s)/);
  let timer: ReturnType<typeof setInterval> | undefined;
  const result = new Promise<ChatResult>((resolve) => {
    if (/fail/i.test(question)) {
      const { message, fix } = describeLlmError(new LlmError('connection', 'fetch failed'), {
        url: 'http://localhost:11434',
        platform: 'windows',
      });
      setTimeout(() => resolve({ status: 'failed', message, fix }), 600);
      return;
    }
    let shown = 0;
    timer = setInterval(() => {
      onChunk(words[shown++]!);
      if (shown < words.length) return;
      clearInterval(timer);
      resolve({ status: 'done', answer: words.join(''), model: MODEL });
    }, 60);
  });
  return { result, stop: () => clearInterval(timer) };
}

function fillDiff(table: HTMLTableElement, start: number): void {
  LINES.forEach(([marker, code], i) => {
    const row = table.insertRow();
    row.className = marker === '+' ? 'added' : marker === '-' ? 'removed' : '';
    row.insertCell().textContent = String(start + i);
    row.cells[0]!.className = 'num';
    row.insertCell().textContent = `${marker} ${code}`;
  });
}

fillDiff(document.querySelector<HTMLTableElement>('#diff')!, 10);
fillDiff(document.querySelector<HTMLTableElement>('#diff-bottom')!, 120);

const status = document.querySelector('#status')!;
const chosen = () =>
  document.querySelector<HTMLInputElement>('input[name="state"]:checked')?.value ?? 'done';

document.addEventListener('click', (event) => {
  const row = (event.target as Element).closest?.('table.diff tr');
  if (!row) return;
  const popup = openPopup(row, {
    onClose: () => (status.textContent = 'Last event: closed'),
    onAsk: () => {
      const session = new ChatSession({
        context: LINES.map(([marker, code]) => marker + code).join('\n'),
        explanation: chosen() === 'unsafe' ? UNSAFE : SAMPLE,
      });
      const line = Number((row as HTMLTableRowElement).cells[0]!.textContent);
      const subject = { filePath: 'src/llm/retry.ts', startLine: line };
      startChat({ ask: fakeAsk, openPanel: openChatPanel }, session, subject).focus();
      status.textContent = 'Last event: chat opened';
    },
  });
  status.textContent = `Last event: opened (${chosen()})`;
  switch (chosen()) {
    case 'loading':
      popup.showLoading(MODEL);
      break;
    case 'done':
      popup.showExplanation(SAMPLE, MODEL);
      break;
    case 'slow':
      popup.showLoading(MODEL);
      setTimeout(() => popup.showExplanation(SAMPLE, MODEL), 2000);
      break;
    case 'failed': {
      const { message, fix } = describeLlmError(new LlmError('connection', 'fetch failed'), {
        url: 'http://localhost:11434',
        platform: 'windows',
      });
      popup.showError(message, fix);
      break;
    }
    case 'unsafe':
      popup.showExplanation(UNSAFE, MODEL);
      break;
  }
});
