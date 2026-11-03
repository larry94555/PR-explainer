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
// so GitHub keeps working as before. Drags and Shift-clicks across several
// lines are handled by src/selection.ts, which explains the block as a whole. Nothing happens at all while the toolbar
// button has click-to-explain turned off.
//
// The parts that talk to Chrome and draw the popup are passed in, so the
// tests can use fakes.

import type { ChatSubject } from './chat/chatPanel';
import type { ChatSeed } from './chat/chatSession';
import { locateRow } from './diffDom';
import { extractContext, formatContext } from './lineContext';
import type { Explanation } from './explain/parseExplanation';
import type { CodeSpan } from './fileContext';
import type { LlmTimings } from './llm/types';
import type { ExplainStream } from './messaging/client';
import type { Popup, PopupAnchor, PopupOptions } from './popup/popup';
import { createClickTrace, type ClickTrace } from './trace/clickTrace';
import type { TraceTask } from './trace/types';

export interface ClickHandlerDeps {
  /**
   * Sends the formatted context to the service worker, calling `onChunk`
   * with each piece of the reply as it arrives. `code` says where the code
   * is in the new file, so its enclosing block can be read from the full
   * file (PR 6.3); it is left out for removed lines. The page's tasks for
   * the request (reading the PR description, fetching the file, sending)
   * are recorded in `trace` (PR 9.1).
   */
  explain(
    context: string,
    onChunk: (text: string) => void,
    options: { fresh: boolean; code?: CodeSpan; trace?: ClickTrace },
  ): ExplainStream;
  /**
   * False while the user has turned click-to-explain off with the toolbar
   * button (PR 3.6). Clicks are then left alone. Leaving it out means on.
   */
  isEnabled?(): boolean;
  /** Opens a popup next to the clicked row, closing any other popup. */
  openPopup(
    anchor: PopupAnchor,
    options: Required<Pick<PopupOptions, 'onStop' | 'onClose' | 'onRegenerate'>> &
      Pick<PopupOptions, 'onAsk'>,
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

export function createClickHandler(deps: ClickHandlerDeps): (event: MouseEvent) => void {
  return (event) => {
    if (deps.isEnabled?.() === false) return;
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    const target = event.target;
    if (isInteractive(target)) return;
    const doc = target instanceof Node ? (target.ownerDocument ?? document) : document;
    if (hasTextSelection(doc)) return;
    explainLineAt(deps, target);
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
  const context = row && extractContext(target);
  if (!row || !context) return null;
  const { filePath, lineNumber, side, text } = context.line;
  const code =
    side === 'removed' ? undefined : { filePath, startLine: lineNumber, endLine: lineNumber, text };
  return {
    row,
    request: {
      text: formatContext(context),
      subject: { filePath, startLine: lineNumber },
      ...(code && { code }),
    },
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
  { text, subject, code }: ExplainRequest,
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
    onStop: () => {
      stream.stop();
      report({ status: 'stopped' });
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
        if (result.status === 'done') {
          popup.showTrace({
            tasks,
            reply,
            ...(result.timings && { timings: result.timings }),
          });
          if (result.prompt) popup.showPrompt(result.prompt);
        }
        report({
          status: result.status,
          model: result.status === 'done' ? result.model : undefined,
          ...(result.status === 'done' && result.cached ? { cached: true } : {}),
          ...(result.status === 'done' && result.timings ? { timings: result.timings } : {}),
          tasks,
          ...(reply && { reply }),
        });
      },
      (error: unknown) => {
        if (!current()) return;
        const { message, fix } = describeRequestError(error);
        popup.showError(message, fix);
        report({ status: 'failed' });
      },
    );
    return request;
  };
  let stream = ask(false);
}
