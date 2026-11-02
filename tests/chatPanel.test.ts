import {
  CHAT_PANEL_ID,
  currentChatPanel,
  formatLines,
  openChatPanel,
  type ChatPanelOptions,
} from '../src/chat/chatPanel';

const SUBJECT = { filePath: 'src/llm/retry.ts', startLine: 12, endLine: 18 };

function shadow(): ShadowRoot {
  const root = document.getElementById(CHAT_PANEL_ID)?.shadowRoot;
  if (!root) throw new Error('chat panel is not open');
  return root;
}

const input = () => shadow().querySelector<HTMLTextAreaElement>('.input')!;
const sendButton = () => shadow().querySelector<HTMLButtonElement>('.send')!;
const list = () => shadow().querySelector<HTMLElement>('.messages')!;
const shown = () =>
  [...shadow().querySelectorAll<HTMLElement>('.message')].map((el) => [
    el.dataset.role,
    el.textContent,
  ]);

function type(text: string): void {
  input().value = text;
  input().dispatchEvent(new Event('input', { bubbles: true }));
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  });
  input().dispatchEvent(event);
  return event;
}

/** jsdom has no layout, so give the list a fake size and scroll position. */
function fakeScroll(el: HTMLElement, sizes: { scrollHeight: number; clientHeight: number }): void {
  let height = sizes.scrollHeight;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => sizes.clientHeight });
  // Each new message makes the list 100 px taller.
  const append = el.append.bind(el);
  el.append = (...nodes) => {
    height += 100 * nodes.length;
    append(...nodes);
  };
}

function open(options: Partial<ChatPanelOptions> = {}) {
  return openChatPanel({ subject: SUBJECT, ...options });
}

describe('formatLines', () => {
  it('names one line or a range of lines', () => {
    expect(formatLines({ filePath: 'a.ts', startLine: 42 })).toBe('line 42');
    expect(formatLines({ filePath: 'a.ts', startLine: 42, endLine: 42 })).toBe('line 42');
    expect(formatLines({ filePath: 'a.ts', startLine: 12, endLine: 18 })).toBe('lines 12 to 18');
    expect(formatLines({ filePath: 'a.ts', startLine: 18, endLine: 12 })).toBe('lines 12 to 18');
  });
});

