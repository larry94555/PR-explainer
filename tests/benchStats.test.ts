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
  formatByHunkReport,
  formatByHunkTable,
  formatDate,
  formatGpuShare,
  formatMs,
  formatReport,
  formatRuns,
  formatShare,
  goalVerdicts,
  formatTable,
  formatParallelReport,
  formatCachedShare,
  formatMinutes,
  formatWholePrReport,
  formatWholePrTable,
  summarizeWholePr,
  type WholePrResult,
  LATENCY_DOC_INTRO,
  median,
  mostAtOnce,
  PARALLEL_TABLE_HEADER,
  ranOneAtATime,
  recommendAtOnce,
  summarizeLevel,
  parseBenchArgs,
  parseSample,
  slowest,
  summarize,
  summarizeAhead,
  summarizeByHunk,
  type HunkBenchResult,
  tokensPerSecond,
  type AheadLineResult,
  type BenchReport,
  type BenchRun,
  type BenchSample,
  type LevelResult,
  type LevelSummary,
  type TimedRun,
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
    expect(parseBenchArgs([])).toEqual({
      models: [],
      runs: 3,
      save: true,
      ahead: false,
      byHunk: false,
      wholePr: false,
    });
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
      byHunk: false,
      wholePr: false,
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
      aheadSkipped: 0,
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

  it('counts lines not tried ahead apart from those that failed', () => {
    const notTried: AheadLineResult = { line: 'a.ts:5', click: ok(4100), fromCache: false };
    const s = summarizeAhead([...lines, notTried]);
    expect(s).toMatchObject({ lines: 5, aheadFailed: 1, aheadSkipped: 1, clicksWithinGoal: 3 });
    expect(formatAheadTable([{ model: 'm', page: 'p', lines: [...lines, notTried] }])).toContain(
      '| m | 5 (1 failed ahead, 1 not tried) |',
    );
    expect(aheadFailures([{ model: 'm', page: 'p', lines: [notTried] }])).toEqual([]);
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

describe('explaining ahead, then clicking (review on #56)', () => {
  // A fake model behind a cache, as in the service worker: an answer explained
  // ahead is in the cache when its line is clicked.
  function fakeModel(failOn: string) {
    const cache = new Set<string>();
    const asked: string[] = [];
    const ask = async (line: { key: string; context: string }, cause: 'ahead' | 'click') => {
      asked.push(`${cause} ${line.key}`);
      if (cache.has(line.key)) return { run: ok(2), fromCache: true };
      if (cause === 'ahead' && line.key === failOn) {
        return { run: { ok: false as const, error: 'Ollama stopped' }, fromCache: false };
      }
      cache.add(line.key);
      return { run: ok(cause === 'ahead' ? 3000 : 3100), fromCache: false };
    };
    return { ask, asked };
  }
  const lines = ['l1', 'l2', 'l3', 'l4'].map((key) => ({ key, context: key }));

  it('stops explaining ahead at the first failed line, as Explain ahead does', async () => {
    const { explainAheadThenClick } = await import('../scripts/benchExplain.ts');
    const model = fakeModel('l2');
    const results = await explainAheadThenClick(lines, model.ask);
    expect(model.asked).toEqual([
      'ahead l1',
      'ahead l2',
      'click l1',
      'click l2',
      'click l3',
      'click l4',
    ]);
    expect(results.map((r) => [r.line, r.ahead?.ok, r.fromCache])).toEqual([
      ['l1', true, true],
      ['l2', false, false],
      ['l3', undefined, false],
      ['l4', undefined, false],
    ]);
    const s = summarizeAhead(results);
    expect(s).toMatchObject({ aheadFailed: 1, aheadSkipped: 2, clicksWithinGoal: 1, share: 0.25 });
  });

  it('explains every line ahead when none fails', async () => {
    const { explainAheadThenClick } = await import('../scripts/benchExplain.ts');
    const results = await explainAheadThenClick(lines, fakeModel('none').ask);
    expect(results.every((r) => r.ahead?.ok && r.fromCache)).toBe(true);
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

describe('by hunk (PR 10.5)', () => {
  const answer = (what: string) => ({ what, why: 'Why.', concerns: 'None found.' });
  const hunks: HunkBenchResult[] = [
    {
      label: 'a.ts: lines 1, 2, 3',
      single: [
        { line: 'a.ts:1', run: ok(4000), answer: answer('One alone.') },
        { line: 'a.ts:2', run: ok(5000), answer: answer('Two alone.') },
        { line: 'a.ts:3', run: failed('Ollama stopped') },
      ],
      hunk: ok(6000),
      byHunk: [answer('One by hunk.'), undefined, answer('Three by hunk.')],
    },
    {
      label: 'b.ts: lines 9, 10',
      single: [
        { line: 'b.ts:9', run: ok(3000), answer: answer('Nine.') },
        { line: 'b.ts:10', run: ok(4000), answer: answer('Ten.') },
      ],
      hunk: failed('Ollama stopped'),
      byHunk: [undefined, undefined],
    },
  ];

  it('compares the time per line one at a time with the time per line answered by hunk', () => {
    expect(summarizeByHunk(hunks)).toEqual({
      lines: 5,
      singleAnswered: 4,
      singlePerLineMs: 4000,
      // 6 s for the 2 lines its answer had; the failed hunk adds nothing.
      hunkAnswered: 2,
      hunkPerLineMs: 3000,
      speedup: 4000 / 3000,
      hunkFailed: 1,
    });
    expect(summarizeByHunk([])).toEqual({
      lines: 0,
      singleAnswered: 0,
      hunkAnswered: 0,
      hunkFailed: 0,
    });
  });

  it('writes a table and both answers for every line, to read by hand', () => {
    const results = [{ model: 'm', page: 'page.html', hunks, ranOn: '100% CPU' }];
    expect(formatByHunkTable(results)).toContain(
      '| m (100% CPU) | 5 | 4.0 s | 3.0 s | 1.3× | 2 of 5 (1 failed) |',
    );
    const text = formatByHunkReport({
      startedAt: new Date(2026, 10, 4, 7, 5),
      machine: {
        os: 'Windows 11 Pro',
        cpu: 'CPU (16 threads)',
        ramBytes: 16 * 1024 ** 3,
        gpus: [],
      },
      llmUrl: 'http://localhost:11434',
      temperature: 0.2,
      maxResponseTokens: 120,
      results,
    });
    expect(text).toMatch(/^## 2026-11-04 07:05 · By hunk · m\n/);
    expect(text).toContain('each added line of `page.html` is explained on its own');
    expect(text).toContain(
      [
        '- **a.ts:1**',
        '  - One at a time: One alone. Why. Concerns: None found.',
        '  - By hunk: One by hunk. Why. Concerns: None found.',
        '- **a.ts:2**',
        '  - One at a time: Two alone. Why. Concerns: None found.',
        '  - By hunk: (missing)',
        '- **a.ts:3**',
        '  - One at a time: failed: Ollama stopped',
      ].join('\n'),
    );
    expect(text).toContain(
      '- **b.ts:9**\n  - One at a time: Nine. Why. Concerns: None found.\n  - By hunk: failed: Ollama stopped',
    );
  });

  it('asks about the hunks of the saved diff page, as Explain ahead would', async () => {
    const { hunkRequests, AHEAD_PAGE } = await import('../scripts/benchExplain.ts');
    const requests = hunkRequests(readFileSync(AHEAD_PAGE, 'utf8'));
    expect(requests.map((r) => r.label)).toEqual([
      'tests/manifest.test.ts: lines 48, 50',
      'tests/manifest.test.ts: lines 59, 60, 61, 62, 63',
    ]);
  });
});

describe('requests at once (PR 10.1)', () => {
  // A finished answer that Ollama worked on from `from` to `to` (its own
  // reading and writing time), sent at `sent`.
  const timed = (from: number, to: number, sent = 0): TimedRun => ({
    run: ok(to - sent, { timings: { promptMs: 100, answerMs: to - from - 100 } }),
    startMs: sent,
    endMs: to,
  });
  const failedRun = (to: number): TimedRun => ({ run: failed(), startMs: 0, endMs: to });

  describe('mostAtOnce', () => {
    it('is 1 when the answers came one after another, even if all were sent at once', () => {
      expect(mostAtOnce([timed(0, 4000), timed(4000, 8000), timed(8010, 12_000)])).toBe(1);
    });

    it('does not count a short overlap from timing noise', () => {
      expect(mostAtOnce([timed(0, 4000), timed(3900, 8000)])).toBe(1);
    });

    it('counts the requests Ollama worked on together', () => {
      expect(mostAtOnce([timed(0, 6000), timed(0, 6000), timed(3000, 9000)])).toBe(3);
      expect(mostAtOnce([timed(0, 6000), timed(0, 6000), timed(6000, 12_000)])).toBe(2);
    });

    it('falls back to the first token, then to when it was sent, without Ollama timings', () => {
      const plain = (sent: number, end: number, firstTokenAtMs?: number): TimedRun => ({
        run: ok(end - sent),
        startMs: sent,
        endMs: end,
        ...(firstTokenAtMs !== undefined && { firstTokenAtMs }),
      });
      expect(mostAtOnce([plain(0, 4000, 1000), plain(0, 8000, 4000)])).toBe(1);
      expect(mostAtOnce([plain(0, 4000), plain(0, 8000)])).toBe(2);
    });

    it('leaves out failed requests, and is 0 when none finished', () => {
      expect(mostAtOnce([timed(0, 4000), failedRun(4000)])).toBe(1);
      expect(mostAtOnce([failedRun(10)])).toBe(0);
      expect(mostAtOnce([])).toBe(0);
    });
  });

  describe('summarizeLevel', () => {
    it('works out answers per minute, the time per answer and the click', () => {
      const level: LevelResult = {
        atOnce: 2,
        answers: [timed(0, 6000), timed(0, 8000), timed(6000, 12_000, 6000), failedRun(12_000)],
        click: { run: ok(9000), startMs: 1000, endMs: 10_000 },
      };
      expect(summarizeLevel(level)).toEqual({
        atOnce: 2,
        answers: 4,
        failed: 1,
        wallMs: 12_000,
        perMinute: 15, // 3 finished in 12 s
        medianMs: 6000,
        slowestMs: 8000,
        ranTogether: 2,
        clickMs: 9000,
      });
    });

    it('notes a failed click and a level with no finished answers', () => {
      const s = summarizeLevel({
        atOnce: 1,
        answers: [failedRun(500)],
        click: { run: failed('boom'), startMs: 0, endMs: 10 },
      });
      expect(s).toEqual({
        atOnce: 1,
        answers: 1,
        failed: 1,
        wallMs: 500,
        ranTogether: 0,
        clickError: 'boom',
      });
    });
  });

  describe('ranOneAtATime', () => {
    const at = (atOnce: number, ranTogether: number, answers = 4, failedCount = 0) =>
      ({ atOnce, ranTogether, answers, failed: failedCount, wallMs: 1 }) as LevelSummary;
    it('is true only when more than one was sent but Ollama ran one at a time', () => {
      expect(ranOneAtATime(at(2, 1))).toBe(true);
      expect(ranOneAtATime(at(4, 1))).toBe(true);
      expect(ranOneAtATime(at(1, 1))).toBe(false);
      expect(ranOneAtATime(at(2, 2))).toBe(false);
      // One finished answer cannot show anything either way.
      expect(ranOneAtATime(at(2, 1, 2, 1))).toBe(false);
    });
  });

  describe('recommendAtOnce', () => {
    const level = (atOnce: number, perMinute?: number, clickMs?: number) =>
      ({
        atOnce,
        answers: 15,
        failed: 0,
        wallMs: 1,
        ranTogether: atOnce,
        ...(perMinute !== undefined && { perMinute }),
        ...(clickMs !== undefined && { clickMs }),
      }) as LevelSummary;

    it('picks 2 when it gives clearly more answers without slowing the click', () => {
      expect(recommendAtOnce([level(1, 10, 5000), level(2, 13, 5200), level(4, 14, 9000)])).toEqual(
        {
          atOnce: 2,
          why: '2 at once gave 30% more answers per minute and the click took 4% longer',
        },
      );
      expect(recommendAtOnce([level(1, 10, 5000), level(2, 12, 4000)]).atOnce).toBe(2);
    });

    it('keeps 1 when 2 gives little more, or slows the click', () => {
      expect(recommendAtOnce([level(1, 10, 5000), level(2, 11, 5000)])).toEqual({
        atOnce: 1,
        why: '2 at once gave 10% more answers per minute',
      });
      expect(recommendAtOnce([level(1, 10, 5000), level(2, 9, 5000)]).why).toBe(
        '2 at once gave 10% fewer answers per minute',
      );
      expect(recommendAtOnce([level(1, 10, 5000), level(2, 15, 6000)])).toEqual({
        atOnce: 1,
        why: '2 at once gave 50% more answers per minute, but the click took 20% longer',
      });
      expect(recommendAtOnce([level(1, 10, 5000), level(2, 15)]).atOnce).toBe(1);
    });

    it('keeps 1 when either level had failed answers, however fast 2 was (review on #60)', () => {
      const withFailures = (l: LevelSummary, failedCount: number) => ({
        ...l,
        failed: failedCount,
      });
      expect(recommendAtOnce([level(1, 10, 5000), withFailures(level(2, 15, 4000), 2)])).toEqual({
        atOnce: 1,
        why: '2 of 15 failed at 2 at once, so the safe choice',
      });
      expect(
        recommendAtOnce([withFailures(level(1, 10, 5000), 1), withFailures(level(2, 15, 4000), 3)]),
      ).toEqual({
        atOnce: 1,
        why: '1 of 15 failed at 1 at once and 3 of 15 failed at 2 at once, so the safe choice',
      });
    });

    it('keeps 1 when level 1 or 2 was not measured', () => {
      expect(recommendAtOnce([level(1, 10, 5000), level(4, 30, 5000)])).toEqual({
        atOnce: 1,
        why: 'levels 1 and 2 were not both measured, so the safe choice',
      });
      expect(recommendAtOnce([level(1), level(2, 10, 1)]).atOnce).toBe(1);
    });
  });

  it('writes the section npm run bench -- --parallel adds to docs/latency.md', () => {
    const serial: LevelResult = {
      atOnce: 2,
      answers: [timed(0, 4000), timed(4000, 8000)],
      click: { run: ok(7000), startMs: 500, endMs: 7500 },
    };
    const one: LevelResult = {
      atOnce: 1,
      answers: [timed(0, 4000), timed(4000, 8000, 4000)],
      click: { run: failed('boom'), startMs: 500, endMs: 600 },
    };
    const text = formatParallelReport({
      startedAt: new Date(2026, 10, 4, 7, 5),
      machine: {
        os: 'Windows 11 Pro',
        cpu: 'CPU (16 threads)',
        ramBytes: 16 * 1024 ** 3,
        gpus: [],
      },
      llmUrl: 'http://localhost:11434',
      temperature: 0.2,
      maxResponseTokens: 120,
      numParallel: '2',
      results: [{ model: 'm', ranOn: '100% CPU', levels: [one, serial] }],
    });
    expect(text).toMatch(/^## 2026-11-04 07:05 · Requests at once · m\n/);
    expect(text).toContain(
      '- **Settings:** temperature 0.2, answers up to 120 tokens, 2 answers per level',
    );
    expect(text).toContain('- **OLLAMA_NUM_PARALLEL:** 2 in this shell');
    expect(text).toContain(`| ${PARALLEL_TABLE_HEADER.join(' | ')} |`);
    expect(text).toContain('| m (100% CPU) | 1 | 2 | 15.0 | 4.0 s | 4.0 s | 1 | failed |');
    expect(text).toContain('| m (100% CPU) | 2 | 2 | 15.0 | 6.0 s | 8.0 s | 1 | 7.0 s |');
    expect(text).toContain('- m: at 2 at once, Ollama ran the requests one after another anyway');
    expect(text).toContain(
      '- **For PR 10.6, m: 1 at once.** 2 at once gave 0% more answers per minute.',
    );
    expect(text).toContain('Failed requests:\n\n- m, 1 at once, click: boom\n');
    // Without the variable in this shell.
    const unset = formatParallelReport({
      startedAt: new Date(2026, 10, 4),
      machine: { os: 'o', cpu: 'c', ramBytes: 0, gpus: [] },
      llmUrl: 'u',
      temperature: 0.2,
      maxResponseTokens: 120,
      results: [{ model: 'm', levels: [one] }],
    });
    expect(unset).toContain('- **OLLAMA_NUM_PARALLEL:** not set in this shell');
  });

  describe('runLevel', () => {
    // A fake Ollama on a fake clock: each answer takes 1000 ms of its own,
    // and `slots` requests are worked on together.
    function fakeOllama(slots: number) {
      let clock = 0;
      let running = 0;
      let mostRunning = 0;
      const waiting: (() => void)[] = [];
      const sent: string[] = [];
      const tick = () => new Promise<void>((r) => setImmediate(r));
      const ask = async (sample: BenchSample, onFirstToken: () => void): Promise<BenchRun> => {
        sent.push(sample.name);
        if (running >= slots) await new Promise<void>((r) => waiting.push(r));
        else running++;
        mostRunning = Math.max(mostRunning, running);
        const from = clock;
        await tick();
        onFirstToken();
        clock += 1000 / slots;
        await tick();
        const next = waiting.shift();
        if (next) next();
        else running--;
        return ok(clock - from, { timings: { answerMs: clock - from } });
      };
      return { ask, sent, now: () => clock, most: () => mostRunning };
    }
    const sample = (name: string): BenchSample => ({ name, context: [name] });
    const samples = ['a', 'b', 'c'].map(sample);

    it('sends every sample `runs` times, and whole rounds until two of the highest level', async () => {
      const { levelJobs } = await import('../scripts/benchExplain.ts');
      const names = (jobs: BenchSample[]) => jobs.map((s) => s.name);
      expect(names(levelJobs(samples, 2, [1, 2]))).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
      // Two rounds of 4 need 8 requests, so three whole rounds of the samples.
      expect(names(levelJobs(samples, 1, [1, 2, 4]))).toEqual([
        ...['a', 'b', 'c'],
        ...['a', 'b', 'c'],
        ...['a', 'b', 'c'],
      ]);
    });

    it('gives every level the same work, also with --runs 1 and 1,2,4 (review on #60)', async () => {
      const { levelJobs } = await import('../scripts/benchExplain.ts');
      const five = ['1', '2', '3', '4', '5'].map(sample);
      const jobs = levelJobs(five, 1, [1, 2, 4]);
      // One list for every level, with each sample the same number of times.
      expect(jobs).toHaveLength(10);
      for (const s of five) expect(jobs.filter((j) => j === s)).toHaveLength(2);
    });

    it('keeps at most `atOnce` requests going, then sends one click once the model is writing', async () => {
      const { runLevel } = await import('../scripts/benchExplain.ts');
      const fake = fakeOllama(8);
      const level = await runLevel(2, levelJobs(samples), sample('click'), fake.ask, fake.now);
      expect(level.answers).toHaveLength(6);
      expect(level.answers.every((a) => a.run.ok && a.firstTokenAtMs !== undefined)).toBe(true);
      // Two background requests and the click.
      expect(fake.most()).toBe(3);
      expect(fake.sent.filter((n) => n === 'click')).toHaveLength(1);
      expect(fake.sent.indexOf('click')).toBe(2);
      expect(level.click?.run.ok).toBe(true);
      function levelJobs(s: BenchSample[]) {
        return [...s, ...s];
      }
    });

    it('shows a server that works one at a time as 1 ran together', async () => {
      const { runLevel } = await import('../scripts/benchExplain.ts');
      const fake = fakeOllama(1);
      const level = await runLevel(
        4,
        [...samples, ...samples],
        sample('click'),
        fake.ask,
        fake.now,
      );
      const s = summarizeLevel(level);
      expect(s).toMatchObject({ atOnce: 4, answers: 6, failed: 0, ranTogether: 1 });
      expect(ranOneAtATime(s)).toBe(true);
    });

    it('still sends the click when the first request fails before writing', async () => {
      const { runLevel } = await import('../scripts/benchExplain.ts');
      const asked: string[] = [];
      const level = await runLevel(1, [sample('a')], sample('click'), async (s) => {
        asked.push(s.name);
        return s.name === 'a' ? failed() : ok(5);
      });
      expect(asked).toEqual(['a', 'click']);
      expect(level.answers[0]!.run.ok).toBe(false);
      expect(level.click?.run).toEqual(ok(5));
    });
  });
});

// PR 10.8: the whole-PR mode.
describe('the whole-PR mode', () => {
  const machine = {
    os: 'Windows 11 Pro',
    cpu: 'CPU (16 threads)',
    ramBytes: 16 * 1024 ** 3,
    gpus: [],
  };
  const okRun = (totalMs: number): BenchRun => ({ ok: true, totalMs });
  const minutes = (m: number) => m * 60_000;

  /** A run over `lines` lines, `answered` of them at the times given (in minutes). */
  const result = (over: Partial<WholePrResult> = {}): WholePrResult => ({
    model: 'm',
    sample: 'tests/fixtures/pr.json',
    lines: 10,
    sent: 10,
    requests: 4,
    atOnce: 1,
    totalMs: minutes(10),
    stopped: false,
    answered: [0.5, 0.5, 2, 2, 4, 4, 6, 8, 10, 10].map((m, i) => ({
      line: `a.ts:added:${i + 1}`,
      atMs: minutes(m),
    })),
    single: [okRun(3000), okRun(5000), { ok: false, error: 'timeout' }],
    click: {
      line: 'a.ts:added:10',
      sentAtMs: 30_000,
      startedAtMs: 30_012,
      run: okRun(4200),
      finishedWhileWaiting: 0,
      cancelled: 1,
    },
    failures: [],
    ...over,
  });

  describe('summarizeWholePr', () => {
    it('gives the whole time, the time per line both ways, and the click wait', () => {
      const s = summarizeWholePr(result());
      expect(s).toMatchObject({
        lines: 10,
        answered: 10,
        wholePrMs: minutes(10),
        estimated: false,
        // The failed single run adds no time.
        singlePerLineMs: 4000,
        byHunkPerLineMs: 60_000,
        click: { line: 'a.ts:added:10', waitMs: 12, totalMs: 4200, cancelled: 1 },
      });
      expect(s.speedup).toBeCloseTo(4000 / 60_000);
      expect(s.click?.waitedAtMostOneCancelled).toBe(true);
    });

    it('counts the lines cached by 1, 5 and 15 minutes, keeping the final share after the end', () => {
      expect(summarizeWholePr(result()).cached).toEqual([
        { minutes: 1, answered: 2, share: 0.2 },
        { minutes: 5, answered: 6, share: 0.6 },
        { minutes: 15, answered: 10, share: 1 },
      ]);
    });

    it('measures the share against every changed line, including those past the limit', () => {
      const s = summarizeWholePr(result({ lines: 20 }));
      expect(s.cached.map((c) => c.share)).toEqual([0.1, 0.3, 0.5]);
    });

    it('estimates the whole PR from the rate when the run was stopped', () => {
      const s = summarizeWholePr(
        result({ stopped: true, sent: 30, totalMs: minutes(20), lines: 30 }),
      );
      expect(s.estimated).toBe(true);
      expect(s.wholePrMs).toBe(minutes(20 / 10) * 30);
    });

    it('fails the click check when a background request finished while it waited', () => {
      const click = { ...result().click!, finishedWhileWaiting: 1 };
      expect(summarizeWholePr(result({ click })).click?.waitedAtMostOneCancelled).toBe(false);
      const never = { ...click, finishedWhileWaiting: 0, startedAtMs: undefined };
      expect(summarizeWholePr(result({ click: never })).click).toMatchObject({
        waitedAtMostOneCancelled: false,
      });
      expect(summarizeWholePr(result({ click: never })).click?.waitMs).toBeUndefined();
    });

    it('gives no times when nothing finished', () => {
      const s = summarizeWholePr(
        result({ answered: [], single: [], click: undefined, totalMs: 0 }),
      );
      expect(s).toMatchObject({ answered: 0 });
      expect(s.byHunkPerLineMs).toBeUndefined();
      expect(s.singlePerLineMs).toBeUndefined();
      expect(s.click).toBeUndefined();
    });
  });

  describe('the section', () => {
    const section = formatWholePrReport({
      startedAt: new Date(2026, 10, 4, 9, 5),
      machine,
      llmUrl: 'http://localhost:11434',
      temperature: 0.2,
      maxResponseTokens: 300,
      maxMs: minutes(20),
      results: [result({ ranOn: '100% CPU' })],
      conclusion: '**Most clicks are instant after 5 minutes, with m.**\n',
    });

    it('has a dated heading, the settings and a row per model', () => {
      expect(section).toContain('## 2026-11-04 09:05 · Whole PR · m');
      expect(section).toContain(
        '1 at once, each model stopped after 20.0 min at most (loading it and the lines one at a time included)',
      );
      expect(section).toContain(
        '| m (100% CPU) | 10 | 10.0 min | 4.0 s | 60.0 s | 20% (2 of 10) | 60% (6 of 10) | 100% (10 of 10) |',
      );
    });

    it('describes the click and ends with the conclusion', () => {
      expect(section).toContain(
        '- m: a click on a.ts:added:10 at 0:30 started after 12 ms, stopping 1 background request, ' +
          'answered in 4.2 s (a line alone: 4.0 s). It waited no longer than one cancelled request.',
      );
      expect(
        section.trimEnd().endsWith('**Most clicks are instant after 5 minutes, with m.**'),
      ).toBe(true);
    });

    it('says how many lines were sent when the limit cut the PR, and lists failures', () => {
      const cut = formatWholePrTable([result({ lines: 600, sent: 500 })]);
      expect(cut).toContain('| m | 600 (500 sent) |');
      const failedSection = formatWholePrReport({
        startedAt: new Date(2026, 10, 4, 9, 5),
        machine,
        llmUrl: 'http://localhost:11434',
        temperature: 0.2,
        maxResponseTokens: 300,
        maxMs: minutes(20),
        results: [result({ failures: ['a.ts: lines 1, 2: timeout'], click: undefined })],
      });
      expect(failedSection).toContain('- m: no click was sent (the run ended first).');
      expect(failedSection).toContain('Failed requests:\n\n- m: a.ts: lines 1, 2: timeout');
    });

    it('rounds the cached share down, so it never says 100% early', () => {
      expect(formatCachedShare({ minutes: 5, answered: 251, share: 251 / 252 }, 252)).toBe(
        '99% (251 of 252)',
      );
    });

    it('formats minutes, and marks an estimate', () => {
      expect(formatMinutes(45_000)).toBe('45.0 s');
      expect(formatMinutes(minutes(12.34))).toBe('12.3 min');
      expect(formatMinutes(minutes(41), true)).toBe('about 41.0 min');
      expect(formatMinutes(undefined)).toBe('–');
    });
  });

  describe('wholePrPlan', () => {
    it('builds one request per hunk from the saved PR, as Whole PR sends them', async () => {
      const { wholePrPlan, WHOLE_PR_SAMPLE } = await import('../scripts/benchExplain.ts');
      const files = JSON.parse(readFileSync(WHOLE_PR_SAMPLE, 'utf8'));
      const plan = wholePrPlan(files);
      expect(plan.lines).toBe(252);
      expect(plan.sent).toBe(252);
      expect(plan.requests.length).toBeGreaterThanOrEqual(39);
      for (const request of plan.requests) {
        expect(request.lines.length).toBeGreaterThan(0);
        expect(request.lines.length).toBeLessThanOrEqual(15);
        // Every line of a request is in the same file.
        const files = new Set(request.lines.map((l) => l.label.split(':added:')[0]));
        expect(files.size).toBe(1);
      }
      expect(plan.requests[0]!.label).toMatch(/^src\/background\.ts: lines? /);
    });

    it('stops at the per-PR limit', async () => {
      const { wholePrPlan, WHOLE_PR_SAMPLE } = await import('../scripts/benchExplain.ts');
      const plan = wholePrPlan(JSON.parse(readFileSync(WHOLE_PR_SAMPLE, 'utf8')), 20);
      expect(plan).toMatchObject({ lines: 252, sent: 20 });
    });
  });

  describe('prefetchWholePr', () => {
    type Ask = import('../scripts/benchExplain.ts').WholePrAsk;
    type Request = import('../src/explainAhead').HunkRequest;

    const request = (file: string, numbers: number[]): Request => ({
      label: `${file}: lines ${numbers.join(', ')}`,
      text: `hunk of ${file}`,
      lines: numbers.map((n) => ({
        label: `${file}:added:${n}`,
        request: { text: `line ${n} of ${file}` } as never,
        line: n,
        code: `+code ${n}`,
      })),
    });

    /**
     * A model that takes 1 s per line on a fake clock, answers on the next
     * tick, and stops when its request is aborted. `missing` lines are left
     * out of a hunk's answer; `failing` requests fail.
     */
    function fakeModel({
      missing = new Set<string>(),
      failing = new Set<string>(),
      hang = false,
    } = {}) {
      const clock = { t: 0 };
      const asked: string[] = [];
      // What the explanation cache would hold: a hunk finds these lines cached.
      const cache = new Set<string>();
      const ask: Ask = (payload, { signal }) =>
        new Promise((resolve, reject) => {
          const label = payload.job?.label ?? payload.cause ?? '';
          asked.push(`${payload.cause}:${label}`);
          signal.addEventListener('abort', () => reject(new Error('aborted')));
          if (hang) return;
          setTimeout(() => {
            if (signal.aborted) return;
            clock.t += 1000 * (payload.hunk?.lines.length ?? 1);
            if (failing.has(label)) {
              resolve({ status: 'failed', message: 'model crashed', fix: '' });
            } else if (payload.hunk) {
              resolve({
                status: 'hunk',
                lines: payload.hunk.lines.map((l) => ({
                  label: l.label,
                  status: cache.has(l.context)
                    ? 'cached'
                    : missing.has(l.label)
                      ? 'missing'
                      : 'done',
                })),
              });
            } else {
              const cached = cache.has(payload.context);
              cache.add(payload.context);
              resolve({
                status: 'done',
                model: 'm',
                explanation: { what: 'w', why: 'y', concerns: 'c' },
                ...(cached && { cached: {} as never }),
              });
            }
          }, 0);
        });
      return { ask, asked, now: () => clock.t };
    }

    it('answers every line in the PR order and records when', async () => {
      const { prefetchWholePr } = await import('../scripts/benchExplain.ts');
      const fake = fakeModel();
      const requests = [request('a.ts', [1, 2]), request('b.ts', [5])];
      const run = await prefetchWholePr(requests, fake.ask, { now: fake.now, click: false });
      expect(fake.asked).toEqual(['ahead:a.ts: lines 1, 2', 'ahead:b.ts:added:5']);
      expect(run).toMatchObject({ totalMs: 3000, stopped: false, failures: [] });
      expect(run.answered).toEqual([
        { line: 'a.ts:added:1', atMs: 2000 },
        { line: 'a.ts:added:2', atMs: 2000 },
        { line: 'b.ts:added:5', atMs: 3000 },
      ]);
      expect(run.click).toBeUndefined();
    });

    it('asks again, one by one, for the lines a hunk answer left out', async () => {
      const { prefetchWholePr } = await import('../scripts/benchExplain.ts');
      const fake = fakeModel({ missing: new Set(['a.ts:added:2']) });
      const run = await prefetchWholePr([request('a.ts', [1, 2, 3])], fake.ask, {
        now: fake.now,
        click: false,
      });
      expect(fake.asked).toEqual(['ahead:a.ts: lines 1, 2, 3', 'ahead:a.ts:added:2']);
      expect(run.answered.map((a) => a.line)).toEqual([
        'a.ts:added:1',
        'a.ts:added:3',
        'a.ts:added:2',
      ]);
    });

    it('lists a request that failed twice and leaves its lines unanswered', async () => {
      const { prefetchWholePr } = await import('../scripts/benchExplain.ts');
      const fake = fakeModel({ failing: new Set(['a.ts: lines 1, 2']) });
      const run = await prefetchWholePr([request('a.ts', [1, 2]), request('b.ts', [5])], fake.ask, {
        now: fake.now,
        click: false,
      });
      expect(fake.asked.filter((a) => a === 'ahead:a.ts: lines 1, 2')).toHaveLength(2);
      expect(run.failures).toEqual(['a.ts: lines 1, 2: model crashed']);
      expect(run.answered.map((a) => a.line)).toEqual(['b.ts:added:5']);
    });

    it('clicks the last line once the first request is in, stopping only the one running', async () => {
      const { prefetchWholePr } = await import('../scripts/benchExplain.ts');
      const fake = fakeModel();
      const requests = [request('a.ts', [1]), request('b.ts', [2, 3]), request('c.ts', [4, 5])];
      const run = await prefetchWholePr(requests, fake.ask, { now: fake.now });
      // b.ts was running when the click came, so it was stopped and run again after.
      expect(fake.asked).toEqual([
        'ahead:a.ts:added:1',
        'ahead:b.ts: lines 2, 3',
        'click:click',
        'ahead:b.ts: lines 2, 3',
        'ahead:c.ts: lines 4, 5',
      ]);
      expect(run.click).toEqual({
        line: 'c.ts:added:5',
        sentAtMs: 1000,
        startedAtMs: 1000,
        run: { ok: true, totalMs: 1000 },
        finishedWhileWaiting: 0,
        cancelled: 1,
      });
      // The clicked line is not counted as prefetched (review on #67), even
      // though c.ts's hunk later finds it in the cache.
      expect(run.answered.map((a) => a.line)).toEqual([
        'a.ts:added:1',
        'b.ts:added:2',
        'b.ts:added:3',
        'c.ts:added:4',
      ]);
      expect(summarizeWholePr({ ...result(), ...run }).click?.waitedAtMostOneCancelled).toBe(true);
    });

    it('does not raise the prefetched share for a line only the click answered', async () => {
      const { prefetchWholePr } = await import('../scripts/benchExplain.ts');
      const fake = fakeModel();
      const requests = [request('a.ts', [1]), request('b.ts', [2])];
      const run = await prefetchWholePr(requests, fake.ask, { now: fake.now });
      expect(run.click).toMatchObject({ line: 'b.ts:added:2', run: { ok: true } });
      // b.ts's own request found its only line cached by the click.
      expect(run.answered.map((a) => a.line)).toEqual(['a.ts:added:1']);
      const s = summarizeWholePr({ ...result(), lines: 2, sent: 2, ...run });
      expect(s.cached.map((c) => c.share)).toEqual([0.5, 0.5, 0.5]);
    });

    it('stops at the time limit and says so', async () => {
      const { prefetchWholePr } = await import('../scripts/benchExplain.ts');
      const fake = fakeModel({ hang: true });
      const run = await prefetchWholePr([request('a.ts', [1, 2])], fake.ask, {
        now: fake.now,
        maxMs: 5,
      });
      expect(run).toMatchObject({ stopped: true, answered: [] });
    });

    it('keeps loading and the lines one at a time inside the time limit (review on #67)', async () => {
      const { runWholePr } = await import('../scripts/benchExplain.ts');
      const hangs = (signal?: AbortSignal) =>
        new Promise<BenchRun>((resolve) =>
          signal?.addEventListener('abort', () => resolve({ ok: false, error: 'stopped' })),
        );
      const asked: string[] = [];
      const bench = {
        explain: (_s: unknown, _m: string, _f?: unknown, signal?: AbortSignal) => {
          asked.push('warm-up');
          return hangs(signal);
        },
        single: (_c: string, _m: string, signal?: AbortSignal) => {
          asked.push('single');
          return hangs(signal);
        },
        wholePrAsk: () => fakeModel({ hang: true }).ask,
        ranOn: async () => undefined,
      };
      const started = Date.now();
      const [model] = await runWholePr(
        bench as never,
        ['m'],
        { name: 'x', context: ['y'] },
        {
          maxMs: 30,
          sample: 'tests/fixtures/github-pr-10-files.json',
        },
      );
      expect(Date.now() - started).toBeLessThan(2000);
      // The stuck warm-up used up the time, so no line was asked alone.
      expect(asked).toEqual(['warm-up']);
      expect(model).toMatchObject({ single: [], answered: [], stopped: true });
    });

    it('ends at once with nothing to send', async () => {
      const { prefetchWholePr } = await import('../scripts/benchExplain.ts');
      const run = await prefetchWholePr([], fakeModel().ask);
      expect(run).toMatchObject({ stopped: false, answered: [], failures: [] });
    });
  });
});
