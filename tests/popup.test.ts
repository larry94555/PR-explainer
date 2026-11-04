import type { Explanation } from '../src/explain/parseExplanation';
import type { RoundTrip, TraceTask } from '../src/trace/types';
import {
  computePosition,
  currentPopup,
  formatElapsed,
  TICK_MS,
  GAP,
  openPopup,
  POPUP_ID,
  promptSummary,
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
    expect(shadow().querySelector('.loading')?.textContent).toBe(
      'Explaining with qwen2.5-coder:7b…',
    );
    expect(shadow().querySelector('.model')?.textContent).toBe('qwen2.5-coder:7b');
    // The name is cut short when the header is full, so it is also the tooltip.
    expect(shadow().querySelector<HTMLElement>('.model')?.title).toBe('qwen2.5-coder:7b');
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
    expect(shadow().querySelector('.cut-off-note')).toBeNull();
  });

  describe('facts known without the model (PR 9.12)', () => {
    const FACTS = {
      where: 'src/retry.ts, line 12',
      scope: 'export async function retry<T>(',
      change: 'Changed line, was:',
      was: 'return fn();',
    };
    const factsLine = () => shadow().querySelector<HTMLElement>('.facts');

    it('shows the facts line while loading, before anything else', () => {
      const popup = openPopup(ANCHOR, { facts: FACTS });
      expect(popup.state).toBe('loading');
      expect(factsLine()?.textContent).toBe(
        'src/retry.ts, line 12 · in export async function retry<T>( · Changed line, was: return fn();',
      );
      const codes = [...factsLine()!.querySelectorAll('code')].map((c) => c.textContent);
      expect(codes).toEqual(['export async function retry<T>(', 'return fn();']);
      // Above the answer, right under the header.
      expect(factsLine()!.previousElementSibling?.className).toBe('header');
    });

    it('stays above the answer once it arrives, and through Regenerate', () => {
      const popup = openPopup(ANCHOR, { facts: FACTS });
      const line = factsLine();
      popup.showExplanation(SAMPLE, 'llama3');
      expect(factsLine()).toBe(line);
      expect(line!.compareDocumentPosition(shadow().querySelector('.body')!)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      popup.showLoading('llama3');
      expect(factsLine()).toBe(line);
    });

    it('is the same for a cached answer', () => {
      const popup = openPopup(ANCHOR, { facts: FACTS });
      const text = factsLine()!.textContent;
      popup.showExplanation(SAMPLE, 'llama3', { elapsedMs: 3000 });
      expect(factsLine()!.textContent).toBe(text);
    });

    it('is read once by screen readers: the dialog description, outside the live region', () => {
      openPopup(ANCHOR, { facts: { where: 'a.ts, line 3', change: 'Added line' } });
      const dialog = shadow().querySelector('[role="dialog"]')!;
      const id = dialog.getAttribute('aria-describedby');
      expect(id).toBe(factsLine()!.id);
      expect(shadow().getElementById(id!)).toBe(factsLine());
      expect(factsLine()!.closest('[aria-live]')).toBeNull();
      expect(factsLine()!.textContent).toBe('a.ts, line 3 · Added line');
    });

    it('is left out when there are no facts', () => {
      openPopup(ANCHOR);
      expect(factsLine()).toBeNull();
      expect(shadow().querySelector('[role="dialog"]')!.hasAttribute('aria-describedby')).toBe(
        false,
      );
    });
  });

  it('says so under an answer that was cut off at the limit (PR 8.4)', () => {
    const popup = openPopup(ANCHOR);
    popup.showExplanation({ ...SAMPLE, why: 'The server is …', cutOff: true }, 'llama3');
    const note = shadow().querySelector('.cut-off-note');
    expect(note?.textContent).toContain('reached the length limit and was cut off');
    expect(note?.querySelector('strong')?.textContent).toBe('Max response length');
    // The note comes after the three sections.
    expect(shadow().querySelector('section[data-section="concerns"] ~ .cut-off-note')).toBe(note);
    // A cached cut-off answer is marked too.
    popup.showLoading();
    popup.showExplanation({ ...SAMPLE, cutOff: true }, 'llama3', { elapsedMs: 9_000 });
    expect(shadow().querySelector('.cut-off-note')).not.toBeNull();
  });

  describe('round trips and Show prompt (PR 9.2)', () => {
    const REPORT = {
      text: '[system]\nYou are a senior engineer.\n\n[user]\nExplain the clicked line.',
      tokens: 1234,
      budget: 3040,
      contextTokens: 4096,
      trimmed: ['lines around the code', 'PR description'],
    };
    const TASK: TraceTask = {
      key: 'find-code',
      label: 'Find the code',
      source: 'page',
      startMs: 0,
      durationMs: 2,
    };
    const trip = (extra: Partial<RoundTrip>): RoundTrip => ({
      target: 'ollama',
      method: 'POST',
      endpoint: 'localhost:11434/api/ps',
      purpose: 'loaded window',
      cause: 'click',
      startMs: 10,
      durationMs: 5,
      status: 'done',
      httpStatus: 200,
      bytesSent: 0,
      bytesReceived: 120,
      ...extra,
    });
    const CHAT = trip({
      endpoint: 'localhost:11434/api/chat',
      purpose: 'explanation',
      startMs: 20,
      durationMs: 12_300,
      bytesSent: 3_200,
      bytesReceived: 8_100,
      messages: [
        { role: 'system', content: 'You are a senior engineer.' },
        { role: 'user', content: 'Explain the clicked line.' },
      ],
      reply: '## What it does\nA.',
      thinking: 'Let me look.',
    });
    const TRIPS: RoundTrip[] = [
      trip({
        target: 'github',
        method: 'GET',
        endpoint: 'github.com/o/r/raw/abc/a.ts',
        purpose: 'file at head',
        startMs: 3,
      }),
      trip({}),
      CHAT,
      trip({ endpoint: 'localhost:11434/api/chat', purpose: 'load the model', cause: 'warmup' }),
    ];
    const rows = () => [...shadow().querySelectorAll<HTMLLIElement>('.round-trip')];

    it("counts the click's round trips and lists each one, with the others marked", () => {
      const popup = openPopup(ANCHOR);
      popup.showExplanation(SAMPLE, 'llama3');
      popup.showTrace({ tasks: [TASK], roundTrips: TRIPS });
      expect(shadow().querySelector('.trip-count')!.textContent).toBe(
        '3 round trips: GitHub 1, Ollama 2 · 1 more by the warm-up, not counted',
      );
      expect(rows().map((r) => r.querySelector('summary')!.textContent)).toEqual([
        'GitHub github.com/o/r/raw/abc/a.ts · file at head · 5 ms',
        'Ollama /api/ps · loaded window · 5 ms',
        'Ollama /api/chat · explanation · 12.3 s',
        'Ollama /api/chat · load the model · 5 ms · by the warm-up',
      ]);
      expect(rows()[2]!.querySelector('.trip-facts')!.textContent).toBe(
        'POST localhost:11434/api/chat · started at 20 ms · sent 3.2 kB · received 8.1 kB · HTTP 200',
      );
      expect(rows().every((r) => !r.querySelector('details')!.open)).toBe(true);
    });

    it('marks the round trip of a line explained ahead that the click joined (PR 9.10)', () => {
      const popup = openPopup(ANCHOR);
      popup.showExplanation(SAMPLE, 'llama3');
      popup.showTrace({ tasks: [TASK], roundTrips: [{ ...CHAT, cause: 'ahead' }] });
      expect(shadow().querySelector('.trip-count')!.textContent).toBe(
        'No round trips for this click · 1 more by Explain ahead, not counted',
      );
      expect(rows()[0]!.querySelector('summary')!.textContent).toBe(
        'Ollama /api/chat · explanation · 12.3 s · by Explain ahead',
      );
    });

    it("shows the explanation's messages by role, and its reply with the thinking apart", () => {
      const popup = openPopup(ANCHOR);
      popup.showExplanation(SAMPLE, 'llama3');
      popup.showTrace({ tasks: [TASK], roundTrips: [CHAT] });
      const parts = [...rows()[0]!.querySelectorAll('.trip-part')].map((p) => [
        p.querySelector('h4')!.textContent,
        p.querySelector('pre')!.textContent,
      ]);
      expect(parts).toEqual([
        ['Sent: system', 'You are a senior engineer.'],
        ['Sent: user', 'Explain the clicked line.'],
        ['Reply: thinking', 'Let me look.'],
        ['Reply', '## What it does\nA.'],
      ]);
    });

    it('marks a failed round trip with its error', () => {
      const popup = openPopup(ANCHOR);
      popup.showError('Ollama is not running.', 'Start it.');
      const failed = trip({
        endpoint: 'localhost:11434/api/chat',
        purpose: 'explanation',
        status: 'failed',
        httpStatus: undefined,
        bytesReceived: 0,
        error: 'Failed to fetch',
      });
      popup.showTrace({ tasks: [TASK], roundTrips: [failed] });
      expect(rows()[0]!.dataset.status).toBe('failed');
      expect(rows()[0]!.querySelector('summary')!.textContent).toBe(
        'Ollama /api/chat · explanation · 5 ms · failed',
      );
      expect(rows()[0]!.querySelector('.trip-facts')!.textContent).toMatch(
        /received 0 B · error: Failed to fetch$/,
      );
    });

    it('says when a click made none (a cached answer)', () => {
      const popup = openPopup(ANCHOR);
      popup.showExplanation(SAMPLE, 'llama3', { elapsedMs: 9_000 });
      popup.showTrace({ tasks: [TASK], roundTrips: [] });
      expect(shadow().querySelector('.trip-count')!.textContent).toBe(
        'No round trips for this click',
      );
      expect(rows()).toEqual([]);
    });

    it("Show prompt opens Details on the explanation's round trip, with the prompt size", () => {
      const popup = openPopup(ANCHOR);
      popup.showExplanation(SAMPLE, 'llama3');
      popup.showTrace({ tasks: [TASK], roundTrips: TRIPS });
      popup.showPrompt(REPORT);
      expect(shadow().querySelector<HTMLElement>('.latency')!.hidden).toBe(false);
      const open = rows().filter((r) => r.querySelector('details')!.open);
      expect(open).toHaveLength(1);
      expect(open[0]!.querySelector('summary')!.textContent).toMatch(/· explanation ·/);
      expect(open[0]!.querySelector('.prompt-size')!.textContent).toBe(
        'Prompt sent · about 1,234 of 3,040 tokens (4,096-token context) · ' +
          'trimmed: lines around the code, PR description',
      );
      // It replaces the old box under the explanation.
      expect(shadow().querySelector('.body details')).toBeNull();
    });

    it('Show prompt on a cached answer adds a row for the prompt that was not sent', () => {
      const popup = openPopup(ANCHOR);
      popup.showExplanation(SAMPLE, 'llama3', { elapsedMs: 9_000 });
      popup.showTrace({ tasks: [TASK], roundTrips: [] });
      popup.showPrompt(REPORT);
      expect(rows()).toHaveLength(1);
      const row = rows()[0]!.querySelector('details')!;
      expect(row.open).toBe(true);
      expect(row.querySelector('summary')!.textContent).toBe(
        'Prompt · not sent: the answer came from the cache',
      );
      expect(row.querySelector('pre')!.textContent).toBe(REPORT.text);
    });

    it('says when nothing was trimmed', () => {
      expect(promptSummary({ ...REPORT, trimmed: [] })).toMatch(/· nothing trimmed$/);
    });

    it('shows no prompt unless an explanation is shown', () => {
      const popup = openPopup(ANCHOR);
      popup.showPrompt(REPORT);
      expect(rows()).toEqual([]);
    });
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

  describe('streaming with Show answers as they are written on', () => {
    const stopButton = () => shadow().querySelector<HTMLButtonElement>('button.stop')!;

    it('renders the reply so far as markdown, replacing it with each update', () => {
      const popup = openPopup(ANCHOR, { streamAnswers: true });
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
      const popup = openPopup(ANCHOR, { streamAnswers: true });
      popup.showPartial('## What it does\nAdds');
      popup.showExplanation(SAMPLE, 'llama3');
      expect(shadow().querySelector('.partial')).toBeNull();
      expect(shadow().querySelectorAll('section')).toHaveLength(3);
      popup.showPartial('late');
      expect(shadow().querySelector('.partial')).toBeNull();
    });

    it('shows HTML in streamed text as plain text', () => {
      openPopup(ANCHOR, { streamAnswers: true }).showPartial(
        '<img src=x onerror="window.__pwned = 6"> <script>x</script>',
      );
      expect(shadow().querySelectorAll('img, script')).toHaveLength(0);
      expect(shadow().querySelector('.partial')!.textContent).toContain('<img');
    });

    it('Stop keeps the text so far, calls onStop once, and ignores later updates', () => {
      const onStop = vi.fn();
      const popup = openPopup(ANCHOR, { onStop, streamAnswers: true });
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
      const popup = openPopup(ANCHOR, { onStop, streamAnswers: true });
      stopButton().click();
      expect(onStop).toHaveBeenCalledOnce();
      expect(popup.state).toBe('stopped');
      expect(shadow().querySelector('.spinner')).toBeNull();
      expect(shadow().querySelector('.stopped-note')!.textContent).toBe(STOPPED_EMPTY);
    });

    it('does nothing when Stop is clicked after the answer arrived', () => {
      const onStop = vi.fn();
      const popup = openPopup(ANCHOR, { onStop, streamAnswers: true });
      popup.showExplanation(SAMPLE);
      stopButton().click();
      expect(onStop).not.toHaveBeenCalled();
      expect(popup.state).toBe('done');
    });
  });

  describe('the whole answer at once (PR 9.6, the default)', () => {
    const stopButton = () => shadow().querySelector<HTMLButtonElement>('button.stop')!;
    const body = () => shadow().querySelector<HTMLElement>('.body')!;

    it('shows the three headings with placeholder lines while it waits', () => {
      const popup = openPopup(ANCHOR);
      popup.showLoading('qwen2.5-coder:7b');
      expect(shadow().querySelector('.spinner')).not.toBeNull();
      expect(shadow().querySelector('.loading')!.textContent).toBe(
        'Explaining with qwen2.5-coder:7b…',
      );
      const placeholder = shadow().querySelector('.placeholder')!;
      const titles = [...placeholder.querySelectorAll('h3')].map((h) => h.textContent);
      expect(titles).toEqual(['What it does', "Why it's needed", 'Concerns']);
      expect(placeholder.querySelectorAll('.placeholder-line')).toHaveLength(6);
      // Screen readers hear only the loading line, not the empty sections.
      expect(placeholder.getAttribute('aria-hidden')).toBe('true');
      expect(shadow().querySelector('.content')).toBeNull();
    });

    it('says only "Explaining…" before the model is known', () => {
      openPopup(ANCHOR);
      expect(shadow().querySelector('.loading')!.textContent).toBe('Explaining…');
    });

    it('keeps the reply back while it is written: the placeholders are not touched', () => {
      const popup = openPopup(ANCHOR);
      popup.showLoading('llama3');
      const before = [...body().childNodes];
      popup.showPartial('## What it does\nAdds a `retry`');
      popup.showPartial('## What it does\nAdds a `retry` loop.');
      expect(popup.state).toBe('streaming');
      expect(shadow().querySelector('.partial')).toBeNull();
      expect(body().textContent).not.toContain('retry');
      // The very same nodes: nothing was redrawn, so nothing is announced again.
      expect([...body().childNodes]).toEqual(before);
      expect(before.every((node) => node.isConnected)).toBe(true);
      expect(shadow().querySelector('.spinner')).not.toBeNull();
    });

    it('replaces the placeholders with the whole answer in one update', () => {
      const popup = openPopup(ANCHOR);
      popup.showPartial('## What it does\nAdds');
      const observer = new MutationObserver(() => {});
      observer.observe(body(), { childList: true });
      popup.showExplanation(SAMPLE, 'llama3');
      const changes = observer.takeRecords();
      observer.disconnect();
      // One swap: the placeholders out, the three sections in.
      expect(changes).toHaveLength(1);
      expect(changes[0]!.addedNodes).toHaveLength(3);
      expect(popup.state).toBe('done');
      expect(shadow().querySelector('.placeholder, .loading')).toBeNull();
      expect(shadow().querySelectorAll('section')).toHaveLength(3);
      expect(section('what').querySelector('code')?.textContent).toBe('retry');
    });

    it('Stop shows what the model had written and says how long it took', () => {
      let clock = 0;
      const onStop = vi.fn();
      const popup = openPopup(ANCHOR, { onStop, now: () => clock });
      popup.showPartial('Adds a `loop`');
      clock = 2_300;
      stopButton().click();
      expect(onStop).toHaveBeenCalledOnce();
      expect(popup.state).toBe('stopped');
      expect(shadow().querySelector('.elapsed')!.textContent).toBe('Stopped after 2.3 s');
      expect(shadow().querySelector('.placeholder')).toBeNull();
      expect(shadow().querySelector('.partial code')!.textContent).toBe('loop');
      popup.showExplanation(SAMPLE);
      expect(popup.state).toBe('stopped');
    });

    it('Stop before any text says nothing was written', () => {
      const popup = openPopup(ANCHOR);
      stopButton().click();
      expect(popup.state).toBe('stopped');
      expect(shadow().querySelector('.stopped-note')!.textContent).toBe(STOPPED_EMPTY);
    });

    it('Regenerate forgets the text kept back from the last answer', () => {
      const popup = openPopup(ANCHOR);
      popup.showPartial('Old text');
      popup.showError('Broke.', 'Fix it.');
      shadow().querySelector<HTMLButtonElement>('button.regenerate')!.click();
      expect(shadow().querySelector('.placeholder')).not.toBeNull();
      stopButton().click();
      expect(shadow().querySelector('.stopped-note')!.textContent).toBe(STOPPED_EMPTY);
      expect(body().textContent).not.toContain('Old text');
    });
  });

  describe('each section as soon as it is written (PR 9.13)', () => {
    const stopButton = () => shadow().querySelector<HTMLButtonElement>('button.stop')!;
    const body = () => shadow().querySelector<HTMLElement>('.body')!;
    const placeholders = () =>
      [...shadow().querySelectorAll<HTMLElement>('.placeholder section')].map(
        (s) => s.dataset.section,
      );
    const shownSections = () =>
      ([...body().children] as HTMLElement[])
        .filter((el) => el.tagName === 'SECTION')
        .map((el) => el.dataset.section);
    const WHAT = '## What it does\nAdds a `retry` loop.\n\n';
    const WHY = "## Why it's needed\nThe server is *slow* to start.\n\n";
    // The whole answer those parts add up to.
    const FULL: Explanation = { ...SAMPLE, what: 'Adds a `retry` loop.' };

    it('shows a section whole once the next heading arrives, and not before', () => {
      const popup = openPopup(ANCHOR);
      popup.showPartial('## What it does\nAdds a `retry`');
      expect(shownSections()).toEqual([]);
      expect(placeholders()).toEqual(['what', 'why', 'concerns']);
      popup.showPartial(WHAT + '## Why');
      expect(popup.state).toBe('streaming');
      expect(shownSections()).toEqual(['what']);
      expect(section('what').querySelector('code')!.textContent).toBe('retry');
      // The others keep their placeholders, and the spinner stays.
      expect(placeholders()).toEqual(['why', 'concerns']);
      expect(shadow().querySelector('.spinner')).not.toBeNull();
      expect(body().textContent).not.toContain('slow');
    });

    it('shows them in order, each in one update, and announces each once', () => {
      const popup = openPopup(ANCHOR);
      const observer = new MutationObserver(() => {});
      observer.observe(body(), { childList: true });
      popup.showPartial(WHAT + '## Why');
      popup.showPartial(WHAT + WHY);
      popup.showPartial(WHAT + WHY + '## Concerns\nNone');
      expect(shownSections()).toEqual(['what', 'why']);
      expect(placeholders()).toEqual(['concerns']);
      // Readable as soon as something is shown, not held back as busy.
      expect(shadow().querySelector('[role="dialog"]')!.getAttribute('aria-busy')).toBe('false');
      const whatNode = body().querySelector('section[data-section="what"]');
      popup.showExplanation(FULL, 'llama3');
      const added = observer
        .takeRecords()
        .flatMap((r) => [...r.addedNodes] as HTMLElement[])
        .filter((n) => n.parentNode === body())
        .map((n) => n.dataset.section);
      observer.disconnect();
      // Each section was added to the live region once, in order.
      expect(added).toEqual(['what', 'why', 'concerns']);
      expect(body().querySelector('section[data-section="what"]')).toBe(whatNode);
      expect(popup.state).toBe('done');
      expect(shownSections()).toEqual(['what', 'why', 'concerns']);
      expect(shadow().querySelector('.placeholder, .loading')).toBeNull();
    });

    it('keeps the timer running until the whole answer is in', () => {
      let clock = 0;
      const popup = openPopup(ANCHOR, { now: () => clock });
      clock = 500;
      popup.showPartial(WHAT + '## Why');
      clock = 1_700;
      expect(popup.elapsedMs).toBe(1_700);
      popup.showExplanation(SAMPLE);
      clock = 9_000;
      expect(shadow().querySelector('.elapsed')!.textContent).toBe('Answered in 1.7 s');
    });

    it('Stop keeps the sections shown and adds what was written of the next', () => {
      const onStop = vi.fn();
      const popup = openPopup(ANCHOR, { onStop });
      popup.showPartial(WHAT + "## Why it's needed\nThe server");
      stopButton().click();
      expect(onStop).toHaveBeenCalledOnce();
      expect(popup.state).toBe('stopped');
      expect(shownSections()).toEqual(['what', 'why']);
      expect(section('why').textContent).toBe('The server');
      expect(shadow().querySelector('.placeholder, .loading, .partial')).toBeNull();
      popup.showExplanation(SAMPLE);
      expect(popup.state).toBe('stopped');
      expect(shownSections()).toEqual(['what', 'why']);
    });

    it('Stop just after a heading shows only the finished sections', () => {
      const popup = openPopup(ANCHOR);
      popup.showPartial(WHAT + '## Why');
      stopButton().click();
      expect(shownSections()).toEqual(['what']);
    });

    it('a cut-off answer marks the last section and adds the note', () => {
      const popup = openPopup(ANCHOR);
      popup.showPartial(WHAT + WHY + '## Concerns\n- The loop never');
      popup.showExplanation(
        { ...SAMPLE, what: 'Adds a `retry` loop.', concerns: '- The loop never …', cutOff: true },
        'llama3',
      );
      expect(shownSections()).toEqual(['what', 'why', 'concerns']);
      expect(section('concerns').textContent).toBe('The loop never …');
      expect(shadow().querySelector('.cut-off-note')).not.toBeNull();
    });

    it('replaces a shown section the whole answer changed', () => {
      const popup = openPopup(ANCHOR);
      popup.showPartial(WHAT + '## Why');
      popup.showExplanation({ ...SAMPLE, what: 'Something else.' });
      expect(shownSections()).toEqual(['what', 'why', 'concerns']);
      expect(section('what').textContent).toBe('Something else.');
    });

    it('a cached answer shows all three at once', () => {
      const popup = openPopup(ANCHOR);
      const observer = new MutationObserver(() => {});
      observer.observe(body(), { childList: true });
      popup.showExplanation(SAMPLE, 'llama3', { elapsedMs: 3_000 });
      const changes = observer.takeRecords();
      observer.disconnect();
      expect(changes).toHaveLength(1);
      expect(shownSections()).toEqual(['what', 'why', 'concerns']);
    });

    it('Regenerate starts over with every placeholder', () => {
      const popup = openPopup(ANCHOR);
      popup.showPartial(WHAT + '## Why');
      popup.showError('Broke.', 'Fix it.');
      shadow().querySelector<HTMLButtonElement>('button.regenerate')!.click();
      expect(placeholders()).toEqual(['what', 'why', 'concerns']);
      expect(shownSections()).toEqual([]);
      expect(shadow().querySelector('[role="dialog"]')!.getAttribute('aria-busy')).toBe('true');
    });

    it('with Show answers as they are written on, streams as before', () => {
      const popup = openPopup(ANCHOR, { streamAnswers: true });
      popup.showPartial(WHAT + '## Why');
      expect(shadow().querySelector('.partial')).not.toBeNull();
      expect(shownSections()).toEqual([]);
    });
  });

  describe('Details waterfall (PR 9.1)', () => {
    const TIMINGS = {
      totalMs: 13_900,
      loadMs: 4_100,
      promptTokens: 812,
      promptMs: 1_300,
      answerTokens: 240,
      answerMs: 8_000,
    };
    const task = (
      key: string,
      startMs: number,
      durationMs: number,
      extra: Partial<TraceTask> = {},
    ): TraceTask => ({ key, label: key, source: 'page', startMs, durationMs, ...extra });
    const TASKS: TraceTask[] = [
      { ...task('find-code', 0, 4), label: 'Find the code' },
      { ...task('pr-description', 4, 100), label: 'Read the PR description' },
      { ...task('file-at-head', 4, 300), label: 'Fetch the file at head' },
      {
        ...task('model', 400, 13_500, { source: 'worker', firstChunkMs: 5_500 }),
        label: 'Wait for the model',
      },
      { ...task('show', 13_900, 300), label: 'Show answer' },
    ];
    // Half of the reply is thinking.
    const REPLY = `<think>${'t'.repeat(35)}</think>${'a'.repeat(50)}`;
    const detailsButton = () => shadow().querySelector<HTMLButtonElement>('button.details')!;
    const panel = () => shadow().querySelector<HTMLElement>('.latency')!;
    const rows = () => Array.from(panel().querySelectorAll<HTMLElement>('li.task'));

    it('is hidden until an answer and its tasks are shown', () => {
      const popup = openPopup(ANCHOR, { now: () => 0 });
      expect(detailsButton().hidden).toBe(true);
      popup.showTrace({ tasks: TASKS, timings: TIMINGS });
      expect(detailsButton().hidden).toBe(true);
      popup.showExplanation(SAMPLE, 'qwen2.5-coder:7b');
      popup.showTrace({ tasks: [] });
      expect(detailsButton().hidden).toBe(true);
      popup.showTrace({ tasks: TASKS, timings: TIMINGS, reply: REPLY });
      expect(detailsButton().hidden).toBe(false);
      expect(detailsButton().textContent).toBe('Details');
      expect(panel().hidden).toBe(true);
    });

    it('opens a row per task, with the model split into Load, Read prompt, Think and Write answer', () => {
      const popup = openPopup(ANCHOR, { now: () => 0 });
      popup.showExplanation(SAMPLE, 'qwen2.5-coder:7b');
      popup.showTrace({ tasks: TASKS, timings: TIMINGS, reply: REPLY });
      expect(detailsButton().getAttribute('aria-expanded')).toBe('false');
      expect(detailsButton().getAttribute('aria-controls')).toBe(panel().id);

      detailsButton().click();
      expect(panel().hidden).toBe(false);
      expect(detailsButton().getAttribute('aria-expanded')).toBe('true');
      expect(
        rows().map((r) => [
          r.querySelector('.task-label')!.textContent,
          r.querySelector('.task-time')!.textContent,
        ]),
      ).toEqual([
        ['Find the code', '4 ms · 0%'],
        ['Read the PR description', '100 ms · 1%'],
        ['Fetch the file at head', '300 ms · 2%'],
        ['Load', '4.1 s · 29%'],
        ['Read prompt', '1.3 s · 9%'],
        ['Think', '~4.0 s · 28%'],
        ['Write answer', '~4.0 s · 28%'],
        ['Other model wait', '100 ms · 1%'],
        ['Show answer', '300 ms · 2%'],
      ]);
      expect(panel().querySelector('.trace-total')!.textContent).toBe(
        'Total 14.2 s · first word at 5.9 s (the line on the bars) · ' +
          '~ estimated from the share of what the model wrote that was thinking',
      );

      detailsButton().click();
      expect(panel().hidden).toBe(true);
      expect(detailsButton().getAttribute('aria-expanded')).toBe('false');
    });

    it('splits Think by thinking returned in its own field, and never shows it as the answer (PR 9.5)', () => {
      const popup = openPopup(ANCHOR, { now: () => 0 });
      popup.showExplanation(SAMPLE, 'qwen2.5-coder:7b');
      const thinking = 'secret plan '.repeat(4) + 'xx'; // 50 characters
      popup.showTrace({ tasks: TASKS, timings: TIMINGS, reply: 'a'.repeat(50), thinking });
      detailsButton().click();
      const think = rows().find((r) => r.dataset.task === 'think')!;
      expect(think.querySelector('.task-time')!.textContent).toBe('~4.0 s · 28%');
      expect(shadow().querySelector('.body')!.textContent).not.toContain('secret plan');
    });

    it('draws each bar where the task started and as long as it took, overlapping for tasks at the same time', () => {
      const popup = openPopup(ANCHOR);
      popup.showExplanation(SAMPLE, 'qwen2.5-coder:7b');
      popup.showTrace({ tasks: TASKS, timings: TIMINGS, reply: REPLY });
      const bar = (key: string) =>
        panel().querySelector<HTMLElement>(`li[data-task="${key}"] .bar`)!.style;
      const pct = (ms: number) => `${(ms / 14_200) * 100}%`;
      expect(bar('pr-description').left).toBe(pct(4));
      expect(bar('file-at-head').left).toBe(pct(4));
      expect(bar('load').left).toBe(pct(400));
      expect(bar('think').left).toBe(pct(5_800));
      const marks = panel().querySelectorAll<HTMLElement>('.first-token');
      expect(marks).toHaveLength(rows().length);
      expect(marks[0]!.style.left).toBe(pct(5_900));
    });

    it('gives screen readers one sentence per row and hides the drawing', () => {
      const popup = openPopup(ANCHOR);
      popup.showExplanation(SAMPLE, 'qwen2.5-coder:7b');
      popup.showTrace({ tasks: TASKS, timings: TIMINGS, reply: REPLY });
      expect(panel().querySelector('ul')!.getAttribute('aria-label')).toBe('Where the time went');
      const think = panel().querySelector<HTMLElement>('li[data-task="think"]')!;
      expect(think.querySelector('.sr-only')!.textContent).toBe(
        'Think (estimated), 4.0 s, 28% of the total, started at 5.8 s, about 120 tokens',
      );
      for (const part of ['.task-label', '.track', '.task-time']) {
        expect(think.querySelector(part)!.getAttribute('aria-hidden')).toBe('true');
      }
    });

    it('shows a cached answer with only its own short trace and no model rows', () => {
      const popup = openPopup(ANCHOR);
      popup.showExplanation(SAMPLE, 'qwen2.5-coder:7b', { elapsedMs: 9_000 });
      popup.showTrace({
        tasks: [
          task('find-code', 0, 2),
          task('cache', 3, 3, { source: 'worker' }),
          task('show', 6, 2),
        ],
      });
      expect(detailsButton().hidden).toBe(false);
      expect(rows().map((r) => r.dataset.task)).toEqual(['find-code', 'cache', 'show']);
      expect(panel().querySelector('.first-token')).toBeNull();
      expect(panel().querySelector('.trace-total')!.textContent).toBe('Total 8 ms');
    });

    it('shows the trace of a failed answer, under the error', () => {
      const popup = openPopup(ANCHOR);
      popup.showError('The model took too long to answer.', 'Try again.');
      popup.showTrace({
        tasks: [
          task('find-code', 0, 2),
          task('model', 10, 30_000, { source: 'worker', status: 'failed' }),
          task('show', 30_010, 5),
        ],
      });
      expect(shadow().querySelector('.error .message')!.textContent).toBe(
        'The model took too long to answer.',
      );
      expect(detailsButton().hidden).toBe(false);
      const model = panel().querySelector<HTMLElement>('li[data-task="model"]')!;
      expect(model.dataset.status).toBe('failed');
      expect(model.querySelector('.task-time')!.textContent).toBe('failed after 30.0 s');
    });

    it("says when Ollama's times were scaled to fit the measured wait", () => {
      const popup = openPopup(ANCHOR);
      popup.showExplanation(SAMPLE, 'qwen2.5-coder:7b');
      popup.showTrace({
        tasks: [task('model', 0, 1_000, { source: 'worker' })],
        timings: { loadMs: 1_000, answerMs: 1_000 },
      });
      expect(panel().querySelector('.trace-total')!.textContent).toContain(
        "Ollama's own times added up to more than the measured wait, so they are scaled to fit",
      );
    });

    it('goes away when Regenerate asks again', () => {
      const popup = openPopup(ANCHOR);
      popup.showExplanation(SAMPLE, 'qwen2.5-coder:7b');
      popup.showTrace({ tasks: TASKS, timings: TIMINGS });
      detailsButton().click();
      shadow().querySelector<HTMLButtonElement>('button.regenerate')!.click();
      expect(detailsButton().hidden).toBe(true);
      expect(panel().hidden).toBe(true);
      expect(panel().children).toHaveLength(0);
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
      expect(shadow().querySelector('.loading')!.textContent).toBe(
        'Explaining with qwen2.5-coder:7b…',
      );
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

  describe('Ask a question', () => {
    const askButton = () => shadow().querySelector<HTMLButtonElement>('.ask');
    const footerShown = () =>
      shadow().querySelector('.popup')!.getAttribute('data-state') === 'done';

    it('is shown only once an explanation is shown', () => {
      const popup = openPopup(ANCHOR, { onAsk: vi.fn() });
      expect(askButton()!.textContent).toBe('Ask a question');
      expect(footerShown()).toBe(false);
      popup.showPartial('Adds');
      expect(footerShown()).toBe(false);
      popup.showExplanation(SAMPLE, 'm');
      expect(footerShown()).toBe(true);
      expect(shadow().textContent).not.toContain('Thinking');
    });

    it('closes the popup, then calls onAsk', () => {
      const calls: string[] = [];
      const popup = openPopup(ANCHOR, {
        onAsk: () => calls.push(`ask, popup ${popup.state}`),
        onClose: () => calls.push('closed'),
      });
      popup.showExplanation(SAMPLE, 'm');
      askButton()!.click();
      expect(calls).toEqual(['closed', 'ask, popup closed']);
      expect(currentPopup()).toBeNull();
    });

    it('does nothing before the explanation is shown', () => {
      const onAsk = vi.fn();
      const popup = openPopup(ANCHOR, { onAsk });
      askButton()!.click();
      popup.showError('Failed.', 'Fix.');
      askButton()!.click();
      expect(onAsk).not.toHaveBeenCalled();
      expect(popup.state).toBe('failed');
    });

    it('is left out without onAsk', () => {
      openPopup(ANCHOR).showExplanation(SAMPLE, 'm');
      expect(askButton()).toBeNull();
    });
  });

  // PR 9.4: with the Debug window setting on, the content script passes onDebug.
  describe('Debug button', () => {
    const debugButton = () => shadow().querySelector<HTMLButtonElement>('.header .debug');

    it('is shown in the header, while loading and after, and opens the debug window', () => {
      const onDebug = vi.fn();
      const popup = openPopup(ANCHOR, { onDebug });
      expect(debugButton()!.textContent).toBe('Debug');
      expect(debugButton()!.type).toBe('button');
      expect(debugButton()!.title).toMatch(/debug window/);
      debugButton()!.click();
      popup.showExplanation(SAMPLE, 'm');
      debugButton()!.click();
      expect(onDebug).toHaveBeenCalledTimes(2);
      // The popup stays open beside the window.
      expect(popup.state).toBe('done');
    });

    it('is left out with the setting off (no onDebug)', () => {
      openPopup(ANCHOR, { onAsk: vi.fn() }).showExplanation(SAMPLE, 'm');
      expect(debugButton()).toBeNull();
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
