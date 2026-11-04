// The explanation popup shown next to a clicked diff line. It lives in a
// Shadow DOM root so GitHub's CSS cannot restyle it and its CSS cannot leak
// into GitHub (same approach as the badge in src/badge.ts).
//
// The popup's states: loading (a spinner and the three section headings with
// placeholder lines), streaming (the model is writing), done (the three
// sections), failed (a message and a fix from describeLlmError), and stopped
// (the Stop button was pressed; the text so far is shown).
//
// By default (PR 9.6) the reply is not shown while the model writes it: the
// placeholders stay, untouched, until the whole answer is shown at once, so
// the sections do not jump around as they fill in and screen readers hear
// "Explaining…" once instead of every word. Each section still appears as
// soon as it is finished (PR 9.13): once the model starts the next section's
// heading, that section replaces its placeholder in one update, so What it
// does shows first, then Why it's needed, then Concerns, each whole and each
// announced once. The timer runs until the whole answer is in. A cached
// answer shows all three at once. With the Show answers as they are
// written setting on (streamAnswers), the reply so far is shown as markdown
// while it streams in, as before. It closes with the close button, the Esc
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
// It follows GitHub's light or dark mode, and changes with it while open
// (src/theme.ts). Opening it moves keyboard focus into it, so Tab reaches its
// buttons and screen readers announce it; closing it while focus is inside
// gives focus back to what had it before, such as the diff line explained
// with Alt+E (PR 7.3). While the model is working the panel is marked
// aria-busy.
//
// Details also counts the click's round trips to GitHub and Ollama (PR 9.2)
// and lists each one; opening one shows where it went, when, its size and
// status, and for the explanation the messages sent and the whole reply.
// With the Show prompt setting on (PR 6.2), Details and the explanation's
// round trip open by themselves, with the prompt's estimated size against
// the budget and what was trimmed to fit. A cached answer sends nothing, so
// its prompt gets its own row.
//
// Once an answer is shown, a Details button next to the time opens a small
// waterfall of where the time went (PR 9.1, replacing PR 8.1's table): one
// row per task of the click, with a bar showing when it started and how long
// it took, its time and its share of the total. Tasks that ran at the same
// time have bars side by side, and a line on the bars marks the first word.
// The model's time is split into Load, Read prompt, Think and Write answer
// (src/popup/latencyBreakdown.ts). A cached answer shows only its own short
// trace.
//
// With the Debug window setting on (PR 9.4), the header also has a Debug
// button that opens the debug window: every round trip, live.
//
// Under the header, a facts line (PR 9.12) says what is known about the code
// without the model: the file and line, the function from the hunk header,
// and what kind of change it is (src/codeFacts.ts). It is there from the
// moment the popup opens and stays above the answer, for a cached answer too.
// It is outside the live region, so screen readers read it once, as the
// popup's description, not again with each update.
//
// The content script opens it from its click handler (src/clickHandler.ts),
// and the demo page (`npm run demo:popup`) shows it with fake data.

import type { CodeFacts } from '../codeFacts';
import type { PromptReport } from '../explain/fitPrompt';
import { sectionProgress } from './sectionProgress';
import type { Explanation, SectionKey } from '../explain/parseExplanation';
import type { LlmTimings } from '../llm/types';
import type { RoundTrip, TraceTask } from '../trace/types';
import { buildWaterfall, formatDuration, rowDescription, rowValue } from './latencyBreakdown';
import { roundTripFacts, roundTripLine, roundTripSummary } from './roundTrips';
import { appendInline, renderMarkdown } from './renderMarkdown';
import { POPUP_STYLE } from './popupStyle';
import { restoreFocus } from '../a11y';
import { followTheme } from '../theme';

export const POPUP_ID = 'pr-explainer-popup';

/** Under an explanation that hit the answer limit (PR 8.4). */
export const CUT_OFF_NOTE =
  'This answer reached the length limit and was cut off. ' +
  'For longer answers, raise **Max response length** in the extension settings.';

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
  /**
   * Called when the Debug button is pressed (PR 9.4). The button is shown
   * only when this is passed: with the Debug window setting on.
   */
  onDebug?: () => void;
  /**
   * Show the reply as markdown while the model writes it (PR 9.6, the Show
   * answers as they are written setting). Off by default: the placeholders
   * stay until the whole answer is shown.
   */
  streamAnswers?: boolean;
  /**
   * What is known about the code without the model (PR 9.12), shown under
   * the header from the start. Left out: no facts line.
   */
  facts?: CodeFacts;
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

