// Explains every changed line of a hunk in one request (PR 10.5), for the
// background queue. The model is asked once (src/explain/hunkPrompt.ts), the
// reply is split per line (parseHunkExplanation.ts), and each line's answer
// is saved under the key a click on that line looks up: the key of the
// single-line prompt, built from the line's own request exactly as the
// explain handler builds it for a click. So a click on the line finds the
// answer, and a new commit that changes the code gives new keys.
//
// Lines already in the cache are left out of the request. A line whose part
// of the reply is missing or cannot be read is reported as missing, and the
// queue puts it back as a single-line job (src/background.ts). When the
// hunk's prompt and answer do not fit the context window, nothing is sent
// and every line is missing, so each is asked on its own.

import { promptBudget, thinkOption } from '../llm/contextSize';
import { describeLlmError } from '../llm/describeLlmError';
import { chooseNumCtx } from '../llm/numCtx';
import type { LlmTimings } from '../llm/types';
import { createRoundTripLog } from '../net/roundTrips';
import type { WorkerTrace } from '../trace/types';
import { explainCacheKey } from './explainCache';
import {
  createTaskRecorder,
  settingsContextTokens,
  toFileContext,
  toPrInfo,
  type ExplainDeps,
  type ExplainPayload,
  type ExplainStreamOptions,
} from './explainHandler';
import { buildFittedExplainPrompt, estimateMessages } from './fitPrompt';
import { MAX_HUNK_LINES, buildHunkPrompt, hunkAnswerTokens } from './hunkPrompt';
import { parseHunkExplanation } from './parseHunkExplanation';

/** One changed line of a hunk request. */
export interface HunkLinePayload {
  /** Names the line, such as "src/a.ts:added:12". */
  label: string;
  /** The context block a click on the line sends (formatContext). */
  context: string;
  /** Its number in the new file. */
  line: number;
  /** The line diff style, such as "+const a = 1;". */
  code: string;
  /** The block around the line in the full file (PR 6.3), as a click sends it. */
  fileContext?: unknown;
}

/** The hunk part of an explain request: the diff section and the lines to explain. */
export interface HunkPayload {
  /** The diff section the model reads (hunkContextText in src/lineContext.ts). */
  text: string;
  /** At most MAX_HUNK_LINES, in the order they appear. */
  lines: HunkLinePayload[];
}

export type HunkLineStatus = 'done' | 'cached' | 'missing';

export type HunkResult =
  | {
      status: 'hunk';
      /** One per line of the request, in order. */
      lines: { label: string; status: HunkLineStatus }[];
      /** The model that answered, when it was asked. */
      model?: string;
      timings?: LlmTimings;
      trace?: WorkerTrace;
    }
  | { status: 'failed'; message: string; fix: string; trace?: WorkerTrace };

/** `value` as a HunkPayload, or undefined when it is not one (it is never trusted). */
export function toHunkPayload(value: unknown): HunkPayload | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { text, lines } = value as { text?: unknown; lines?: unknown };
  if (typeof text !== 'string' || !text.trim() || !Array.isArray(lines)) return undefined;
  if (lines.length === 0 || lines.length > MAX_HUNK_LINES) return undefined;
  const out: HunkLinePayload[] = [];
  for (const item of lines as unknown[]) {
    if (typeof item !== 'object' || item === null) return undefined;
    const l = item as Record<string, unknown>;
    if (typeof l.label !== 'string' || !l.label) return undefined;
    if (typeof l.context !== 'string' || !l.context.trim()) return undefined;
    if (!Number.isInteger(l.line) || (l.line as number) < 1) return undefined;
    if (typeof l.code !== 'string') return undefined;
    out.push({
      label: l.label.slice(0, 200),
      context: l.context,
      line: l.line as number,
      code: l.code,
      ...(l.fileContext !== undefined && { fileContext: l.fileContext }),
    });
  }
  return { text, lines: out };
}

/** The request a click on line `i` of `payload`'s hunk sends, for its single-line job. */
export function linePayload(payload: ExplainPayload, line: HunkLinePayload): ExplainPayload {
  return {
    context: line.context,
    ...(payload.pr !== undefined && { pr: payload.pr }),
    ...(payload.prInfo && { prInfo: payload.prInfo }),
    ...(line.fileContext !== undefined && { fileContext: line.fileContext as never }),
    cause: 'ahead',
    ...(payload.debugId !== undefined && { debugId: payload.debugId }),
    job: {
      label: line.label,
      ...(payload.job?.order !== undefined && { order: payload.job.order }),
    },
  };
}

