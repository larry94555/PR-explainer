// The numbers and the markdown behind `npm run bench:history` (PR 8.8). Pure
// functions only: scripts/benchHistory.ts runs the benchmark at each step and
// writes the file, so everything here can be unit tested without a model.

import { formatMs, median, type BenchRun } from './benchStats.ts';

/** The milestone's goal: an explanation in under 10 seconds. */
export const GOAL_MS = 10_000;

/** The answer length the floor is measured with (roadmap, Milestone 8). */
export const FLOOR_ANSWER_TOKENS = 150;

/** One point in the history: the code as it was when that PR merged. */
export interface HistoryStep {
  label: string;
  /** A commit on main, or "HEAD" for the code as it is now. */
  ref: string;
}

// The merge commit of each PR that changed what `npm run bench` measures.
// 8.6 (the Speed test) and 8.7 (prefetch on hover) do not change the explain
// request itself, so "Now" stands for them; prefetch hides time instead of
// cutting it, and the report says so.
export const HISTORY_STEPS: readonly HistoryStep[] = [
  { label: 'Baseline (8.2)', ref: 'b03ff14' },
  { label: 'Model kept loaded (8.3)', ref: '4f464d6' },
  { label: 'Shorter answers (8.4)', ref: '1ebac10' },
  { label: 'Smaller prompts (8.5)', ref: '3821237' },
  { label: 'Now (8.6 to 8.8)', ref: 'HEAD' },
];

/** The last dated section `npm run bench` added to docs/latency.md, or undefined when there is none. */
export function lastSection(doc: string): string | undefined {
  const starts = [...doc.matchAll(/^## /gm)].map((m) => m.index);
  const start = starts.at(-1);
  return start === undefined ? undefined : doc.slice(start).trimEnd() + '\n';
}

/** Reads "850 ms" or "12.3 s" back into milliseconds; undefined for a dash or anything else. */
export function parseDuration(text: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s)\s*$/.exec(text);
  if (!m) return undefined;
  return Number(m[1]) * (m[2] === 's' ? 1000 : 1);
}

/** A model's "All samples" row from one bench section. */
export interface StepResult {
  model: string;
  medianMs?: number;
  slowestMs?: number;
  tokensPerSecond?: number;
  /** "ran on 100% GPU" and the like, from the model's heading. */
  ranOn?: string;
  /** How many runs there were, and how many failed, from the Runs column. */
  runs?: number;
  failed?: number;
}

/** Reads the Runs column back: "15", or "13 of 15 (2 failed)". */
export function parseRuns(text: string): { runs: number; failed: number } | undefined {
  const all = /^\s*(\d+)\s*$/.exec(text);
  if (all) return { runs: Number(all[1]), failed: 0 };
  const some = /^\s*(\d+) of (\d+) \((\d+) failed\)\s*$/.exec(text);
  return some ? { runs: Number(some[2]), failed: Number(some[3]) } : undefined;
}

/** Each model's "All samples" row in a section written by `npm run bench` (any version since 8.2). */
export function parseSection(section: string): StepResult[] {
  const results: StepResult[] = [];
  let current: StepResult | undefined;
  for (const line of section.split('\n')) {
    const heading = /^### (\S+)(.*)$/.exec(line);
    if (heading) {
      const ranOn = /ran on ([^,)]+)/.exec(heading[2]!)?.[1];
      current = { model: heading[1]!, ...(ranOn && { ranOn }) };
      results.push(current);
      continue;
    }
    if (!current || !line.startsWith('| **All samples**')) continue;
    // Sample | Runs | Median | Slowest | First token | Load | Prompt tokens | Answer tokens | Tokens/s
    const cells = line.split('|').map((c) => c.trim());
    const median = parseDuration(cells[3] ?? '');
    const slowest = parseDuration(cells[4] ?? '');
    const rate = Number(cells[9]);
    const runs = parseRuns(cells[2] ?? '');
    if (runs) Object.assign(current, runs);
    if (median !== undefined) current.medianMs = median;
    if (slowest !== undefined) current.slowestMs = slowest;
    if (cells[9] && Number.isFinite(rate)) current.tokensPerSecond = rate;
  }
  return results;
}

/** The parts of one explanation's time, in the terms of the milestone's formula. */
export interface TimeParts {
  load: number;
  prompt: number;
  answer: number;
  outside: number;
}

