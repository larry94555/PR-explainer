// Points from the chat to the code it is about (PR 11.14). While a chat
// opened from Ask a question is open, the clicked line (or selected block)
// keeps an outline on the page, and:
//
// - with the chat on the page, an arrow runs from the chat's left edge to the
//   line, and follows both as the page scrolls;
// - with the chat in Chrome's side panel, which the page cannot draw into, a
//   tab on the outline's right says "In the chat ▸", pointing at the panel.
//
// When the line is scrolled out of view the arrow (or tab) stops at the top
// or bottom edge of the window, pointing the way to it. Everything is removed
// when the chat closes, and moves when another line is clicked into the chat.
//
// It redraws only when the page scrolls, the window or page changes size, or
// it is pointed at other code, so an idle chat costs nothing (review on #83).
//
// The drawing lives in its own Shadow DOM root, takes no clicks, and sits
// just under the chat panel. `pointerGeometry` does the maths, so it can be
// tested without a browser's layout.

import { followTheme, THEME_VARS } from '../theme';

export const CODE_POINTER_ID = 'pr-explainer-code-pointer';
export const SIDE_PANEL_TAB_TEXT = 'In the chat ▸';

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right?: number;
}

/** What the pointer follows: the clicked row, or a selected block (live rects). */
export interface PointerAnchor {
  getBoundingClientRect(): Rect;
}

export interface PointerGeometry {
  /** The outline around the code, in window coordinates. */
  outline: { top: number; left: number; width: number; height: number };
  /** From the chat to the code; left out when the chat is in the side panel. */
  arrow?: { x1: number; y1: number; x2: number; y2: number };
  /** The side panel's tab, at the outline's right, kept in the window. */
  tab?: { top: number; right: number };
  /** Where the code is when it is out of view. */
  offscreen: 'above' | 'below' | null;
}

/** How far inside the window an arrow or tab stops when the code is out of view. */
export const EDGE = 12;
const PAD = 2;
/** How far left of the chat an arrow reaches into a row the chat covers. */
const MIN_REACH = 120;

/**
 * Where to draw, or null when there is nothing to point at (the code's row
 * was removed from the page, so its rect is empty). `chat` is the on-page
 * chat's box, or null when the chat is in the side panel.
 */
export function pointerGeometry(
  target: Rect,
  chat: Rect | null,
  viewport: { width: number; height: number },
): PointerGeometry | null {
  const right = target.right ?? viewport.width;
  if (target.bottom <= target.top || right <= target.left) return null;
  const offscreen = target.bottom < 0 ? 'above' : target.top > viewport.height ? 'below' : null;
  const outline = {
    top: target.top - PAD,
    left: target.left - PAD,
    width: right - target.left + 2 * PAD,
    height: target.bottom - target.top + 2 * PAD,
  };
  const clampY = (y: number) => Math.min(Math.max(y, EDGE), viewport.height - EDGE);
  const middle = clampY((target.top + target.bottom) / 2);
  if (!chat) {
    const tabRight = Math.max(viewport.width - Math.min(right, viewport.width) + EDGE, EDGE);
    return { outline, tab: { top: clampY(target.top), right: tabRight }, offscreen };
  }
  // From the middle of the chat's left edge, or as near the code's height as
  // the chat reaches.
  const x1 = chat.left - PAD;
  const y1 = Math.min(Math.max(middle, chat.top + 16), chat.bottom - 16);
  // To the code's right end when it stops before the chat, or else to a point
  // inside the row, left of the chat, so the head is on the code.
  const x2 =
    right + MIN_REACH <= x1
      ? right + PAD
      : Math.max(Math.min(x1 - MIN_REACH, right), target.left + EDGE);
  return { outline, arrow: { x1, y1, x2, y2: middle }, offscreen };
}

