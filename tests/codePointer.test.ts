import {
  CODE_POINTER_ID,
  createCodePointer,
  EDGE,
  pointerGeometry,
  SIDE_PANEL_TAB_TEXT,
  type CodePointer,
  type PointerAnchor,
  type Rect,
} from '../src/chat/codePointer';

const VIEW = { width: 1200, height: 800 };
// A diff row across the page, and the chat floating at the bottom right.
const ROW: Rect = { top: 300, bottom: 320, left: 40, right: 1180 };
const CHAT: Rect = { top: 380, bottom: 780, left: 760, right: 1180 };

describe('pointerGeometry', () => {
  it('outlines the code with a little room', () => {
    expect(pointerGeometry(ROW, CHAT, VIEW)!.outline).toEqual({
      top: 298,
      left: 38,
      width: 1144,
      height: 24,
    });
  });

  it('draws an arrow from the chat to the row, ending on the code left of the chat', () => {
    const { arrow, offscreen } = pointerGeometry(ROW, CHAT, VIEW)!;
    expect(offscreen).toBeNull();
    // From the chat's left edge, as near the row's height as the chat reaches.
    expect(arrow!.x1).toBe(758);
    expect(arrow!.y1).toBe(396);
    // To the middle of the row, left of the chat.
    expect(arrow!.y2).toBe(310);
    expect(arrow!.x2).toBeLessThan(arrow!.x1);
    expect(arrow!.x2).toBeGreaterThan(ROW.left);
  });

  it("ends at the code's right end when that is clear of the chat", () => {
    const short = { ...ROW, right: 400 };
    expect(pointerGeometry(short, CHAT, VIEW)!.arrow!.x2).toBe(402);
  });

  it('starts level with the code when the chat is beside it', () => {
    const beside = { ...ROW, top: 500, bottom: 520 };
    const { arrow } = pointerGeometry(beside, CHAT, VIEW)!;
    expect(arrow!.y1).toBe(510);
    expect(arrow!.y2).toBe(510);
  });

  it('points to the top or bottom edge when the code is scrolled out of view', () => {
    const above = pointerGeometry({ ...ROW, top: -400, bottom: -380 }, CHAT, VIEW)!;
    expect(above.offscreen).toBe('above');
    expect(above.arrow!.y2).toBe(EDGE);
    const below = pointerGeometry({ ...ROW, top: 900, bottom: 920 }, CHAT, VIEW)!;
    expect(below.offscreen).toBe('below');
    expect(below.arrow!.y2).toBe(VIEW.height - EDGE);
  });

  it('puts a tab on the outline instead of an arrow when the chat is in the side panel', () => {
    const geometry = pointerGeometry(ROW, null, VIEW)!;
    expect(geometry.arrow).toBeUndefined();
    expect(geometry.tab).toEqual({ top: 300, right: VIEW.width - ROW.right! + EDGE });
    // Kept in the window when the code is out of view.
    expect(pointerGeometry({ ...ROW, top: -50, bottom: -30 }, null, VIEW)!.tab!.top).toBe(EDGE);
  });

  it('draws nothing for a row that is no longer on the page (an empty rect)', () => {
    expect(pointerGeometry({ top: 0, bottom: 0, left: 0, right: 0 }, CHAT, VIEW)).toBeNull();
  });

  it('takes a block anchor without a right edge as reaching across the window', () => {
    const block = { top: 100, bottom: 180, left: 40 };
    expect(pointerGeometry(block, CHAT, VIEW)!.outline.width).toBe(VIEW.width - 40 + 4);
  });
});

