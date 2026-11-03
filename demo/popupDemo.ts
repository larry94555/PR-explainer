// Static demo for the popup (`npm run demo:popup`). Uses fake data only: no
// extension APIs and no LLM, so each state can be checked by eye. Ask a
// question opens the real chat flow (src/chat/chatFlow.ts) with a fake model
// that streams canned answers word by word; a question with "fail" in it
// gets an error instead. While the chat is open, clicking another line adds
// it to the conversation (PR 5.4) instead of opening the popup.

import type { ChatResult } from '../src/chat/chatHandler';
import { openChatPanel } from '../src/chat/chatPanel';
import { startChat, type ActiveChat } from '../src/chat/chatFlow';
import { ChatSession } from '../src/chat/chatSession';
import { describeLlmError } from '../src/llm/describeLlmError';
import type { ChatMessage, LlmTimings } from '../src/llm/types';
import { LlmError } from '../src/llm/types';
import { openPopup } from '../src/popup/popup';
import type { TraceTask } from '../src/trace/types';
import { traceLine } from '../src/trace/clickTrace';
import { buildWaterfall } from '../src/popup/latencyBreakdown';
import { isExplainShortcut } from '../src/a11y';
import { resolveTheme, watchTheme } from '../src/theme';
import { buildFittedExplainPrompt, type PromptReport } from '../src/explain/fitPrompt';
import { promptBudget } from '../src/llm/contextSize';
import { parseExplanation, type Explanation } from '../src/explain/parseExplanation';

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

// What Ollama reports for a 7B model that had to be loaded first (PR 8.1).
const TIMINGS: LlmTimings = {
  totalMs: 13_900,
  loadMs: 4_100,
  promptTokens: 812,
  promptMs: 1_300,
  answerTokens: 240,
  answerMs: 8_000,
};

// A click on a reasoning model that thinks before it answers (PR 9.1): the
// page's tasks, the service worker's, and the model's, timed from the click.
// About 45% of the reply is inside <think>, so Think gets that share of the
// 8 s Ollama spent writing.
const page = (key: string, label: string, startMs: number, durationMs: number): TraceTask => ({
  key,
  label,
  source: 'page',
  startMs,
  durationMs,
});
const worker = (key: string, label: string, startMs: number, durationMs: number): TraceTask => ({
  ...page(key, label, startMs, durationMs),
  source: 'worker',
});
const TASKS: TraceTask[] = [
  page('find-code', 'Find the code', 0, 3),
  page('pr-description', 'Read the PR description', 3, 180),
  page('file-at-head', 'Fetch the file at head', 3, 410),
  page('send', 'Send the request', 413, 1),
  worker('settings', 'Read settings', 416, 4),
  worker('fit-prompt', 'Build the prompt', 420, 12),
  worker('cache', 'Check the cache', 432, 3),
  worker('loaded-window', 'Check loaded window', 435, 25),
  { ...worker('model', 'Wait for the model', 460, 13_560), firstChunkMs: 5_500 },
  worker('parse', 'Parse the answer', 14_020, 2),
  worker('cache-save', 'Save to the cache', 14_022, 6),
  page('show', 'Show answer', 14_028, 172),
];
const THINKING_REPLY =
  `<think>${'The loop retries fetch with a growing delay. '.repeat(9)}</think>\n` +
  `## What it does\n${'Retries the fetch call up to three times. '.repeat(9)}`;
// A cached answer: no model, a few milliseconds in all.
const CACHED_TASKS: TraceTask[] = [
  page('find-code', 'Find the code', 0, 2),
  page('pr-description', 'Read the PR description', 2, 1),
  page('file-at-head', 'Fetch the file at head', 2, 1),
  page('send', 'Send the request', 3, 1),
  worker('settings', 'Read settings', 5, 2),
  worker('fit-prompt', 'Build the prompt', 7, 4),
  worker('cache', 'Check the cache', 11, 3),
  page('show', 'Show answer', 15, 4),
];

// A reply that hit the answer limit partway through "Why it's needed" (PR 8.4).
const CUT_OFF = parseExplanation(
  '## What it does\nRetries the `fetch` call up to three times, waiting longer each time.\n' +
    "## Why it's needed\nOllama can take a moment to load a model, so the first",
  { cutOff: true },
);

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
const RELATED =
  'The line you moved to is part of the same loop as the line we started on:\n\n' +
  '- The earlier line sets up the retry loop.\n' +
  '- This line decides **how long to wait** before the next try in that loop.';

