// Where a click's time went (PR 9.1): turns a click's trace (src/trace/) and
// the server's timings (PR 8.1) into the rows of the popup's Details, a small
// waterfall with one row per task. The model's task is split into Load, Read
// prompt, Think and Write answer. Ollama reports one time for everything the
// model wrote, so Think and Write answer are split by the share of the
// reply's characters inside <think> (marked estimated) until PR 9.5 makes
// Ollama report thinking on its own.
//
// Used by the content script and `npm run bench`. The service worker passes
// the server's raw timings (src/llm/types.ts, LlmTimings), so the two never
// share this module.

import type { LlmTimings } from '../llm/types';
import { formatMs } from '../trace/clickTrace';
import type { TraceTask, TaskSource } from '../trace/types';

/** "45 ms" under a second, then "1.2 s". */
export const formatDuration = formatMs;

/**
 * The share of `reply` (0 to 1) inside <think> blocks, tags included. A
 * reply cut off inside <think> (no closing tag) is thinking to the end.
 */
export function thinkShare(reply: string): number {
  if (!reply) return 0;
  let thinking = 0;
  for (const match of reply.matchAll(/<think>[\s\S]*?(?:<\/think>|$)/gi)) {
    thinking += match[0].length;
  }
  return thinking / reply.length;
}

/** A count and a time, either of which may be unknown. */
export interface Amount {
  tokens?: number;
  ms?: number;
}

/** Splits what the model wrote into thinking and answer by `share` (0 to 1). */
export function splitAnswer(answer: Amount, share: number): { think: Amount; write: Amount } {
  const part = (value: number | undefined, s: number) =>
    value === undefined ? undefined : value * s;
  const pick = (s: number): Amount => {
    const tokens = part(answer.tokens, s);
    const ms = part(answer.ms, s);
    return {
      ...(tokens !== undefined && { tokens: Math.round(tokens) }),
      ...(ms !== undefined && { ms }),
    };
  };
  const s = Math.min(1, Math.max(0, share));
  const think = pick(s);
  // The answer gets the rest, so the two always add up to the whole.
  const write: Amount = {
    ...(answer.tokens !== undefined && { tokens: answer.tokens - (think.tokens ?? 0) }),
    ...(answer.ms !== undefined && { ms: answer.ms - (think.ms ?? 0) }),
  };
  return { think, write };
}

/** One row of the waterfall. */
export interface WaterfallRow {
  key: string;
  label: string;
  source: TaskSource;
  startMs: number;
  durationMs: number;
  /** durationMs as a share of the total, 0 to 1. */
  share: number;
  status?: 'failed' | 'skipped';
  /** True when the time is an estimate (Think and Write answer). */
  estimated?: boolean;
  /** Tokens and speed, for the model's rows. */
  detail?: string;
}

export interface Waterfall {
  rows: WaterfallRow[];
  /** From the click to the popup showing the answer. */
  totalMs: number;
  /** When the first piece of the reply arrived, from the click. */
  firstTokenMs?: number;
}

function tokens(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'token' : 'tokens'}`;
}

type RowDraft = Omit<WaterfallRow, 'share'>;

/** The model's task as Load, Read prompt, Think and Write answer, one after another. */
function modelRows(task: TraceTask, timings: LlmTimings, reply: string): RowDraft[] {
  const rows: RowDraft[] = [];
  let at = task.startMs;
  const push = (row: Omit<RowDraft, 'startMs' | 'source'>) => {
    rows.push({ ...row, source: 'model', startMs: at });
    at += row.durationMs;
  };
  if (timings.loadMs !== undefined) {
    push({ key: 'load', label: 'Load', durationMs: timings.loadMs });
  }
  if (timings.promptMs !== undefined || timings.promptTokens !== undefined) {
    push({
      key: 'prompt',
      label: 'Read prompt',
      durationMs: timings.promptMs ?? 0,
      ...(timings.promptTokens !== undefined && { detail: tokens(timings.promptTokens) }),
    });
  }
  if (timings.answerMs !== undefined || timings.answerTokens !== undefined) {
    const share = thinkShare(reply);
    const { think, write } = splitAnswer(
      { tokens: timings.answerTokens, ms: timings.answerMs },
      share,
    );
    if (share > 0) {
      push({
        key: 'think',
        label: 'Think',
        durationMs: think.ms ?? 0,
        estimated: true,
        ...(think.tokens !== undefined && { detail: `~${tokens(think.tokens)}` }),
      });
    }
    const perSecond =
      timings.answerTokens !== undefined && timings.answerMs
        ? timings.answerTokens / (timings.answerMs / 1000)
        : undefined;
    const detail = [
      write.tokens !== undefined && `${share > 0 ? '~' : ''}${tokens(write.tokens)}`,
      perSecond !== undefined && `${perSecond.toFixed(1)} tokens/s`,
    ].filter((d) => d !== false);
    push({
      key: 'write',
      label: 'Write answer',
      durationMs: write.ms ?? 0,
      ...(share > 0 && { estimated: true }),
      ...(detail.length && { detail: detail.join(' · ') }),
    });
  }
  return rows;
}

/**
 * The waterfall for a click's `tasks`. The model's task is split by the
 * server's `timings` and the `reply` (for Think); without timings it stays
 * one row. Rows are in the order they started.
 */
export function buildWaterfall(
  tasks: readonly TraceTask[],
  timings?: LlmTimings,
  reply = '',
): Waterfall {
  const drafts: RowDraft[] = [];
  let firstTokenMs: number | undefined;
  for (const task of tasks) {
    if (task.key === 'model' && task.firstChunkMs !== undefined) {
      firstTokenMs = task.startMs + task.firstChunkMs;
    }
    const split = task.key === 'model' && timings ? modelRows(task, timings, reply) : [];
    if (split.length) {
      drafts.push(...split);
      continue;
    }
    drafts.push({
      key: task.key,
      label: task.label,
      source: task.source,
      startMs: task.startMs,
      durationMs: task.durationMs,
      ...(task.status && { status: task.status }),
    });
  }
  const totalMs = Math.max(0, ...drafts.map((r) => r.startMs + r.durationMs));
  const rows = drafts
    .map((r) => ({ ...r, share: totalMs > 0 ? r.durationMs / totalMs : 0 }))
    .sort((a, b) => a.startMs - b.startMs);
  return { rows, totalMs, ...(firstTokenMs !== undefined && { firstTokenMs }) };
}

/** "~20.1 s · 45%", "skipped", or "failed after 30 ms". */
export function rowValue(row: WaterfallRow): string {
  if (row.status === 'skipped') return 'skipped';
  const time = `${row.estimated ? '~' : ''}${formatMs(row.durationMs)}`;
  if (row.status === 'failed') return `failed after ${time}`;
  return `${time} · ${Math.round(row.share * 100)}%`;
}

/** What a screen reader says for a row. */
export function rowDescription(row: WaterfallRow): string {
  const parts = [
    `${row.label}${row.estimated ? ' (estimated)' : ''}`,
    row.status === 'skipped'
      ? 'skipped'
      : `${row.status === 'failed' ? 'failed after ' : ''}${formatMs(row.durationMs)}`,
  ];
  if (!row.status) parts.push(`${Math.round(row.share * 100)}% of the total`);
  parts.push(`started at ${formatMs(row.startMs)}`);
  if (row.detail) parts.push(row.detail.replace(/~/g, 'about '));
  return parts.join(', ');
}