/** The loading line, read once by screen readers (PR 9.6). */
export function loadingText(model?: string): string {
  return model ? `Explaining with ${model}…` : 'Explaining…';
}

/**
 * The loading state's body: a spinner and a line saying what is happening,
 * then the three section headings with grey placeholder lines where the
 * answer will go (PR 9.6). The placeholders are hidden from screen readers,
 * which only hear the loading line.
 */
function loadingBody(doc: Document, model?: string): HTMLElement[] {
  const loading = doc.createElement('div');
  loading.className = 'loading';
  const spinner = doc.createElement('span');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const text = doc.createElement('span');
  text.textContent = loadingText(model);
  loading.append(spinner, text);
  const placeholder = doc.createElement('div');
  placeholder.className = 'placeholder';
  placeholder.setAttribute('aria-hidden', 'true');
  for (const key of Object.keys(SECTION_TITLES) as SectionKey[]) {
    const section = doc.createElement('section');
    section.dataset.section = key;
    const heading = doc.createElement('h3');
    heading.textContent = SECTION_TITLES[key];
    section.append(heading);
    // Two lines for each section, the second shorter, like a short answer.
    for (const width of ['92%', '64%']) {
      const line = doc.createElement('span');
      line.className = 'placeholder-line';
      line.style.width = width;
      section.append(line);
    }
    placeholder.append(section);
  }
  return [loading, placeholder];
}

/** A section of the answer: its heading and its text as markdown. */
function sectionNode(doc: Document, key: SectionKey, markdown: string): HTMLElement {
  const section = doc.createElement('section');
  section.dataset.section = key;
  const heading = doc.createElement('h3');
  heading.textContent = SECTION_TITLES[key];
  const content = doc.createElement('div');
  content.className = 'content';
  content.append(renderMarkdown(doc, markdown));
  section.append(heading, content);
  return section;
}

export interface Popup {
  readonly host: HTMLElement;
  readonly state: PopupState;
  /**
   * Time since the popup opened (or since showLoading was last called),
   * frozen when the answer or error arrives.
   */
  readonly elapsedMs: number;
  /** Shows the spinner and placeholders, and restarts the timer. */
  showLoading(model?: string): void;
  /**
   * The reply so far (markdown) while the model is still writing. Shown as
   * it is with streamAnswers on; otherwise each finished section is shown
   * whole (PR 9.13), and the rest is kept, shown only if Stop is pressed.
   */
  showPartial(markdown: string): void;
  /** `cached` is set when the answer came from the cache. */
  showExplanation(explanation: Explanation, model?: string, cached?: { elapsedMs: number }): void;
  showError(message: string, fix: string): void;
  /**
   * Opens Details on the explanation's round trip, with the prompt's size
   * (the Show prompt setting). Call it after showTrace.
   */
  showPrompt(report: PromptReport): void;
  /**
   * Adds the Details button and its waterfall for the answer or error shown
   * (PR 9.1). Does nothing unless one is shown, or when there are no tasks.
   */
  showTrace(trace: TraceDetails): void;
  close(): void;
}

/** What the Details waterfall is drawn from (PR 9.1). */
export interface TraceDetails {
  /** The click's tasks (src/trace/clickTrace.ts). */
  tasks: readonly TraceTask[];
  /** The server's timings, which split the model's task. Left out for a cached answer. */
  timings?: LlmTimings;
  /** The click's round trips (PR 9.2). Left out: no count line. */
  roundTrips?: readonly RoundTrip[];
  /** The whole reply, to estimate how much of it was thinking. */
  reply?: string;
  /** Thinking the model returned in its own field (PR 9.5), never shown as the answer. */
  thinking?: string;
}

/** The summary line of the Prompt sent section. */
export function promptSummary(report: PromptReport): string {
  const size = `about ${report.tokens.toLocaleString('en-US')} of ${report.budget.toLocaleString('en-US')} tokens`;
  const window = `${report.contextTokens.toLocaleString('en-US')}-token context`;
  const trimmed = report.trimmed.length
    ? `trimmed: ${report.trimmed.join(', ')}`
    : 'nothing trimmed';
  return `Prompt sent · ${size} (${window}) · ${trimmed}`;
}

