// PR 8.8: the latency report behind `npm run bench:history`. The script
// itself runs git and a real Ollama and is tested by hand.
import { execFileSync } from 'node:child_process';
import { formatReport, type BenchReport, type BenchRun } from '../scripts/benchStats.ts';
import {
  conclusion,
  demote,
  dominantTerm,
  fastest,
  formatHistoryReport,
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
        { model: 'steady', medianMs: 8000, failed: 0 },
        { model: 'flaky', medianMs: 2000, runs: 15, failed: 4 },
      ],
      [],
    );
    expect(text).toMatch(
      /^\*\*Goal met\.\*\* With the default settings, steady explains in 8\.0 s/,
    );
    expect(text).toMatch(/Left out because some runs failed.*: flaky \(4 of 15 runs failed\)\./);
  });

  it('says the goal is met by the fastest model, and warns when its slowest run passes 10 s', () => {
    const text = conclusion(
      [
        { model: 'big', medianMs: 14_000, failed: 0 },
        { model: 'small', medianMs: 6200, slowestMs: 11_000, ranOn: '100% GPU', failed: 0 },
      ],
      [],
    );
    expect(text).toMatch(/^\*\*Goal met\.\*\* With the default settings, small explains in 6\.2 s/);
    expect(text).toMatch(/on 100% GPU/);
    expect(text).toMatch(/slowest run took 11\.0 s/);
    expect(
      conclusion([{ model: 'small', medianMs: 6200, slowestMs: 8000, failed: 0 }], []),
    ).not.toMatch(/slowest/);
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
  const steps = HISTORY_STEPS.map((step, i) => ({
    step,
    section: benchSection([
      { model: 'm', totals: [20_000 - i * 3000, 21_000 - i * 3000, 19_000 - i * 3000] },
    ]),
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
    expect(text).toContain('| Now (8.6 to 8.8) | 8.0 s | 9.0 s |');
    expect(text).toContain(
      '### Conclusion\n\n**Goal met.** With the default settings, m explains in 8.0 s',
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