export function createHunkExplainHandler(deps: ExplainDeps) {
  return async (
    payload: ExplainPayload,
    { onChunk, signal }: ExplainStreamOptions = {},
  ): Promise<HunkResult> => {
    const hunk = toHunkPayload(payload.hunk);
    if (!hunk) throw new Error('a hunk request needs a diff section and 1 to 15 lines');
    const now = deps.now ?? Date.now;
    const tasks = createTaskRecorder(now);
    const roundTrips = createRoundTripLog('ahead', now, {
      ...(typeof payload.debugId === 'string' && { group: payload.debugId.slice(0, 100) }),
      onUpdate: deps.onRoundTrip,
    });
    const trace = (): WorkerTrace => ({
      ...tasks.trace(),
      roundTrips: roundTrips.list(tasks.origin),
    });
    const failed = (message: string, fix: string): HunkResult => ({
      status: 'failed',
      message,
      fix,
      trace: trace(),
    });
    const settings = await tasks.time('settings', 'Read settings', () => deps.getSettings());
    const { cache } = deps;
    const pr = typeof payload.pr === 'string' ? payload.pr : '';
    if (!cache || !pr || !settings.model) {
      return failed(
        'A hunk is explained only to fill the cache, and this request has no PR or model to save under.',
        'Click the line to explain it.',
      );
    }
    const contextTokens = await (deps.contextTokens ?? settingsContextTokens)(
      settings,
      signal,
      undefined,
      roundTrips,
    );
    const prInfo = toPrInfo(payload.prInfo);

    // Each line's key, as a click on it builds it (createExplainHandler).
    const lineBudget = promptBudget(contextTokens, settings.maxResponseTokens);
    const keys = await tasks.time('fit-prompt', 'Build the prompt', () =>
      Promise.all(
        hunk.lines.map(async (line) => {
          try {
            const { messages } = buildFittedExplainPrompt(
              line.context,
              prInfo,
              lineBudget,
              toFileContext(line.fileContext),
            );
            return await explainCacheKey({
              pr,
              model: settings.model,
              temperature: settings.temperature,
              maxResponseTokens: settings.maxResponseTokens,
              messages,
              letModelThink: settings.letModelThink,
            });
          } catch {
            // Too long for one click too: its own job will say so.
            return null;
          }
        }),
      ),
    );
    const statuses: HunkLineStatus[] = hunk.lines.map(() => 'missing');
    await tasks.time('cache', 'Check the cache', () =>
      Promise.all(
        keys.map(async (key, i) => {
          if (key && (await cache.get(key).catch(() => null))) statuses[i] = 'cached';
        }),
      ),
    );
    const result = (extra: Partial<Extract<HunkResult, { status: 'hunk' }>> = {}): HunkResult => ({
      status: 'hunk',
      lines: hunk.lines.map((line, i) => ({ label: line.label, status: statuses[i]! })),
      ...extra,
      trace: trace(),
    });
    const todo = hunk.lines.flatMap((line, i) =>
      statuses[i] === 'missing' && keys[i] ? [{ line, i, key: keys[i] }] : [],
    );
    if (todo.length === 0) return result();

    const messages = buildHunkPrompt({ text: hunk.text, lines: todo.map((t) => t.line), prInfo });
    const answerTokens = hunkAnswerTokens(todo.length, settings.maxResponseTokens);
    const promptTokens = estimateMessages(messages);
    // Too big to ask at once: every line goes back as a single-line job.
    if (promptTokens > promptBudget(contextTokens, answerTokens)) return result();

    const client = deps.createClient(settings, { roundTrips });
    const numCtx =
      settings.contextTokens > 0
        ? contextTokens
        : chooseNumCtx({
            promptTokens,
            answerTokens,
            limit: contextTokens,
            loaded: deps.loadedWindow?.known(settings),
          });
    const think = thinkOption(
      deps.thinking ? await deps.thinking(settings, signal, undefined, roundTrips) : undefined,
      settings.letModelThink,
    );
    const startedAt = now();
    const windowTicket = deps.loadedWindow?.start(settings, numCtx);
    try {
      const stream = client.chatStream(messages, {
        model: settings.model,
        temperature: settings.temperature,
        maxResponseTokens: answerTokens,
        contextTokens: numCtx,
        keepAliveMinutes: settings.keepAliveMinutes,
        ...(think !== undefined && { think }),
        signal,
      });
      let content = '';
      let next = await stream.next();
      while (!next.done) {
        content += next.value;
        onChunk?.(next.value);
        next = await stream.next();
      }
      tasks.add('model', 'Wait for the model', startedAt);
      windowTicket?.done();
      const { model, timings, doneReason } = next.value;
      const answers = parseHunkExplanation(content, todo.length, {
        cutOff: doneReason === 'length',
      });
      // Each line's share of the time, as "how long the model took to write it".
      const elapsedMs = Math.round((now() - startedAt) / todo.length);
      await tasks.time('cache-save', 'Save to the cache', () =>
        Promise.all(
          todo.map(async ({ i, key }, n) => {
            const explanation = answers[n];
            if (!explanation) return;
            // Done only once saved: a failed save stays missing, so the line
            // goes back to the queue on its own instead of being lost.
            await cache.set(key, { explanation, model, elapsedMs, savedAt: now() }, pr).then(
              () => (statuses[i] = 'done'),
              () => {},
            );
          }),
        ),
      );
      return result({ model, ...(timings && { timings }) });
    } catch (error) {
      tasks.add('model', 'Wait for the model', startedAt, { status: 'failed' });
      windowTicket?.failed();
      const { message, fix } = describeLlmError(error, {
        url: settings.llmUrl,
        model: settings.model,
        platform: deps.platform,
      });
      return failed(message, fix);
    }
  };
}