export interface CodePointerDeps {
  doc?: Document;
  /** The on-page chat's box, or null when the chat is in the side panel. */
  chatRect(): Rect | null;
  /**
   * Whether the chat is still open; checked at each redraw, as a backstop to
   * the caller calling hide when the chat closes.
   */
  isOpen(): boolean;
  /** Next frame (window.requestAnimationFrame), for redraws; tests pass their own. */
  frame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

export interface CodePointer {
  /** Points at `anchor` (replacing any earlier code) until the chat closes. */
  show(anchor: PointerAnchor): void;
  hide(): void;
  readonly shown: boolean;
}

const STYLE = `
  :host { all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483645; }
  ${THEME_VARS}
  .outline {
    position: fixed;
    box-sizing: border-box;
    border: 2px solid var(--pe-accent);
    border-radius: 4px;
    /* A light tint, so the code under it can still be read. */
    background: color-mix(in srgb, var(--pe-accent) 10%, transparent);
  }
  svg { position: fixed; inset: 0; width: 100%; height: 100%; overflow: visible; }
  line { stroke: var(--pe-accent); stroke-width: 2.5; stroke-dasharray: 6 4; }
  .head { fill: var(--pe-accent); }
  .tab {
    position: fixed;
    transform: translateY(-100%);
    padding: 2px 8px;
    border-radius: 4px 4px 0 0;
    background: var(--pe-accent);
    color: #ffffff;
    font: 600 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
    white-space: nowrap;
  }
  [hidden] { display: none; }
`;

const SVG = 'http://www.w3.org/2000/svg';

/** Draws the outline and arrow (or tab) for the chat's code, following the page. */
export function createCodePointer(deps: CodePointerDeps): CodePointer {
  const doc = deps.doc ?? document;
  const win = doc.defaultView ?? window;
  const frame = deps.frame ?? ((cb: () => void) => win.requestAnimationFrame(cb));
  const cancelFrame = deps.cancelFrame ?? ((handle: number) => win.cancelAnimationFrame(handle));

  let anchor: PointerAnchor | null = null;
  let host: HTMLElement | null = null;
  let parts: {
    outline: HTMLElement;
    svg: SVGSVGElement;
    line: SVGLineElement;
    head: SVGPolygonElement;
    tab: HTMLElement;
  } | null = null;
  let stopTheme = () => {};
  let stopWatching = () => {};
  let pending: number | undefined;
  // What was last drawn, so a redraw that changes nothing writes nothing.
  let drawn = '';

  // Redraws only when something may have moved (review on #83): a scroll
  // anywhere on the page, a resize of the window, or a change in the page's
  // or the chat's size (GitHub loading more of the diff, the chat growing).
  // Several in one frame make one redraw; an idle chat costs nothing.
  const schedule = () => {
    if (pending === undefined && parts) pending = frame(draw);
  };
  const watch = () => {
    const options = { capture: true, passive: true } as const;
    win.addEventListener('scroll', schedule, options);
    win.addEventListener('resize', schedule, options);
    const Observer = (win as Window & typeof globalThis).ResizeObserver;
    const observer = typeof Observer === 'function' ? new Observer(schedule) : null;
    observer?.observe(doc.body);
    return () => {
      win.removeEventListener('scroll', schedule, options);
      win.removeEventListener('resize', schedule, options);
      observer?.disconnect();
    };
  };

  const build = () => {
    host = doc.createElement('div');
    host.id = CODE_POINTER_ID;
    host.setAttribute('aria-hidden', 'true');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = STYLE;
    const outline = doc.createElement('div');
    outline.className = 'outline';
    const svg = doc.createElementNS(SVG, 'svg');
    const line = doc.createElementNS(SVG, 'line');
    const head = doc.createElementNS(SVG, 'polygon');
    head.setAttribute('class', 'head');
    svg.append(line, head);
    const tab = doc.createElement('div');
    tab.className = 'tab';
    tab.textContent = SIDE_PANEL_TAB_TEXT;
    shadow.append(style, outline, svg, tab);
    doc.body.append(host);
    stopTheme = followTheme(host, doc);
    stopWatching = watch();
    parts = { outline, svg, line, head, tab };
  };

  const draw = () => {
    pending = undefined;
    if (!anchor || !parts) return;
    if (!deps.isOpen()) {
      hide();
      return;
    }
    const geometry = pointerGeometry(anchor.getBoundingClientRect(), deps.chatRect(), {
      width: win.innerWidth,
      height: win.innerHeight,
    });
    const key = JSON.stringify(geometry);
    if (key === drawn) return;
    drawn = key;
    const { outline, svg, line, head, tab } = parts;
    outline.hidden = !geometry || geometry.offscreen !== null;
    svg.toggleAttribute('hidden', !geometry?.arrow);
    tab.hidden = !geometry?.tab;
    if (geometry) {
      const o = geometry.outline;
      Object.assign(outline.style, {
        top: `${o.top}px`,
        left: `${o.left}px`,
        width: `${o.width}px`,
        height: `${o.height}px`,
      });
      if (geometry.arrow) {
        const { x1, y1, x2, y2 } = geometry.arrow;
        // The line stops short of the tip so the head covers its end.
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const back = (d: number, turn = 0) =>
          `${x2 - d * Math.cos(angle + turn)},${y2 - d * Math.sin(angle + turn)}`;
        line.setAttribute('x1', String(x1));
        line.setAttribute('y1', String(y1));
        const [bx, by] = back(10).split(',');
        line.setAttribute('x2', bx!);
        line.setAttribute('y2', by!);
        head.setAttribute('points', `${x2},${y2} ${back(14, 0.45)} ${back(14, -0.45)}`);
      }
      if (geometry.tab) {
        tab.style.top = `${geometry.tab.top}px`;
        tab.style.right = `${geometry.tab.right}px`;
      }
    }
  };

  function hide(): void {
    anchor = null;
    if (pending !== undefined) cancelFrame(pending);
    pending = undefined;
    stopTheme();
    stopTheme = () => {};
    stopWatching();
    stopWatching = () => {};
    drawn = '';
    host?.remove();
    host = null;
    parts = null;
  }

  return {
    show(next) {
      anchor = next;
      if (!parts) build();
      if (pending !== undefined) cancelFrame(pending);
      drawn = '';
      draw();
    },
    hide,
    get shown() {
      return host !== null;
    },
  };
}