export type Term = keyof TimeParts;

/**
 * Medians of each part over the runs that finished. "Outside" is the time the
 * script waited beyond Ollama's own total (messaging, building the prompt).
 * Undefined when no run finished with Ollama's timings.
 */
export function timeParts(runs: readonly BenchRun[]): TimeParts | undefined {
  const done = runs.flatMap((r) => (r.ok && r.timings ? [{ run: r, t: r.timings }] : []));
  if (!done.length) return undefined;
  const mid = (values: number[]) => median(values) ?? 0;
  return {
    load: mid(done.map(({ t }) => t.loadMs ?? 0)),
    prompt: mid(done.map(({ t }) => t.promptMs ?? 0)),
    answer: mid(done.map(({ t }) => t.answerMs ?? 0)),
    outside: mid(
      done.map(({ run, t }) => {
        const ollama = t.totalMs ?? (t.loadMs ?? 0) + (t.promptMs ?? 0) + (t.answerMs ?? 0);
        return Math.max(0, run.totalMs - ollama);
      }),
    ),
  };
}

/** The biggest part of the time. */
export function dominantTerm(parts: TimeParts): Term {
  return (Object.keys(parts) as Term[]).reduce((a, b) => (parts[b] > parts[a] ? b : a));
}

const TERM_NAMES: Record<Term, string> = {
  load: 'loading the model',
  prompt: 'reading the prompt',
  answer: 'writing the answer',
  outside: 'time outside Ollama',
};

/** What would cut the biggest part next, worded for the report. */
export function nextStep(term: Term, ranOn: string | undefined): string {
  const onCpu = ranOn !== undefined && ranOn !== '100% GPU' && ranOn !== 'Unknown';
  switch (term) {
    case 'answer':
      return onCpu
        ? `The model runs on ${ranOn}, so a GPU (or freeing video memory so all of it fits) would write the answer several times faster. Without one, a smaller model (1.5B or 3B) writes faster.`
        : 'A smaller model (1.5B or 3B) or a smaller quantization (a tag ending in q4_K_M) would write the answer faster.';
    case 'prompt':
      return onCpu
        ? `The model runs on ${ranOn}, and reading the prompt is far faster on a GPU. Without one, a smaller model reads it faster.`
        : 'Fewer lines of context, or a smaller model, would cut the time spent reading the prompt.';
    case 'load':
      return 'Keep model loaded (minutes) should stay above 0, so the model is loaded once when a PR opens and not on each click.';
    case 'outside':
      return 'Most of the time is spent outside Ollama, which points at the extension or the connection to Ollama rather than the model.';
  }
}

/** The floor measurement for one model: shortest sample, a short answer, model already loaded. */
export interface FloorResult {
  model: string;
  sample: string;
  runs: BenchRun[];
  ranOn?: string;
}

export interface HistoryReport {
  startedAt: string;
  runsPerSample: number;
  steps: { step: HistoryStep; section?: string; error?: string }[];
  floors: FloorResult[];
}

const fmt = (ms: number | undefined) => formatMs(ms);

