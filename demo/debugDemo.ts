// Static demo for the debug window (`npm run demo:debug`, PR 9.4). It plays a
// recorded flow over a fake debug log port: the warm-up, a click on a line
// with its GitHub reads, tasks and explanation, Explain on hover, and a chat
// question. A second click then runs live, its reply growing word by word.
// No extension APIs and no LLM. Add ?live=0 to the address to skip the live click.

import '../src/debug/debugWindow.css';
import { createDebugWindow, type DebugPort } from '../src/debug/debugWindow';
import type { DebugEntry, DebugLogPortMessage, DebugRunningEntry } from '../src/debug/types';
import type { RoundTrip, TraceTask } from '../src/trace/types';

const T0 = Date.now() - 95_000;
let nextId = 1;

const SYSTEM =
  'You explain code from a GitHub pull request to a reviewer. Answer in three short sections: ' +
  '**What it does**, **Why it is needed**, **Concerns**.';
const USER =
  'PR: "Retry Ollama requests while the model loads"\n' +
  'File: src/llm/retry.ts (TypeScript)\n' +
  'Clicked line: line 14 of the new file\n' +
  '+    await sleep(200 * 2 ** attempt);\n\n' +
  'Surrounding code:\n' +
  ' export async function retry<T>(fn: () => Promise<T>): Promise<T> {\n' +
  '   for (let attempt = 0; ; attempt++) {\n' +
  '     try {\n' +
  '       return await fn();\n' +
  '     } catch (error) {\n' +
  '       if (attempt >= 2) throw error;\n' +
  '>      await sleep(200 * 2 ** attempt);\n' +
  '     }\n' +
  '   }\n' +
  ' }';
const REPLY =
  '<think>The line waits before the next try, doubling each time. Keep it short.</think>\n' +
  '**What it does** Waits 200 ms, then 400 ms, before trying the request again.\n\n' +
  '**Why it is needed** Ollama can fail the first request while it loads the model.\n\n' +
  '**Concerns** A real failure (a wrong URL) now takes 600 ms longer to report.';

function trip(extra: Partial<RoundTrip> & Pick<RoundTrip, 'endpoint' | 'purpose'>): RoundTrip {
  return {
    target: 'ollama',
    method: 'POST',
    cause: 'click',
    startMs: 0,
    durationMs: 0,
    status: 'done',
    httpStatus: 200,
    bytesSent: 0,
    bytesReceived: 0,
    ...extra,
  };
}

function rt(
  group: string,
  cause: DebugEntry['cause'],
  at: number,
  t: RoundTrip,
  where?: string,
): DebugEntry {
  return { id: nextId++, kind: 'round-trip', group, cause, at, trip: t, ...(where && { where }) };
}

const task = (
  key: string,
  label: string,
  source: TraceTask['source'],
  startMs: number,
  durationMs: number,
): TraceTask => ({ key, label, source, startMs, durationMs });

const CLICK_TASKS: TraceTask[] = [
  task('find-code', 'Find the clicked code', 'page', 0, 4),
  task('pr-description', 'Read the PR description', 'page', 5, 180),
  task('file-at-head', 'Fetch the file at head', 'page', 5, 260),
  task('send', 'Send the request', 'page', 266, 3),
  task('settings', 'Read settings', 'worker', 270, 2),
  task('loaded-window', 'Check the loaded window', 'worker', 273, 9),
  task('fit-prompt', 'Build and fit the prompt', 'worker', 283, 6),
  task('model', 'Wait for the model', 'model', 290, 2_480),
  task('parse', 'Parse the answer', 'worker', 2_771, 2),
  task('show', 'Show answer', 'page', 2_775, 12),
];

const warmAt = T0;
const clickAt = T0 + 21_000;
const hoverAt = T0 + 48_000;
const chatAt = T0 + 70_000;
const where = 'src/llm/retry.ts:14';

