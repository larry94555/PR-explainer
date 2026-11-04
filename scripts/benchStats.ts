// The numbers and the markdown behind `npm run bench` (PR 8.2). Pure
// functions only: scripts/bench.ts does the talking to Ollama and the file
// writing, so everything here can be unit tested without a model.

import { LATENCY_GOAL_MS } from '../src/llm/latencyGoal.ts';

/** Ollama's timings for one reply, in milliseconds (the shape of LlmTimings). */
export interface RunTimings {
  totalMs?: number;
  loadMs?: number;
  promptTokens?: number;
  promptMs?: number;
  answerTokens?: number;
  answerMs?: number;
}

/** One request to the model: what it took, or why it failed. */
export type BenchRun =
  | {
      ok: true;
      /** From sending the explain request to the whole answer, as the script timed it. */
      totalMs: number;
      /** From sending the request to the first piece of the answer. */
      firstTokenMs?: number;
      timings?: RunTimings;
      /**
       * The part of the answer spent thinking (PR 9.1), estimated from the
       * share of the reply inside <think>.
       */
      think?: { tokens?: number; ms?: number };
    }
  | { ok: false; error: string };

/** Summary of the runs of one sample (or of every sample) on one model. */
export interface BenchSummary {
  runs: number;
  failed: number;
  medianMs?: number;
  slowestMs?: number;
  firstTokenMs?: number;
  loadMs?: number;
  promptTokens?: number;
  answerTokens?: number;
  tokensPerSecond?: number;
  thinkTokens?: number;
  thinkMs?: number;
}

/** The middle value (the mean of the two middle ones for an even count), or undefined for none. */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The largest value, or undefined for none. */
export function slowest(values: readonly number[]): number | undefined {
  return values.length ? Math.max(...values) : undefined;
}

function medianOf(values: readonly (number | undefined)[]): number | undefined {
  return median(values.filter((v): v is number => v !== undefined && Number.isFinite(v)));
}

/** Tokens written per second of writing, or undefined when it cannot be told. */
export function tokensPerSecond(timings: RunTimings | undefined): number | undefined {
  const { answerTokens, answerMs } = timings ?? {};
  if (answerTokens === undefined || answerMs === undefined || answerMs <= 0) return undefined;
  return answerTokens / (answerMs / 1000);
}

/**
 * Medians over the runs that finished, the slowest of them, and how many
 * failed. A failed run is counted, never dropped, so a sample that fails
 * often cannot look fast.
 */
export function summarize(runs: readonly BenchRun[]): BenchSummary {
  const done = runs.filter((r) => r.ok);
  const totals = done.map((r) => r.totalMs);
  const summary: BenchSummary = { runs: runs.length, failed: runs.length - done.length };
  const values: Omit<BenchSummary, 'runs' | 'failed'> = {
    medianMs: median(totals),
    slowestMs: slowest(totals),
    firstTokenMs: medianOf(done.map((r) => r.firstTokenMs)),
    loadMs: medianOf(done.map((r) => r.timings?.loadMs)),
    promptTokens: medianOf(done.map((r) => r.timings?.promptTokens)),
    answerTokens: medianOf(done.map((r) => r.timings?.answerTokens)),
    tokensPerSecond: medianOf(done.map((r) => tokensPerSecond(r.timings))),
    thinkTokens: medianOf(done.map((r) => r.think?.tokens)),
    thinkMs: medianOf(done.map((r) => r.think?.ms)),
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) (summary as unknown as Record<string, number>)[key] = value;
  }
  return summary;
}

const NONE = '–';

/** "850 ms" under a second, then "12.3 s"; a dash when unknown. */
export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return NONE;
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatCount(n: number | undefined): string {
  return n === undefined ? NONE : Math.round(n).toLocaleString('en-US');
}

export function formatRate(n: number | undefined): string {
  return n === undefined ? NONE : n.toFixed(1);
}

/** "3", or "2 of 3 (1 failed)" when any failed. */
export function formatRuns(s: Pick<BenchSummary, 'runs' | 'failed'>): string {
  return s.failed ? `${s.runs - s.failed} of ${s.runs} (${s.failed} failed)` : String(s.runs);
}

export const TABLE_HEADER = [
  'Sample',
  'Runs',
  'Median',
  'Slowest',
  'First token',
  'Load',
  'Prompt tokens',
  'Answer tokens',
  'Tokens/s',
  // Added last (PR 9.1), so scripts/latencyReport.ts still reads older sections.
  'Think tokens',
  'Think time',
] as const;

// Pipes would end a cell early.
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/** A markdown table with one row per sample. Numbers are medians unless the column says otherwise. */
export function formatTable(rows: readonly { sample: string; summary: BenchSummary }[]): string {
  const line = (cells: readonly string[]) => `| ${cells.map(cell).join(' | ')} |`;
  return [
    line(TABLE_HEADER),
    line(TABLE_HEADER.map((_, i) => (i < 2 ? '---' : '---:'))),
    ...rows.map(({ sample, summary: s }) =>
      line([
        sample,
        formatRuns(s),
        formatMs(s.medianMs),
        formatMs(s.slowestMs),
        formatMs(s.firstTokenMs),
        formatMs(s.loadMs),
        formatCount(s.promptTokens),
        formatCount(s.answerTokens),
        formatRate(s.tokensPerSecond),
        formatCount(s.thinkTokens),
        formatMs(s.thinkMs),
      ]),
    ),
  ].join('\n');
}

/** What the script found out about the computer it ran on. */
export interface MachineInfo {
  os: string;
  cpu: string;
  ramBytes: number;
  /** Graphics card names, when the system says. */
  gpus: string[];
  /** Ollama's version, when it says. */
  ollamaVersion?: string;
}

/** The benchmark's results for one model. */
export interface ModelResult {
  model: string;
  rows: { sample: string; runs: BenchRun[] }[];
  /** How much of the model sat in GPU memory (0 to 1), from Ollama's /api/ps. */
  gpuShare?: number;
  /** The context window the requests used, in tokens. */
  contextTokens?: number;
}

