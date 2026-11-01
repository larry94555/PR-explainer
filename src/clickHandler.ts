// Click-to-explain: turns a click on a diff line into an explanation popup.
//
// On each click on a code line it opens the popup in the loading state next
// to the line, streams the explanation of the line's context from the service
// worker into it as the model writes, and shows the three sections at the
// end. The popup's Stop button, or closing the popup, stops the request. Clicks on GitHub's own controls
// (the comment "+" button, links, menus, form fields), clicks that finish a
// text selection, and modified clicks (Shift, Ctrl, Alt, Cmd) are left alone
// so GitHub keeps working as before. Nothing happens at all while the toolbar
// button has click-to-explain turned off.
//
// The parts that talk to Chrome and draw the popup are passed in, so the
// tests can use fakes.

import { locateRow } from './diffDom';
import { extractContext, formatContext } from './lineContext';
import type { ExplainStream } from './messaging/client';
import type { Popup, PopupOptions } from './popup/popup';

export interface ClickHandlerDeps {
  /**
   * Sends the formatted context to the service worker, calling `onChunk`
   * with each piece of the reply as it arrives.
   */
  explain(context: string, onChunk: (text: string) => void): ExplainStream;
  /**
   * False while the user has turned click-to-explain off with the toolbar
   * button (PR 3.6). Clicks are then left alone. Leaving it out means on.
   */
  isEnabled?(): boolean;
  /** Opens a popup next to the clicked row, closing any other popup. */
  openPopup(anchor: Element, options: Required<Pick<PopupOptions, 'onStop' | 'onClose'>>): Popup;
  /** Called with each context block sent to the model (dev logging). */
  onContext?(context: string): void;
  /**
   * Called when an answer (or error) is shown, or Stop is pressed, with how
   * long it took from the click, so latency can be logged and compared
   * across models.
   */
  onTiming?(timing: ExplainTiming): void;
}

export interface ExplainTiming {
  elapsedMs: number;
  status: 'done' | 'failed' | 'stopped';
  /** The model that answered, when it answered. */
  model?: string;
  /** When the first piece of the reply arrived, if any did. */
  firstChunkMs?: number;
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

    const row = locateRow(target);
    const context = row && extractContext(target);
    if (!row || !context) return;

    const text = formatContext(context);
    deps.onContext?.(text);
    // Opening a popup closes the previous one, which stops its request. A
    // stopped or closed popup also ignores updates, so a late answer changes
    // nothing.
    let firstChunkMs: number | undefined;
    const report = (timing: Omit<ExplainTiming, 'elapsedMs' | 'firstChunkMs'>) =>
      deps.onTiming?.({ elapsedMs: popup.elapsedMs, ...timing, firstChunkMs });
    // The popup's callbacks only run after a user action, by which time
    // `stream` (below) is set.
    const popup = deps.openPopup(row, {
      onStop: () => {
        stream.stop();
        report({ status: 'stopped' });
      },
      onClose: () => stream.stop(),
    });
    const waiting = () => popup.state === 'loading' || popup.state === 'streaming';

    let reply = '';
    const stream: ExplainStream = deps.explain(text, (chunk) => {
      if (!waiting()) return;
      firstChunkMs ??= popup.elapsedMs;
      reply += chunk;
      popup.showPartial(reply);
    });
    stream.result.then(
      (result) => {
        if (!waiting()) return;
        if (result.status === 'done') popup.showExplanation(result.explanation, result.model);
        else popup.showError(result.message, result.fix);
        report({
          status: result.status,
          model: result.status === 'done' ? result.model : undefined,
        });
      },
      (error: unknown) => {
        if (!waiting()) return;
        const { message, fix } = describeRequestError(error);
        popup.showError(message, fix);
        report({ status: 'failed' });
      },
    );
  };
}
