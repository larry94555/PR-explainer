// PR 8.8: the latency report behind `npm run bench:history`. The script
// itself runs git and a real Ollama and is tested by hand.
import { execFileSync } from 'node:child_process';
import {
  formatReport,
  type AheadResult,
  type BenchReport,
  type BenchRun,
} from '../scripts/benchStats.ts';
import {
  aheadMeetsGoal,
  conclusion,
  demote,
  dominantTerm,
  fastest,
  formatHistoryReport,
  freshStep,
  GOAL_MS,
  HISTORY_STEPS,
  lastSection,
  nextStep,
  parseDuration,
  parseRuns,
  parseSection,
  timeParts,
  type FloorResult,
  type HistoryReport,
} from '../scripts/latencyReport.ts';
import { LATENCY_GOAL_MS } from '../src/llm/latencyGoal';

const run = (totalMs: number, t: Partial<Record<string, number>> = {}): BenchRun => ({
  ok: true,
  totalMs,
  timings: t,
});

// A section exactly as `npm run bench` writes it.
function benchSection(models: { model: string; totals: number[]; gpuShare?: number }[]): string {
  const report: BenchReport = {
    startedAt: new Date(2026, 10, 2, 9, 30),
    machine: {
      os: 'Windows 11 Pro',
      cpu: 'Test CPU (16 threads)',
      ramBytes: 16 * 1024 ** 3,
      gpus: [],
    },
    llmUrl: 'http://localhost:11434',
    runsPerSample: 3,
    temperature: 0.2,
    maxResponseTokens: 300,
    models: models.map(({ model, totals, gpuShare }) => ({
      model,
      contextTokens: 4096,
      ...(gpuShare !== undefined && { gpuShare }),
      rows: [
        {
          sample: 'Short TypeScript line',
          runs: totals.map((ms) => run(ms, { answerTokens: 200, answerMs: ms * 0.8 })),
        },
      ],
    })),
  };
  return formatReport(report);
}

describe('history steps', () => {
  it('names a commit on main for every step but the last, which is the code as it is now', () => {
    expect(HISTORY_STEPS.at(-1)!.ref).toBe('HEAD');
    expect(HISTORY_STEPS[0]!.label).toMatch(/Baseline/);
    for (const step of HISTORY_STEPS.slice(0, -1)) {
      let isAncestor = true;
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', step.ref, 'HEAD'], { stdio: 'ignore' });
      } catch {
        isAncestor = false;
      }
      expect(isAncestor, `${step.label} (${step.ref}) is in this branch's history`).toBe(true);
    }
  });

  it('adds the Milestone 9 steps after the Milestone 8 ones (PR 9.11)', () => {
    expect(HISTORY_STEPS.map((s) => s.label)).toEqual([
      'Baseline (8.2)',
      'Model kept loaded (8.3)',
      'Shorter answers (8.4)',
      'Smaller prompts (8.5)',
      'End of Milestone 8 (8.6 to 8.8)',
      'Thinking off (9.5)',
      'Fewer round trips (9.7)',
      'One-sentence answers (9.8)',
      'Now (9.9 to 9.11)',
    ]);
    // Each step comes after the one before it.
    const refs = HISTORY_STEPS.slice(0, -1).map((s) => s.ref);
    for (let i = 1; i < refs.length; i++) {
      expect(() =>
        execFileSync('git', ['merge-base', '--is-ancestor', refs[i - 1]!, refs[i]!], {
          stdio: 'ignore',
        }),
      ).not.toThrow();
    }
  });
});