/** "### 2026-…" headings one level lower, so each step's section sits under the report. */
export function demote(section: string): string {
  return section.replace(/^(#{2,5}) /gm, '#$1 ');
}

/** Whether every run of the model finished, so its median stands for every sample. */
export function finishedEveryRun(result: StepResult): boolean {
  return result.medianMs !== undefined && result.failed === 0;
}

/**
 * The fastest model by its "Now" median, among those that finished every
 * run: a model whose long samples time out would otherwise look fast on the
 * short ones alone. Undefined when none finished every run.
 */
export function fastest(results: readonly StepResult[]): StepResult | undefined {
  return results
    .filter(finishedEveryRun)
    .reduce<StepResult | undefined>((a, b) => (a && a.medianMs! <= b.medianMs! ? a : b), undefined);
}

/** "m (2 of 15 runs failed)" for each model that did not finish every run. */
function failedRuns(results: readonly StepResult[]): string {
  return results
    .filter((r) => !finishedEveryRun(r))
    .map((r) =>
      r.runs === undefined ? r.model : `${r.model} (${r.failed} of ${r.runs} runs failed)`,
    )
    .join(', ');
}

/** The conclusion: goal met with which model, or the floor and what limits it. */
export function conclusion(now: readonly StepResult[], floors: readonly FloorResult[]): string {
  const best = fastest(now);
  const unfinished = failedRuns(now);
  if (!best) {
    return now.length
      ? `**No conclusion.** No model finished every run at the last step: ${unfinished}. ` +
          'Its times leave out the runs that failed, so they do not show whether the goal is met.'
      : 'No run finished at the last step, so there is no conclusion.';
  }
  const leftOut = unfinished
    ? ` Left out because some runs failed, so their times do not cover every sample: ${unfinished}.`
    : '';
  if (best.medianMs! < GOAL_MS) {
    const slow =
      best.slowestMs !== undefined && best.slowestMs >= GOAL_MS
        ? ` The slowest run took ${fmt(best.slowestMs)}, so a long selection can still pass 10 s.`
        : '';
    return (
      `**Goal met.** With the default settings, ${best.model} explains in ${fmt(best.medianMs)} ` +
      `(median of every sample${best.ranOn ? `, on ${best.ranOn}` : ''}).${slow}${leftOut}`
    );
  }
  const floor = floors.find((f) => f.model === best.model);
  const parts = floor && timeParts(floor.runs);
  const lines = [
    `**Goal not met.** The fastest model, ${best.model}, takes ${fmt(best.medianMs)} ` +
      `(median of every sample${best.ranOn ? `, on ${best.ranOn}` : ''}).${leftOut}`,
  ];
  if (floor && parts) {
    const total = median(floor.runs.flatMap((r) => (r.ok ? [r.totalMs] : [])));
    const term = dominantTerm(parts);
    lines.push(
      '',
      `The floor on this laptop is **${fmt(total)}**: ${floor.sample}, an answer of at most ` +
        `${FLOOR_ANSWER_TOKENS} tokens, model already loaded. Of that, ${fmt(parts.load)} is loading, ` +
        `${fmt(parts.prompt)} reading the prompt, ${fmt(parts.answer)} writing the answer and ` +
        `${fmt(parts.outside)} outside Ollama, so ${TERM_NAMES[term]} limits it.`,
      '',
      `Next step: ${nextStep(term, floor.ranOn ?? best.ranOn)}`,
    );
  }
  return lines.join('\n');
}

/** The section `npm run bench:history` adds to docs/latency.md. */
export function formatHistoryReport(report: HistoryReport): string {
  const parsed = report.steps.map((s) => (s.section ? parseSection(s.section) : []));
  const models = [...new Set(parsed.flat().map((r) => r.model))];
  const out = [
    `## Latency report ${report.startedAt}`,
    '',
    `Every step below ran \`npm run bench\` (${report.runsPerSample} ${report.runsPerSample === 1 ? 'run' : 'runs'} per sample) with the code as it ` +
      'was when that PR merged, one after another on this computer, each starting with the model ' +
      'unloaded. Times are the median, and the slowest run, of every sample. Keeping the model ' +
      'loaded (8.3) mostly helps the first click after a pause, which back-to-back runs do not ' +
      'show, and Explain on hover (8.7) hides time while you read rather than cutting it.',
    '',
  ];
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  out.push(
    line(['Step', ...models.map((m) => `${m} median`), ...models.map((m) => `${m} slowest`)]),
  );
  out.push(line(['---', ...models.flatMap(() => ['---:', '---:'])]));
  report.steps.forEach(({ step, error }, i) => {
    const find = (m: string) => parsed[i]!.find((r) => r.model === m);
    out.push(
      line([
        error ? `${step.label} (failed)` : step.label,
        ...models.map((m) => fmt(find(m)?.medianMs)),
        ...models.map((m) => fmt(find(m)?.slowestMs)),
      ]),
    );
  });
  out.push('', '### Conclusion', '', conclusion(parsed.at(-1) ?? [], report.floors));
  const failed = report.steps.filter((s) => s.error);
  if (failed.length) {
    out.push('', 'Steps that failed:', '', ...failed.map((s) => `- ${s.step.label}: ${s.error}`));
  }
  report.steps.forEach(({ step, section }) => {
    if (section) out.push('', `### ${step.label}`, '', demote(demote(section)).trimEnd());
  });
  return out.join('\n') + '\n';
}
