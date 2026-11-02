import type { Explanation } from '../src/explain/parseExplanation';
import {
  computePosition,
  currentPopup,
  formatElapsed,
  TICK_MS,
  GAP,
  openPopup,
  POPUP_ID,
  STOPPED_EMPTY,
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

  describe('streaming', () => {
    const stopButton = () => shadow().querySelector<HTMLButtonElement>('button.stop')!;

    it('renders the reply so far as markdown, replacing it with each update', () => {
      const popup = openPopup(ANCHOR);
      popup.showPartial('## What it does\nAdds a `retry`');
      expect(popup.state).toBe('streaming');
      expect(shadow().querySelector('.spinner')).toBeNull();
      popup.showPartial('## What it does\nAdds a `retry` loop.\n\n- tries **three**');
      const partial = shadow().querySelector('.partial')!;
      expect(shadow().querySelectorAll('.partial')).toHaveLength(1);
      expect(partial.querySelector('strong')!.textContent).toBe('What it does');
      expect(partial.querySelector('code')!.textContent).toBe('retry');
      expect(partial.querySelector('li')!.textContent).toBe('tries three');
      expect(shadow().querySelector('[data-state]')!.getAttribute('data-state')).toBe('streaming');
    });

    it('swaps the streamed text for the three sections at the end', () => {
      const popup = openPopup(ANCHOR);
      popup.showPartial('## What it does\nAdds');
      popup.showExplanation(SAMPLE, 'llama3');
      expect(shadow().querySelector('.partial')).toBeNull();
      expect(shadow().querySelectorAll('section')).toHaveLength(3);
      popup.showPartial('late');
      expect(shadow().querySelector('.partial')).toBeNull();
    });

    it('shows HTML in streamed text as plain text', () => {
      openPopup(ANCHOR).showPartial('<img src=x onerror="window.__pwned = 6"> <script>x</script>');
      expect(shadow().querySelectorAll('img, script')).toHaveLength(0);
      expect(shadow().querySelector('.partial')!.textContent).toContain('<img');
    });

    it('Stop keeps the text so far, calls onStop once, and ignores later updates', () => {
      const onStop = vi.fn();
      const popup = openPopup(ANCHOR, { onStop });
      popup.showPartial('Adds a loop');
      stopButton().click();
      stopButton().click();
      expect(onStop).toHaveBeenCalledOnce();
      expect(popup.state).toBe('stopped');
      popup.showPartial('Adds a loop that retries');
      popup.showExplanation(SAMPLE);
      popup.showError('late', 'late');
      expect(popup.state).toBe('stopped');
      expect(shadow().querySelector('.partial')!.textContent).toBe('Adds a loop');
      expect(shadow().querySelector('section, .error')).toBeNull();
    });

    it('Stop while still loading says nothing was written', () => {
      const onStop = vi.fn();
      const popup = openPopup(ANCHOR, { onStop });
      stopButton().click();
      expect(onStop).toHaveBeenCalledOnce();
      expect(popup.state).toBe('stopped');
      expect(shadow().querySelector('.spinner')).toBeNull();
      expect(shadow().querySelector('.stopped-note')!.textContent).toBe(STOPPED_EMPTY);
    });

    it('does nothing when Stop is clicked after the answer arrived', () => {
      const onStop = vi.fn();
      const popup = openPopup(ANCHOR, { onStop });
      popup.showExplanation(SAMPLE);
      stopButton().click();
      expect(onStop).not.toHaveBeenCalled();
      expect(popup.state).toBe('done');
    });
  });

  describe('Regenerate', () => {
    const regenerateButton = () => shadow().querySelector<HTMLButtonElement>('button.regenerate')!;
    const style = () => shadow().querySelector('style')!.textContent!;

    it('is only shown once the model has finished, failed, or been stopped', () => {
      openPopup(ANCHOR);
      // The button's visibility comes from the popup's state (see popupStyle.ts).
      expect(style()).toContain(
        ".popup:not([data-state='done']):not([data-state='failed']):not([data-state='stopped']) .regenerate { display: none; }",
      );
      expect(regenerateButton().textContent).toBe('Regenerate');
    });

    it.each([
      ['done', (p: ReturnType<typeof openPopup>) => p.showExplanation(SAMPLE, 'qwen2.5-coder:7b')],
      ['failed', (p: ReturnType<typeof openPopup>) => p.showError('Broke.', 'Fix it.')],
      ['stopped', () => shadow().querySelector<HTMLButtonElement>('button.stop')!.click()],
    ])('goes back to loading and calls onRegenerate when %s', (_state, finish) => {
      const onRegenerate = vi.fn();
      const popup = openPopup(ANCHOR, { onRegenerate });
      popup.showPartial('Adds');
      finish(popup);
      regenerateButton().click();
      expect(onRegenerate).toHaveBeenCalledOnce();
      expect(popup.state).toBe('loading');
      expect(shadow().querySelector('.spinner')).not.toBeNull();
      // A new answer can arrive after regenerating, even after a Stop.
      popup.showExplanation(SAMPLE, 'qwen2.5-coder:7b');
      expect(popup.state).toBe('done');
    });

    it('keeps the model name while asking again', () => {
      const popup = openPopup(ANCHOR, {});
      popup.showExplanation(SAMPLE, 'qwen2.5-coder:7b');
      regenerateButton().click();
      expect(shadow().querySelector('.model')!.textContent).toBe('qwen2.5-coder:7b');
      expect(shadow().querySelector('.loading')!.textContent).toBe('Asking qwen2.5-coder:7b…');
    });

    it('does nothing while the model is still working', () => {
      const onRegenerate = vi.fn();
      const popup = openPopup(ANCHOR, { onRegenerate });
      regenerateButton().click();
      popup.showPartial('Adds');
      regenerateButton().click();
      expect(onRegenerate).not.toHaveBeenCalled();
      expect(popup.state).toBe('streaming');
    });
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

describe('elapsed time', () => {
  let clock = 0;
  const now = () => clock;
  const elapsedText = () =>
    document.getElementById(POPUP_ID)!.shadowRoot!.querySelector('.elapsed')!.textContent;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1000;
  });

  afterEach(() => {
    currentPopup()?.close();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('counts up while loading', () => {
    const popup = openPopup(ANCHOR, { now });
    expect(elapsedText()).toBe('0.0 s');
    clock += 2350;
    vi.advanceTimersByTime(TICK_MS);
    expect(elapsedText()).toBe('2.3 s');
    expect(popup.elapsedMs).toBe(2350);
  });

  it('freezes at the answer and says how long it took', () => {
    const popup = openPopup(ANCHOR, { now });
    clock += 12_400;
    popup.showExplanation(SAMPLE, 'qwen2.5-coder:7b');
    expect(elapsedText()).toBe('Answered in 12.4 s');
    clock += 5000;
    vi.advanceTimersByTime(TICK_MS * 10);
    expect(elapsedText()).toBe('Answered in 12.4 s');
    expect(popup.elapsedMs).toBe(12_400);
  });

  it('keeps counting while the reply streams in', () => {
    const popup = openPopup(ANCHOR, { now });
    clock += 1500;
    popup.showPartial('Adds');
    vi.advanceTimersByTime(TICK_MS);
    expect(elapsedText()).toBe('1.5 s');
    clock += 2000;
    vi.advanceTimersByTime(TICK_MS);
    expect(elapsedText()).toBe('3.5 s');
    popup.showExplanation(SAMPLE);
    expect(elapsedText()).toBe('Answered in 3.5 s');
  });

  it('says when it was stopped and stops its timer', () => {
    const popup = openPopup(ANCHOR, { now });
    clock += 4200;
    popup.showPartial('Adds');
    document
      .getElementById(POPUP_ID)!
      .shadowRoot!.querySelector<HTMLButtonElement>('button.stop')!
      .click();
    expect(elapsedText()).toBe('Stopped after 4.2 s');
    expect(vi.getTimerCount()).toBe(0);
    clock += 3000;
    expect(popup.elapsedMs).toBe(4200);
  });

  it('says an answer came from the cache and how long the model took the first time', () => {
    const popup = openPopup(ANCHOR, { now });
    clock += 30;
    popup.showExplanation(SAMPLE, 'qwen2.5-coder:7b', { elapsedMs: 9800 });
    expect(elapsedText()).toBe('From cache · took 9.8 s');
    expect(vi.getTimerCount()).toBe(0);
    expect(popup.elapsedMs).toBe(30);
  });

  it('starts the timer again from zero on Regenerate', () => {
    const popup = openPopup(ANCHOR, { now });
    popup.showExplanation(SAMPLE, 'qwen2.5-coder:7b', { elapsedMs: 9800 });
    clock += 5000;
    document
      .getElementById(POPUP_ID)!
      .shadowRoot!.querySelector<HTMLButtonElement>('button.regenerate')!
      .click();
    expect(elapsedText()).toBe('0.0 s');
    clock += 1500;
    vi.advanceTimersByTime(TICK_MS);
    expect(elapsedText()).toBe('1.5 s');
    clock += 1500;
    popup.showExplanation(SAMPLE, 'qwen2.5-coder:7b');
    expect(elapsedText()).toBe('Answered in 3.0 s');
  });

  it('says how long it took to fail', () => {
    const popup = openPopup(ANCHOR, { now });
    clock += 800;
    popup.showError('Ollama is not running.', 'Start it.');
    expect(elapsedText()).toBe('Failed after 0.8 s');
  });

  it('stops its timer when closed', () => {
    const popup = openPopup(ANCHOR, { now });
    expect(vi.getTimerCount()).toBe(1);
    popup.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('formats seconds and minutes', () => {
    expect(formatElapsed(0)).toBe('0.0 s');
    expect(formatElapsed(450)).toBe('0.4 s');
    expect(formatElapsed(59_990)).toBe('59.9 s');
    expect(formatElapsed(60_000)).toBe('1 min 00 s');
    expect(formatElapsed(125_700)).toBe('2 min 05 s');
    expect(formatElapsed(-5)).toBe('0.0 s');
  });
});
