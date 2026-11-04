// Click-to-explain: turns a click on a diff line into an explanation popup.
//
// On each click on a code line it opens the popup in the loading state next
// to the line, streams the explanation of the line's context from the service
// worker into it as the model writes, and shows the three sections at the
// end. The popup's Stop button, or closing the popup, stops the request. Its
// Regenerate button asks again with `fresh` set, so the service worker skips
// its cache. Once the explanation is shown, its Ask a question button opens
// the chat about the same code (openChat, src/chat/chatFlow.ts). While the
// chat is open, a click on another line goes to the chat instead of a popup
// (addToChat, PR 5.4). Clicks on
// GitHub's own controls
// (the comment "+" button, links, menus, form fields), clicks that finish a
// text selection, and modified clicks (Shift, Ctrl, Alt, Cmd) are left alone
// so GitHub keeps working as before. Since PR 11.1 the request starts when
// the mouse button goes down on a line (createClickHandler), and the click
// opens the popup on it. Drags and Shift-clicks across several
// lines are handled by src/selection.ts, which explains the block as a whole. Nothing happens at all while the toolbar
// button has click-to-explain turned off.
//
// The parts that talk to Chrome and draw the popup are passed in, so the
// tests can use fakes.

import type { ChatSubject } from './chat/chatPanel';
import type { ChatSeed } from './chat/chatSession';
import { factsFromHunk, type CodeFacts } from './codeFacts';
import { locateHunk, locateRow, type DiffHunk } from './diffDom';
import { contextFromHunk, DEFAULT_CONTEXT, formatContext } from './lineContext';
import type { Explanation } from './explain/parseExplanation';
import type { CodeSpan } from './fileContext';
import type { LlmTimings } from './llm/types';
import type { ExplainStream } from './messaging/client';
import type { Popup, PopupAnchor, PopupOptions } from './popup/popup';
import { createClickTrace, type ClickTrace } from './trace/clickTrace';
import type { TraceTask } from './trace/types';
import type { DebugLogPayload } from './debug/types';
import type { ExplainJobInfo } from './explain/explainHandler';

export interface ClickHandlerDeps {
  /**
   * Sends the formatted context to the service worker, calling `onChunk`
   * with each piece of the reply as it arrives. `code` says where the code
   * is in the new file, so its enclosing block can be read from the full
   * file (PR 6.3); it is left out for removed lines. The page's tasks for
   * the request (reading the PR description, fetching the file, sending)
   * are recorded in `trace` (PR 9.1). `cause` is "hover" for Explain on
   * hover (PR 8.7) and "ahead" for Explain ahead (PR 9.10), so their round
   * trips are not counted against a click (PR 9.2). Without a trace,
   * `debugId` names the request's group in the debug log (PR 9.3). The
   * service worker's queue (PR 10.3) joins a click to a running hover or
   * Explain ahead request for the same code.
   */
  explain(
    context: string,
    onChunk: (text: string) => void,
    options: {
      fresh: boolean;
      code?: CodeSpan;
      trace?: ClickTrace;
      cause?: 'click' | 'hover' | 'ahead';
      debugId?: string;
      /** The line's name, for the background queue in the debug window (PR 10.3). */
      job?: ExplainJobInfo;
    },
  ): ExplainStream;
  /**
   * False while the user has turned click-to-explain off with the toolbar
   * button (PR 3.6). Clicks are then left alone. Leaving it out means on.
   */
  isEnabled?(): boolean;
  /**
   * True while the chat is open, so a press sends nothing: the click that
   * follows goes to the chat (PR 11.1). Leaving it out means never.
   */
  isChatOpen?(): boolean;
  /** Opens a popup next to the clicked row, closing any other popup. */
  openPopup(
    anchor: PopupAnchor,
    options: Required<Pick<PopupOptions, 'onStop' | 'onClose' | 'onRegenerate'>> &
      Pick<PopupOptions, 'onAsk' | 'facts'>,
  ): Popup;
  /**
   * Opens the chat about an explanation (the popup's Ask a question button).
   * Leaving it out hides the button.
   */
  openChat?(chat: ChatStart): void;
  /**
   * Hands clicked code to the open chat, which adds it to the conversation
   * (PR 5.4). Returns false when no chat is open, and the code is explained
   * in the popup as usual. Leaving it out means there is never a chat to add to.
   */
  addToChat?(request: ExplainRequest): boolean;
  /** Called with each context block sent to the model (dev logging). */
  onContext?(context: string): void;
  /**
   * Called when an answer (or error) is shown, or Stop is pressed, with how
   * long it took from the click, so latency can be logged and compared
   * across models.
   */
  onTiming?(timing: ExplainTiming): void;
}