/** The facts line under the header (PR 9.12): file and line · in scope · kind of change. */
function factsLine(doc: Document, facts: CodeFacts): HTMLElement {
  const line = doc.createElement('p');
  line.className = 'facts';
  line.id = 'pe-facts';
  const part = (className: string, ...children: Array<Node | string>) => {
    if (line.childNodes.length) line.append(' · ');
    const span = doc.createElement('span');
    span.className = className;
    span.append(...children);
    line.append(span);
  };
  const code = (text: string) => {
    const el = doc.createElement('code');
    el.textContent = text;
    return el;
  };
  part('where', facts.where);
  if (facts.scope) part('scope', 'in ', code(facts.scope));
  if (facts.was !== undefined) part('change', `${facts.change} `, code(facts.was));
  else part('change', facts.change);
  return line;
}

/** A heading and its text, for a round trip's message or reply. */
function block(doc: Document, heading: string, text: string, role?: string): HTMLElement {
  const section = doc.createElement('section');
  section.className = 'trip-part';
  if (role) section.dataset.role = role;
  const title = doc.createElement('h4');
  title.textContent = heading;
  const pre = doc.createElement('pre');
  pre.textContent = text;
  section.append(title, pre);
  return section;
}

/**
 * The count line and the list of round trips for Details (PR 9.2). Each row
 * opens to show its facts, and for /api/chat the messages and the reply.
 */
