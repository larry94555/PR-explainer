// The numbers and the markdown behind `npm run bench:history` (PR 8.8, with
// the Milestone 9 steps, fresh answers and Explain ahead from PR 9.11). Pure
// functions only: scripts/benchHistory.ts runs the benchmark at each step and
// writes the file, so everything here can be unit tested without a model.

import { LATENCY_GOAL_MS } from '../src/llm/latencyGoal.ts';
import {
  AHEAD_SHARE_GOAL,
  formatAheadTable,
  formatMs,
  formatShare,
  median,
  summarize,
  summarizeAhead,
  summarizeWholePr,
  formatMinutes,
  type AheadResult,
  type BenchRun,
  type WholePrResult,
  type WholePrSummary,
} from './benchStats.ts';

/** The goal the report is measured against (PR 9.9): the same one as the Speed test. */
export const GOAL_MS = LATENCY_GOAL_MS;

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
// request itself, so the end of Milestone 8 stands for them; prefetch hides
// time instead of cutting it, and the report says so. In Milestone 9, 9.1 to
// 9.4 only measure and show, 9.6 changes how the popup shows the answer, and
// 9.9 and 9.10 change the Speed test and add Explain ahead, which the report
// measures on its own; "Now" stands for them.
export const HISTORY_STEPS: readonly HistoryStep[] = [
  { label: 'Baseline (8.2)', ref: 'b03ff14' },
  { label: 'Model kept loaded (8.3)', ref: '4f464d6' },
  { label: 'Shorter answers (8.4)', ref: '1ebac10' },
  { label: 'Smaller prompts (8.5)', ref: '3821237' },
  { label: 'End of Milestone 8 (8.6 to 8.8)', ref: 'b7fc818' },
  { label: 'Thinking off (9.5)', ref: 'f791407' },
  { label: 'Fewer round trips (9.7)', ref: 'eb7d4d4' },
  { label: 'One-sentence answers (9.8)', ref: '6716b55' },
  { label: 'Now (9.9 to 9.11)', ref: 'HEAD' },
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
    // (then Think tokens | Think time since PR 9.1, which are not read here)
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

/** Fresh answers with the current code (PR 9.11): every sample, the model already loaded, no cache. */
export interface FreshResult {
  model: string;
  runs: BenchRun[];
  ranOn?: string;
}

/** A model's fresh answers in the shape the conclusion picks the fastest from. */
export function freshStep({ model, runs, ranOn }: FreshResult): StepResult {
  const s = summarize(runs);
  return {
    model,
    runs: s.runs,
    failed: s.failed,
    ...(s.medianMs !== undefined && { medianMs: s.medianMs }),
    ...(s.slowestMs !== undefined && { slowestMs: s.slowestMs }),
    ...(s.tokensPerSecond !== undefined && { tokensPerSecond: s.tokensPerSecond }),
    ...(ranOn && { ranOn }),
  };
}

export interface HistoryReport {
  startedAt: string;
  runsPerSample: number;
  steps: { step: HistoryStep; section?: string; error?: string }[];
  floors: FloorResult[];
  /** Fresh answers with the model warm (PR 9.11). */
  fresh?: FreshResult[];
  /** Clicks after Explain ahead (PR 9.11). */
  ahead?: AheadResult[];
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

/** What the conclusion is drawn from besides the last step. */
export interface ConclusionExtras {
  /**
   * Fresh answers with the model warm (PR 9.11). When given, the fastest
   * model is picked from these instead of the last step, whose first run of
   * each model includes loading it.
   */
  fresh?: readonly StepResult[];
  /** Clicks after Explain ahead (PR 9.11). */
  ahead?: readonly AheadResult[];
}

/** True when enough clicks after Explain ahead came within the goal. */
export function aheadMeetsGoal(result: AheadResult): boolean {
  const s = summarizeAhead(result.lines);
  return s.lines > 0 && s.share >= AHEAD_SHARE_GOAL;
}

/** One sentence on the clicks after Explain ahead with `result`'s model. */
function aheadSentence(result: AheadResult): string {
  const s = summarizeAhead(result.lines);
  return (
    `After Explain ahead had explained the ${s.lines} lines of \`${result.page}\` ` +
    `(${fmt(s.aheadMedianMs)} per line, ${fmt(s.aheadTotalMs)} in all with ${result.model}), ` +
    `${formatShare(s)} clicks were answered within ${fmt(GOAL_MS)}` +
    (s.clickMedianMs !== undefined ? `, median ${fmt(s.clickMedianMs)}.` : '.')
  );
}

/** The floor for `best`, what limits it, and the next step; empty without a floor. */
function floorLines(best: StepResult, floors: readonly FloorResult[]): string[] {
  const floor = floors.find((f) => f.model === best.model);
  const parts = floor && timeParts(floor.runs);
  if (!floor || !parts) return [];
  const total = median(floor.runs.flatMap((r) => (r.ok ? [r.totalMs] : [])));
  const term = dominantTerm(parts);
  return [
    '',
    `The floor on this laptop is **${fmt(total)}**: ${floor.sample}, an answer of at most ` +
      `${FLOOR_ANSWER_TOKENS} tokens, model already loaded. Of that, ${fmt(parts.load)} is loading, ` +
      `${fmt(parts.prompt)} reading the prompt, ${fmt(parts.answer)} writing the answer and ` +
      `${fmt(parts.outside)} outside Ollama, so ${TERM_NAMES[term]} limits it.`,
    '',
    `Next step: ${nextStep(term, floor.ranOn ?? best.ranOn)}`,
  ];
}

/**
 * The conclusion: the goal met for fresh answers (with which model), met
 * only for clicks after Explain ahead, or met for neither, with the floor and
 * what limits it.
 */
export function conclusion(
  now: readonly StepResult[],
  floors: readonly FloorResult[],
  { fresh, ahead = [] }: ConclusionExtras = {},
): string {
  const results = fresh ?? now;
  const where = fresh ? 'in the fresh answers' : 'at the last step';
  const best = fastest(results);
  const unfinished = failedRuns(results);
  const leftOut = unfinished
    ? ` Left out because some runs failed, so their times do not cover every sample: ${unfinished}.`
    : '';
  const how = (r: StepResult) => `(median of every sample${r.ranOn ? `, on ${r.ranOn}` : ''})`;
  // The after-ahead numbers of the fastest fresh model, given for context.
  const bestAhead = best && ahead.find((a) => a.model === best.model);
  const afterAhead = bestAhead ? ` ${aheadSentence(bestAhead)}` : '';

  if (best && best.medianMs! < GOAL_MS) {
    const slow =
      best.slowestMs !== undefined && best.slowestMs >= GOAL_MS
        ? ` The slowest run took ${fmt(best.slowestMs)}, so a long selection can still pass ${fmt(GOAL_MS)}.`
        : '';
    const writes = fresh
      ? `With the default settings and the model warm, ${best.model} writes a fresh answer in`
      : `With the default settings, ${best.model} explains in`;
    return `**Goal met.** ${writes} ${fmt(best.medianMs)} ${how(best)}.${slow}${leftOut}${afterAhead}`;
  }

  // Fresh answers miss the goal (or no model finished them all), so any model
  // that meets it after Explain ahead counts, not only the fastest fresh one.
  const metAhead = bestAhead && aheadMeetsGoal(bestAhead) ? bestAhead : bestAheadModel(ahead);
  if (metAhead) {
    const freshNote = !best
      ? `No model finished every fresh run (${unfinished}), so fresh answers are not judged.`
      : best.model === metAhead.model
        ? `${best.model} takes ${fmt(best.medianMs)} ${how(best)} for a fresh answer.${leftOut}`
        : `The fastest model for fresh answers, ${best.model}, takes ${fmt(best.medianMs)} ` +
          `${how(best)}.${leftOut}`;
    return [
      `**Goal met only after Explain ahead, with ${metAhead.model}.** ${freshNote}` +
        ` ${aheadSentence(metAhead)} So a click on a changed line the page has had time to ` +
        'explain is answered within the goal; a fresh answer, such as a selection or a line ' +
        'the work has not reached, is not.',
      ...(best ? floorLines(best, floors) : []),
    ].join('\n');
  }

  if (!best) {
    return results.length
      ? `**No conclusion.** No model finished every run ${where}: ${unfinished}. ` +
          'Its times leave out the runs that failed, so they do not show whether the goal is met.'
      : `No run finished ${where}, so there is no conclusion.`;
  }
  return [
    `**Goal not met.** The fastest model, ${best.model}, takes ${fmt(best.medianMs)} ${how(best)}.` +
      `${leftOut}${afterAhead}`,
    ...floorLines(best, floors),
  ].join('\n');
}

/**
 * Of the models that meet the goal after Explain ahead, the one with the
 * most clicks within it, then the quickest to explain a line ahead.
 */
export function bestAheadModel(ahead: readonly AheadResult[]): AheadResult | undefined {
  return ahead
    .filter(aheadMeetsGoal)
    .map((result) => ({ result, s: summarizeAhead(result.lines) }))
    .sort(
      (a, b) =>
        b.s.share - a.s.share || (a.s.aheadMedianMs ?? Infinity) - (b.s.aheadMedianMs ?? Infinity),
    )[0]?.result;
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
  const fresh = report.fresh?.map(freshStep);
  if (fresh?.length) {
    out.push(
      '',
      '### Fresh answers, model warm',
      '',
      'The current code on every sample, with the model loaded before the first run and no ' +
        'cache: what a click on a line nothing has explained yet takes.',
      '',
      line(['Model', 'Median', 'Slowest', 'Runs']),
      line(['---', '---:', '---:', '---:']),
      ...fresh.map((r) =>
        line([
          r.ranOn ? `${r.model} (${r.ranOn})` : r.model,
          fmt(r.medianMs),
          fmt(r.slowestMs),
          r.failed
            ? `${(r.runs ?? 0) - r.failed} of ${r.runs} (${r.failed} failed)`
            : String(r.runs),
        ]),
      ),
    );
  }
  if (report.ahead?.length) {
    out.push(
      '',
      '### Clicks after Explain ahead',
      '',
      `Each added line of \`${report.ahead[0]!.page}\` explained ahead, one at a time, as ` +
        'Explain ahead does, then a click on each timed. A click does not wait for the 2 seconds ' +
        'of stillness or for lines not yet reached, so this is the best case once the page has ' +
        `had time; at least ${Math.round(AHEAD_SHARE_GOAL * 100)}% of clicks within ` +
        `${fmt(GOAL_MS)} counts as meeting the goal.`,
      '',
      formatAheadTable(report.ahead),
    );
  }
  out.push(
    '',
    '### Conclusion',
    '',
    conclusion(parsed.at(-1) ?? [], report.floors, {
      ...(fresh && { fresh }),
      ...(report.ahead && { ahead: report.ahead }),
    }),
  );
  const failed = report.steps.filter((s) => s.error);
  if (failed.length) {
    out.push('', 'Steps that failed:', '', ...failed.map((s) => `- ${s.step.label}: ${s.error}`));
  }
  report.steps.forEach(({ step, section }) => {
    if (section) out.push('', `### ${step.label}`, '', demote(demote(section)).trimEnd());
  });
  return out.join('\n') + '\n';
}

// --- Whole PR (PR 10.8) ----------------------------------------------------

/** The extension's defaults the whole-PR conclusion weighs. */
export interface WholePrDefaults {
  /** Requests at once (REQUESTS_AT_ONCE.default). */
  atOnce: number;
  /** The per-PR limit, in lines (AHEAD_MAX_PER_PR). */
  maxPerPr: number;
}

/** How long Whole PR may take to get through a PR at the per-PR limit before the limit should come down. */
export const WHOLE_PR_LIMIT_BUDGET_MS = 30 * 60_000;

const sharePercent = (share: number) => `${Math.floor(share * 100)}%`;

const cachedAfter = (s: WholePrSummary, minutes: number) =>
  s.cached.find((c) => c.minutes === minutes)?.share ?? 0;

/**
 * The model the whole-PR conclusion is about: the most lines cached after 5
 * minutes, then after 15, then the quicker whole PR. Undefined when no model
 * answered any line.
 */
export function bestWholePr(
  results: readonly WholePrResult[],
): { result: WholePrResult; summary: WholePrSummary } | undefined {
  return results
    .map((result) => ({ result, summary: summarizeWholePr(result) }))
    .filter(({ summary }) => summary.answered > 0)
    .sort(
      (a, b) =>
        cachedAfter(b.summary, 5) - cachedAfter(a.summary, 5) ||
        cachedAfter(b.summary, 15) - cachedAfter(a.summary, 15) ||
        (a.summary.wholePrMs ?? Infinity) - (b.summary.wholePrMs ?? Infinity),
    )[0];
}

/**
 * The whole-PR section's conclusion: how many clicks are instant after 5
 * minutes (most, at least AHEAD_SHARE_GOAL, or only after 15 minutes, or
 * not yet), how long the whole PR took, whether a click during the run
 * waited no longer than one cancelled request, and what the numbers say
 * about the defaults (Requests at once and the per-PR limit). Undefined when
 * no model answered a line. `defaults` are the extension's (src/explainAhead.ts,
 * which Node cannot load directly, so scripts/bench.ts passes them in).
 */
export function wholePrConclusion(
  results: readonly WholePrResult[],
  defaults: WholePrDefaults,
): string | undefined {
  const best = bestWholePr(results);
  if (!best) return undefined;
  const { result, summary: s } = best;
  const five = cachedAfter(s, 5);
  const fifteen = cachedAfter(s, 15);
  const whole = s.estimated
    ? `the whole PR (${result.sent} lines) would take ${formatMinutes(s.wholePrMs, true)} at that rate`
    : `the whole PR (${result.sent} lines) took ${formatMinutes(s.wholePrMs)}`;
  const perLine =
    s.byHunkPerLineMs === undefined
      ? ''
      : ` (${formatMs(s.byHunkPerLineMs)} per line by hunk` +
        (s.speedup !== undefined
          ? s.speedup >= 1
            ? `, ${s.speedup.toFixed(1)}× faster than ${formatMs(s.singlePerLineMs)} one at a time)`
            : `, slower than ${formatMs(s.singlePerLineMs)} one at a time)`
          : ')');
  let head: string;
  if (five >= AHEAD_SHARE_GOAL) {
    head =
      `**Most clicks are instant after 5 minutes, with ${result.model}.** ` +
      `${sharePercent(five)} of the changed lines were answered in the background after 5 minutes, and ${whole}${perLine}.`;
  } else if (fifteen >= AHEAD_SHARE_GOAL) {
    head =
      `**Most clicks are instant only after 15 minutes, with ${result.model}.** ` +
      `${sharePercent(five)} of the changed lines were answered after 5 minutes and ` +
      `${sharePercent(fifteen)} after 15, and ${whole}${perLine}.`;
  } else {
    head =
      `**Most clicks are not instant yet.** The best model, ${result.model}, answered ` +
      `${sharePercent(five)} of the changed lines after 5 minutes and ${sharePercent(fifteen)} after 15, ` +
      `and ${whole}${perLine}. A click on a line not reached yet is answered fresh, as before.`;
  }
  const out = [head];

  const click = s.click;
  if (!click) out.push('No click was sent during the run, so the click wait was not checked.');
  else if (click.waitedAtMostOneCancelled) {
    out.push(
      `A click sent during the run started after ${formatMs(click.waitMs)} and waited no longer than ` +
        `one cancelled request` +
        (click.error !== undefined
          ? `, but it failed: ${click.error}.`
          : `; it was answered in ${formatMs(click.totalMs)}.`),
    );
  } else if (click.waitMs === undefined) {
    out.push('**Check failed:** the click sent during the run never started.');
  } else {
    const finished = result.click?.finishedWhileWaiting ?? 0;
    out.push(
      `**Check failed:** the click sent during the run waited ${formatMs(click.waitMs)}, while ` +
        `${finished} background ${finished === 1 ? 'request' : 'requests'} finished and ` +
        `${click.cancelled} ${click.cancelled === 1 ? 'was' : 'were'} stopped. The queue (PR 10.3) should stop one at most.`,
    );
  }

  const notes: string[] = [];
  if (result.atOnce === defaults.atOnce) {
    notes.push(
      `**Requests at once** stays at ${defaults.atOnce}: this run measured that setting only, and the ` +
        'Requests at once report (`npm run bench -- --parallel 1,2`) is what would change it.',
    );
  }
  if (s.byHunkPerLineMs !== undefined) {
    const atLimitMs = s.byHunkPerLineMs * defaults.maxPerPr;
    const inBudget = Math.floor(WHOLE_PR_LIMIT_BUDGET_MS / s.byHunkPerLineMs);
    notes.push(
      atLimitMs <= WHOLE_PR_LIMIT_BUDGET_MS
        ? `The per-PR limit of ${defaults.maxPerPr} lines stays: at this rate a PR that large takes ` +
            `${formatMinutes(atLimitMs, true)}.`
        : `The per-PR limit of ${defaults.maxPerPr} lines would take ${formatMinutes(atLimitMs, true)} at ` +
            `this rate, so about ${inBudget} lines (what ${formatMinutes(WHOLE_PR_LIMIT_BUDGET_MS)} covers) ` +
            'would be a better limit on this laptop.',
    );
  }
  out.push(...notes);
  return out.join(' ') + '\n';
}
