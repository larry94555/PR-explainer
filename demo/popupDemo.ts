// Static demo for the popup (`npm run demo:popup`). Uses fake data only: no
// extension APIs and no LLM, so each state can be checked by eye.

import { describeLlmError } from '../src/llm/describeLlmError';
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
  const popup = openPopup(row, { onClose: () => (status.textContent = 'Last event: closed') });
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