function roundTripList(doc: Document, trips: readonly RoundTrip[]): HTMLElement[] {
  const count = doc.createElement('p');
  count.className = 'trip-count';
  count.textContent = roundTripSummary(trips);
  if (trips.length === 0) return [count];
  const list = doc.createElement('ul');
  list.className = 'round-trips';
  list.setAttribute('aria-label', 'Round trips');
  for (const trip of trips) {
    const item = doc.createElement('li');
    item.className = 'round-trip';
    item.dataset.target = trip.target;
    item.dataset.status = trip.status;
    item.dataset.cause = trip.cause;
    // The explanation's round trip carries the prompt (Show prompt opens it).
    if (trip.messages && trip.cause !== 'warmup') item.dataset.prompt = '';
    const details = doc.createElement('details');
    const summary = doc.createElement('summary');
    summary.textContent = roundTripLine(trip);
    const facts = doc.createElement('p');
    facts.className = 'trip-facts';
    facts.textContent = roundTripFacts(trip);
    details.append(summary, facts);
    for (const message of trip.messages ?? []) {
      details.append(block(doc, `Sent: ${message.role}`, message.content, message.role));
    }
    if (trip.thinking) details.append(block(doc, 'Reply: thinking', trip.thinking));
    if (trip.reply !== undefined) details.append(block(doc, 'Reply', trip.reply));
    item.append(details);
    list.append(item);
  }
  return [count, list];
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
  // Where keyboard focus goes back to when the popup closes.
  const returnFocus = doc.activeElement;

  const host = doc.createElement('div');
  host.id = POPUP_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = POPUP_STYLE;

  const panel = doc.createElement('div');
  panel.className = 'popup';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'PR Explainer');
  // Focusable from code only, so focus can move into the popup when it opens.
  panel.tabIndex = -1;

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
  // Shown only once the server's timings for an answer are known (PR 8.1).
  const detailsButton = doc.createElement('button');
  detailsButton.className = 'details';
  detailsButton.type = 'button';
  detailsButton.textContent = 'Details';
  detailsButton.title = 'Show where the time went';
  detailsButton.hidden = true;
  detailsButton.setAttribute('aria-expanded', 'false');
  detailsButton.setAttribute('aria-controls', 'pe-latency');
  header.append(title, modelLabel, elapsedLabel, detailsButton);
  if (options.onDebug) {
    const debugButton = doc.createElement('button');
    debugButton.className = 'debug';
    debugButton.type = 'button';
    debugButton.textContent = 'Debug';
    debugButton.title = 'Open the debug window: every round trip, with its prompt, reply and time';
    debugButton.addEventListener('click', () => options.onDebug?.());
    header.append(debugButton);
  }
  header.append(stopButton, regenerateButton, closeButton);

  const latency = doc.createElement('div');
  latency.className = 'latency';
  latency.id = 'pe-latency';
  latency.hidden = true;
  let detailsOpen = false;
  const showDetails = (open: boolean) => {
    detailsOpen = open;
    latency.hidden = !open;
    detailsButton.setAttribute('aria-expanded', String(open));
  };
  const hideTimings = () => {
    detailsButton.hidden = true;
    showDetails(false);
    latency.replaceChildren();
  };
  detailsButton.addEventListener('click', () => {
    showDetails(!detailsOpen);
    place();
  });

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
  panel.append(header);
  if (options.facts) {
    panel.append(factsLine(doc, options.facts));
    panel.setAttribute('aria-describedby', 'pe-facts');
  }
  panel.append(latency, body, footer);
  shadow.append(style, panel);
  doc.body.append(host);
  const stopFollowingTheme = followTheme(host, doc);

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

  const setState = (next: PopupState) => {
    state = next;
    panel.dataset.state = next;
    // Busy until there is something to read: once a section is shown it is
    // announced at once, not held back until the whole answer is in.
    const working = next === 'loading' || next === 'streaming';
    panel.setAttribute('aria-busy', String(working && shown.size === 0));
  };
  const setBody = (next: PopupState, ...children: Node[]) => {
    setState(next);
    body.replaceChildren(...children);
    place();
  };

  const setModel = (model?: string) => {
    modelLabel.textContent = model ?? '';
    modelLabel.title = model ?? '';
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
    // A reply that was kept back is shown now, so what the model wrote is not lost.
    if (shown.size > 0) {
      // Sections already shown stay; the one being written follows with
      // what the model had of it.
      body.querySelector('.loading')?.remove();
      body.querySelector('.placeholder')?.remove();
      const { writing } = sectionProgress(written);
      if (writing.markdown) body.append(sectionNode(doc, writing.key, writing.markdown));
      setState('stopped');
      place();
    } else if (state === 'streaming' && !options.streamAnswers) {
      setBody('stopped', partialBody(written));
    } else if (state === 'loading') {
      const note = doc.createElement('p');
      note.className = 'stopped-note';
      note.textContent = STOPPED_EMPTY;
      setBody('stopped', note);
    } else setState('stopped');
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
  // The reply so far, kept while it is not shown (streamAnswers off).
  let written = '';
  // Sections shown before the whole answer was in (PR 9.13), with their text.
  const shown = new Map<SectionKey, { node: HTMLElement; markdown: string }>();
  const revealSection = (key: SectionKey, markdown: string) => {
    const node = sectionNode(doc, key, markdown);
    const placeholder = body.querySelector('.placeholder');
    if (!placeholder) return;
    // Shown sections come before the placeholders left, so the order holds.
    placeholder.before(node);
    placeholder.querySelector(`section[data-section="${key}"]`)?.remove();
    shown.set(key, { node, markdown });
  };
  const partialBody = (markdown: string) => {
    const partial = doc.createElement('div');
    partial.className = 'partial';
    partial.append(renderMarkdown(doc, markdown));
    return partial;
  };

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
      hideTimings();
      written = '';
      shown.clear();
      setBody('loading', ...loadingBody(doc, model || undefined));
    },
    showPartial(markdown) {
      if (state !== 'loading' && state !== 'streaming') return;
      written = markdown;
      // Kept back: each placeholder stays as it is until its section is whole.
      if (!options.streamAnswers) {
        const before = shown.size;
        for (const { key, markdown: text } of sectionProgress(markdown).finished) {
          if (!shown.has(key)) revealSection(key, text);
        }
        setState('streaming');
        if (shown.size !== before) place();
        return;
      }
      const follow = state === 'loading' || nearBottom();
      setBody('streaming', partialBody(markdown));
      if (follow) panel.scrollTop = panel.scrollHeight;
    },
    showExplanation(explanation, model, cached) {
      if (state === 'closed' || state === 'stopped') return;
      setModel(model);
      if (cached) showCached(cached.elapsedMs);
      else stopTicking('Answered in ');
      const keys = Object.keys(SECTION_TITLES) as SectionKey[];
      const notes: HTMLElement[] = [];
      if (explanation.cutOff) {
        const note = doc.createElement('p');
        note.className = 'cut-off-note';
        appendInline(note, CUT_OFF_NOTE);
        notes.push(note);
      }
      if (shown.size > 0 && state === 'streaming') {
        // Some sections are already shown (PR 9.13): they stay as they are,
        // so they are not announced again, unless the whole answer changed
        // them (a cut-off mark, or a heading the model repeated).
        const placeholder = body.querySelector('.placeholder');
        for (const key of keys) {
          const before = shown.get(key);
          if (before?.markdown === explanation[key]) continue;
          const node = sectionNode(doc, key, explanation[key]);
          if (before) before.node.replaceWith(node);
          else if (placeholder) placeholder.before(node);
          else body.append(node);
        }
        body.querySelector('.loading')?.remove();
        placeholder?.remove();
        body.append(...notes);
        setState('done');
        place();
        return;
      }
      setBody('done', ...keys.map((key) => sectionNode(doc, key, explanation[key])), ...notes);
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
    showTrace({ tasks, timings, reply, thinking, roundTrips }) {
      // A failed answer shows its trace too: that is when it matters most.
      if ((state !== 'done' && state !== 'failed') || tasks.length === 0) return;
      const waterfall = buildWaterfall(tasks, timings, reply, thinking);
      const total = waterfall.totalMs || 1;
      const percent = (ms: number) => `${Math.min(100, (Math.max(0, ms) / total) * 100)}%`;
      const list = doc.createElement('ul');
      list.className = 'tasks';
      list.setAttribute('aria-label', 'Where the time went');
      for (const row of waterfall.rows) {
        const item = doc.createElement('li');
        item.className = 'task';
        item.dataset.task = row.key;
        item.dataset.source = row.source;
        if (row.status) item.dataset.status = row.status;
        // The visible cells are hidden from screen readers, which read one
        // sentence per row instead.
        const spoken = doc.createElement('span');
        spoken.className = 'sr-only';
        spoken.textContent = rowDescription(row);
        const label = doc.createElement('span');
        label.className = 'task-label';
        label.setAttribute('aria-hidden', 'true');
        label.textContent = row.label;
        if (row.detail) label.title = row.detail;
        const track = doc.createElement('span');
        track.className = 'track';
        track.setAttribute('aria-hidden', 'true');
        const bar = doc.createElement('span');
        bar.className = 'bar';
        bar.style.left = percent(row.startMs);
        // At least a sliver, so a task of a few milliseconds can be seen.
        bar.style.width = `max(2px, ${percent(row.durationMs)})`;
        track.append(bar);
        if (waterfall.firstTokenMs !== undefined) {
          const mark = doc.createElement('span');
          mark.className = 'first-token';
          mark.style.left = percent(waterfall.firstTokenMs);
          track.append(mark);
        }
        const value = doc.createElement('span');
        value.className = 'task-time';
        value.setAttribute('aria-hidden', 'true');
        value.textContent = rowValue(row);
        item.append(spoken, label, track, value);
        list.append(item);
      }
      const summary = doc.createElement('p');
      summary.className = 'trace-total';
      const parts = [`Total ${formatDuration(waterfall.totalMs)}`];
      if (waterfall.firstTokenMs !== undefined) {
        parts.push(
          `first word at ${formatDuration(waterfall.firstTokenMs)} (the line on the bars)`,
        );
      }
      if (waterfall.rows.some((r) => r.key === 'think')) {
        parts.push('~ estimated from the share of what the model wrote that was thinking');
      }
      if (waterfall.scaled) {
        parts.push(
          "Ollama's own times added up to more than the measured wait, so they are scaled to fit",
        );
      }
      summary.textContent = parts.join(' · ');
      latency.replaceChildren(list, summary);
      if (roundTrips) latency.append(...roundTripList(doc, roundTrips));
      detailsButton.hidden = false;
    },
    showPrompt(report) {
      if (state !== 'done') return;
      let trips = latency.querySelector('.round-trips');
      if (!trips) {
        trips = doc.createElement('ul');
        trips.className = 'round-trips';
        latency.append(trips);
      }
      let row = trips.querySelector<HTMLDetailsElement>('li[data-prompt] > details');
      if (!row) {
        // A cached answer: nothing was sent, but the prompt is still shown.
        const item = doc.createElement('li');
        item.className = 'round-trip';
        item.dataset.prompt = '';
        row = doc.createElement('details');
        const summary = doc.createElement('summary');
        summary.textContent = 'Prompt · not sent: the answer came from the cache';
        row.append(summary, block(doc, 'Prompt', report.text));
        item.append(row);
        trips.append(item);
      }
      const size = doc.createElement('p');
      size.className = 'prompt-size';
      size.textContent = promptSummary(report);
      row.querySelector('summary')!.after(size);
      row.open = true;
      detailsButton.hidden = false;
      showDetails(true);
      place();
    },
    close() {
      if (state === 'closed') return;
      // Focus inside a shadow root shows as its host on the page.
      const hadFocus = doc.activeElement === host;
      state = 'closed';
      clearInterval(ticker);
      stopFollowingTheme();
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('mousedown', onMouseDown, true);
      host.remove();
      if (hadFocus) restoreFocus(returnFocus);
      if (current === popup) current = null;
      options.onClose?.();
    },
  };

  current = popup;
  popup.showLoading();
  panel.focus({ preventScroll: true });
  return popup;
}