/** What a chat starts from: the code, its explanation, and where the code is. */
export interface ChatStart extends ChatSeed {
  subject: ChatSubject;
  /** True when the explanation came from Regenerate, so the chat starts over. */
  regenerated: boolean;
}

/** The code to explain: the context block for the model, and where it is. */
export interface ExplainRequest {
  /** From formatContext or formatSelection (src/lineContext.ts). */
  text: string;
  /** The file and lines, for the chat panel's header. */
  subject: ChatSubject;
  /** Where the code is in the new file (PR 6.3). Left out when it is only removed lines. */
  code?: CodeSpan;
  /** What is known without the model, for the popup's facts line (PR 9.12). */
  facts?: CodeFacts;
}

export interface ExplainTiming {
  elapsedMs: number;
  status: 'done' | 'failed' | 'stopped';
  /** The model that answered, when it answered. */
  model?: string;
  /** When the first piece of the reply arrived, if any did. */
  firstChunkMs?: number;
  /** True when the answer came from the cache. */
  cached?: boolean;
  /** Where the server's time went, for an answer from the model (PR 8.1). */
  timings?: LlmTimings;
  /** Every task of the click, timed from the click (PR 9.1). */
  tasks?: TraceTask[];
  /** The whole reply as it streamed in, to estimate the thinking share. */
  reply?: string;
  /** Thinking the model returned in its own field (PR 9.5), for the same. */
  thinking?: string;
  /** What the debug log needs from the click (PR 9.3). */
  debug?: Omit<DebugLogPayload, 'tasks'>;
}

// Elements GitHub (or the browser) already gives a meaning to a click on.
const INTERACTIVE = [
  'a[href]',
  'button',
  'summary',
  'input',
  'textarea',
  'select',
  'label',
  'details-menu',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="link"]',
].join(', ');

/** True when the click landed on (or inside) one of GitHub's own controls. */
export function isInteractive(target: EventTarget | null): boolean {
  const element =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return element?.closest(INTERACTIVE) != null;
}

/** True when the user just selected text (for example by dragging across code). */
function hasTextSelection(doc: Document): boolean {
  const selection = doc.getSelection();
  return selection != null && !selection.isCollapsed && selection.toString().trim() !== '';
}

/** The message and fix to show when the service worker cannot answer at all. */
export function describeRequestError(error: unknown): { message: string; fix: string } {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError') {
    return {
      message: 'The model took too long to answer.',
      fix: 'Try again, or pick a smaller model on the PR Explainer settings page.',
    };
  }
  // sendRequest's message already starts with "Could not reach the service
  // worker: …" when Chrome itself failed (for example "Extension context
  // invalidated" after the extension was reloaded).
  const detail = error instanceof Error ? error.message : String(error);
  return {
    message: `PR Explainer did not get an answer. ${detail}`,
    fix: 'Reload this page. If that does not help, reload the extension on `chrome://extensions`.',
  };
}

/** How far (in pixels) the pointer may move while pressed before it counts as a drag (PR 11.1). */
export const PRESS_SLOP_PX = 4;

/**
 * How long a released press waits for its click before it is cancelled
 * (PR 11.1). The click normally follows the release at once; this only
 * covers a click that never comes, such as one GitHub's own code swallowed.
 */
export const PRESS_CLICK_WAIT_MS = 1000;

/**
 * The click listener, plus the pointer listeners that start a line's request
 * as the mouse button goes down (PR 11.1). Add them all with
 * listenForClicks.
 */
export interface ClickHandler {
  (event: MouseEvent): void;
  onPointerDown(event: PointerEvent): void;
  onPointerMove(event: PointerEvent): void;
  onPointerUp(event: PointerEvent): void;
  /** For `pointercancel`, a page change, or turning off: stops a pressed line's request. */
  cancelPress(): void;
}

/** True for the main button with no modifier keys: the only press or click explained. */
function isPlainPress(event: MouseEvent): boolean {
  return event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
}

