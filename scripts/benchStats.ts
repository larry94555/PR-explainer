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

function formatRate(n: number | undefined): string {
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
}

/** Reads `[model ...] [--runs N] [--url URL] [--no-save] [--ahead]`. Throws on anything else. */
export function parseBenchArgs(argv: readonly string[]): BenchArgs {
  const args: BenchArgs = { models: [], runs: 3, save: true, ahead: false };
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
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option ${arg}`);
    } else {
      args.models.push(arg);
    }
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