describe('reading what npm run bench wrote', () => {
  it('reads durations back', () => {
    expect(parseDuration('850 ms')).toBe(850);
    expect(parseDuration('12.3 s')).toBe(12_300);
    expect(parseDuration('–')).toBeUndefined();
    expect(parseDuration('fast')).toBeUndefined();
  });

  it('takes the last dated section of docs/latency.md', () => {
    const doc = `# Explanation latency\n\nIntro.\n\n## 2026-11-01 · a\n\nold\n\n## 2026-11-02 · b\n\nnew\n`;
    expect(lastSection(doc)).toBe('## 2026-11-02 · b\n\nnew\n');
    expect(lastSection('# Explanation latency\n\nIntro.\n')).toBeUndefined();
  });

  it("reads each model's All samples row and where it ran from a real bench section", () => {
    const section = benchSection([
      { model: 'qwen2.5-coder:7b', totals: [14_000, 12_000, 13_000], gpuShare: 0 },
      { model: 'qwen2.5-coder:1.5b', totals: [4000, 3000, 5000], gpuShare: 1 },
    ]);
    expect(parseSection(section)).toEqual([
      {
        model: 'qwen2.5-coder:7b',
        ranOn: '100% CPU',
        medianMs: 13_000,
        slowestMs: 14_000,
        tokensPerSecond: 19.2,
        runs: 3,
        failed: 0,
      },
      {
        model: 'qwen2.5-coder:1.5b',
        ranOn: '100% GPU',
        medianMs: 4000,
        slowestMs: 5000,
        tokensPerSecond: 62.5,
        runs: 3,
        failed: 0,
      },
    ]);
  });

  it('reads a section where every run failed as a model with no times', () => {
    const section = benchSection([{ model: 'm', totals: [] }]);
    expect(parseSection(section)).toEqual([{ model: 'm', runs: 0, failed: 0 }]);
  });

  it('reads how many runs failed from the Runs column', () => {
    expect(parseRuns('15')).toEqual({ runs: 15, failed: 0 });
    expect(parseRuns('13 of 15 (2 failed)')).toEqual({ runs: 15, failed: 2 });
    expect(parseRuns('0 of 3 (3 failed)')).toEqual({ runs: 3, failed: 3 });
    expect(parseRuns('many')).toBeUndefined();
  });

  it('does not call the goal met when most runs timed out, even if the one that finished was fast', () => {
    // One fast short line, then five timeouts, including every long selection.
    const timeout: BenchRun = { ok: false, error: 'The model took too long to answer.' };
    const report: BenchReport = {
      startedAt: new Date(2026, 10, 2, 9, 30),
      machine: { os: 'Windows 11 Pro', cpu: 'CPU', ramBytes: 16 * 1024 ** 3, gpus: [] },
      llmUrl: 'http://localhost:11434',
      runsPerSample: 3,
      temperature: 0.2,
      maxResponseTokens: 300,
      models: [
        {
          model: 'flaky',
          rows: [
            { sample: 'Short TypeScript line', runs: [run(1000), timeout, timeout] },
            { sample: 'Long TypeScript selection', runs: [timeout, timeout, timeout] },
          ],
        },
      ],
    };
    const [flaky] = parseSection(formatReport(report));
    expect(flaky).toMatchObject({ model: 'flaky', medianMs: 1000, runs: 6, failed: 5 });
    const text = conclusion([flaky!], []);
    expect(text).not.toMatch(/Goal met/);
    expect(text).toMatch(
      /^\*\*No conclusion\.\*\* No model finished every run at the last step: flaky \(5 of 6 runs failed\)/,
    );
  });
});

describe('where the time goes', () => {
  it('takes the median of each part, with the time outside Ollama never negative', () => {
    const parts = timeParts([
      run(5000, { totalMs: 4500, loadMs: 10, promptMs: 500, answerMs: 4000 }),
      run(6000, { totalMs: 5600, loadMs: 20, promptMs: 600, answerMs: 5000 }),
      run(4000, { totalMs: 4100, loadMs: 30, promptMs: 700, answerMs: 3300 }),
      { ok: false, error: 'boom' },
    ]);
    expect(parts).toEqual({ load: 20, prompt: 600, answer: 4000, outside: 400 });
    expect(dominantTerm(parts!)).toBe('answer');
  });

  it('adds up the parts when Ollama gives no total', () => {
    expect(timeParts([run(1000, { loadMs: 100, promptMs: 200, answerMs: 300 })])!.outside).toBe(
      400,
    );
  });

  it('has no parts when no run finished with timings', () => {
    expect(
      timeParts([
        { ok: false, error: 'x' },
        { ok: true, totalMs: 10 },
      ]),
    ).toBeUndefined();
  });

  it('suggests a GPU when the model is on the CPU, and a smaller model when it is already on the GPU', () => {
    expect(nextStep('answer', '100% CPU')).toMatch(/GPU/);
    expect(nextStep('answer', '100% GPU')).toMatch(/smaller model/);
    expect(nextStep('answer', 'Unknown')).not.toMatch(/runs on Unknown/);
    expect(nextStep('prompt', '40% GPU, 60% CPU')).toMatch(/runs on 40% GPU, 60% CPU/);
    expect(nextStep('load', undefined)).toMatch(/Keep model loaded/);
    expect(nextStep('outside', undefined)).toMatch(/outside Ollama/);
  });
});