const ENTRIES: DebugEntry[] = [
  rt(
    'warm',
    'warmup',
    warmAt,
    trip({
      method: 'POST',
      endpoint: 'localhost:11434/api/show',
      purpose: 'context size',
      cause: 'warmup',
      durationMs: 14,
      bytesSent: 28,
      bytesReceived: 18_400,
    }),
  ),
  rt(
    'warm',
    'warmup',
    warmAt + 15,
    trip({
      method: 'GET',
      endpoint: 'localhost:11434/api/ps',
      purpose: 'is the model loaded',
      cause: 'warmup',
      durationMs: 4,
      bytesReceived: 12,
    }),
  ),
  rt(
    'warm',
    'warmup',
    warmAt + 20,
    trip({
      endpoint: 'localhost:11434/api/chat',
      purpose: 'load the model',
      cause: 'warmup',
      durationMs: 4_130,
      bytesSent: 96,
      bytesReceived: 310,
      messages: [],
      reply: '',
      timings: { loadMs: 4_090, totalMs: 4_120 },
    }),
  ),
  {
    id: nextId++,
    kind: 'trace',
    group: 'click-1',
    cause: 'click',
    at: clickAt,
    where,
    tasks: CLICK_TASKS,
  },
  rt(
    'click-1',
    'click',
    clickAt + 5,
    trip({
      target: 'github',
      method: 'GET',
      endpoint: 'github.com/acme/api/pull/482',
      purpose: 'PR description',
      durationMs: 180,
      bytesReceived: 41_200,
    }),
    where,
  ),
  rt(
    'click-1',
    'click',
    clickAt + 5,
    trip({
      target: 'github',
      method: 'GET',
      endpoint: 'raw.githubusercontent.com/acme/api/9f3c1e2/src/llm/retry.ts',
      purpose: 'file at head',
      durationMs: 260,
      bytesReceived: 2_310,
    }),
    where,
  ),
  rt(
    'click-1',
    'click',
    clickAt + 273,
    trip({
      method: 'GET',
      endpoint: 'localhost:11434/api/ps',
      purpose: 'loaded window',
      durationMs: 9,
      bytesReceived: 240,
    }),
  ),
  rt(
    'click-1',
    'click',
    clickAt + 290,
    trip({
      endpoint: 'localhost:11434/api/chat',
      purpose: 'explanation',
      durationMs: 2_480,
      bytesSent: 1_380,
      bytesReceived: 9_870,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER },
      ],
      reply: REPLY,
      timings: {
        loadMs: 12,
        promptTokens: 412,
        promptMs: 310,
        answerTokens: 96,
        answerMs: 2_090,
        totalMs: 2_440,
      },
    }),
  ),
  rt(
    'hover-1',
    'hover',
    hoverAt,
    trip({
      endpoint: 'localhost:11434/api/chat',
      purpose: 'explanation',
      cause: 'hover',
      durationMs: 2_150,
      bytesSent: 1_290,
      bytesReceived: 8_800,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER.replace('line 14', 'line 12') },
      ],
      reply:
        '**What it does** Gives up after the third try.\n\n**Why it is needed** So a server that is down fails instead of retrying forever.\n\n**Concerns** None.',
      timings: {
        promptTokens: 398,
        promptMs: 290,
        answerTokens: 71,
        answerMs: 1_780,
        totalMs: 2_100,
      },
    }),
    'src/llm/retry.ts:12',
  ),
  rt(
    'chat-1',
    'chat',
    chatAt,
    trip({
      endpoint: 'localhost:11434/api/chat',
      purpose: 'chat answer',
      cause: 'chat',
      durationMs: 3_020,
      bytesSent: 2_100,
      bytesReceived: 7_400,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER },
        { role: 'assistant', content: REPLY.replace(/<think>[\s\S]*<\/think>\n/, '') },
        { role: 'user', content: 'Why 200 ms and not 1 s?' },
      ],
      reply:
        '200 ms covers a model that is almost loaded; doubling reaches 400 ms on the last try, so the whole wait stays under a second.',
      timings: {
        promptTokens: 61,
        promptMs: 120,
        answerTokens: 38,
        answerMs: 2_700,
        totalMs: 2_880,
      },
    }),
  ),
];

const LIVE_REPLY =
  '**What it does** Throws the last error once three tries have failed.\n\n' +
  '**Why it is needed** Without it the loop would retry forever.\n\n' +
  '**Concerns** The caller cannot tell how many tries were made.';

function fakePort(): DebugPort {
  const listeners: ((m: unknown) => void)[] = [];
  const send = (m: DebugLogPortMessage) => listeners.forEach((l) => l(m));
  setTimeout(() => {
    send({ type: 'snapshot', entries: ENTRIES, running: [] });
    if (new URLSearchParams(location.search).get('live') !== '0')
      setTimeout(() => liveClick(send), 1_500);
  });
  return {
    onMessage: { addListener: (l) => void listeners.push(l) },
    onDisconnect: { addListener: () => {} },
    disconnect: () => {},
  };
}

/** A second click: its explanation's reply grows, then it ends. */
function liveClick(send: (m: DebugLogPortMessage) => void) {
  const at = Date.now();
  const words = LIVE_REPLY.split(/(?<=\s)/);
  const base = trip({
    id: 'click-2:2',
    endpoint: 'localhost:11434/api/chat',
    purpose: 'explanation',
    status: 'running',
    bytesSent: 1_350,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: USER.replace('line 14', 'line 11') },
    ],
  });
  const running = (reply: string): DebugRunningEntry => ({
    kind: 'round-trip',
    group: 'click-2',
    cause: 'click',
    at,
    trip: { ...base, reply, durationMs: Date.now() - at, bytesReceived: reply.length * 9 },
  });
  send({
    type: 'entry',
    entry: rt(
      'click-2',
      'click',
      at - 12,
      trip({
        id: 'click-2:1',
        method: 'GET',
        endpoint: 'localhost:11434/api/ps',
        purpose: 'loaded window',
        durationMs: 8,
        bytesReceived: 240,
      }),
    ),
  });
  send({ type: 'running', entry: running('') });
  let shown = 0;
  const timer = setInterval(() => {
    shown += 1;
    if (shown <= words.length) {
      send({ type: 'running', entry: running(words.slice(0, shown).join('')) });
      return;
    }
    clearInterval(timer);
    send({
      type: 'entry',
      entry: rt('click-2', 'click', at, {
        ...base,
        status: 'done',
        reply: LIVE_REPLY,
        durationMs: Date.now() - at,
        bytesReceived: 9_100,
        timings: {
          promptTokens: 405,
          promptMs: 300,
          answerTokens: 52,
          answerMs: 1_900,
          totalMs: 2_230,
        },
      }),
    });
    send({
      type: 'entry',
      entry: {
        id: nextId++,
        kind: 'trace',
        group: 'click-2',
        cause: 'click',
        at: at - 280,
        where: 'src/llm/retry.ts:11',
        tasks: CLICK_TASKS,
      },
    });
  }, 250);
}

createDebugWindow(document.getElementById('app')!, {
  connect: fakePort,
  clear: async () => {},
  copy: async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      console.log(text);
    }
  },
});
