import {
  buildWaterfall,
  formatDuration,
  rowDescription,
  rowValue,
  splitAnswer,
  thinkShare,
} from '../src/popup/latencyBreakdown';
import type { TraceTask } from '../src/trace/types';

// A reply from a model that had to be loaded first.
const COLD = {
  totalMs: 13_900,
  loadMs: 4_100,
  promptTokens: 812,
  promptMs: 1_300,
  answerTokens: 240,
  answerMs: 8_000,
};

const task = (
  key: string,
  startMs: number,
  durationMs: number,
  extra: Partial<TraceTask> = {},
): TraceTask => ({ key, label: key, source: 'page', startMs, durationMs, ...extra });

// 14.2 s from the click: the page's tasks, the worker's, the model, then Show answer.
const TASKS: TraceTask[] = [
  task('find-code', 0, 4),
  task('pr-description', 4, 100),
  task('file-at-head', 4, 300),
  task('send', 304, 1),
  task('settings', 306, 4, { source: 'worker' }),
  task('model', 400, 13_500, { source: 'worker', firstChunkMs: 5_500 }),
  task('show', 13_900, 300),
];

describe('thinkShare', () => {
  it('is 0 for a reply with no thinking, and for an empty one', () => {
    expect(thinkShare('## What it does\nAdds one.')).toBe(0);
    expect(thinkShare('')).toBe(0);
  });

  it('is the share of characters inside <think>, tags included', () => {
    const thinking = '<think>abcdefghijklm</think>'; // 28 characters
    expect(thinkShare(`${thinking}${'x'.repeat(72)}`)).toBeCloseTo(0.28);
  });

  it('counts every <think> block, in any case', () => {
    expect(thinkShare('<think>ab</think>xx<THINK>cd</THINK>')).toBeCloseTo(34 / 36);
  });

  it('is all thinking when the reply is cut off inside <think>', () => {
    expect(thinkShare('<think>still working out what the code')).toBe(1);
    expect(thinkShare('ab<think>cd')).toBeCloseTo(9 / 11);
  });
});

describe('splitAnswer', () => {
  const answer = { tokens: 240, ms: 8_000 };

  it('gives all of it to Think when the reply is all thinking', () => {
    expect(splitAnswer(answer, 1)).toEqual({
      think: { tokens: 240, ms: 8_000 },
      write: { tokens: 0, ms: 0 },
    });
  });

  it('gives all of it to Write answer when there is no thinking', () => {
    expect(splitAnswer(answer, 0)).toEqual({
      think: { tokens: 0, ms: 0 },
      write: { tokens: 240, ms: 8_000 },
    });
  });

  it('splits by the share, and the two parts always add up to the whole', () => {
    for (const share of [0.1, 0.333, 0.45, 0.9]) {
      const { think, write } = splitAnswer(answer, share);
      expect(think.tokens! + write.tokens!).toBe(240);
      expect(think.ms! + write.ms!).toBeCloseTo(8_000);
    }
    expect(splitAnswer(answer, 0.45).think).toEqual({ tokens: 108, ms: 3_600 });
  });

  it('keeps unknown parts unknown and clamps the share', () => {
    expect(splitAnswer({ ms: 1_000 }, 2)).toEqual({ think: { ms: 1_000 }, write: { ms: 0 } });
    expect(splitAnswer({}, 0.5)).toEqual({ think: {}, write: {} });
  });
});