describe('the conclusion', () => {
  const floor = (model: string): FloorResult => ({
    model,
    sample: 'Short TypeScript line',
    ranOn: '100% CPU',
    runs: [
      run(11_000, { totalMs: 10_900, loadMs: 5, promptMs: 1500, answerMs: 9395 }),
      run(12_000, { totalMs: 11_900, loadMs: 5, promptMs: 1600, answerMs: 10_295 }),
    ],
  });

  it('picks the model with the lowest median among those that finished every run', () => {
    expect(
      fastest([
        { model: 'a', medianMs: 9000, failed: 0 },
        { model: 'b', medianMs: 4000, failed: 0 },
        { model: 'c' },
      ])?.model,
    ).toBe('b');
    expect(
      fastest([
        { model: 'a', medianMs: 9000, failed: 0 },
        { model: 'b', medianMs: 1000, runs: 15, failed: 4 },
      ])?.model,
    ).toBe('a');
    expect(fastest([{ model: 'c' }])).toBeUndefined();
  });

  it('names a faster model left out because some of its runs failed', () => {
    const text = conclusion(
      [
        { model: 'steady', medianMs: 1800, failed: 0 },
        { model: 'flaky', medianMs: 900, runs: 15, failed: 4 },
      ],
      [],
    );
    expect(text).toMatch(
      /^\*\*Goal met\.\*\* With the default settings, steady explains in 1\.8 s/,
    );
    expect(text).toMatch(/Left out because some runs failed.*: flaky \(4 of 15 runs failed\)\./);
  });

  it('says the goal is met by the fastest model, and warns when its slowest run passes 2 s', () => {
    expect(GOAL_MS).toBe(LATENCY_GOAL_MS);
    expect(GOAL_MS).toBe(2000);
    const text = conclusion(
      [
        { model: 'big', medianMs: 14_000, failed: 0 },
        { model: 'small', medianMs: 1600, slowestMs: 2_400, ranOn: '100% GPU', failed: 0 },
      ],
      [],
    );
    expect(text).toMatch(/^\*\*Goal met\.\*\* With the default settings, small explains in 1\.6 s/);
    expect(text).toMatch(/on 100% GPU/);
    expect(text).toMatch(/slowest run took 2\.4 s, so a long selection can still pass 2\.0 s\./);
    expect(
      conclusion([{ model: 'small', medianMs: 1600, slowestMs: 1900, failed: 0 }], []),
    ).not.toMatch(/slowest/);
  });

  it('does not call a median of exactly 2 seconds, or the 10 seconds of Milestone 8, the goal met', () => {
    expect(conclusion([{ model: 'm', medianMs: 2000, failed: 0 }], [])).toMatch(
      /^\*\*Goal not met\.\*\*/,
    );
    expect(conclusion([{ model: 'm', medianMs: 8000, failed: 0 }], [])).toMatch(
      /^\*\*Goal not met\.\*\*/,
    );
  });

  it('gives the floor, the part that limits it and the next step when the goal is not met', () => {
    const text = conclusion(
      [{ model: 'm', medianMs: 18_000, ranOn: '100% CPU', failed: 0 }],
      [floor('m')],
    );
    expect(text).toMatch(/^\*\*Goal not met\.\*\* The fastest model, m, takes 18\.0 s/);
    expect(text).toMatch(
      /The floor on this laptop is \*\*11\.5 s\*\*: Short TypeScript line, an answer of at most 150 tokens/,
    );
    expect(text).toMatch(/writing the answer limits it/);
    expect(text).toMatch(/Next step: The model runs on 100% CPU, so a GPU/);
  });

  it('says there is no conclusion when nothing finished', () => {
    expect(conclusion([], [])).toMatch(/no conclusion/);
    expect(conclusion([{ model: 'm', runs: 3, failed: 3 }], [])).toMatch(
      /^\*\*No conclusion\.\*\* No model finished every run at the last step: m \(3 of 3 runs failed\)/,
    );
  });
});