/** A line whose request started when the mouse went down, waiting for its click (PR 11.1). */
interface Pressed {
  row: Element;
  request: ExplainRequest;
  trace: ClickTrace;
  /** Ends the trace's Pressed task, at the click. */
  endPressed: () => void;
  stream: ExplainStream;
  sink: {
    /** The reply so far, kept until the click's popup takes over the stream. */
    chunks: string[];
    /** The popup's chunk callback, once the click has opened it. */
    onChunk?: (text: string) => void;
  };
  x: number;
  y: number;
  /** Cancels the press if the click never comes after the release. */
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Explains a clicked line. With a press handler (PR 11.1), the request
 * starts on `pointerdown` on a line's code: the same request a click sends
 * (lineRequest), so it uses the cache and joins a running prefetch. The
 * popup still opens on `click`, which takes over the request already
 * running instead of sending another. A press that moves more than
 * PRESS_SLOP_PX before release (the start of a drag selection, PR 4.4), or
 * is released somewhere else, is cancelled and shows nothing. Nothing is
 * sent on a press while the chat is open, as the click goes to the chat.
 */
export function createClickHandler(deps: ClickHandlerDeps): ClickHandler {
  let pressed: Pressed | undefined;

  const cancelPress = () => {
    const press = pressed;
    if (!press) return;
    pressed = undefined;
    clearTimeout(press.timer);
    press.stream.stop();
  };

  const onPointerDown = (event: PointerEvent) => {
    cancelPress();
    if (deps.isEnabled?.() === false || deps.isChatOpen?.() === true) return;
    if (!isPlainPress(event) || event.isPrimary === false) return;
    const target = event.target;
    if (isInteractive(target)) return;
    // The trace starts at the press, so Details shows how early it started.
    const trace = createClickTrace();
    const endPressed = trace.start('press', 'Pressed');
    const found = trace.start('find-code', 'Find the code');
    const line = lineRequest(target);
    if (!line) return;
    found();
    const { row, request } = line;
    const sink: Pressed['sink'] = { chunks: [] };
    const stream = deps.explain(
      request.text,
      (chunk) => (sink.onChunk ? sink.onChunk(chunk) : sink.chunks.push(chunk)),
      { fresh: false, ...(request.code && { code: request.code }), trace },
    );
    // Seen to by the popup once the click opens it; until then a failure
    // must not be reported as unhandled.
    stream.result.catch(() => {});
    const press: Pressed = {
      row,
      request,
      trace,
      endPressed,
      stream,
      sink,
      x: event.clientX,
      y: event.clientY,
    };
    pressed = press;
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!pressed || pressed.timer !== undefined) return;
    const dx = event.clientX - pressed.x;
    const dy = event.clientY - pressed.y;
    // A drag selects lines (src/selection.ts) or text, not this one line.
    if (dx * dx + dy * dy > PRESS_SLOP_PX * PRESS_SLOP_PX) cancelPress();
  };

  const onPointerUp = (event: PointerEvent) => {
    const press = pressed;
    if (!press) return;
    if (locateRow(event.target) !== press.row) {
      cancelPress();
      return;
    }
    press.timer = setTimeout(() => {
      if (pressed === press) cancelPress();
    }, PRESS_CLICK_WAIT_MS);
  };

  /** The pressed line's request, if `row` is its line; the press is used up either way. */
  const takePress = (row: Element | null): Pressed | undefined => {
    const press = pressed;
    if (!press) return undefined;
    pressed = undefined;
    clearTimeout(press.timer);
    if (press.row === row) return press;
    press.stream.stop();
    return undefined;
  };

  const onClick = (event: MouseEvent) => {
    if (deps.isEnabled?.() === false || !isPlainPress(event)) {
      cancelPress();
      return;
    }
    const target = event.target;
    const doc = target instanceof Node ? (target.ownerDocument ?? document) : document;
    if (isInteractive(target) || hasTextSelection(doc)) {
      cancelPress();
      return;
    }
    const press = takePress(locateRow(target));
    if (!press) {
      explainLineAt(deps, target);
      return;
    }
    press.endPressed();
    press.trace.mark('click', 'Clicked');
    let adopted = false;
    // The popup's first request is the one the press started; Regenerate
    // asks again as usual.
    const explain: ClickHandlerDeps['explain'] = (context, onChunk, options) => {
      if (adopted || options.fresh || context !== press.request.text) {
        return deps.explain(context, onChunk, options);
      }
      adopted = true;
      // After the popup has the stream, so it takes the reply so far.
      queueMicrotask(() => {
        for (const chunk of press.sink.chunks.splice(0)) onChunk(chunk);
        press.sink.onChunk = onChunk;
      });
      return press.stream;
    };
    explainCode({ ...deps, explain }, press.request, press.row, undefined, press.trace);
    // The chat took the code after all (it opened during the press).
    if (!adopted) press.stream.stop();
  };

  return Object.assign(onClick, { onPointerDown, onPointerMove, onPointerUp, cancelPress });
}