function fakeAsk(messages: ChatMessage[], onChunk: (text: string) => void) {
  const question = messages.at(-1)!.content;
  const earlier = messages.filter((m) => m.role === 'user').length - 2;
  const answer = question.includes('Now looking at') ? RELATED : ANSWERS[earlier % ANSWERS.length]!;
  const words = answer.split(/(?<=\s)/);
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
    // Like the cells of GitHub's newer diff view, so Tab and Alt+E work here.
    row.cells[1]!.tabIndex = 0;
  });
}

// The Theme buttons set the attribute GitHub uses (PR 7.3); the popup and
// chat follow it, and the page's own colors follow resolveTheme.
const html = document.documentElement;
const paintPage = () => (html.dataset.demoTheme = resolveTheme(document));
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="theme"]')) {
  input.addEventListener('change', () => (html.dataset.colorMode = input.value));
}
html.dataset.colorMode = 'auto';
paintPage();
watchTheme(document, paintPage);

fillDiff(document.querySelector<HTMLTableElement>('#diff')!, 10);
fillDiff(document.querySelector<HTMLTableElement>('#diff-bottom')!, 120);

const status = document.querySelector('#status')!;
// What Show prompt (PR 6.2) shows for the clicked line in a 2048-token
// context: a long PR description and 30 lines on each side, trimmed to fit.
function demoPrompt(row: Element): PromptReport {
  const cells = (row as HTMLTableRowElement).cells;
  const lineNumber = cells[0]!.textContent;
  // The cell shows "+ code"; the prompt writes it "+code".
  const clicked = (cells[1]!.textContent ?? '').replace(/^(.) /, '$1');
  const nearby = (from: number) =>
    Array.from({ length: 30 }, (_, i) => ` const step${from + i} = await load(${from + i});`);
  const context = [
    'File: src/llm/retry.ts (TypeScript)',
    `Clicked line: line ${lineNumber} of the new file`,
    clicked,
    '',
    'Surrounding diff (the clicked line starts with >):',
    '@@ -1,12 +1,20 @@',
    ...nearby(1),
    `>${clicked}`,
    ...nearby(31),
  ].join('\n');
  const description = Array.from(
    { length: 60 },
    () => 'The first request after Ollama starts often fails while the model loads, so retry it.',
  ).join(' ');
  const contextTokens = 2048;
  const budget = promptBudget(contextTokens, 1024);
  const fitted = buildFittedExplainPrompt(
    context,
    { title: 'Retry the first request while the model loads', description },
    budget,
  );
  return {
    text: fitted.messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n'),
    tokens: fitted.tokens,
    budget,
    contextTokens,
    trimmed: fitted.trimmed,
  };
}

// What Show prompt shows with the full file context (PR 6.3): the clicked
// line sits in a long function, mostly collapsed in the diff, so the
// function is read from the file and cut to fit around the line.
function demoFilePrompt(row: Element): PromptReport {
  const cells = (row as HTMLTableRowElement).cells;
  // Placed further down the file than the demo diff's numbers, so the
  // function has room to start above it.
  const lineNumber = Number(cells[0]!.textContent) + 50;
  const clicked = (cells[1]!.textContent ?? '').replace(/^(.) /, '$1');
  const context = [
    'File: src/llm/retry.ts (TypeScript)',
    `Clicked line: line ${lineNumber} of the new file`,
    clicked,
    '',
    'Surrounding diff (the clicked line starts with >):',
    `@@ -${lineNumber - 1},3 +${lineNumber - 1},3 @@`,
    ' const delay = backoff(attempt);',
    `>${clicked}`,
    ' log(attempt, delay);',
  ].join('\n');
  // The function the line is in: 40 lines above it and 40 below.
  const startLine = lineNumber - 41;
  const body = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => `  const step${from + i} = await load(${from + i});`);
  const lines = [
    'export async function loadModel(',
    '  name: string,',
    '): Promise<Model> {',
    ...body(startLine + 3, 38),
    clicked.slice(1),
    ...body(lineNumber + 1, 39),
    '}',
  ];
  const contextTokens = 2048;
  const budget = promptBudget(contextTokens, 1024);
  const fitted = buildFittedExplainPrompt(
    context,
    { title: 'Retry the first request while the model loads', description: 'Fixes #12.' },
    budget,
    {
      kind: 'block',
      startLine,
      lines,
      focusStart: lineNumber,
      focusEnd: lineNumber,
      headerLines: 3,
    },
  );
  return {
    text: fitted.messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n'),
    tokens: fitted.tokens,
    budget,
    contextTokens,
    trimmed: fitted.trimmed,
  };
}

