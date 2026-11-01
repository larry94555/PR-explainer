// The explanation popup shown next to a clicked diff line. It lives in a
// Shadow DOM root so GitHub's CSS cannot restyle it and its CSS cannot leak
// into GitHub (same approach as the badge in src/badge.ts).
//
// The popup has three states: loading (spinner), done (the three sections),
// and failed (a message and a fix from describeLlmError). It closes with the
// close button, the Esc key, or a click anywhere outside it. Only one popup
// is open at a time: opening a new one closes the old one.
//
// PR 3.5 opens it from the content script's click handler. Until then it is
// only used by the demo page (`npm run demo:popup`).

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

export interface PopupOptions {
  /** Called once when the popup closes, however it was closed. */
  onClose?: () => void;
}

export type PopupState = 'loading' | 'done' | 'failed' | 'closed';

export interface Popup {
  readonly host: HTMLElement;
  readonly state: PopupState;
  showLoading(model?: string): void;
  showExplanation(explanation: Explanation, model?: string): void;
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
 * when that fits, otherwise below. Kept inside the window horizontally.
 */
export function computePosition(
  anchor: AnchorRect,
  size: { width: number; height: number },
  viewport: Viewport,
): { top: number; left: number } {
  const fitsBelow = anchor.bottom + GAP + size.height <= viewport.height;
  const fitsAbove = anchor.top - GAP - size.height >= 0;
  const top = !fitsBelow && fitsAbove ? anchor.top - GAP - size.height : anchor.bottom + GAP;
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
  anchor: Element | AnchorRect,
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
  const closeButton = doc.createElement('button');
  closeButton.className = 'close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.textContent = '×';
  header.append(title, modelLabel, closeButton);

  const body = doc.createElement('div');
  body.className = 'body';
  body.setAttribute('aria-live', 'polite');
  panel.append(header, body);
  shadow.append(style, panel);
  doc.body.append(host);

  let state: PopupState = 'loading';

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
  // mousedown, not click: the click that opens a popup (PR 3.5) has already
  // finished its mousedown, so it cannot close the popup it just opened.
  const onMouseDown = (event: MouseEvent) => {
    if (!event.composedPath().includes(host)) popup.close();
  };
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('mousedown', onMouseDown, true);
  closeButton.addEventListener('click', () => popup.close());

  const popup: Popup = {
    host,
    get state() {
      return state;
    },
    showLoading(model) {
      if (state === 'closed') return;
      setModel(model);
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
    showExplanation(explanation, model) {
      if (state === 'closed') return;
      setModel(model);
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
      if (state === 'closed') return;
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
