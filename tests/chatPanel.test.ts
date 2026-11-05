import {
  CHAT_PANEL_ID,
  currentChatPanel,
  formatLines,
  openChatPanel,
  STOPPED_EMPTY,
  STOPPED_NOTE,
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

  describe('the whole answer at once (PR 9.6, the default)', () => {
    const ask = (options: Partial<ChatPanelOptions> = {}) => {
      const chat = open(options);
      chat.addMessage('user', 'Why?');
      const answer = chat.addMessage('assistant', '');
      chat.setBusy(true);
      return { chat, answer };
    };

    it('says it is busy while an answer is written, for Explain ahead (PR 9.10)', () => {
      const { chat } = ask();
      expect(chat.isBusy).toBe(true);
      chat.setBusy(false);
      expect(chat.isBusy).toBe(false);
    });

    it('keeps the answer empty ("Thinking…") while it is written', () => {
      const { answer } = ask();
      answer.update('Use `vi.fn()`');
      answer.update('Use `vi.fn()` and **fake timers**.');
      expect(answer.element.childNodes).toHaveLength(0);
      expect(answer.element.matches(':empty')).toBe(true);
    });

    it('shows the whole answer in one update when the panel stops being busy', () => {
      const { chat, answer } = ask();
      answer.update('Use `vi.fn()`');
      answer.update('Use `vi.fn()` and **fake timers**.');
      const observer = new MutationObserver(() => {});
      observer.observe(answer.element, { childList: true });
      chat.setBusy(false);
      const changes = observer.takeRecords();
      observer.disconnect();
      expect(changes).toHaveLength(1);
      expect(answer.element.querySelector('code')?.textContent).toBe('vi.fn()');
      expect(answer.element.textContent).toBe('Use vi.fn() and fake timers.');
      // Once it has ended, updates show at once.
      answer.update('Edited.');
      expect(answer.element.textContent).toBe('Edited.');
    });

    it('shows what was written when the answer is stopped', () => {
      const { answer } = ask();
      answer.update('It **matches**');
      answer.showStopped();
      expect(answer.element.querySelector('strong')!.textContent).toBe('matches');
      expect(answer.element.querySelector('.stopped-note')!.textContent).toBe(STOPPED_NOTE);
    });

    it('drops the kept-back text when the answer fails', () => {
      const { chat, answer } = ask();
      answer.update('Half an answer');
      answer.showError('It broke.', 'Fix it.');
      chat.setBusy(false);
      expect(answer.element.textContent).toBe('It broke.Fix it.');
    });

    it('shows earlier messages and questions at once', () => {
      const { chat } = ask();
      const question = chat.addMessage('user', 'Another?');
      question.update('Another one?');
      expect(question.element.textContent).toBe('Another one?');
    });

    it('shows each update while it is written with Show answers as they are written on', () => {
      const { answer } = ask({ streamAnswers: true });
      answer.update('Use `vi.fn()`');
      expect(answer.element.querySelector('code')?.textContent).toBe('vi.fn()');
    });
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

  it('shows notes between messages, with inline code and no HTML', () => {
    const chat = open({ messages: [{ role: 'note', text: 'Now looking at `a.ts` line 3' }] });
    chat.addMessage('user', 'Q');
    chat.addNote('Now looking at `<b>b.ts</b>` line 9');
    const notes = [...shadow().querySelectorAll('.note')];
    expect(notes.map((n) => n.textContent)).toEqual([
      'Now looking at a.ts line 3',
      'Now looking at <b>b.ts</b> line 9',
    ]);
    expect(notes[0]!.querySelector('code')?.textContent).toBe('a.ts');
    expect(shadow().querySelector('b')).toBeNull();
    // Notes are not messages.
    expect(chat.messages).toHaveLength(1);
    expect(list().lastElementChild).toBe(notes[1]);
  });

  it('changes the header when the subject changes', () => {
    const chat = open();
    chat.setSubject({ filePath: 'src/other.ts', startLine: 42 });
    expect(shadow().querySelector('.file')!.textContent).toBe('src/other.ts');
    expect(shadow().querySelector('.lines')!.textContent).toBe('line 42');
    expect(shadow().querySelector<HTMLElement>('.subject')!.title).toBe('src/other.ts, line 42');
  });

  it('shows New chat only with onNewChat, and clear empties the list', () => {
    open();
    expect(shadow().querySelector('.new-chat')).toBeNull();

    const onNewChat = vi.fn();
    const chat = open({ onNewChat, messages: [{ role: 'assistant', text: 'Hi' }] });
    chat.addNote('Now looking at line 2');
    const button = shadow().querySelector<HTMLButtonElement>('.new-chat')!;
    expect(button.textContent).toBe('New chat');
    button.click();
    expect(onNewChat).toHaveBeenCalledTimes(1);

    chat.clear();
    expect(list().children).toHaveLength(0);
    expect(chat.messages).toEqual([]);
    chat.close();
    button.click();
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('focuses the text box', () => {
    const chat = open();
    chat.focus();
    expect(shadow().activeElement).toBe(input());
  });

  describe('Stop, errors and stopped answers', () => {
    const stopButton = () => shadow().querySelector<HTMLButtonElement>('.stop')!;
    const busy = () => shadow().querySelector('.chat')!.getAttribute('data-busy');

    it('Stop calls onStop only while an answer is being written', () => {
      const onStop = vi.fn();
      const chat = open({ onStop });
      expect(stopButton().textContent).toBe('Stop');
      stopButton().click();
      expect(onStop).not.toHaveBeenCalled();
      chat.setBusy(true);
      expect(busy()).toBe('true');
      stopButton().click();
      expect(onStop).toHaveBeenCalledOnce();
    });

    it('shows an error with its fix, as text', () => {
      const chat = open();
      const answer = chat.addMessage('assistant', 'Part');
      answer.showError('Could not reach `localhost` <img src=x>', 'Start Ollama.');
      expect(answer.element.dataset.status).toBe('failed');
      expect(answer.element.getAttribute('role')).toBe('alert');
      expect(answer.element.querySelector('.error-message')!.textContent).toBe(
        'Could not reach localhost <img src=x>',
      );
      expect(answer.element.querySelector('.error-message code')).not.toBeNull();
      expect(answer.element.querySelector('img')).toBeNull();
      expect(answer.element.querySelector('.fix')!.textContent).toBe('Start Ollama.');
    });

    it('marks a stopped answer, keeping its text', () => {
      const chat = open();
      const partial = chat.addMessage('assistant', 'It **matches**');
      partial.showStopped();
      expect(partial.element.querySelector('strong')!.textContent).toBe('matches');
      expect(partial.element.querySelector('.stopped-note')!.textContent).toBe(STOPPED_NOTE);
      const empty = chat.addMessage('assistant', '');
      empty.showStopped();
      expect(empty.element.textContent).toBe(STOPPED_EMPTY);
    });
  });

  describe('answer timer (PR 8.1)', () => {
    let time = 0;
    const elapsed = () => [...shadow().querySelectorAll<HTMLElement>('.elapsed')];
    const ask = () => {
      const panel = openChatPanel({ subject: SUBJECT, now: () => time });
      panel.addMessage('user', 'Why?');
      const answer = panel.addMessage('assistant', '');
      panel.setBusy(true);
      return { panel, answer };
    };

    beforeEach(() => {
      time = 0;
      vi.useFakeTimers();
    });
    afterEach(() => vi.useRealTimers());

    it('ticks under the answer while it is written, then says how long it took', () => {
      const { panel, answer } = ask();
      expect(elapsed()).toHaveLength(1);
      expect(answer.element.nextElementSibling).toBe(elapsed()[0]);
      expect(elapsed()[0]!.textContent).toBe('0.0 s');
      // Hidden from screen readers while it ticks, so the log is not re-read.
      expect(elapsed()[0]!.getAttribute('aria-hidden')).toBe('true');

      time = 2_340;
      vi.advanceTimersByTime(100);
      expect(elapsed()[0]!.textContent).toBe('2.3 s');
      answer.update('Because.');
      time = 4_150;
      panel.setBusy(false);
      expect(elapsed()[0]!.textContent).toBe('Answered in 4.1 s');
      expect(elapsed()[0]!.hasAttribute('aria-hidden')).toBe(false);
      time = 9_000;
      vi.advanceTimersByTime(1_000);
      expect(elapsed()[0]!.textContent).toBe('Answered in 4.1 s');
    });

    it('says "Failed after" or "Stopped after", even when called after setBusy(false)', () => {
      const first = ask();
      time = 1_500;
      first.panel.setBusy(false);
      first.answer.showError('Ollama is not running.', 'Start it.');
      expect(elapsed()[0]!.textContent).toBe('Failed after 1.5 s');

      const second = first.panel.addMessage('assistant', '');
      first.panel.setBusy(true);
      time = 2_000;
      second.showStopped();
      first.panel.setBusy(false);
      expect(elapsed()[1]!.textContent).toBe('Stopped after 0.5 s');
      expect(elapsed()[0]!.textContent).toBe('Failed after 1.5 s');
    });

    it('times each answer separately, and not the earlier messages', () => {
      const panel = openChatPanel({
        subject: SUBJECT,
        now: () => time,
        messages: [{ role: 'assistant', text: 'The explanation.' }],
      });
      expect(elapsed()).toHaveLength(0);
      panel.addMessage('user', 'Why?');
      panel.addMessage('assistant', '');
      panel.setBusy(true);
      panel.setBusy(true);
      expect(elapsed()).toHaveLength(1);
      time = 3_000;
      panel.setBusy(false);
      panel.addMessage('user', 'And?');
      panel.addMessage('assistant', '');
      time = 4_000;
      panel.setBusy(true);
      time = 5_000;
      panel.setBusy(false);
      expect(elapsed().map((e) => e.textContent)).toEqual([
        'Answered in 3.0 s',
        'Answered in 1.0 s',
      ]);
    });

    it('stops ticking when the chat is cleared or closed', () => {
      const { panel } = ask();
      panel.clear();
      expect(elapsed()).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      panel.addMessage('assistant', '');
      panel.setBusy(true);
      expect(vi.getTimerCount()).toBe(1);
      panel.close();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

// PR 11.8: the same panel draws the chat in Chrome's side panel.
describe('chat panel in both places', () => {
  afterEach(() => {
    currentChatPanel()?.close();
    document.documentElement.removeAttribute('data-color-mode');
  });

  const host = () => document.getElementById(CHAT_PANEL_ID)!;
  const chat = () => shadow().querySelector<HTMLElement>('.chat')!;

  it('floats over the page as a dialog by default', () => {
    open();
    expect(host().dataset.layout).toBeUndefined();
    expect(chat().getAttribute('role')).toBe('dialog');
  });

  it('fills the side panel as a region with layout fill', () => {
    open({ layout: 'fill' });
    expect(host().dataset.layout).toBe('fill');
    expect(chat().getAttribute('role')).toBe('region');
    const style = shadow().querySelector('style')!.textContent!;
    expect(style).toContain(":host([data-layout='fill'])");
  });

  it('works the same in the side panel: send, answer, stop and New chat', () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const onNewChat = vi.fn();
    const panel = open({ layout: 'fill', onSend, onStop, onNewChat, streamAnswers: true });
    type('Why retry?');
    press('Enter');
    expect(onSend).toHaveBeenCalledWith('Why retry?');
    const answer = panel.addMessage('assistant', '');
    panel.setBusy(true);
    answer.update('Because the network fails.');
    expect(shown()).toEqual([
      ['user', 'Why retry?'],
      ['assistant', 'Because the network fails.'],
    ]);
    shadow().querySelector<HTMLButtonElement>('.stop')!.click();
    expect(onStop).toHaveBeenCalledTimes(1);
    shadow().querySelector<HTMLButtonElement>('.new-chat')!.click();
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('is not closed by Esc in the side panel, but is on the page', () => {
    const side = open({ layout: 'fill' });
    press('Escape');
    expect(side.isOpen).toBe(true);
    side.close();
    const onPage = open();
    press('Escape');
    expect(onPage.isOpen).toBe(false);
  });

  it('takes the theme it is given instead of the page it is on', () => {
    document.documentElement.setAttribute('data-color-mode', 'light');
    open({ layout: 'fill', theme: 'dark' });
    expect(host().dataset.theme).toBe('dark');
    // A change on this page does not move it; the side panel sets it.
    document.documentElement.setAttribute('data-color-mode', 'dark');
    document.documentElement.setAttribute('data-color-mode', 'light');
    expect(host().dataset.theme).toBe('dark');
  });

  it('follows the page it is on when no theme is given', () => {
    document.documentElement.setAttribute('data-color-mode', 'dark');
    open();
    expect(host().dataset.theme).toBe('dark');
  });
});