describe('buildWaterfall', () => {
  const reply = `<think>${'t'.repeat(35)}</think>${'a'.repeat(50)}`; // 50 of 100 thinking

  it('splits the model task into Load, Read prompt, Think and Write answer, one after another', () => {
    const { rows, totalMs, firstTokenMs } = buildWaterfall(TASKS, COLD, reply);
    expect(totalMs).toBe(14_200);
    expect(firstTokenMs).toBe(5_900);
    expect(rows.map((r) => [r.key, r.startMs, r.durationMs])).toEqual([
      ['find-code', 0, 4],
      ['pr-description', 4, 100],
      ['file-at-head', 4, 300],
      ['send', 304, 1],
      ['settings', 306, 4],
      ['load', 400, 4_100],
      ['prompt', 4_500, 1_300],
      ['think', 5_800, 4_000],
      ['write', 9_800, 4_000],
      ['show', 13_900, 300],
    ]);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.think).toMatchObject({
      label: 'Think',
      source: 'model',
      estimated: true,
      detail: '~120 tokens',
    });
    expect(byKey.write).toMatchObject({
      label: 'Write answer',
      estimated: true,
      detail: '~120 tokens · 30.0 tokens/s',
    });
    expect(byKey.prompt).toMatchObject({ label: 'Read prompt', detail: '812 tokens' });
    expect(byKey.load!.share).toBeCloseTo(4_100 / 14_200);
  });

  it('has no Think row, and nothing estimated, when the model did not think', () => {
    const { rows } = buildWaterfall(TASKS, COLD, '## What it does\nAdds one.');
    expect(rows.map((r) => r.key)).not.toContain('think');
    expect(rows.find((r) => r.key === 'write')).toMatchObject({
      durationMs: 8_000,
      detail: '240 tokens · 30.0 tokens/s',
    });
    expect(rows.some((r) => r.estimated)).toBe(false);
  });

  it('gives Write answer nothing when the reply was cut off inside <think>', () => {
    const { rows } = buildWaterfall(TASKS, COLD, '<think>the model never got to the answer');
    const think = rows.find((r) => r.key === 'think')!;
    const write = rows.find((r) => r.key === 'write')!;
    expect(think.durationMs).toBe(8_000);
    expect(write.durationMs).toBe(0);
  });

  it('keeps the shares of the model rows adding up to the model time Ollama reported', () => {
    const { rows, totalMs } = buildWaterfall(TASKS, COLD, reply);
    const model = rows.filter((r) => r.source === 'model');
    const share = model.reduce((sum, r) => sum + r.share, 0);
    expect(share).toBeCloseTo((4_100 + 1_300 + 8_000) / totalMs);
    const thinkAndWrite = model.filter((r) => r.key === 'think' || r.key === 'write');
    expect(thinkAndWrite.reduce((sum, r) => sum + r.durationMs, 0)).toBeCloseTo(8_000);
  });

  it('keeps the model task as one row when the server gave no timings', () => {
    const { rows } = buildWaterfall(TASKS);
    expect(rows.find((r) => r.key === 'model')).toMatchObject({ durationMs: 13_500 });
    expect(rows.map((r) => r.key)).not.toContain('load');
  });

  it('gives a cached answer only its own short trace', () => {
    const cached = [task('find-code', 0, 2), task('cache', 3, 3, { source: 'worker' })];
    const waterfall = buildWaterfall(cached);
    expect(waterfall.totalMs).toBe(6);
    expect(waterfall.firstTokenMs).toBeUndefined();
    expect(waterfall.rows.map((r) => r.share)).toEqual([2 / 6, 3 / 6]);
  });
});

describe('rowValue and rowDescription', () => {
  const { rows } = buildWaterfall(
    [...TASKS, task('context-size', 306, 0, { status: 'skipped' })],
    COLD,
    `<think>${'t'.repeat(35)}</think>${'a'.repeat(50)}`,
  );
  const row = (key: string) => rows.find((r) => r.key === key)!;

  it('shows the time and the share, with ~ for an estimate', () => {
    expect(rowValue(row('load'))).toBe('4.1 s · 29%');
    expect(rowValue(row('think'))).toBe('~4.0 s · 28%');
    expect(rowValue(row('context-size'))).toBe('skipped');
    expect(rowValue({ ...row('send'), status: 'failed' })).toBe('failed after 1 ms');
  });

  it('says each row in one sentence for screen readers', () => {
    expect(rowDescription(row('think'))).toBe(
      'Think (estimated), 4.0 s, 28% of the total, started at 5.8 s, about 120 tokens',
    );
    expect(rowDescription(row('context-size'))).toBe('context-size, skipped, started at 306 ms');
  });
});

describe('formatDuration', () => {
  it('shows milliseconds under a second, then tenths of a second', () => {
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatDuration(12.6)).toBe('13 ms');
    expect(formatDuration(999.4)).toBe('999 ms');
    expect(formatDuration(1_000)).toBe('1.0 s');
    expect(formatDuration(14_250)).toBe('14.3 s');
    expect(formatDuration(-3)).toBe('0 ms');
  });
});