/**
 * Adds a click handler's listeners to `doc`: the click, and the pointer
 * events that start a line's request on the press (PR 11.1). Returns a
 * function that removes them and cancels a pending press.
 */
export function listenForClicks(handler: ClickHandler, doc: Document = document): () => void {
  const { onPointerDown, onPointerMove, onPointerUp, cancelPress } = handler;
  doc.addEventListener('click', handler);
  doc.addEventListener('pointerdown', onPointerDown);
  doc.addEventListener('pointermove', onPointerMove, { passive: true });
  doc.addEventListener('pointerup', onPointerUp);
  doc.addEventListener('pointercancel', cancelPress);
  return () => {
    doc.removeEventListener('click', handler);
    doc.removeEventListener('pointerdown', onPointerDown);
    doc.removeEventListener('pointermove', onPointerMove);
    doc.removeEventListener('pointerup', onPointerUp);
    doc.removeEventListener('pointercancel', cancelPress);
    cancelPress();
  };
}

/**
 * Explains the diff line `target` is on (a click's target, or the focused
 * line for Alt+E, PR 7.3): in the open chat if there is one, otherwise in a
 * popup next to the line. Returns false when `target` is not on a code line.
 */
export function explainLineAt(
  deps: Pick<
    ClickHandlerDeps,
    'explain' | 'openPopup' | 'onContext' | 'onTiming' | 'openChat' | 'addToChat'
  >,
  target: EventTarget | null,
): boolean {
  // The click's trace starts here, before the code is found (PR 9.1).
  const trace = createClickTrace();
  const found = trace.start('find-code', 'Find the code');
  const line = lineRequest(target);
  if (!line) return false;
  found();
  explainCode(deps, line.request, line.row, undefined, trace);
  return true;
}

/**
 * The row of the diff line `target` is on and the request that explains it,
 * or null when `target` is not on a code line. A click and a hover prefetch
 * (src/prefetch.ts) both build their request here, so they send the same text
 * and a click can join the prefetch.
 */
export function lineRequest(
  target: EventTarget | null,
): { row: Element; request: ExplainRequest } | null {
  const row = locateRow(target);
  const hunk = row && locateHunk(target);
  if (!row || !hunk) return null;
  return { row, request: requestFromHunk(hunk) };
}

/**
 * The request that explains the line at `hunk.index`. A click builds it from
 * the hunk drawn on the page (lineRequest), and the PR's diff from GitHub's
 * API builds it from the same hunk read from the patch (src/patchRequests.ts,
 * PR 10.4), so both send the same text and get the same cache key.
 */
export function requestFromHunk(hunk: DiffHunk): ExplainRequest {
  const context = contextFromHunk(hunk, DEFAULT_CONTEXT);
  const { filePath, lineNumber, side, text } = context.line;
  const code =
    side === 'removed' ? undefined : { filePath, startLine: lineNumber, endLine: lineNumber, text };
  return {
    text: formatContext(context),
    subject: { filePath, startLine: lineNumber },
    ...(code && { code }),
    facts: factsFromHunk(hunk),
  };
}

/**
 * Brings `request` into the open chat if there is one (PR 5.4), and otherwise
 * explains it in a popup (explainInPopup). `onClose` runs when the popup
 * closes, or right away when the chat took the code.
 */
export function explainCode(
  deps: Pick<
    ClickHandlerDeps,
    'explain' | 'openPopup' | 'onContext' | 'onTiming' | 'openChat' | 'addToChat'
  >,
  request: ExplainRequest,
  anchor: PopupAnchor,
  onClose?: () => void,
  trace?: ClickTrace,
): void {
  if (deps.addToChat?.(request)) {
    deps.onContext?.(request.text);
    onClose?.();
    return;
  }
  explainInPopup(deps, request, anchor, onClose, trace);
}

/**
 * Sends `request.text` to the model and streams the answer into a popup next
 * to `anchor`, with Stop, Regenerate and Ask a question wired up. Used for
 * one clicked line and for a selected block (src/selection.ts). `onClose`
 * runs when the popup closes. `trace` is the click's trace so far (PR 9.1);
 * a new one starts when it is left out, and on Regenerate.
 */
