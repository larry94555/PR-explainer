import {
  formatDuration,
  latencyBreakdown,
  latencyRows,
  latencySummary,
} from '../src/popup/latencyBreakdown';

// A reply from a model that had to be loaded first: 14.2 s in the popup.
const COLD = {
  totalMs: 13_900,
  loadMs: 4_100,
  promptTokens: 812,
  promptMs: 1_300,
  answerTokens: 240,
  answerMs: 8_000,
};

describe('latencyBreakdown', () => {
  it('splits the popup time into load, prompt, answer, and the time outside Ollama', () => {
    expect(latencyBreakdown(14_200, COLD)).toEqual({
      totalMs: 14_200,
      loadMs: 4_100,
      prompt: { tokens: 812, ms: 1_300 },
      answer: { tokens: 240, ms: 8_000, tokensPerSecond: 30 },
      otherMs: 300,
    });
  });

  it('adds up the parts when the server leaves out its total', () => {
    const parts = { ...COLD, totalMs: undefined };
    // 4.1 + 1.3 + 8.0 = 13.4 s inside Ollama.
    expect(latencyBreakdown(14_200, parts)?.otherMs).toBe(800);
  });

  it('never makes the time outside Ollama negative, when the clocks disagree', () => {
    expect(latencyBreakdown(13_000, COLD)?.otherMs).toBe(0);
    expect(latencyBreakdown(-5, COLD)).toMatchObject({ totalMs: 0, otherMs: 0 });
  });

  it('leaves out what the server did not report', () => {
    // A prompt read entirely from Ollama's cache has no prompt fields.
    expect(latencyBreakdown(3_000, { totalMs: 2_500, answerTokens: 50, answerMs: 2_000 })).toEqual({
      totalMs: 3_000,
      answer: { tokens: 50, ms: 2_000, tokensPerSecond: 25 },
      otherMs: 500,
    });
    expect(latencyBreakdown(3_000, { answerTokens: 50 })).toEqual({
      totalMs: 3_000,
      answer: { tokens: 50 },
      otherMs: 3_000,
    });
  });

  it('gives no tokens per second when the answer took no time', () => {
    expect(latencyBreakdown(100, { answerTokens: 1, answerMs: 0 })?.answer).toEqual({
      tokens: 1,
      ms: 0,
    });
  });

  it('is null when there is nothing to split the time by', () => {
    expect(latencyBreakdown(1_000, undefined)).toBeNull();
    expect(latencyBreakdown(1_000, {})).toBeNull();
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

describe('latencyRows and latencySummary', () => {
  it('lists each part in order, ending with the total', () => {
    expect(latencyRows(latencyBreakdown(14_200, COLD)!)).toEqual([
      { key: 'load', label: 'Load', value: '4.1 s' },
      { key: 'prompt', label: 'Prompt', value: '812 tokens · 1.3 s' },
      { key: 'answer', label: 'Answer', value: '240 tokens · 8.0 s · 30.0 tokens/s' },
      { key: 'other', label: 'Outside Ollama', value: '300 ms' },
      { key: 'total', label: 'Total', value: '14.2 s' },
    ]);
  });

  it('writes large counts with separators, and one token without an s', () => {
    const rows = latencyRows(latencyBreakdown(5_000, { promptTokens: 1_234, answerTokens: 1 })!);
    expect(rows.map((r) => r.value)).toEqual(['1,234 tokens', '1 token', '5.0 s', '5.0 s']);
  });

  it('puts the same numbers on one line for the console, without the total', () => {
    expect(latencySummary(latencyBreakdown(14_200, COLD)!)).toBe(
      'Load: 4.1 s, Prompt: 812 tokens · 1.3 s, Answer: 240 tokens · 8.0 s · 30.0 tokens/s, ' +
        'Outside Ollama: 300 ms',
    );
  });
});