const chosen = () =>
  document.querySelector<HTMLInputElement>('input[name="state"]:checked')?.value ?? 'done';

const subjectOf = (row: Element) => ({
  filePath: 'src/llm/retry.ts',
  startLine: Number((row as HTMLTableRowElement).cells[0]!.textContent),
});
let activeChat: ActiveChat | undefined;

document.addEventListener('click', (event) => {
  const row = (event.target as Element).closest?.('table.diff tr');
  if (row) explainRow(row);
});
// Alt+E on a focused line does what a click does (PR 7.3).
document.addEventListener('keydown', (event) => {
  const row = (event.target as Element).closest?.('table.diff tr');
  if (!row || !isExplainShortcut(event)) return;
  event.preventDefault();
  explainRow(row);
});

function explainRow(row: Element): void {
  const code = `File: src/llm/retry.ts\n${row.textContent}`;
  if (activeChat?.addCode(code, subjectOf(row))) {
    status.textContent = 'Last event: line added to the chat';
    return;
  }
  // The Explanation state answers at once, so it uses a clock that says the
  // answer took 14.2 s, to match its Details (PR 8.1).
  let fakeTime = 0;
  const popup = openPopup(row, {
    ...(chosen() === 'done' && { now: () => fakeTime }),
    onClose: () => (status.textContent = 'Last event: closed'),
    onAsk: () => {
      const session = new ChatSession({
        context: LINES.map(([marker, code]) => marker + code).join('\n'),
        explanation: chosen() === 'unsafe' ? UNSAFE : SAMPLE,
      });
      activeChat = startChat({ ask: fakeAsk, openPanel: openChatPanel }, session, subjectOf(row));
      activeChat.focus();
      status.textContent = 'Last event: chat opened';
    },
  });
  status.textContent = `Last event: opened (${chosen()})`;
  switch (chosen()) {
    case 'loading':
      popup.showLoading(MODEL);
      break;
    case 'done':
      fakeTime = 14_200;
      popup.showExplanation(SAMPLE, MODEL);
      popup.showTrace({ tasks: TASKS, timings: TIMINGS, reply: THINKING_REPLY });
      // The same line the content script logs for each click (PR 9.1).
      console.info(
        `[PR Explainer] explained in 14.2 s (${MODEL}, first text after 6.0 s, tasks: ` +
          `${traceLine(buildWaterfall(TASKS, TIMINGS, THINKING_REPLY).rows)})`,
      );
      break;
    case 'cached':
      popup.showExplanation(SAMPLE, MODEL, { elapsedMs: 14_200 });
      popup.showTrace({ tasks: CACHED_TASKS });
      break;
    case 'prompt':
      popup.showExplanation(SAMPLE, MODEL);
      popup.showPrompt(demoPrompt(row));
      break;
    case 'file':
      popup.showExplanation(SAMPLE, MODEL);
      popup.showPrompt(demoFilePrompt(row));
      break;
    case 'slow':
      popup.showLoading(MODEL);
      setTimeout(() => {
        popup.showExplanation(SAMPLE, MODEL);
        // A model that does not think, already loaded: no Think row.
        popup.showTrace({
          tasks: [
            page('find-code', 'Find the code', 0, 2),
            page('send', 'Send the request', 2, 1),
            worker('fit-prompt', 'Build the prompt', 4, 10),
            { ...worker('model', 'Wait for the model', 14, 1_900), firstChunkMs: 450 },
            page('show', 'Show answer', 1_914, 86),
          ],
          timings: {
            totalMs: 1_700,
            loadMs: 15,
            promptTokens: 812,
            promptMs: 400,
            answerTokens: 40,
            answerMs: 1_280,
          },
          reply: '## What it does\nRetries the fetch call.',
        });
      }, 2000);
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
    case 'cutoff':
      popup.showExplanation(CUT_OFF, MODEL);
      break;
  }
}
