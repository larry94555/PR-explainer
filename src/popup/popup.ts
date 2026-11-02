// The explanation popup shown next to a clicked diff line. It lives in a
// Shadow DOM root so GitHub's CSS cannot restyle it and its CSS cannot leak
// into GitHub (same approach as the badge in src/badge.ts).
//
// The popup's states: loading (spinner), streaming (the reply so far, as
// markdown, while the model writes it), done (the three sections), failed (a
// message and a fix from describeLlmError), and stopped (the Stop button was
// pressed; the text so far stays). It closes with the close button, the Esc
// key, or a click anywhere outside it. Once stopped or closed it ignores
// further updates, so a late answer changes nothing. Once the model has
// finished, failed, or been stopped, a Regenerate button asks it again,
// skipping the explanation cache; the popup goes back to loading. Once an
// explanation is shown, an Ask a question button (when the caller passes
// onAsk) closes the popup and opens the chat about the same code (PR 5.3).
//
// The header shows how long the request has taken: a live timer while
// loading and streaming, then "Answered in …", "Failed after …", or
// "Stopped after …", so the local model's
// latency is always visible. An answer from the cache says "From cache" and
// how long the model took when it first wrote it. Only one popup
// is open at a time: opening a new one closes the old one.
//
// The content script opens it from its click handler (src/clickHandler.ts),
// and the demo page (`npm run demo:popup`) shows it with fake data.

import type { Explanation, SectionKey } from '../explain/parseExplanation';
import { appendInline, renderMarkdown } from './renderMarkdown';
import { POPUP_STYLE } from './popupStyle';

export const POPUP_ID = 'pr-explainer-popup';

export const SECTION_TITLES: Record<SectionKey, string> = {
  what: 'What it does',
  why: "Why it's needed",
  concerns: 'Concerns',
};

/** Where the popup should point: an element (its box is used) or a box. */
export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
}

/**
 * Anything whose box the popup can point at: a row, or a selected block of
 * rows (src/selection.ts). Its box is read again each time the popup moves.
 */
export interface PopupAnchor {
  getBoundingClientRect(): AnchorRect;
}

export interface PopupOptions {
  /** Called once when the popup closes, however it was closed. */
  onClose?: () => void;
  /** Called when the Stop button is pressed, to cancel the request. */
  onStop?: () => void;
  /**
   * Called when the Regenerate button is pressed, after the popup has gone
   * back to loading, to ask the model again without the cache.
   */
  onRegenerate?: () => void;
  /**
   * Called when the Ask a question button is pressed, after the popup has
   * closed. The button is shown only once an explanation is shown, and only
   * when this is passed.
   */
  onAsk?: () => void;
  /** Clock in milliseconds, for the elapsed time. Tests pass a fake one. */
  now?: () => number;
}

/** How often the elapsed time updates while loading. */
export const TICK_MS = 100;

