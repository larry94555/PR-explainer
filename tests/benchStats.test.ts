// PR 8.2: the numbers and markdown behind `npm run bench`. The script itself
// talks to a real Ollama and is tested by hand.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendReport,
  formatDate,
  formatGpuShare,
  formatMs,
  formatReport,
  formatRuns,
  formatTable,
  LATENCY_DOC_INTRO,
  median,
  parseBenchArgs,
  parseSample,
  slowest,
  summarize,
  tokensPerSecond,
  type BenchReport,
  type BenchRun,
} from '../scripts/benchStats.ts';
import { buildFittedExplainPrompt } from '../src/explain/fitPrompt';
import { toFileContext } from '../src/explain/explainHandler';
import { FALLBACK_CONTEXT_TOKENS, promptBudget } from '../src/llm/contextSize';
import { DEFAULT_SETTINGS } from '../src/settings';

const ok = (totalMs: number, extra: Partial<Extract<BenchRun, { ok: true }>> = {}): BenchRun => ({
  ok: true,
  totalMs,
  ...extra,
});
const failed = (error = 'Ollama stopped mid-reply (out of memory).'): BenchRun => ({
  ok: false,
  error,
});

describe('median and slowest', () => {
  it('takes the middle value of an odd count, whatever the order', () => {
    expect(median([9000, 3000, 4000])).toBe(4000);
  });

  it('takes the mean of the two middle values of an even count', () => {
    expect(median([1000, 4000, 2000, 3000])).toBe(2500);
  });

  it('has no median or slowest for no values', () => {
    expect(median([])).toBeUndefined();
    expect(slowest([])).toBeUndefined();
  });

  it('finds the slowest run', () => {
    expect(slowest([1200, 15000, 4000])).toBe(15000);
  });

  it('does not reorder the caller’s array', () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('tokensPerSecond', () => {
  it('divides answer tokens by the seconds spent writing them', () => {
    expect(tokensPerSecond({ answerTokens: 200, answerMs: 4000 })).toBe(50);
  });

  it('is unknown when the answer took no time or a field is missing', () => {
    expect(tokensPerSecond({ answerTokens: 200, answerMs: 0 })).toBeUndefined();
    expect(tokensPerSecond({ answerTokens: 200 })).toBeUndefined();
    expect(tokensPerSecond(undefined)).toBeUndefined();
  });
});

describe('summarize', () => {
  it('gives medians of each column and the slowest total', () => {
    const summary = summarize([
      ok(12000, {
        firstTokenMs: 5000,
        timings: { loadMs: 4000, promptTokens: 600, answerTokens: 300, answerMs: 6000 },
      }),
      ok(8000, {
        firstTokenMs: 1000,
        timings: { loadMs: 10, promptTokens: 600, answerTokens: 280, answerMs: 7000 },
      }),
      ok(7000, {
        firstTokenMs: 900,
        timings: { loadMs: 12, promptTokens: 20, answerTokens: 260, answerMs: 5200 },
      }),
    ]);
    expect(summary).toEqual({
      runs: 3,
      failed: 0,
      medianMs: 8000,
      slowestMs: 12000,
      firstTokenMs: 1000,
      loadMs: 12,
      promptTokens: 600,
      answerTokens: 280,
      tokensPerSecond: 50,
    });
  });

  it('marks failed runs instead of dropping them, and leaves them out of the times', () => {
    const summary = summarize([ok(5000), failed(), ok(7000)]);
    expect(summary).toMatchObject({ runs: 3, failed: 1, medianMs: 6000, slowestMs: 7000 });
  });

  it('has no times when every run failed', () => {
    expect(summarize([failed(), failed()])).toEqual({ runs: 2, failed: 2 });
  });

  it('leaves out a column no run reported', () => {
    const summary = summarize([ok(5000), ok(6000)]);
    expect(summary).toEqual({ runs: 2, failed: 0, medianMs: 5500, slowestMs: 6000 });
  });
});

describe('formatting', () => {
  it('writes milliseconds under a second and seconds after, with a dash when unknown', () => {
    expect(formatMs(845.6)).toBe('846 ms');
    expect(formatMs(12345)).toBe('12.3 s');
    expect(formatMs(undefined)).toBe('–');
  });

  it('says how many runs failed', () => {
    expect(formatRuns({ runs: 3, failed: 0 })).toBe('3');
    expect(formatRuns({ runs: 3, failed: 1 })).toBe('2 of 3 (1 failed)');
  });

  it('names the GPU share the way `ollama ps` does', () => {
    expect(formatGpuShare(1)).toBe('100% GPU');
    expect(formatGpuShare(0)).toBe('100% CPU');
    expect(formatGpuShare(0.4)).toBe('40% GPU, 60% CPU');
  });

  it('dates a section in local time', () => {
    expect(formatDate(new Date(2026, 10, 2, 9, 5))).toBe('2026-11-02 09:05');
  });

  it('formats a markdown table with numbers right-aligned', () => {
    const table = formatTable([
      {
        sample: 'Go line',
        summary: {
          runs: 3,
          failed: 1,
          medianMs: 9100,
          slowestMs: 14000,
          firstTokenMs: 800,
          loadMs: 5,
          promptTokens: 1234,
          answerTokens: 250,
          tokensPerSecond: 31.25,
        },
      },
      { sample: 'Broken | sample', summary: { runs: 3, failed: 3 } },
    ]);
    expect(table.split('\n')).toEqual([
      '| Sample | Runs | Median | Slowest | First token | Load | Prompt tokens | Answer tokens | Tokens/s |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| Go line | 2 of 3 (1 failed) | 9.1 s | 14.0 s | 800 ms | 5 ms | 1,234 | 250 | 31.3 |',
      '| Broken \\| sample | 0 of 3 (3 failed) | – | – | – | – | – | – | – |',
    ]);
  });
});

describe('formatReport', () => {
  const report: BenchReport = {
    startedAt: new Date(2026, 10, 2, 14, 5),
    machine: {
      os: 'Windows 11 Home (10.0.26100)',
      cpu: 'AMD Ryzen 7 7840U (16 threads)',
      ramBytes: 32 * 1024 ** 3,
      gpus: ['AMD Radeon 780M'],
      ollamaVersion: '0.12.3',
    },
    llmUrl: 'http://localhost:11434',
    runsPerSample: 2,
    temperature: 0.2,
    maxResponseTokens: 1024,
    models: [
      {
        model: 'qwen2.5-coder:7b',
        contextTokens: 4096,
        gpuShare: 1,
        rows: [
          { sample: 'Short line', runs: [ok(9000), ok(11000)] },
          { sample: 'Long block', runs: [ok(20000), failed('The request was cancelled.')] },
        ],
      },
    ],
  };

  it('puts the date, models, machine and settings above a table per model', () => {
    const text = formatReport(report);
    expect(text).toContain('## 2026-11-02 14:05 · qwen2.5-coder:7b\n');
    expect(text).toContain(
      '- **Machine:** Windows 11 Home (10.0.26100); AMD Ryzen 7 7840U (16 threads); 32.0 GB RAM',
    );
    expect(text).toContain('- **GPU:** AMD Radeon 780M');
    expect(text).toContain('- **Ollama:** 0.12.3 at http://localhost:11434');
    expect(text).toContain('temperature 0.2, answers up to 1024 tokens, 2 runs per sample');
    expect(text).toContain('### qwen2.5-coder:7b (context 4096 tokens, ran on 100% GPU)');
  });

  it('adds a row for all samples together', () => {
    const text = formatReport(report);
    expect(text).toContain('| Short line | 2 | 10.0 s | 11.0 s |');
    expect(text).toContain('| Long block | 1 of 2 (1 failed) | 20.0 s | 20.0 s |');
    expect(text).toContain('| **All samples** | 3 of 4 (1 failed) | 11.0 s | 20.0 s |');
  });

  it('lists each failed run with its error under the table', () => {
    expect(formatReport(report)).toContain(
      'Failed runs:\n\n- Long block, run 2: The request was cancelled.',
    );
  });

  it('says when no GPU was found and leaves out what Ollama did not report', () => {
    const text = formatReport({
      ...report,
      runsPerSample: 1,
      machine: { ...report.machine, gpus: [], ollamaVersion: undefined },
      models: [{ model: 'm', rows: [{ sample: 's', runs: [ok(1000)] }] }],
    });
    expect(text).toContain('- **GPU:** none found');
    expect(text).toContain('- **Ollama:** http://localhost:11434');
    expect(text).toContain('1 run per sample');
    expect(text).toContain('### m\n');
    expect(text).not.toContain('Failed runs');
  });
});

describe('appendReport', () => {
  it('starts a new file with the intro', () => {
    expect(appendReport(null, '## run 1\n')).toBe(`${LATENCY_DOC_INTRO.trimEnd()}\n\n## run 1\n`);
  });

  it('adds each run at the end, keeping the earlier ones', () => {
    const first = appendReport(null, '## run 1\n');
    const second = appendReport(first, '## run 2\n');
    expect(second.startsWith(first.trimEnd())).toBe(true);
    expect(second.endsWith('## run 1\n\n## run 2\n')).toBe(true);
  });
});

describe('parseBenchArgs', () => {
  it('defaults to 3 runs, the first installed model, and saving', () => {
    expect(parseBenchArgs([])).toEqual({ models: [], runs: 3, save: true });
  });

  it('reads models, --runs, --url and --no-save in either form', () => {
    expect(
      parseBenchArgs([
        'qwen2.5-coder:7b',
        '--runs',
        '5',
        'llama3.2:3b',
        '--url=http://127.0.0.1:1234',
        '--no-save',
      ]),
    ).toEqual({
      models: ['qwen2.5-coder:7b', 'llama3.2:3b'],
      runs: 5,
      llmUrl: 'http://127.0.0.1:1234',
      save: false,
    });
  });

  it('refuses unknown options and bad run counts', () => {
    expect(() => parseBenchArgs(['--fast'])).toThrow('Unknown option --fast');
    expect(() => parseBenchArgs(['--runs', '0'])).toThrow('--runs must be');
    expect(() => parseBenchArgs(['--runs', 'two'])).toThrow('--runs must be');
    expect(() => parseBenchArgs(['--url'])).toThrow('--url needs a value');
  });
});

describe('the samples in bench/', () => {
  const dir = join(import.meta.dirname, '..', 'bench');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

  it('has five samples', () => {
    expect(files).toHaveLength(5);
  });

  it.each(files)('%s is a valid sample that fits the default prompt budget untrimmed', (file) => {
    const sample = parseSample(JSON.parse(readFileSync(join(dir, file), 'utf8')), file);
    const fileContext =
      sample.fileContext === undefined ? undefined : toFileContext(sample.fileContext);
    if (sample.fileContext !== undefined) expect(fileContext).toBeDefined();
    const budget = promptBudget(FALLBACK_CONTEXT_TOKENS, DEFAULT_SETTINGS.maxResponseTokens);
    const fitted = buildFittedExplainPrompt(
      sample.context.join('\n'),
      sample.pr,
      budget,
      fileContext,
    );
    expect(fitted.trimmed).toEqual([]);
  });

  it('refuses a sample without a name or context lines', () => {
    expect(() => parseSample({ context: ['x'] }, 'a.json')).toThrow('a.json: "name" must be text');
    expect(() => parseSample({ name: 'x', context: [] }, 'b.json')).toThrow('"context" must be');
    expect(() => parseSample({ name: 'x', context: ['y'], pr: { title: 't' } }, 'c.json')).toThrow(
      '"pr" needs',
    );
  });
});