describe('chat panel', () => {
  afterEach(() => {
    currentChatPanel()?.close();
    document.body.innerHTML = '';
  });

  it('shows the file and lines being discussed in the header', () => {
    open();
    expect(shadow().querySelector('.title')?.textContent).toBe('Chat');
    expect(shadow().querySelector('.file')?.textContent).toBe('src/llm/retry.ts');
    expect(shadow().querySelector('.lines')?.textContent).toBe('lines 12 to 18');
    expect(shadow().querySelector<HTMLElement>('.subject')?.title).toBe(
      'src/llm/retry.ts, lines 12 to 18',
    );
    expect(shadow().querySelector('[role="dialog"]')).not.toBeNull();
    expect(shadow().querySelector('[role="log"]')).not.toBeNull();
  });

  it('renders a conversation in order, with answers as markdown', () => {
    const chat = open({
      messages: [
        { role: 'assistant', text: 'Retries **three** times.' },
        { role: 'user', text: 'Why three?' },
        { role: 'assistant', text: 'A guess:\n\n```ts\nconst MAX = 3;\n```' },
      ],
    });
    expect(shown()).toEqual([
      ['assistant', 'Retries three times.'],
      ['user', 'Why three?'],
      ['assistant', 'A guess:const MAX = 3;'],
    ]);
    const [first, , last] = chat.messages;
    expect(first!.element.querySelector('strong')?.textContent).toBe('three');
    expect(last!.element.querySelector('pre code')?.textContent).toBe('const MAX = 3;');
  });

  it('shows questions as plain text, without markdown', () => {
    const chat = open();
    chat.addMessage('user', 'Is **this** `safe`?');
    const el = chat.messages[0]!.element;
    expect(el.textContent).toBe('Is **this** `safe`?');
    expect(el.querySelector('strong, code')).toBeNull();
  });

  it('never runs HTML in an answer or a question', () => {
    const chat = open();
    chat.addMessage('assistant', '<img src=x onerror="alert(1)"> <script>alert(2)</script>');
    chat.addMessage('user', '<b>bold?</b>');
    expect(shadow().querySelector('img, script, b')).toBeNull();
    expect(shown()).toEqual([
      ['assistant', '<img src=x onerror="alert(1)"> <script>alert(2)</script>'],
      ['user', '<b>bold?</b>'],
    ]);
  });

  it('updates an answer as it streams in', () => {
    const chat = open();
    const answer = chat.addMessage('assistant', '');
    answer.update('Use `vi.fn()`');
    answer.update('Use `vi.fn()` and **fake timers**.');
    expect(answer.element.querySelector('code')?.textContent).toBe('vi.fn()');
    expect(answer.element.textContent).toBe('Use vi.fn() and fake timers.');
  });

  it('disables Send while the text box is empty or only spaces', () => {
    open();
    expect(sendButton().disabled).toBe(true);
    type('   \n ');
    expect(sendButton().disabled).toBe(true);
    type('How do I test this?');
    expect(sendButton().disabled).toBe(false);
    type('');
    expect(sendButton().disabled).toBe(true);
  });

  it('sends with Enter: adds the question, clears the box, and calls onSend', () => {
    const onSend = vi.fn();
    const chat = open({ onSend });
    type('  How do I test this?  ');
    const event = press('Enter');
    expect(event.defaultPrevented).toBe(true);
    expect(onSend).toHaveBeenCalledExactlyOnceWith('How do I test this?');
    expect(shown()).toEqual([['user', 'How do I test this?']]);
    expect(chat.messages[0]!.role).toBe('user');
    expect(input().value).toBe('');
    expect(sendButton().disabled).toBe(true);
  });

  it('sends with the Send button', () => {
    const onSend = vi.fn();
    open({ onSend });
    type('Why?');
    sendButton().click();
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Why?');
  });

  it('keeps Shift+Enter as a new line instead of sending', () => {
    const onSend = vi.fn();
    open({ onSend });
    type('First line');
    const event = press('Enter', { shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(shown()).toEqual([]);
  });

  it('does not send on Enter while an input method is composing a word', () => {
    const onSend = vi.fn();
    open({ onSend });
    type('にほん');
    press('Enter', { isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send an empty question with Enter', () => {
    const onSend = vi.fn();
    open({ onSend });
    type('   ');
    press('Enter');
    expect(onSend).not.toHaveBeenCalled();
    expect(shown()).toEqual([]);
  });

  it('does not send while busy, and allows it again after', () => {
    const onSend = vi.fn();
    const chat = open({ onSend });
    chat.setBusy(true);
    type('Next question');
    expect(sendButton().disabled).toBe(true);
    press('Enter');
    expect(onSend).not.toHaveBeenCalled();
    expect(input().value).toBe('Next question');
    chat.setBusy(false);
    expect(sendButton().disabled).toBe(false);
    press('Enter');
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Next question');
  });

  it('keeps key presses away from GitHub keyboard shortcuts', () => {
    open();
    const onPageKey = vi.fn();
    document.addEventListener('keydown', onPageKey);
    type('t');
    press('t');
    document.removeEventListener('keydown', onPageKey);
    expect(onPageKey).not.toHaveBeenCalled();
  });

  describe('auto-scroll', () => {
    it('scrolls to a new message when already at the bottom', () => {
      const chat = open();
      fakeScroll(list(), { scrollHeight: 300, clientHeight: 300 });
      chat.addMessage('assistant', 'New answer');
      expect(list().scrollTop).toBe(400);
    });

    it('follows an answer as it streams in', () => {
      const chat = open();
      fakeScroll(list(), { scrollHeight: 300, clientHeight: 300 });
      const answer = chat.addMessage('assistant', 'Part');
      // The longer text makes the list taller once it is rendered.
      Object.defineProperty(list(), 'scrollHeight', {
        configurable: true,
        get: () => (answer.element.textContent!.length > 4 ? 900 : 400),
      });
      answer.update('Part of a much longer answer');
      expect(list().scrollTop).toBe(900);
    });

    it('stays put when the user has scrolled up to read', () => {
      const chat = open();
      fakeScroll(list(), { scrollHeight: 1000, clientHeight: 300 });
      list().scrollTop = 100;
      const answer = chat.addMessage('assistant', 'New answer');
      expect(list().scrollTop).toBe(100);
      answer.update('New answer, longer');
      expect(list().scrollTop).toBe(100);
    });

    it('always scrolls to the question the user just sent', () => {
      open();
      fakeScroll(list(), { scrollHeight: 1000, clientHeight: 300 });
      list().scrollTop = 100;
      type('My question');
      press('Enter');
      expect(list().scrollTop).toBe(1100);
    });
  });

  it('closes with the × button and calls onClose once', () => {
    const onClose = vi.fn();
    const chat = open({ onClose });
    shadow().querySelector<HTMLButtonElement>('.close')!.click();
    expect(chat.isOpen).toBe(false);
    expect(document.getElementById(CHAT_PANEL_ID)).toBeNull();
    expect(currentChatPanel()).toBeNull();
    chat.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps one panel open at a time', () => {
    const first = open();
    const second = open({ subject: { filePath: 'b.ts', startLine: 3 } });
    expect(first.isOpen).toBe(false);
    expect(currentChatPanel()).toBe(second);
    expect(document.querySelectorAll(`#${CHAT_PANEL_ID}`)).toHaveLength(1);
    expect(shadow().querySelector('.lines')?.textContent).toBe('line 3');
  });

  it('keeps its styles inside the shadow root', () => {
    open();
    expect(document.head.querySelector('style')).toBeNull();
    expect(shadow().querySelector('style')?.textContent).toContain('.messages');
  });

  it('focuses the text box', () => {
    const chat = open();
    chat.focus();
    expect(shadow().activeElement).toBe(input());
  });
});