export function explainInPopup(
  deps: Pick<ClickHandlerDeps, 'explain' | 'openPopup' | 'onContext' | 'onTiming' | 'openChat'>,
  { text, subject, code, facts }: ExplainRequest,
  anchor: PopupAnchor,
  onClose?: () => void,
  firstTrace?: ClickTrace,
): void {
  deps.onContext?.(text);
  // Opening a popup closes the previous one, which stops its request. A
  // stopped or closed popup also ignores updates, so a late answer changes
  // nothing.
  let firstChunkMs: number | undefined;
  let trace = firstTrace ?? createClickTrace();
  const report = (timing: Omit<ExplainTiming, 'elapsedMs' | 'firstChunkMs'>) =>
    deps.onTiming?.({ elapsedMs: popup.elapsedMs, ...timing, firstChunkMs });
  // The explanation the popup shows, for Ask a question.
  let explanation: Explanation | undefined;
  let regenerated = false;
  const { openChat } = deps;
  // The popup's callbacks only run after a user action, by which time
  // `stream` (below) is set.
  const popup = deps.openPopup(anchor, {
    // Shown at once, before anything is sent (PR 9.12).
    ...(facts && { facts }),
    onStop: () => {
      stream.stop();
      report({ status: 'stopped', ...endedEarly(trace, 'stopped') });
    },
    onClose: () => {
      stream.stop();
      onClose?.();
    },
    // The popup is back in the loading state when this runs.
    onRegenerate: () => {
      stream.stop();
      trace = createClickTrace();
      stream = ask(true);
    },
    // The popup has closed when this runs, and shows the button only once an
    // explanation is shown.
    ...(openChat && {
      onAsk: () => {
        if (explanation) openChat({ context: text, explanation, subject, regenerated });
      },
    }),
  });
  const waiting = () => popup.state === 'loading' || popup.state === 'streaming';
  // What the debug log gets for a click (PR 9.3), however it ends.
  const debugOf = (t: ClickTrace): ExplainTiming['debug'] => ({
    group: t.id,
    at: t.startedAt,
    where: whereOf(subject),
    roundTrips: t.roundTrips(),
  });
  // A click stopped, or whose request failed, before an answer came: its
  // unfinished tasks are marked so and the trace so far is still reported.
  const endedEarly = (t: ClickTrace, status: 'stopped' | 'failed') => {
    t.end(status === 'stopped' ? 'stopped' : 'failed');
    return { tasks: t.tasks(), debug: debugOf(t) };
  };

  // Each request checks it is still the newest, so a request replaced by
  // Regenerate cannot write into the popup.
  let latest: ExplainStream | undefined;
  const ask = (fresh: boolean): ExplainStream => {
    firstChunkMs = undefined;
    explanation = undefined;
    regenerated = fresh;
    let reply = '';
    const requestTrace = trace;
    const current = () => latest === request && waiting();
    const request: ExplainStream = deps.explain(
      text,
      (chunk) => {
        if (!current()) return;
        firstChunkMs ??= popup.elapsedMs;
        reply += chunk;
        popup.showPartial(reply);
      },
      { fresh, ...(code && { code }), trace: requestTrace },
    );
    latest = request;
    request.result.then(
      (result) => {
        if (!current()) return;
        requestTrace.addWorker(result.trace);
        if (result.status === 'done') {
          explanation = result.explanation;
          popup.showExplanation(result.explanation, result.model, result.cached);
        } else popup.showError(result.message, result.fix);
        requestTrace.finish();
        const tasks = requestTrace.tasks();
        // A failed answer shows its trace too, so a slow failure can be read.
        popup.showTrace({
          tasks,
          roundTrips: requestTrace.roundTrips(),
          reply,
          ...(result.status === 'done' && result.timings && { timings: result.timings }),
          ...(result.status === 'done' && result.thinking && { thinking: result.thinking }),
        });
        if (result.status === 'done' && result.prompt) popup.showPrompt(result.prompt);
        report({
          status: result.status,
          model: result.status === 'done' ? result.model : undefined,
          ...(result.status === 'done' && result.cached ? { cached: true } : {}),
          ...(result.status === 'done' && result.timings ? { timings: result.timings } : {}),
          tasks,
          ...(reply && { reply }),
          ...(result.status === 'done' && result.thinking && { thinking: result.thinking }),
          debug: debugOf(requestTrace),
        });
      },
      (error: unknown) => {
        if (!current()) return;
        const { message, fix } = describeRequestError(error);
        popup.showError(message, fix);
        report({ status: 'failed', ...endedEarly(requestTrace, 'failed') });
      },
    );
    return request;
  };
  let stream = ask(false);
}

/** "src/app.ts:12", or "src/app.ts:12-18" for a block, for the debug log. */
export function whereOf({ filePath, startLine, endLine }: ChatSubject): string {
  return `${filePath}:${startLine}${endLine !== undefined && endLine !== startLine ? `-${endLine}` : ''}`;
}
