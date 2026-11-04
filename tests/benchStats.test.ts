// PR 8.2: the numbers and markdown behind `npm run bench`. The script itself
// talks to a real Ollama and is tested by hand.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AHEAD_SHARE_GOAL,
  AHEAD_TABLE_HEADER,
  aheadFailures,
  appendReport,
  formatAheadReport,
  formatAheadTable,
  formatDate,
  formatGpuShare,
  formatMs,
  formatReport,
  formatRuns,
  formatShare,
  goalVerdicts,
  formatTable,
  LATENCY_DOC_INTRO,
  median,
  parseBenchArgs,
  parseSample,
  slowest,
  summarize,
  summarizeAhead,
  tokensPerSecond,
  type AheadLineResult,
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
  it('gives the median thinking tokens and time, and leaves them out when no run thought (PR 9.1)', () => {
    const summary = summarize([
      ok(9000, { think: { tokens: 200, ms: 6000 } }),
      ok(8000, { think: { tokens: 0, ms: 0 } }),
      ok(7000, { think: { tokens: 100, ms: 3000 } }),
      failed(),
    ]);
    expect(summary).toMatchObject({ thinkTokens: 100, thinkMs: 3000 });
    const none = summarize([ok(5000), ok(6000)]);
    expect(none).not.toHaveProperty('thinkTokens');
    expect(none).not.toHaveProperty('thinkMs');
  });

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
          thinkTokens: 180,
          thinkMs: 5760,
        },
      },
      { sample: 'Broken | sample', summary: { runs: 3, failed: 3 } },
    ]);
    expect(table.split('\n')).toEqual([
      '| Sample | Runs | Median | Slowest | First token | Load | Prompt tokens | Answer tokens | Tokens/s | Think tokens | Think time |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| Go line | 2 of 3 (1 failed) | 9.1 s | 14.0 s | 800 ms | 5 ms | 1,234 | 250 | 31.3 | 180 | 5.8 s |',
      '| Broken \\| sample | 0 of 3 (3 failed) | – | – | – | – | – | – | – | – | – |',
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

  it('says how each model did against the 2 s goal (PR 9.9)', () => {
    expect(formatReport(report)).toContain(
      '- **Against the 2 s goal:** qwen2.5-coder:7b did not finish every run (median 11.0 s of those that did).\n',
    );
  });

  it('puts the date, models, machine and settings above a table per model', () => {
    const text = formatReport(report);
    expect(text).toContain('## 2026-11-02 14:05 · qwen2.5-coder:7b\n');
    expect(text).toContain(
      '- **Machine:** Windows 11 Home (10.0.26100); AMD Ryzen 7 7840U (16 threads); 32.0 GB RAM',
    );
    expect(text).toContain('- **GPU:** AMD Radeon 780M');
    expect(text).toContain('- **Ollama:** 0.12.3 at http://localhost:11434');
    expect(text).toContain('temperature 0.2, answers up to 1024 tokens, 2 runs per sample');
    expect(text).toContain('### qwen2.5-coder:7b (context up to 4096 tokens, ran on 100% GPU)');
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
    expect(parseBenchArgs([])).toEqual({ models: [], runs: 3, save: true, ahead: false });
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
      ahead: false,
    });
  });

  it('reads --ahead (PR 9.11)', () => {
    expect(parseBenchArgs(['m', '--ahead'])).toMatchObject({ models: ['m'], ahead: true });
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

describe('goalVerdicts (PR 9.9)', () => {
  const model = (name: string, ...totals: (number | 'failed')[]) => ({
    model: name,
    rows: [{ sample: 'Short line', runs: totals.map((t) => (t === 'failed' ? failed() : ok(t))) }],
  });

  it('compares each model with 2 seconds by the median of every sample', () => {
    expect(
      goalVerdicts([model('qwen2.5-coder:1.5b', 1500, 1700, 2600), model('deepseek-r1:7b', 9000)]),
    ).toBe('qwen2.5-coder:1.5b met it (median 1.7 s); deepseek-r1:7b did not (median 9.0 s).');
  });

  it('does not count exactly 2 seconds as met', () => {
    expect(goalVerdicts([model('m', 2000)])).toBe('m did not (median 2.0 s).');
  });

  it('does not call a model with failed runs met, and says when none finished', () => {
    expect(goalVerdicts([model('flaky', 900, 'failed')])).toBe(
      'flaky did not finish every run (median 900 ms of those that did).',
    );
    expect(goalVerdicts([model('down', 'failed')])).toBe('down has no finished runs.');
  });
});

// PR 9.11: the ahead mode explains each line ahead, then times a click on each.
describe('the ahead mode', () => {
  const line = (
    name: string,
    aheadMs: number | string,
    clickMs: number | string,
    fromCache = true,
  ): AheadLineResult => ({
    line: name,
    ahead: typeof aheadMs === 'number' ? ok(aheadMs) : { ok: false, error: aheadMs },
    click: typeof clickMs === 'number' ? ok(clickMs) : { ok: false, error: clickMs },
    fromCache,
  });
  const lines = [
    line('a.ts:1', 3000, 4),
    line('a.ts:2', 5000, 6),
    line('a.ts:3', 4000, 5),
    line('a.ts:4', 'Ollama stopped', 4200, false),
  ];

  it('sums up the time ahead and the share of clicks within 2 seconds', () => {
    const s = summarizeAhead(lines);
    expect(s).toEqual({
      lines: 4,
      aheadFailed: 1,
      aheadMedianMs: 4000,
      aheadTotalMs: 12_000,
      clicksWithinGoal: 3,
      share: 0.75,
      clickMedianMs: 5.5,
      clickSlowestMs: 4200,
      fromCache: 3,
    });
    expect(formatShare(s)).toBe('3 of 4 (75%)');
  });

  it('counts a failed click as not within the goal, and a click of exactly 2 s as too slow', () => {
    const s = summarizeAhead([line('a', 3000, 'boom'), line('b', 3000, 2000), line('c', 1, 1999)]);
    expect(s.clicksWithinGoal).toBe(1);
    expect(s.share).toBeCloseTo(1 / 3);
    expect(summarizeAhead([])).toMatchObject({ lines: 0, share: 0, aheadTotalMs: 0 });
    expect(AHEAD_SHARE_GOAL).toBe(0.9);
  });

  it('writes a row per model and lists the lines that failed', () => {
    const results = [{ model: 'm', page: 'page.html', ranOn: '100% CPU', lines }];
    const table = formatAheadTable(results);
    expect(table.split('\n')[0]).toBe(`| ${AHEAD_TABLE_HEADER.join(' | ')} |`);
    expect(table).toContain('| Clicks within 2 s |');
    expect(table).toContain(
      '| m (100% CPU) | 4 (1 failed ahead) | 4.0 s | 12.0 s | 3 of 4 (75%) | 6 ms | 4.2 s | 3 of 4 |',
    );
    expect(aheadFailures(results)).toEqual(['- m, a.ts:4, ahead: Ollama stopped']);
  });

  it('writes the section npm run bench -- --ahead adds to docs/latency.md', () => {
    const text = formatAheadReport({
      startedAt: new Date(2026, 10, 4, 7, 5),
      machine: {
        os: 'Windows 11 Pro',
        cpu: 'CPU (16 threads)',
        ramBytes: 16 * 1024 ** 3,
        gpus: [],
      },
      llmUrl: 'http://localhost:11434',
      temperature: 0.2,
      maxResponseTokens: 300,
      results: [{ model: 'm', page: 'page.html', lines }],
    });
    expect(text).toMatch(/^## 2026-11-04 07:05 · Explain ahead · m\n/);
    expect(text).toContain('- **Machine:** Windows 11 Pro; CPU (16 threads); 16.0 GB RAM');
    expect(text).toContain('each added line of `page.html` is explained ahead');
    expect(text).toContain('| m | 4 (1 failed ahead) |');
    expect(text).toContain('Failed lines:\n\n- m, a.ts:4, ahead: Ollama stopped\n');
  });
});

describe('the lines the ahead mode explains', () => {
  it('are the added lines of the saved diff page, each with the request a click sends', async () => {
    const { aheadLines, AHEAD_PAGE } = await import('../scripts/benchExplain.ts');
    const lines = aheadLines(readFileSync(AHEAD_PAGE, 'utf8'));
    expect(lines.map((l) => l.key)).toEqual([
      'tests/manifest.test.ts:48',
      'tests/manifest.test.ts:50',
      'tests/manifest.test.ts:59',
      'tests/manifest.test.ts:60',
      'tests/manifest.test.ts:61',
      'tests/manifest.test.ts:62',
      'tests/manifest.test.ts:63',
    ]);
    expect(lines[0]!.context).toMatch(
      /^File: tests\/manifest\.test\.ts \(TypeScript\)\nClicked line: added, line 48 of the new file\n/,
    );
    expect(lines[0]!.context).toContain('Surrounding diff (the clicked line starts with >):');
  });
});
