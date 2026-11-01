import type { Explanation } from '../src/explain/parseExplanation';
import {
  computePosition,
  currentPopup,
  GAP,
  openPopup,
  POPUP_ID,
  type AnchorRect,
} from '../src/popup/popup';

const ANCHOR: AnchorRect = { top: 100, bottom: 120, left: 40 };

const SAMPLE: Explanation = {
  what: 'Adds a `retry` loop.\n\n- tries **three** times\n- waits longer each time',
  why: 'The server is *slow* to start.',
  concerns: 'None found.',
};

function shadow(): ShadowRoot {
  const root = document.getElementById(POPUP_ID)?.shadowRoot;
  if (!root) throw new Error('popup is not open');
  return root;
}

function section(key: string): HTMLElement {
  return shadow().querySelector<HTMLElement>(`section[data-section="${key}"] .content`)!;
}

function pressKey(key: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

function mouseDown(target: EventTarget): void {
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
}

describe('popup', () => {
  afterEach(() => {
    currentPopup()?.close();
    document.body.innerHTML = '';
  });

  it('opens in the loading state with a spinner and the model name', () => {
    const popup = openPopup(ANCHOR);
    popup.showLoading('qwen2.5-coder:7b');
    expect(popup.state).toBe('loading');
    expect(shadow().querySelector('.spinner')).not.toBeNull();
    expect(shadow().querySelector('.loading')?.textContent).toBe('Asking qwen2.5-coder:7b…');
    expect(shadow().querySelector('.model')?.textContent).toBe('qwen2.5-coder:7b');
    expect(shadow().querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('shows the three titled sections with rendered markdown', () => {
    const popup = openPopup(ANCHOR);
    popup.showExplanation(SAMPLE, 'llama3');
    expect(popup.state).toBe('done');
    expect(shadow().querySelector('.spinner')).toBeNull();
    const titles = [...shadow().querySelectorAll('h3')].map((h) => h.textContent);
    expect(titles).toEqual(['What it does', "Why it's needed", 'Concerns']);
    expect(section('what').querySelector('code')?.textContent).toBe('retry');
    expect(section('what').querySelectorAll('li')).toHaveLength(2);
    expect(section('what').querySelector('li strong')?.textContent).toBe('three');
    expect(section('why').querySelector('em')?.textContent).toBe('slow');
    expect(section('concerns').textContent).toBe('None found.');
  });

  it('shows an error message and a fix, with commands as code', () => {
    const popup = openPopup(ANCHOR);
    popup.showError('Ollama is not running.', 'Run `ollama serve`, then try again.');
    expect(popup.state).toBe('failed');
    const error = shadow().querySelector('[role="alert"]')!;
    expect(error.querySelector('.message')?.textContent).toBe('Ollama is not running.');
    expect(error.querySelector('.fix')?.textContent).toBe('Run ollama serve, then try again.');
    expect(error.querySelector('.fix code')?.textContent).toBe('ollama serve');
  });

  it('closes with the close button and calls onClose once', () => {
    const onClose = vi.fn();
    const popup = openPopup(ANCHOR, { onClose });
    shadow().querySelector<HTMLButtonElement>('button.close')!.click();
    expect(popup.state).toBe('closed');
    expect(document.getElementById(POPUP_ID)).toBeNull();
    popup.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Esc but not on other keys', () => {
    const popup = openPopup(ANCHOR);
    pressKey('Enter');
    expect(popup.state).toBe('loading');
    pressKey('Escape');
    expect(popup.state).toBe('closed');
  });

  it('closes on a click outside, but not on a click inside', () => {
    const outside = document.createElement('div');
    document.body.append(outside);
    const popup = openPopup(ANCHOR);
    popup.showExplanation(SAMPLE);
    mouseDown(section('why'));
    expect(popup.state).toBe('done');
    mouseDown(outside);
    expect(popup.state).toBe('closed');
  });

  it('stops listening once closed', () => {
    const onClose = vi.fn();
    openPopup(ANCHOR, { onClose }).close();
    pressKey('Escape');
    mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps only one popup open at a time', () => {
    const first = openPopup(ANCHOR);
    const second = openPopup(ANCHOR);
    expect(first.state).toBe('closed');
    expect(document.querySelectorAll(`#${POPUP_ID}`)).toHaveLength(1);
    expect(currentPopup()).toBe(second);
  });

  it('ignores updates after it is closed', () => {
    const popup = openPopup(ANCHOR);
    popup.close();
    popup.showExplanation(SAMPLE);
    popup.showError('late', 'late');
    expect(popup.state).toBe('closed');
    expect(document.getElementById(POPUP_ID)).toBeNull();
  });

  it('keeps its styles inside the shadow root', () => {
    const headStyles = document.head.querySelectorAll('style').length;
    openPopup(ANCHOR).showExplanation(SAMPLE);
    expect(document.head.querySelectorAll('style')).toHaveLength(headStyles);
    // The only light-DOM node is the host; all markup and CSS are in the shadow root.
    expect(document.body.querySelectorAll('style, section, h3')).toHaveLength(0);
    const style = shadow().querySelector('style')?.textContent ?? '';
    expect(style).toContain(':host { all: initial; }');
  });

  it('positions itself next to an anchor element', () => {
    const line = document.createElement('tr');
    document.body.append(line);
    line.getBoundingClientRect = () => ({ top: 200, bottom: 220, left: 30 }) as DOMRect;
    const popup = openPopup(line);
    expect(popup.host.style.position).toBe('absolute');
    expect(popup.host.style.top).toBe(`${220 + GAP}px`);
    expect(popup.host.style.left).toBe('30px');
  });

  describe('does not run code from the model', () => {
    const UNSAFE: Explanation = {
      what: 'Look: <img src=x onerror="window.__pwned = 1"> <script>window.__pwned = 2</script>',
      why: '[click me](javascript:window.__pwned=3) and <b>bold</b>',
      concerns: '```html\n<img src=x onerror="window.__pwned = 4">\n```',
    };

    afterEach(() => {
      delete (window as { __pwned?: number }).__pwned;
    });

    it('shows HTML as plain text and creates no elements from it', async () => {
      openPopup(ANCHOR).showExplanation(UNSAFE);
      const root = shadow();
      expect(root.querySelectorAll('img, script, b, a, iframe')).toHaveLength(0);
      expect([...root.querySelectorAll('*')].some((el) => el.hasAttribute('onerror'))).toBe(false);
      expect(section('what').textContent).toContain('<script>window.__pwned = 2</script>');
      expect(section('why').textContent).toBe('click me and <b>bold</b>');
      expect(section('concerns').querySelector('pre code')?.textContent).toContain('onerror');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    });

    it('shows HTML in an error as plain text', () => {
      openPopup(ANCHOR).showError('<img src=x onerror="window.__pwned = 5">', '<script>x</script>');
      expect(shadow().querySelectorAll('img, script')).toHaveLength(0);
      expect(shadow().querySelector('.message')?.textContent).toContain('<img');
    });
  });
});

describe('computePosition', () => {
  const viewport = { width: 1000, height: 800, scrollX: 0, scrollY: 0 };
  const size = { width: 400, height: 300 };

  it('goes below the line when it fits', () => {
    expect(computePosition(ANCHOR, size, viewport)).toEqual({ top: 120 + GAP, left: 40 });
  });

  it('goes above the line when there is no room below', () => {
    const anchor = { top: 700, bottom: 720, left: 40 };
    expect(computePosition(anchor, size, viewport).top).toBe(700 - GAP - 300);
  });

  it('keeps the whole popup inside the window when neither side has room', () => {
    // A 480px popup next to a line in the middle of an 800px window: below
    // would end at 858, above would start at -138.
    const anchor = { top: 350, bottom: 370, left: 40 };
    const { top } = computePosition(anchor, { width: 400, height: 480 }, viewport);
    expect(top).toBe(800 - 480 - GAP);
    expect(top + 480).toBeLessThanOrEqual(800);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it('pins to the top of the window when the popup is taller than the window', () => {
    const anchor = { top: 200, bottom: 220, left: 40 };
    expect(computePosition(anchor, { width: 400, height: 900 }, viewport).top).toBe(GAP);
  });

  it('adds the page scroll when clamping, too', () => {
    const anchor = { top: 350, bottom: 370, left: 40 };
    const scrolled = { ...viewport, scrollY: 1000 };
    expect(computePosition(anchor, { width: 400, height: 480 }, scrolled).top).toBe(
      1000 + 800 - 480 - GAP,
    );
  });

  it('stays inside the window horizontally', () => {
    expect(computePosition({ ...ANCHOR, left: 900 }, size, viewport).left).toBe(1000 - 400 - GAP);
    expect(computePosition({ ...ANCHOR, left: -50 }, size, viewport).left).toBe(GAP);
  });

  it('adds the page scroll so the popup scrolls with the page', () => {
    const scrolled = { ...viewport, scrollX: 15, scrollY: 2000 };
    expect(computePosition(ANCHOR, size, scrolled)).toEqual({ top: 2000 + 120 + GAP, left: 55 });
  });
});