describe('the report section', () => {
  const last = HISTORY_STEPS.length - 1;
  // From 20 s at the baseline down to 1.6 s now.
  const at = (i: number, ms: number) => Math.round(ms - (i * 18_400) / last);
  const steps = HISTORY_STEPS.map((step, i) => ({
    step,
    section: benchSection([{ model: 'm', totals: [at(i, 20_000), at(i, 21_000), at(i, 19_000)] }]),
  }));
  const report: HistoryReport = {
    startedAt: '2026-11-02 09:30',
    runsPerSample: 3,
    steps,
    floors: [],
  };

  it("has a row per step, the conclusion, then each step's tables one level lower", () => {
    const text = formatHistoryReport(report);
    expect(text).toMatch(/^## Latency report 2026-11-02 09:30\n/);
    expect(text).toContain('| Step | m median | m slowest |');
    expect(text).toContain('| Baseline (8.2) | 20.0 s | 21.0 s |');
    expect(text).toContain('| Now (9.9 to 9.11) | 1.6 s | 2.6 s |');
    expect(text).toContain(
      '### Conclusion\n\n**Goal met.** With the default settings, m explains in 1.6 s',
    );
    expect(text).toContain('### Baseline (8.2)\n\n#### 2026-11-02 09:30 · m');
    expect(text).toContain('\n##### m (context up to 4096 tokens)\n');
    expect(text.match(/^## /gm)).toHaveLength(1);
  });

  it('marks a step that failed and lists why', () => {
    const text = formatHistoryReport({
      ...report,
      steps: [
        { step: HISTORY_STEPS[0]!, error: 'npm run bench failed at this step' },
        ...steps.slice(1),
      ],
    });
    expect(text).toContain('| Baseline (8.2) (failed) | – | – |');
    expect(text).toContain('- Baseline (8.2): npm run bench failed at this step');
  });

  it('demotes headings by one level', () => {
    expect(demote('## a\n### b\ntext ## c')).toBe('### a\n#### b\ntext ## c');
  });
});

// PR 9.11: fresh answers with the model warm, and clicks after Explain ahead.
describe('fresh answers and Explain ahead', () => {
  const aheadLines = (clickMs: number[]): AheadResult['lines'] =>
    clickMs.map((ms, i) => ({
      line: `a.ts:${i + 1}`,
      ahead: run(4000),
      click: run(ms),
      fromCache: ms < 100,
    }));
  const ahead = (model: string, clickMs: number[]): AheadResult => ({
    model,
    page: 'page.html',
    lines: aheadLines(clickMs),
  });
  const floor: FloorResult = {
    model: 'm',
    sample: 'Short TypeScript line',
    ranOn: '100% CPU',
    runs: [run(3000, { totalMs: 2900, loadMs: 5, promptMs: 400, answerMs: 2495 })],
  };

  it('sums up fresh runs the way a step is read', () => {
    expect(
      freshStep({ model: 'm', ranOn: '100% GPU', runs: [run(1000), run(3000), run(2000)] }),
    ).toEqual({
      model: 'm',
      runs: 3,
      failed: 0,
      medianMs: 2000,
      slowestMs: 3000,
      ranOn: '100% GPU',
    });
    expect(freshStep({ model: 'm', runs: [run(1000), { ok: false, error: 'x' }] })).toMatchObject({
      runs: 2,
      failed: 1,
    });
  });

  it('meets the goal after ahead when at least 90% of clicks are within 2 s', () => {
    expect(aheadMeetsGoal(ahead('m', [5, 5, 5, 5, 5, 5, 5, 5, 5, 3000]))).toBe(true);
    expect(aheadMeetsGoal(ahead('m', [5, 5, 5, 5, 5, 5, 5, 5, 3000, 3000]))).toBe(false);
    expect(aheadMeetsGoal(ahead('m', []))).toBe(false);
  });

  it('says the goal is met for fresh answers, picking the model from the warm runs', () => {
    const text = conclusion(
      // The last step's first run included loading the model, so it looks slow.
      [{ model: 'm', medianMs: 6000, failed: 0 }],
      [],
      {
        fresh: [{ model: 'm', medianMs: 1500, slowestMs: 1900, ranOn: '100% GPU', failed: 0 }],
        ahead: [ahead('m', [4, 6, 5])],
      },
    );
    expect(text).toMatch(
      /^\*\*Goal met\.\*\* With the default settings and the model warm, m writes a fresh answer in 1\.5 s \(median of every sample, on 100% GPU\)\./,
    );
    expect(text).toContain(
      'After Explain ahead had explained the 3 lines of `page.html` (4.0 s per line, 12.0 s in all with m), 3 of 3 (100%) clicks were answered within 2.0 s, median 5 ms.',
    );
  });

  it('says the goal is met only after Explain ahead, with the floor for fresh answers', () => {
    const text = conclusion([{ model: 'm', medianMs: 9000, failed: 0 }], [floor], {
      fresh: [{ model: 'm', medianMs: 4500, ranOn: '100% CPU', failed: 0 }],
      ahead: [ahead('m', [4, 6, 5, 7, 5, 5, 5, 5, 5, 5])],
    });
    expect(text).toMatch(
      /^\*\*Goal met only after Explain ahead\.\*\* The fastest model, m, takes 4\.5 s \(median of every sample, on 100% CPU\) for a fresh answer\./,
    );
    expect(text).toContain('10 of 10 (100%) clicks were answered within 2.0 s');
    expect(text).toContain(
      'a fresh answer, such as a selection or a line the work has not reached, is not',
    );
    expect(text).toMatch(/The floor on this laptop is \*\*3\.0 s\*\*/);
    expect(text).toMatch(/writing the answer limits it/);
  });

  it('says the goal is met for neither, with the share after ahead and the floor', () => {
    const text = conclusion([{ model: 'm', medianMs: 9000, failed: 0 }], [floor], {
      fresh: [{ model: 'm', medianMs: 4500, failed: 0 }],
      ahead: [ahead('m', [5, 5, 3000, 3000])],
    });
    expect(text).toMatch(/^\*\*Goal not met\.\*\* The fastest model, m, takes 4\.5 s/);
    expect(text).toContain('2 of 4 (50%) clicks were answered within 2.0 s');
    expect(text).toMatch(/Next step: The model runs on 100% CPU/);
  });

  it('gives no conclusion when no model finished every fresh run', () => {
    expect(
      conclusion([{ model: 'm', medianMs: 1000, failed: 0 }], [], {
        fresh: [{ model: 'm', runs: 3, failed: 3 }],
      }),
    ).toMatch(/^\*\*No conclusion\.\*\* No model finished every run in the fresh answers: m/);
  });

  it('adds the fresh and after-ahead tables to the report, before the conclusion', () => {
    const text = formatHistoryReport({
      startedAt: '2026-11-04 07:05',
      runsPerSample: 3,
      steps: [],
      floors: [floor],
      fresh: [{ model: 'm', ranOn: '100% CPU', runs: [run(4000), run(5000), run(4500)] }],
      ahead: [ahead('m', [4, 6, 5, 7, 5, 5, 5, 5, 5, 5])],
    });
    expect(text).toContain('### Fresh answers, model warm');
    expect(text).toContain('| m (100% CPU) | 4.5 s | 5.0 s | 3 |');
    expect(text).toContain('### Clicks after Explain ahead');
    expect(text).toContain('Each added line of `page.html` explained ahead');
    expect(text).toContain(
      '| m | 10 | 4.0 s | 40.0 s | 10 of 10 (100%) | 5 ms | 7 ms | 10 of 10 |',
    );
    expect(text.indexOf('### Clicks after Explain ahead')).toBeLessThan(
      text.indexOf('### Conclusion'),
    );
    expect(text).toContain('**Goal met only after Explain ahead.**');
  });
});
