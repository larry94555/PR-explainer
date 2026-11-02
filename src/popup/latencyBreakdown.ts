// Splits the time from a click to "Answered in …" into the parts Ollama
// reports (PR 8.1): loading the model, reading the prompt, and writing the
// answer, plus the time spent outside Ollama (messaging between the page and
// the service worker, building the prompt, and parsing the answer). The
// popup's Details section and the console log both show it.
//
// Used by the content script only. The service worker passes the server's raw
// timings (src/llm/types.ts, LlmTimings), so the two never share this module.

import type { LlmTimings } from '../llm/types';

export interface LatencyBreakdown {
  /** From the click to the answer, as the popup timed it. */
  totalMs: number;
  /** Loading the model into memory. */
  loadMs?: number;
  /** Reading the prompt. */
  prompt?: { tokens?: number; ms?: number };
  /** Writing the answer, and how fast. */
  answer?: { tokens?: number; ms?: number; tokensPerSecond?: number };
  /** Time Ollama did not account for: messaging and parsing. Never negative. */
  otherMs: number;
}

/**
 * The breakdown of `elapsedMs` (the popup's time) using the server's
 * `timings`, or null when the server reported nothing to split it by.
 */
export function latencyBreakdown(
  elapsedMs: number,
  timings: LlmTimings | undefined,
): LatencyBreakdown | null {
  if (!timings) return null;
  const { loadMs, promptTokens, promptMs, answerTokens, answerMs } = timings;
  const parts = [loadMs, promptMs, answerMs].filter((n) => n !== undefined);
  const serverMs = timings.totalMs ?? (parts.length ? parts.reduce((a, b) => a + b, 0) : undefined);
  if (serverMs === undefined && promptTokens === undefined && answerTokens === undefined) {
    return null;
  }
  const totalMs = Math.max(0, elapsedMs);
  const breakdown: LatencyBreakdown = {
    totalMs,
    // The server's clock and the popup's are not the same, so a fast reply can
    // look like it took longer inside Ollama than in total.
    otherMs: Math.max(0, totalMs - (serverMs ?? 0)),
  };
  if (loadMs !== undefined) breakdown.loadMs = loadMs;
  if (promptTokens !== undefined || promptMs !== undefined) {
    breakdown.prompt = {
      ...(promptTokens !== undefined && { tokens: promptTokens }),
      ...(promptMs !== undefined && { ms: promptMs }),
    };
  }
  if (answerTokens !== undefined || answerMs !== undefined) {
    const perSecond =
      answerTokens !== undefined && answerMs !== undefined && answerMs > 0
        ? answerTokens / (answerMs / 1000)
        : undefined;
    breakdown.answer = {
      ...(answerTokens !== undefined && { tokens: answerTokens }),
      ...(answerMs !== undefined && { ms: answerMs }),
      ...(perSecond !== undefined && { tokensPerSecond: perSecond }),
    };
  }
  return breakdown;
}

/** "45 ms" under a second, then "1.2 s". */
export function formatDuration(ms: number): string {
  const value = Math.max(0, ms);
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

function tokens(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'token' : 'tokens'}`;
}

/** One row of the Details section: a label and what it measured. */
export interface LatencyRow {
  key: 'load' | 'prompt' | 'answer' | 'other' | 'total';
  label: string;
  value: string;
}

/** The rows the popup's Details section shows, in order. */
export function latencyRows(b: LatencyBreakdown): LatencyRow[] {
  const rows: LatencyRow[] = [];
  if (b.loadMs !== undefined) {
    rows.push({ key: 'load', label: 'Load', value: formatDuration(b.loadMs) });
  }
  if (b.prompt) {
    const parts = [
      b.prompt.tokens !== undefined && tokens(b.prompt.tokens),
      b.prompt.ms !== undefined && formatDuration(b.prompt.ms),
    ].filter((p) => p !== false);
    rows.push({ key: 'prompt', label: 'Prompt', value: parts.join(' · ') });
  }
  if (b.answer) {
    const parts = [
      b.answer.tokens !== undefined && tokens(b.answer.tokens),
      b.answer.ms !== undefined && formatDuration(b.answer.ms),
      b.answer.tokensPerSecond !== undefined && `${b.answer.tokensPerSecond.toFixed(1)} tokens/s`,
    ].filter((p) => p !== false);
    rows.push({ key: 'answer', label: 'Answer', value: parts.join(' · ') });
  }
  rows.push({ key: 'other', label: 'Outside Ollama', value: formatDuration(b.otherMs) });
  rows.push({ key: 'total', label: 'Total', value: formatDuration(b.totalMs) });
  return rows;
}

/** The same numbers on one line, for the console log. */
export function latencySummary(b: LatencyBreakdown): string {
  return latencyRows(b)
    .filter((row) => row.key !== 'total')
    .map((row) => `${row.label}: ${row.value}`)
    .join(', ');
}