describe('createCodePointer', () => {
  let frames: (() => void)[];
  let open: boolean;
  let chat: Rect | null;
  const anchorAt = (rect: Rect): PointerAnchor => ({ getBoundingClientRect: () => rect });
  let made: CodePointer[] = [];
  const make = () => {
    const pointer = createCodePointer({
      chatRect: () => chat,
      isOpen: () => open,
      frame: (cb) => frames.push(cb),
      cancelFrame: (handle) => {
        frames[handle - 1] = () => {};
      },
    });
    made.push(pointer);
    return pointer;
  };
  const nextFrame = () => frames.at(-1)!();
  const root = () => document.getElementById(CODE_POINTER_ID)?.shadowRoot ?? null;
  const part = (selector: string) => root()!.querySelector<HTMLElement>(selector)!;

  beforeEach(() => {
    frames = [];
    open = true;
    chat = CHAT;
    window.innerWidth = VIEW.width;
    window.innerHeight = VIEW.height;
  });
  afterEach(() => {
    for (const pointer of made) pointer.hide();
    made = [];
  });

  it('outlines the code and draws the arrow on the page, taking no clicks', () => {
    const pointer = make();
    pointer.show(anchorAt(ROW));
    expect(pointer.shown).toBe(true);
    expect(document.getElementById(CODE_POINTER_ID)!.getAttribute('aria-hidden')).toBe('true');
    expect(part('style').textContent).toContain('pointer-events: none');
    expect(part('.outline').hidden).toBe(false);
    expect(part('.outline').style.top).toBe('298px');
    expect(part('svg').hasAttribute('hidden')).toBe(false);
    expect(part('line').getAttribute('x1')).toBe('758');
    expect(part('.head').getAttribute('points')).toMatch(/^\d/);
    expect(part('.tab').hidden).toBe(true);
  });

  it('shows the side panel tab instead of an arrow when the chat is in the side panel', () => {
    chat = null;
    make().show(anchorAt(ROW));
    expect(part('svg').hasAttribute('hidden')).toBe(true);
    expect(part('.tab').hidden).toBe(false);
    expect(part('.tab').textContent).toBe(SIDE_PANEL_TAB_TEXT);
  });

  it('follows the code when the page scrolls, once per frame', () => {
    let rect = ROW;
    make().show({ getBoundingClientRect: () => rect });
    rect = { ...ROW, top: 100, bottom: 120 };
    window.dispatchEvent(new Event('scroll'));
    // A scroll inside the diff (not the window) counts too, in the same frame.
    document.body.dispatchEvent(new Event('scroll'));
    expect(frames).toHaveLength(1);
    nextFrame();
    expect(part('.outline').style.top).toBe('98px');
    // Out of view: no outline, but the arrow still points the way.
    rect = { ...ROW, top: -300, bottom: -280 };
    window.dispatchEvent(new Event('resize'));
    nextFrame();
    expect(part('.outline').hidden).toBe(true);
    expect(part('svg').hasAttribute('hidden')).toBe(false);
  });

  it('does nothing while the chat sits idle, and writes nothing when nothing moved (review on #83)', () => {
    const read = vi.fn(() => ROW);
    make().show({ getBoundingClientRect: read });
    expect(read).toHaveBeenCalledTimes(1);
    // No frames are asked for without a scroll or resize.
    expect(frames).toHaveLength(0);
    const outline = part('.outline');
    const written = vi.spyOn(outline.style, 'setProperty');
    const top = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'top');
    let topWrites = 0;
    Object.defineProperty(outline.style, 'top', {
      configurable: true,
      get: () => top?.get?.call(outline.style),
      set: (value: string) => {
        topWrites++;
        top?.set?.call(outline.style, value);
      },
    });
    window.dispatchEvent(new Event('scroll'));
    nextFrame();
    expect(read).toHaveBeenCalledTimes(2);
    expect(topWrites).toBe(0);
    expect(written).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
  });

  it('stops listening once hidden', () => {
    const pointer = make();
    pointer.show(anchorAt(ROW));
    pointer.hide();
    window.dispatchEvent(new Event('scroll'));
    expect(frames).toHaveLength(0);
  });

  it('moves to other code when shown again, with one drawing', () => {
    const pointer = make();
    pointer.show(anchorAt(ROW));
    pointer.show(anchorAt({ ...ROW, top: 500, bottom: 520 }));
    expect(document.querySelectorAll(`#${CODE_POINTER_ID}`)).toHaveLength(1);
    expect(part('.outline').style.top).toBe('498px');
  });

  it('goes away at the next redraw if the chat closed without hide', () => {
    const pointer = make();
    pointer.show(anchorAt(ROW));
    open = false;
    window.dispatchEvent(new Event('scroll'));
    nextFrame();
    expect(pointer.shown).toBe(false);
    expect(document.getElementById(CODE_POINTER_ID)).toBeNull();
  });

  it('hides everything for a row GitHub removed, and hide removes it', () => {
    const pointer = make();
    pointer.show(anchorAt({ top: 0, bottom: 0, left: 0, right: 0 }));
    expect(part('.outline').hidden).toBe(true);
    expect(part('svg').hasAttribute('hidden')).toBe(true);
    pointer.hide();
    expect(root()).toBeNull();
  });
});