export interface BenchReport {
  startedAt: Date;
  machine: MachineInfo;
  llmUrl: string;
  runsPerSample: number;
  temperature: number;
  maxResponseTokens: number;
  models: ModelResult[];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-11-02 14:05" in the computer's own time zone. */
export function formatDate(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** "100% GPU", "100% CPU", or "40% GPU, 60% CPU", as `ollama ps` puts it. */
export function formatGpuShare(share: number): string {
  const gpu = Math.round(Math.min(1, Math.max(0, share)) * 100);
  if (gpu === 100) return '100% GPU';
  if (gpu === 0) return '100% CPU';
  return `${gpu}% GPU, ${100 - gpu}% CPU`;
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Each model against the goal (PR 9.9), by the median of every sample: met
 * only when every run finished and the median is under the goal.
 */
export function goalVerdicts(models: readonly Pick<ModelResult, 'model' | 'rows'>[]): string {
  return (
    models
      .map(({ model, rows }) => {
        const s = summarize(rows.flatMap((r) => r.runs));
        if (s.medianMs === undefined) return `${model} has no finished runs`;
        const median = `median ${formatMs(s.medianMs)}`;
        if (s.failed > 0) return `${model} did not finish every run (${median} of those that did)`;
        return s.medianMs < LATENCY_GOAL_MS
          ? `${model} met it (${median})`
          : `${model} did not (${median})`;
      })
      .join('; ') + '.'
  );
}

/** The machine, GPU and Ollama lines at the top of a section. */
function machineLines({ machine, llmUrl }: Pick<BenchReport, 'machine' | 'llmUrl'>): string[] {
  return [
    `- **Machine:** ${machine.os}; ${machine.cpu}; ${formatGb(machine.ramBytes)} RAM`,
    `- **GPU:** ${machine.gpus.length ? machine.gpus.join(', ') : 'none found'}`,
    `- **Ollama:** ${machine.ollamaVersion ? `${machine.ollamaVersion} at ` : ''}${llmUrl}`,
  ];
}

/** One dated section of docs/latency.md: the machine, the settings, and a table per model. */
export function formatReport(report: BenchReport): string {
  const out = [
    `## ${formatDate(report.startedAt)} · ${report.models.map((m) => m.model).join(', ')}`,
    '',
    ...machineLines(report),
    `- **Settings:** temperature ${report.temperature}, answers up to ${report.maxResponseTokens} ` +
      `tokens, ${report.runsPerSample} ${report.runsPerSample === 1 ? 'run' : 'runs'} per sample`,
  ];
  out.push(`- **Against the ${LATENCY_GOAL_MS / 1000} s goal:** ${goalVerdicts(report.models)}`);
  for (const model of report.models) {
    const notes = [
      // The window is sized to each prompt within this (PR 8.5).
      model.contextTokens !== undefined && `context up to ${model.contextTokens} tokens`,
      model.gpuShare !== undefined && `ran on ${formatGpuShare(model.gpuShare)}`,
    ].filter((n) => n !== false);
    const all = model.rows.flatMap((r) => r.runs);
    const rows = [
      ...model.rows.map((r) => ({ sample: r.sample, summary: summarize(r.runs) })),
      { sample: '**All samples**', summary: summarize(all) },
    ];
    out.push('', `### ${model.model}${notes.length ? ` (${notes.join(', ')})` : ''}`, '');
    out.push(formatTable(rows));
    const failures = model.rows.flatMap((r) =>
      r.runs.flatMap((run, i) => (run.ok ? [] : [`- ${r.sample}, run ${i + 1}: ${run.error}`])),
    );
    if (failures.length) out.push('', 'Failed runs:', '', ...failures);
  }
  return out.join('\n') + '\n';
}

// --- The ahead mode (PR 9.11) ----------------------------------------------

/**
 * The share of clicks that must be answered within the goal for Explain
 * ahead to count as meeting it. Not all, because a line the model failed on
 * is then explained fresh; the report lists those.
 */
export const AHEAD_SHARE_GOAL = 0.9;

/** One line of the ahead mode: explained ahead, then clicked. */
export interface AheadLineResult {
  /** Such as "src/a.ts:12". */
  line: string;
  /**
   * Explaining it ahead, as Explain ahead does (PR 9.10). Left out when it was
   * not tried: a failed line ends the pass, as it does in the extension.
   */
  ahead?: BenchRun;
  /** The click on it afterwards. */
  click: BenchRun;
  /** Whether the click was answered from the cache. */
  fromCache: boolean;
}

/** The ahead mode's results for one model. */
export interface AheadResult {
  model: string;
  /** The saved diff page the lines came from. */
  page: string;
  lines: AheadLineResult[];
  /** Where the model ran, worded like `ollama ps`. */
  ranOn?: string;
}

export interface AheadSummary {
  lines: number;
  /** Lines the model failed on ahead of time. */
  aheadFailed: number;
  /** Lines not tried ahead, because an earlier line failed. */
  aheadSkipped: number;
  /** Median time to explain one line ahead. */
  aheadMedianMs?: number;
  /** Time to explain every line ahead, one after another. */
  aheadTotalMs: number;
  clicksWithinGoal: number;
  /** clicksWithinGoal ÷ lines, 0 when there are no lines. */
  share: number;
  clickMedianMs?: number;
  clickSlowestMs?: number;
  fromCache: number;
}

/** The ahead mode's numbers. A failed click counts as not within the goal. */
export function summarizeAhead(
  lines: readonly AheadLineResult[],
  goalMs: number = LATENCY_GOAL_MS,
): AheadSummary {
  const aheadDone = lines.flatMap((l) => (l.ahead?.ok ? [l.ahead.totalMs] : []));
  const aheadSkipped = lines.filter((l) => !l.ahead).length;
  const clicks = lines.flatMap((l) => (l.click.ok ? [l.click.totalMs] : []));
  const within = clicks.filter((ms) => ms < goalMs).length;
  const summary: AheadSummary = {
    lines: lines.length,
    aheadFailed: lines.length - aheadDone.length - aheadSkipped,
    aheadSkipped,
    aheadTotalMs: aheadDone.reduce((a, b) => a + b, 0),
    clicksWithinGoal: within,
    share: lines.length ? within / lines.length : 0,
    fromCache: lines.filter((l) => l.fromCache).length,
  };
  const values = {
    aheadMedianMs: median(aheadDone),
    clickMedianMs: median(clicks),
    clickSlowestMs: slowest(clicks),
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) (summary as unknown as Record<string, number>)[key] = value;
  }
  return summary;
}

/** "9 of 10 (90%)". */
export function formatShare(s: Pick<AheadSummary, 'clicksWithinGoal' | 'lines' | 'share'>): string {
  return `${s.clicksWithinGoal} of ${s.lines} (${Math.round(s.share * 100)}%)`;
}

export const AHEAD_TABLE_HEADER = [
  'Model',
  'Lines',
  'Ahead, per line',
  'Ahead, all lines',
  `Clicks within ${LATENCY_GOAL_MS / 1000} s`,
  'Click median',
  'Click slowest',
  'From cache',
] as const;

/** "7", or "7 (1 failed ahead, 4 not tried)". */
function aheadLinesCell(s: AheadSummary): string {
  const notes = [
    s.aheadFailed && `${s.aheadFailed} failed ahead`,
    s.aheadSkipped && `${s.aheadSkipped} not tried`,
  ].filter(Boolean);
  return notes.length ? `${s.lines} (${notes.join(', ')})` : String(s.lines);
}

/** A row per model: how long explaining ahead took, then how the clicks went. */
export function formatAheadTable(results: readonly AheadResult[]): string {
  const line = (cells: readonly string[]) => `| ${cells.map(cell).join(' | ')} |`;
  return [
    line(AHEAD_TABLE_HEADER),
    line(AHEAD_TABLE_HEADER.map((_, i) => (i === 0 ? '---' : '---:'))),
    ...results.map(({ model, lines, ranOn }) => {
      const s = summarizeAhead(lines);
      return line([
        ranOn ? `${model} (${ranOn})` : model,
        aheadLinesCell(s),
        formatMs(s.aheadMedianMs),
        formatMs(s.aheadTotalMs),
        formatShare(s),
        formatMs(s.clickMedianMs),
        formatMs(s.clickSlowestMs),
        `${s.fromCache} of ${s.lines}`,
      ]);
    }),
  ].join('\n');
}

/** The lines that failed, ahead or on the click, as a list (empty when none did). */
export function aheadFailures(results: readonly AheadResult[]): string[] {
  return results.flatMap(({ model, lines }) =>
    lines.flatMap((l) => [
      ...(l.ahead && !l.ahead.ok ? [`- ${model}, ${l.line}, ahead: ${l.ahead.error}`] : []),
      ...(l.click.ok ? [] : [`- ${model}, ${l.line}, click: ${l.click.error}`]),
    ]),
  );
}

export interface AheadReport {
  startedAt: Date;
  machine: MachineInfo;
  llmUrl: string;
  temperature: number;
  maxResponseTokens: number;
  results: AheadResult[];
}

/** The section `npm run bench -- --ahead` adds to docs/latency.md. */
export function formatAheadReport(report: AheadReport): string {
  const page = report.results[0]?.page;
  const out = [
    `## ${formatDate(report.startedAt)} · Explain ahead · ${report.results.map((r) => r.model).join(', ')}`,
    '',
    ...machineLines(report),
    `- **Settings:** temperature ${report.temperature}, answers up to ${report.maxResponseTokens} tokens`,
    `- **How:** each added line of ${page ? `\`${page}\`` : 'a saved diff page'} is explained ` +
      'ahead, one at a time, as Explain ahead does (a failed line ends the pass, so the lines ' +
      'after it are not tried); then a click on each line is timed. A click ' +
      `counts when its whole answer came within ${LATENCY_GOAL_MS / 1000} s.`,
    '',
    formatAheadTable(report.results),
  ];
  const failures = aheadFailures(report.results);
  if (failures.length) out.push('', 'Failed lines:', '', ...failures);
  return out.join('\n') + '\n';
}

// --- Requests at once (PR 10.1) --------------------------------------------

/**
 * One request of the parallel mode, with when it happened. Times are in
 * milliseconds from the start of its level.
 */
export interface TimedRun {
  run: BenchRun;
  startMs: number;
  endMs: number;
  /** When the first piece of the answer arrived, if any did. */
  firstTokenAtMs?: number;
}

/** One level of the parallel mode: `atOnce` requests kept going until every answer was in. */
export interface LevelResult {
  atOnce: number;
  answers: TimedRun[];
  /** The extra request sent while the others were running, timed as a click. */
  click?: TimedRun;
}

/** The parallel mode's results for one model. */
export interface ParallelResult {
  model: string;
  levels: LevelResult[];
  /** Where the model ran, worded like `ollama ps`. */
  ranOn?: string;
}

/**
 * Two requests count as running together only when Ollama worked on both for
 * longer than this, so the gap between one answer ending and the next
 * starting, seen from the script, is not taken for overlap.
 */
export const OVERLAP_SLACK_MS = 250;

/**
 * When Ollama was working on a request: from Ollama's own reading and writing
 * time counted back from the end, since a request waiting in Ollama's queue
 * looks the same as a running one from outside. Falls back to the first
 * token, then to when it was sent.
 */
function busySpan({ run, startMs, endMs, firstTokenAtMs }: TimedRun): [number, number] {
  const t = run.ok ? run.timings : undefined;
  const working =
    t?.answerMs !== undefined || t?.promptMs !== undefined
      ? (t.promptMs ?? 0) + (t.answerMs ?? 0)
      : undefined;
  const from =
    working !== undefined && working > 0
      ? Math.max(startMs, endMs - working)
      : (firstTokenAtMs ?? startMs);
  return [from, endMs];
}

/**
 * The most finished requests Ollama worked on at the same moment. 1 means it
 * ran them one after another however many were sent; 0 when none finished.
 */
export function mostAtOnce(runs: readonly TimedRun[], slackMs = OVERLAP_SLACK_MS): number {
  const events = runs
    .filter((r) => r.run.ok)
    .map(busySpan)
    .filter(([from, to]) => to - from > slackMs)
    .flatMap(([from, to]) => [
      { at: from + slackMs, step: 1 },
      { at: to, step: -1 },
    ])
    // An end before a start at the same moment, so touching spans do not count.
    .sort((a, b) => a.at - b.at || a.step - b.step);
  let now = 0;
  let most = 0;
  for (const { step } of events) {
    now += step;
    most = Math.max(most, now);
  }
  return Math.max(most, runs.some((r) => r.run.ok) ? 1 : 0);
}

export interface LevelSummary {
  atOnce: number;
  answers: number;
  failed: number;
  /** From the start of the level to the last answer. */
  wallMs: number;
  /** Finished answers per minute of wall time, the total for the level. */
  perMinute?: number;
  /** Per answer, from sending it to its whole answer. */
  medianMs?: number;
  slowestMs?: number;
  /** The most requests Ollama worked on together (see mostAtOnce). */
  ranTogether: number;
  /** How long the click took, from sending it to its whole answer. */
  clickMs?: number;
  clickError?: string;
}

export function summarizeLevel(level: LevelResult): LevelSummary {
  const done = level.answers.filter((a) => a.run.ok);
  const totals = done.map((a) => (a.run as Extract<BenchRun, { ok: true }>).totalMs);
  const wallMs = Math.max(0, ...level.answers.map((a) => a.endMs));
  const summary: LevelSummary = {
    atOnce: level.atOnce,
    answers: level.answers.length,
    failed: level.answers.length - done.length,
    wallMs,
    ranTogether: mostAtOnce(level.answers),
  };
  const values = {
    perMinute: done.length && wallMs > 0 ? (done.length / wallMs) * 60_000 : undefined,
    medianMs: median(totals),
    slowestMs: slowest(totals),
    clickMs: level.click?.run.ok ? level.click.run.totalMs : undefined,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) (summary as unknown as Record<string, number>)[key] = value;
  }
  if (level.click && !level.click.run.ok) summary.clickError = level.click.run.error;
  return summary;
}

/** True when more than one request was sent at once but Ollama ran them one at a time. */
export function ranOneAtATime(s: LevelSummary): boolean {
  return s.atOnce > 1 && s.answers - s.failed > 1 && s.ranTogether === 1;
}

/** How much more throughput 2 at once must give to be worth it: 20% more answers per minute. */
export const PARALLEL_MIN_GAIN = 1.2;
/** How much slower the click may get at 2 at once: 10%, about the noise between runs. */
export const PARALLEL_MAX_CLICK_SLOWDOWN = 1.1;

const percent = (ratio: number) => `${Math.round(Math.abs(ratio - 1) * 100)}%`;

/**
 * Which level PR 10.6 should use for `model`: 1 unless 2 at once gives
 * clearly more answers per minute without slowing the click.
 */
export function recommendAtOnce(levels: readonly LevelSummary[]): {
  atOnce: 1 | 2;
  why: string;
} {
  const one = levels.find((l) => l.atOnce === 1);
  const two = levels.find((l) => l.atOnce === 2);
  if (!one?.perMinute || !two?.perMinute) {
    return { atOnce: 1, why: 'levels 1 and 2 were not both measured, so the safe choice' };
  }
  // A default must not trade failed explanations for speed (review on #60).
  const failures = [one, two].filter((l) => l.failed > 0);
  if (failures.length) {
    const which = failures
      .map((l) => `${l.failed} of ${l.answers} failed at ${l.atOnce} at once`)
      .join(' and ');
    return { atOnce: 1, why: `${which}, so the safe choice` };
  }
  const gain = two.perMinute / one.perMinute;
  const more = gain >= 1 ? `${percent(gain)} more` : `${percent(gain)} fewer`;
  if (gain < PARALLEL_MIN_GAIN) {
    return { atOnce: 1, why: `2 at once gave ${more} answers per minute` };
  }
  if (one.clickMs === undefined || two.clickMs === undefined) {
    return { atOnce: 1, why: `2 at once gave ${more} answers per minute, but a click failed` };
  }
  const slowdown = two.clickMs / one.clickMs;
  const click = `the click took ${percent(slowdown)} ${slowdown >= 1 ? 'longer' : 'less'}`;
  return slowdown <= PARALLEL_MAX_CLICK_SLOWDOWN
    ? { atOnce: 2, why: `2 at once gave ${more} answers per minute and ${click}` }
    : { atOnce: 1, why: `2 at once gave ${more} answers per minute, but ${click}` };
}

export const PARALLEL_TABLE_HEADER = [
  'Model',
  'At once',
  'Answers',
  'Answers/min',
  'Median per answer',
  'Slowest per answer',
  'Ran together',
  'Click',
] as const;

/** A row per model and level. */
export function formatParallelTable(results: readonly ParallelResult[]): string {
  const line = (cells: readonly string[]) => `| ${cells.map(cell).join(' | ')} |`;
  return [
    line(PARALLEL_TABLE_HEADER),
    line(PARALLEL_TABLE_HEADER.map((_, i) => (i === 0 ? '---' : '---:'))),
    ...results.flatMap(({ model, levels, ranOn }) =>
      levels.map((level) => {
        const s = summarizeLevel(level);
        return line([
          ranOn ? `${model} (${ranOn})` : model,
          String(s.atOnce),
          formatRuns({ runs: s.answers, failed: s.failed }),
          formatRate(s.perMinute),
          formatMs(s.medianMs),
          formatMs(s.slowestMs),
          String(s.ranTogether),
          s.clickError ? 'failed' : formatMs(s.clickMs),
        ]);
      }),
    ),
  ].join('\n');
}

export interface ParallelReport {
  startedAt: Date;
  machine: MachineInfo;
  llmUrl: string;
  temperature: number;
  maxResponseTokens: number;
  /** OLLAMA_NUM_PARALLEL as this shell has it, if set. */
  numParallel?: string;
  results: ParallelResult[];
}

/** The section `npm run bench -- --parallel …` adds to docs/latency.md. */
export function formatParallelReport(report: ParallelReport): string {
  const answers = report.results[0]?.levels[0]?.answers.length ?? 0;
  const out = [
    `## ${formatDate(report.startedAt)} · Requests at once · ${report.results.map((r) => r.model).join(', ')}`,
    '',
    ...machineLines(report),
    `- **Settings:** temperature ${report.temperature}, answers up to ${report.maxResponseTokens} ` +
      `tokens, ${answers} answers per level`,
    report.numParallel !== undefined
      ? `- **OLLAMA_NUM_PARALLEL:** ${report.numParallel} in this shell (Ollama uses the value it was started with)`
      : '- **OLLAMA_NUM_PARALLEL:** not set in this shell (Ollama uses the value it was started ' +
        'with, or its own default)',
    '- **How:** at each level, that many requests are kept going at once until every answer is ' +
      'in. Once the model is writing, one more request (a click) is sent and timed. ' +
      '**Answers/min** is the total for the level. **Ran together** is the most requests Ollama ' +
      'worked on at the same moment, from its own timings; 1 means it ran them one after another. ' +
      'The extension will cancel background requests for a click (PR 10.3), so **Click** is the ' +
      'worst case.',
    '',
    formatParallelTable(report.results),
  ];
  const notes: string[] = [];
  for (const { model, levels } of report.results) {
    const summaries = levels.map(summarizeLevel);
    const serial = summaries.filter(ranOneAtATime).map((s) => s.atOnce);
    if (serial.length) {
      notes.push(
        `- ${model}: at ${serial.join(' and ')} at once, Ollama ran the requests one after ` +
          'another anyway (OLLAMA_NUM_PARALLEL is probably 1 on the server).',
      );
    }
    const { atOnce, why } = recommendAtOnce(summaries);
    notes.push(
      `- **For PR 10.6, ${model}: ${atOnce} at once.** ${why[0]!.toUpperCase()}${why.slice(1)}.`,
    );
  }
  out.push('', ...notes);
  const failures = report.results.flatMap(({ model, levels }) =>
    levels.flatMap(({ atOnce, answers, click }) => [
      ...answers.flatMap((a, i) =>
        a.run.ok ? [] : [`- ${model}, ${atOnce} at once, answer ${i + 1}: ${a.run.error}`],
      ),
      ...(click && !click.run.ok
        ? [`- ${model}, ${atOnce} at once, click: ${click.run.error}`]
        : []),
    ]),
  );
  if (failures.length) out.push('', 'Failed requests:', '', ...failures);
  return out.join('\n') + '\n';
}

// --- By hunk (PR 10.5) -----------------------------------------------------

/** An answer's three sections, as the popup shows them. */
export interface BenchAnswer {
  what: string;
  why: string;
  concerns: string;
}

/** One hunk of the by-hunk mode: its lines asked one at a time, then all at once. */
export interface HunkBenchResult {
  /** Such as "src/a.ts: lines 12, 14, 15". */
  label: string;
  /** Each line asked on its own, as a click would. */
  single: { line: string; run: BenchRun; answer?: BenchAnswer }[];
  /** The whole hunk in one request. */
  hunk: BenchRun;
  /** Each line's answer from the hunk request, left out when its part was missing. */
  byHunk: (BenchAnswer | undefined)[];
}

export interface ByHunkResult {
  model: string;
  page: string;
  hunks: HunkBenchResult[];
  ranOn?: string;
}

export interface ByHunkSummary {
  lines: number;
  /** Lines answered one at a time, and the mean time per line. */
  singleAnswered: number;
  singlePerLineMs?: number;
  /** Lines the hunk requests answered, and the hunk time per line answered. */
  hunkAnswered: number;
  hunkPerLineMs?: number;
  /** How many times faster per line by hunk (single ÷ hunk), when both are known. */
  speedup?: number;
  /** Hunk requests that failed. */
  hunkFailed: number;
}

/** The by-hunk mode's numbers. Failed requests and missing lines add no time. */
export function summarizeByHunk(hunks: readonly HunkBenchResult[]): ByHunkSummary {
  const singles = hunks.flatMap((h) => h.single.flatMap((l) => (l.run.ok ? [l.run.totalMs] : [])));
  const hunkRuns = hunks.flatMap((h) =>
    h.hunk.ok ? [{ ms: h.hunk.totalMs, answered: h.byHunk.filter(Boolean).length }] : [],
  );
  const hunkAnswered = hunkRuns.reduce((n, r) => n + r.answered, 0);
  const summary: ByHunkSummary = {
    lines: hunks.reduce((n, h) => n + h.single.length, 0),
    singleAnswered: singles.length,
    hunkAnswered,
    hunkFailed: hunks.filter((h) => !h.hunk.ok).length,
  };
  if (singles.length) summary.singlePerLineMs = singles.reduce((a, b) => a + b, 0) / singles.length;
  if (hunkAnswered) {
    summary.hunkPerLineMs = hunkRuns.reduce((n, r) => n + r.ms, 0) / hunkAnswered;
  }
  if (summary.singlePerLineMs !== undefined && summary.hunkPerLineMs) {
    summary.speedup = summary.singlePerLineMs / summary.hunkPerLineMs;
  }
  return summary;
}

export const BY_HUNK_TABLE_HEADER = [
  'Model',
  'Lines',
  'One at a time, per line',
  'By hunk, per line',
  'Faster by',
  'Answered by hunk',
] as const;

export function formatByHunkTable(results: readonly ByHunkResult[]): string {
  const line = (cells: readonly string[]) => `| ${cells.map(cell).join(' | ')} |`;
  return [
    line(BY_HUNK_TABLE_HEADER),
    line(BY_HUNK_TABLE_HEADER.map((_, i) => (i === 0 ? '---' : '---:'))),
    ...results.map(({ model, hunks, ranOn }) => {
      const s = summarizeByHunk(hunks);
      return line([
        ranOn ? `${model} (${ranOn})` : model,
        String(s.lines),
        formatMs(s.singlePerLineMs),
        formatMs(s.hunkPerLineMs),
        s.speedup === undefined ? '–' : `${s.speedup.toFixed(1)}×`,
        `${s.hunkAnswered} of ${s.lines}` + (s.hunkFailed ? ` (${s.hunkFailed} failed)` : ''),
      ]);
    }),
  ].join('\n');
}

const answerText = (a: BenchAnswer | undefined) =>
  a ? `${a.what} ${a.why} Concerns: ${a.concerns}`.replace(/\s+/g, ' ') : '(missing)';

/** Both answers for every line, one after the other, to check by hand. */
export function formatSideBySide(result: ByHunkResult): string[] {
  return result.hunks.flatMap((h) =>
    h.single.flatMap((l, i) => [
      `- **${l.line}**`,
      `  - One at a time: ${l.run.ok ? answerText(l.answer) : `failed: ${l.run.error}`}`,
      `  - By hunk: ${h.hunk.ok ? answerText(h.byHunk[i]) : `failed: ${h.hunk.error}`}`,
    ]),
  );
}

export interface ByHunkReport {
  startedAt: Date;
  machine: MachineInfo;
  llmUrl: string;
  temperature: number;
  maxResponseTokens: number;
  results: ByHunkResult[];
}

/** The section `npm run bench -- --by-hunk` adds to docs/latency.md. */
export function formatByHunkReport(report: ByHunkReport): string {
  const page = report.results[0]?.page;
  const out = [
    `## ${formatDate(report.startedAt)} · By hunk · ${report.results.map((r) => r.model).join(', ')}`,
    '',
    ...machineLines(report),
    `- **Settings:** temperature ${report.temperature}, answers up to ${report.maxResponseTokens} ` +
      'tokens per line',
    `- **How:** each added line of ${page ? `\`${page}\`` : 'a saved diff page'} is explained ` +
      'on its own, as a click does, then each hunk is explained in one request (PR 10.5). ' +
      "**By hunk, per line** is the hunk requests' time divided by the lines they answered. " +
      'Read the answers below to check those by hunk are still about their own line.',
    '',
    formatByHunkTable(report.results),
  ];
  for (const result of report.results) {
    out.push('', `Answers with ${result.model}:`, '', ...formatSideBySide(result));
  }
  return out.join('\n') + '\n';
}

// --- Whole PR (PR 10.8) ----------------------------------------------------

/** The times, in minutes after the PR opens, the whole-PR mode reports the cached share at. */
export const WHOLE_PR_CHECKPOINTS_MIN = [1, 5, 15] as const;

/** A changed line the whole-PR mode answered, and when (ms from the start of the run). */
export interface AnsweredLine {
  line: string;
  atMs: number;
}

/** The click the whole-PR mode sends while the background work runs. */
export interface WholePrClick {
  /** Such as "src/a.ts:added:12": a line the background work had not reached. */
  line: string;
  /** When it was sent, from the start of the run. */
  sentAtMs: number;
  /** When the queue started it, from the start of the run. Left out when it never started. */
  startedAtMs?: number;
  /** From sending it to its whole answer. */
  run: BenchRun;
  /** Background requests that finished (not stopped) while it waited to start: should be 0. */
  finishedWhileWaiting: number;
  /** Background requests the click stopped to free the model. */
  cancelled: number;
}

/** The whole-PR mode's results for one model. */
export interface WholePrResult {
  model: string;
  /** The saved PR the lines came from. */
  sample: string;
  /** Changed lines worth explaining in the PR (blank and closing lines left out). */
  lines: number;
  /** Lines sent, at most the per-PR limit. */
  sent: number;
  /** Requests sent: one per hunk, at most AHEAD_HUNK_MAX_LINES lines each. */
  requests: number;
  /** How many requests ran at once (Requests at once). */
  atOnce: number;
  /** From the first request to the queue running dry, or to the time limit. */
  totalMs: number;
  /** True when the run hit the time limit before every line was answered. */
  stopped: boolean;
  /**
   * The lines the background work answered with the model. The click's line
   * is left out (review on #67), even when the background work later finds
   * it in the cache, so the share is what prefetching alone made instant.
   */
  answered: AnsweredLine[];
  /** A sample of lines asked one at a time with nothing cached, as a click asks. */
  single: BenchRun[];
  click?: WholePrClick;
  /** Requests that failed, after their retry. */
  failures: string[];
  /** Where the model ran, worded like `ollama ps`. */
  ranOn?: string;
}

export interface CachedShare {
  minutes: number;
  answered: number;
  /** answered ÷ lines, 0 when there are no lines. */
  share: number;
}

export interface WholePrSummary {
  lines: number;
  answered: number;
  /** The whole PR's time: measured, or estimated from the rate when the run was stopped. */
  wholePrMs?: number;
  estimated: boolean;
  /** Mean time per line asked one at a time. */
  singlePerLineMs?: number;
  /** The run's time per line it answered (one request per hunk). */
  byHunkPerLineMs?: number;
  /** single ÷ by hunk, when both are known. */
  speedup?: number;
  cached: CachedShare[];
  click?: {
    line: string;
    /** From sending the click to the queue starting it. */
    waitMs?: number;
    totalMs?: number;
    error?: string;
    cancelled: number;
    /** No background request finished while it waited, so it waited at most for stopping one. */
    waitedAtMostOneCancelled: boolean;
  };
}

/**
 * The whole-PR mode's numbers. The share cached after N minutes counts the
 * lines answered by then (a run that ended sooner keeps its final share); a
 * click on any of them would be answered from the cache.
 */
export function summarizeWholePr(
  result: WholePrResult,
  checkpoints: readonly number[] = WHOLE_PR_CHECKPOINTS_MIN,
): WholePrSummary {
  const answered = result.answered.length;
  const share = (n: number) => (result.lines ? n / result.lines : 0);
  const singles = result.single.flatMap((r) => (r.ok ? [r.totalMs] : []));
  const summary: WholePrSummary = {
    lines: result.lines,
    answered,
    estimated: result.stopped,
    cached: checkpoints.map((minutes) => {
      const n = result.answered.filter((a) => a.atMs <= minutes * 60_000).length;
      return { minutes, answered: n, share: share(n) };
    }),
  };
  if (singles.length) summary.singlePerLineMs = singles.reduce((a, b) => a + b, 0) / singles.length;
  if (answered && result.totalMs > 0) summary.byHunkPerLineMs = result.totalMs / answered;
  if (!result.stopped) summary.wholePrMs = result.totalMs;
  else if (summary.byHunkPerLineMs !== undefined) {
    summary.wholePrMs = summary.byHunkPerLineMs * result.sent;
  }
  if (summary.singlePerLineMs !== undefined && summary.byHunkPerLineMs) {
    summary.speedup = summary.singlePerLineMs / summary.byHunkPerLineMs;
  }
  const { click } = result;
  if (click) {
    summary.click = {
      line: click.line,
      cancelled: click.cancelled,
      waitedAtMostOneCancelled:
        click.startedAtMs !== undefined && click.finishedWhileWaiting === 0 && click.cancelled <= 1,
    };
    if (click.startedAtMs !== undefined) summary.click.waitMs = click.startedAtMs - click.sentAtMs;
    if (click.run.ok) summary.click.totalMs = click.run.totalMs;
    else summary.click.error = click.run.error;
  }
  return summary;
}

/** "37% (112 of 300)", rounded down so it never says 100% early. */
export function formatCachedShare(c: CachedShare, lines: number): string {
  return `${Math.floor(c.share * 100)}% (${c.answered} of ${lines})`;
}

export const WHOLE_PR_TABLE_HEADER = [
  'Model',
  'Lines',
  'Whole PR',
  'One at a time, per line',
  'By hunk, per line',
  ...WHOLE_PR_CHECKPOINTS_MIN.map((m) => `Cached after ${m} min`),
] as const;

/** "12.3 min", or "about 41.0 min" when estimated. */
export function formatMinutes(ms: number | undefined, estimated = false): string {
  if (ms === undefined) return NONE;
  const text = ms < 60_000 ? formatMs(ms) : `${(ms / 60_000).toFixed(1)} min`;
  return estimated ? `about ${text}` : text;
}

/** A row per model. */
export function formatWholePrTable(results: readonly WholePrResult[]): string {
  const line = (cells: readonly string[]) => `| ${cells.map(cell).join(' | ')} |`;
  return [
    line(WHOLE_PR_TABLE_HEADER),
    line(WHOLE_PR_TABLE_HEADER.map((_, i) => (i === 0 ? '---' : '---:'))),
    ...results.map((result) => {
      const s = summarizeWholePr(result);
      const sent = result.sent < result.lines ? ` (${result.sent} sent)` : '';
      return line([
        result.ranOn ? `${result.model} (${result.ranOn})` : result.model,
        `${result.lines}${sent}`,
        formatMinutes(s.wholePrMs, s.estimated),
        formatMs(s.singlePerLineMs),
        formatMs(s.byHunkPerLineMs),
        ...s.cached.map((c) => formatCachedShare(c, s.lines)),
      ]);
    }),
  ].join('\n');
}

/** "0:35" from the start of the run. */
function clockTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
}

/** One line per model on the click sent during the run. */
export function formatWholePrClick(result: WholePrResult): string {
  const s = summarizeWholePr(result);
  const { click } = s;
  if (!click) return `- ${result.model}: no click was sent (the run ended first).`;
  const sent = `a click on ${click.line} at ${clockTime(result.click!.sentAtMs)}`;
  if (click.waitMs === undefined) return `- ${result.model}: ${sent} never started.`;
  const stopped =
    click.cancelled === 0
      ? 'with nothing to stop'
      : `stopping ${click.cancelled} background ${click.cancelled === 1 ? 'request' : 'requests'}`;
  const answer =
    click.error !== undefined
      ? `failed: ${click.error}`
      : `answered in ${formatMs(click.totalMs)}` +
        (s.singlePerLineMs !== undefined ? ` (a line alone: ${formatMs(s.singlePerLineMs)})` : '');
  const verdict = click.waitedAtMostOneCancelled
    ? 'It waited no longer than one cancelled request.'
    : `It waited longer than one cancelled request: ${result.click!.finishedWhileWaiting} finished first.`;
  return `- ${result.model}: ${sent} started after ${formatMs(click.waitMs)}, ${stopped}, ${answer}. ${verdict}`;
}

export interface WholePrReport {
  startedAt: Date;
  machine: MachineInfo;
  llmUrl: string;
  temperature: number;
  maxResponseTokens: number;
  /** The run's time limit per model. */
  maxMs: number;
  results: WholePrResult[];
  /** From wholePrConclusion (scripts/latencyReport.ts); left out when there is none. */
  conclusion?: string;
}

/** The section `npm run bench -- --whole-pr` adds to docs/latency.md. */
export function formatWholePrReport(report: WholePrReport): string {
  const first = report.results[0];
  const out = [
    `## ${formatDate(report.startedAt)} · Whole PR · ${report.results.map((r) => r.model).join(', ')}`,
    '',
    ...machineLines(report),
    `- **Settings:** temperature ${report.temperature}, answers up to ${report.maxResponseTokens} ` +
      `tokens per line, ${first?.atOnce ?? 1} at once, each model stopped after ` +
      `${formatMinutes(report.maxMs)} at most (loading it and the lines one at a time included)`,
    `- **How:** every changed line of ${first ? `\`${first.sample}\`` : 'a saved PR'} ` +
      `(${first ? `${first.lines} lines in ${first.requests} requests` : 'its lines'}) goes through ` +
      "the service worker's queue as Whole PR sends it, one request per hunk (PR 10.5), with an " +
      'empty cache and the model loaded. **One at a time, per line** asks a sample of lines alone ' +
      'first, as a click would with nothing cached. **Cached after N min** is the share of changed ' +
      'lines the background work answered by then. Once the first request is in, a click on a ' +
      'line not reached yet is sent and timed; its line is not counted as prefetched.',
    '',
    formatWholePrTable(report.results),
    '',
    'Clicks during the run:',
    '',
    ...report.results.map(formatWholePrClick),
  ];
  if (report.conclusion) out.push('', report.conclusion);
  const failures = report.results.flatMap(({ model, failures }) =>
    failures.map((f) => `- ${model}: ${f}`),
  );
  if (failures.length) out.push('', 'Failed requests:', '', ...failures);
  return out.join('\n') + '\n';
}

export const LATENCY_DOC_INTRO = `# Explanation latency

Measured with \`npm run bench\` (roadmap PR 8.2), which sends the extension's real explain
prompt for the samples in \`bench/\` to the local Ollama and times each answer. Each run
below adds a dated section at the end, with the computer it ran on, so numbers from different
laptops are not compared by mistake.

How to read a table: every time is the median of the runs that finished, except **Slowest**.
**Median** and **Slowest** run from sending the request to the end of the answer, like
"Answered in …" in the popup without the time spent on the GitHub page. **First token** is
when the first word arrived. **Load** is Ollama loading the model into memory (near zero
once it is loaded). **Prompt tokens** counts only the tokens Ollama had to read, so a
cached prompt counts fewer. **Tokens/s** is how fast the answer was written. **Think tokens**
and **Think time** are the part of the answer a reasoning model spent inside \`<think>\`,
estimated from its share of the reply (PR 9.1). A failed run is listed under its table and
counted in **Runs**, never dropped.

\`npm run bench -- --whole-pr [model ...]\` (roadmap PR 10.8) adds a **Whole PR** section: every
changed line of a saved PR (\`tests/fixtures/github-pr-66-src-files.json\`, 252 lines) goes through
the service worker's queue as **Explain ahead**'s Whole PR sends it, one request per hunk, with an
empty cache. It reports how long the whole PR took, the time per line (a sample asked one at a
time, and by hunk), the share of changed lines a click would find answered after 1, 5 and 15
minutes, and how long a click sent during the run waited (it should stop at most one background
request, never wait for one to finish). Its conclusion says whether most clicks (at least 90%) are
instant after 5 minutes, only after 15, or not yet, and what the numbers say about **Requests at
once** and the per-PR limit.
`;

/** docs/latency.md with `section` added at the end (and the intro first, when there is no file yet). */
export function appendReport(existing: string | null, section: string): string {
  const base = existing?.trim() ? existing.trimEnd() : LATENCY_DOC_INTRO.trimEnd();
  return `${base}\n\n${section.trimEnd()}\n`;
}

/** What the command line asked for. */
export interface BenchArgs {
  models: string[];
  runs: number;
  llmUrl?: string;
  save: boolean;
  /** Run the ahead mode (PR 9.11) instead of timing each sample. */
  ahead: boolean;
  /**
   * How many requests to send at once, one level after another (PR 10.1),
   * instead of timing each sample alone. Left out when not asked for.
   */
  parallel?: number[];
  /** Compare one line at a time with a whole hunk per request (PR 10.5). */
  byHunk: boolean;
  /** Prefetch a whole saved PR through the queue (PR 10.8). */
  wholePr: boolean;
}

/** The most requests `--parallel` sends at once. */
export const MAX_AT_ONCE = 8;

/** Reads "1,2,4": whole numbers from 1 to MAX_AT_ONCE, smallest first, each once. */
export function parseLevels(text: string): number[] {
  const parts = text.split(',').map((p) => p.trim());
  const levels = parts.map(Number);
  const bad = parts.some((p) => !/^\d+$/.test(p));
  if (bad || levels.some((n) => n < 1 || n > MAX_AT_ONCE)) {
    throw new Error(
      `--parallel must be a list of whole numbers from 1 to ${MAX_AT_ONCE}, such as 1,2,4`,
    );
  }
  return [...new Set(levels)].sort((a, b) => a - b);
}

/**
 * Reads `[model ...] [--runs N] [--url URL] [--no-save] [--ahead | --parallel 1,2,4 | --by-hunk | --whole-pr]`.
 * Throws on anything else.
 */
export function parseBenchArgs(argv: readonly string[]): BenchArgs {
  const args: BenchArgs = {
    models: [],
    runs: 3,
    save: true,
    ahead: false,
    byHunk: false,
    wholePr: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.startsWith('--') ? arg.split(/=(.*)/s, 2) : [arg];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--runs') {
      const runs = Number(value());
      if (!Number.isInteger(runs) || runs < 1 || runs > 50) {
        throw new Error('--runs must be a whole number from 1 to 50');
      }
      args.runs = runs;
    } else if (flag === '--url') {
      args.llmUrl = value();
    } else if (flag === '--no-save') {
      args.save = false;
    } else if (flag === '--ahead') {
      args.ahead = true;
    } else if (flag === '--parallel') {
      args.parallel = parseLevels(value());
    } else if (flag === '--by-hunk') {
      args.byHunk = true;
    } else if (flag === '--whole-pr') {
      args.wholePr = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option ${arg}`);
    } else {
      args.models.push(arg);
    }
  }
  const modes = [args.ahead, args.parallel !== undefined, args.byHunk, args.wholePr];
  if (modes.filter(Boolean).length > 1) {
    throw new Error('Use only one of --ahead, --parallel, --by-hunk and --whole-pr');
  }
  return args;
}

/** One sample in bench/: the context the content script would send for a click or a selection. */
export interface BenchSample {
  name: string;
  /** The context block, one entry per line (formatContext or formatSelection output). */
  context: string[];
  pr?: { title: string; description: string };
  /** The full-file context (PR 6.3), in the shape src/fileContext.ts sends. */
  fileContext?: unknown;
}

/** Checks a parsed bench/*.json file has the fields a sample needs. */
export function parseSample(value: unknown, file: string): BenchSample {
  const v = (value ?? {}) as Record<string, unknown>;
  const fail = (problem: string): never => {
    throw new Error(`${file}: ${problem}`);
  };
  if (typeof v.name !== 'string' || !v.name.trim()) fail('"name" must be text');
  if (
    !Array.isArray(v.context) ||
    !v.context.length ||
    v.context.some((l) => typeof l !== 'string')
  ) {
    fail('"context" must be a list of lines');
  }
  const pr = v.pr as Record<string, unknown> | undefined;
  if (pr !== undefined && (typeof pr?.title !== 'string' || typeof pr.description !== 'string')) {
    fail('"pr" needs a "title" and a "description"');
  }
  return v as unknown as BenchSample;
}