/** "0.4 s" and "12.3 s" under a minute, then "1 min 05 s". */
export function formatElapsed(ms: number): string {
  const tenths = Math.floor(Math.max(0, ms) / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} s`;
  const seconds = Math.floor(tenths / 10);
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

export type PopupState = 'loading' | 'streaming' | 'done' | 'failed' | 'stopped' | 'closed';

/** Shown in place of the reply when Stop is pressed before any text arrived. */
export const STOPPED_EMPTY = 'Stopped before the model wrote anything.';

export interface Popup {
  readonly host: HTMLElement;
  readonly state: PopupState;
  /**
   * Time since the popup opened (or since showLoading was last called),
   * frozen when the answer or error arrives.
   */
  readonly elapsedMs: number;
  /** Shows the spinner and restarts the timer. */
  showLoading(model?: string): void;
  /** Shows the reply so far (markdown) while the model is still writing. */
  showPartial(markdown: string): void;
  /** `cached` is set when the answer came from the cache. */
  showExplanation(explanation: Explanation, model?: string, cached?: { elapsedMs: number }): void;
  showError(message: string, fix: string): void;
  close(): void;
}

/** Space between the line and the popup, and between the popup and the window edge. */
export const GAP = 8;

export interface Viewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

/**
 * Where to put the popup's top-left corner, in page coordinates (so it
 * scrolls with the page). Below the line when it fits, otherwise above it
 * when that fits. When neither fits, it is moved up as far as needed to keep
 * its bottom inside the window (but never above the window's top), so the
 * whole panel can be seen without scrolling the page. Kept inside the window
 * horizontally too.
 */
export function computePosition(
  anchor: AnchorRect,
  size: { width: number; height: number },
  viewport: Viewport,
): { top: number; left: number } {
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - size.height;
  let top: number;
  if (below + size.height <= viewport.height) top = below;
  else if (above >= 0) top = above;
  else top = Math.max(GAP, Math.min(below, viewport.height - size.height - GAP));
  const maxLeft = viewport.width - size.width - GAP;
  const left = Math.max(GAP, Math.min(anchor.left, maxLeft));
  return { top: top + viewport.scrollY, left: left + viewport.scrollX };
}

let current: Popup | null = null;

/** The open popup, if any. */
export function currentPopup(): Popup | null {
  return current;
}

/** Opens a popup in the loading state next to `anchor`, closing any other popup. */
export function openPopup(
  anchor: PopupAnchor | AnchorRect,
  options: PopupOptions = {},
  doc: Document = document,
): Popup {
  current?.close();
  const win = doc.defaultView!;

  const host = doc.createElement('div');
  host.id = POPUP_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = POPUP_STYLE;

  const panel = doc.createElement('div');
  panel.className = 'popup';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'PR Explainer');

  const header = doc.createElement('div');
  header.className = 'header';
  const title = doc.createElement('span');
  title.className = 'title';
  title.textContent = 'PR Explainer';
  const modelLabel = doc.createElement('span');
  modelLabel.className = 'model';
  const elapsedLabel = doc.createElement('span');
  elapsedLabel.className = 'elapsed';
  const closeButton = doc.createElement('button');
  closeButton.className = 'close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.textContent = '×';
  // Shown only while loading or streaming (see popupStyle.ts).
  const stopButton = doc.createElement('button');
  stopButton.className = 'stop';
  stopButton.type = 'button';
  stopButton.textContent = 'Stop';
  stopButton.title = 'Stop the model';
  // Shown only once the model has finished, failed, or been stopped.
  const regenerateButton = doc.createElement('button');
  regenerateButton.className = 'regenerate';
  regenerateButton.type = 'button';
  regenerateButton.textContent = 'Regenerate';
  regenerateButton.title = 'Ask the model again, without the cache';
  header.append(title, modelLabel, elapsedLabel, stopButton, regenerateButton, closeButton);

  const body = doc.createElement('div');
  body.className = 'body';
  body.setAttribute('aria-live', 'polite');
  // Shown only once the explanation is shown (see popupStyle.ts).
  const footer = doc.createElement('div');
  footer.className = 'footer';
  if (options.onAsk) {
    const askButton = doc.createElement('button');
    askButton.className = 'ask';
    askButton.type = 'button';
    askButton.textContent = 'Ask a question';
    askButton.title = 'Chat with the model about this code';
    askButton.addEventListener('click', () => {
      if (state !== 'done') return;
      popup.close();
      options.onAsk?.();
    });
    footer.append(askButton);
  }
  panel.append(header, body, footer);
  shadow.append(style, panel);
  doc.body.append(host);

  let state: PopupState = 'loading';

  const now = options.now ?? (() => performance.now());
  let startedAt = now();
  let finishedAt: number | null = null;
  const elapsed = () => (finishedAt ?? now()) - startedAt;
  const showElapsed = (prefix = '') => {
    elapsedLabel.textContent = prefix + formatElapsed(elapsed());
  };
  let ticker: ReturnType<typeof setInterval> | undefined;
  const startTicking = () => {
    startedAt = now();
    finishedAt = null;
    showElapsed();
    ticker ??= setInterval(() => showElapsed(), TICK_MS);
  };
  const stopTicking = (prefix: string) => {
    clearInterval(ticker);
    ticker = undefined;
    finishedAt ??= now();
    showElapsed(prefix);
  };
  // A cached answer arrives at once, so the time worth showing is how long
  // the model took the first time.
  const showCached = (ms: number) => {
    clearInterval(ticker);
    ticker = undefined;
    finishedAt ??= now();
    elapsedLabel.textContent = `From cache · took ${formatElapsed(ms)}`;
  };

  const place = () => {
    const rect = 'getBoundingClientRect' in anchor ? anchor.getBoundingClientRect() : anchor;
    const box = panel.getBoundingClientRect();
    const { top, left } = computePosition(
      rect,
      { width: box.width, height: box.height },
      {
        width: win.innerWidth,
        height: win.innerHeight,
        scrollX: win.scrollX,
        scrollY: win.scrollY,
      },
    );
    host.style.setProperty('position', 'absolute');
    host.style.setProperty('top', `${top}px`);
    host.style.setProperty('left', `${left}px`);
    host.style.setProperty('z-index', '2147483647');
  };

  const setBody = (next: PopupState, ...children: Node[]) => {
    state = next;
    panel.dataset.state = next;
    body.replaceChildren(...children);
    place();
  };

  const setModel = (model?: string) => {
    modelLabel.textContent = model ?? '';
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') popup.close();
  };
  // mousedown, not click: the click that opens a popup (src/clickHandler.ts) has already
  // finished its mousedown, so it cannot close the popup it just opened.
  const onMouseDown = (event: MouseEvent) => {
    if (!event.composedPath().includes(host)) popup.close();
  };
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('mousedown', onMouseDown, true);
  closeButton.addEventListener('click', () => popup.close());
  stopButton.addEventListener('click', () => {
    if (state !== 'loading' && state !== 'streaming') return;
    stopTicking('Stopped after ');
    if (state === 'loading') {
      const note = doc.createElement('p');
      note.className = 'stopped-note';
      note.textContent = STOPPED_EMPTY;
      setBody('stopped', note);
    } else {
      state = 'stopped';
      panel.dataset.state = 'stopped';
    }
    options.onStop?.();
  });
  regenerateButton.addEventListener('click', () => {
    if (state !== 'done' && state !== 'failed' && state !== 'stopped') return;
    popup.showLoading(modelLabel.textContent || undefined);
    options.onRegenerate?.();
  });

  // Keeps the newest text in view while it streams in, unless the user has
  // scrolled up to read something.
  const nearBottom = () => panel.scrollHeight - panel.scrollTop - panel.clientHeight < 24;

  const popup: Popup = {
    host,
    get state() {
      return state;
    },
    get elapsedMs() {
      return elapsed();
    },
    showLoading(model) {
      if (state === 'closed') return;
      setModel(model);
      startTicking();
      const loading = doc.createElement('div');
      loading.className = 'loading';
      const spinner = doc.createElement('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');
      const text = doc.createElement('span');
      text.textContent = `Asking ${model || 'the model'}…`;
      loading.append(spinner, text);
      setBody('loading', loading);
    },
    showPartial(markdown) {
      if (state !== 'loading' && state !== 'streaming') return;
      const follow = state === 'loading' || nearBottom();
      const partial = doc.createElement('div');
      partial.className = 'partial';
      partial.append(renderMarkdown(doc, markdown));
      setBody('streaming', partial);
      if (follow) panel.scrollTop = panel.scrollHeight;
    },
    showExplanation(explanation, model, cached) {
      if (state === 'closed' || state === 'stopped') return;
      setModel(model);
      if (cached) showCached(cached.elapsedMs);
      else stopTicking('Answered in ');
      const sections = (Object.keys(SECTION_TITLES) as SectionKey[]).map((key) => {
        const section = doc.createElement('section');
        section.dataset.section = key;
        const heading = doc.createElement('h3');
        heading.textContent = SECTION_TITLES[key];
        const content = doc.createElement('div');
        content.className = 'content';
        content.append(renderMarkdown(doc, explanation[key]));
        section.append(heading, content);
        return section;
      });
      setBody('done', ...sections);
    },
    showError(message, fix) {
      if (state === 'closed' || state === 'stopped') return;
      stopTicking('Failed after ');
      const error = doc.createElement('div');
      error.className = 'error';
      error.setAttribute('role', 'alert');
      const messageEl = doc.createElement('p');
      messageEl.className = 'message';
      appendInline(messageEl, message);
      const fixEl = doc.createElement('p');
      fixEl.className = 'fix';
      appendInline(fixEl, fix);
      error.append(messageEl, fixEl);
      setBody('failed', error);
    },
    close() {
      if (state === 'closed') return;
      state = 'closed';
      clearInterval(ticker);
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('mousedown', onMouseDown, true);
      host.remove();
      if (current === popup) current = null;
      options.onClose?.();
    },
  };

  current = popup;
  popup.showLoading();
  return popup;
}
