import { openChatPanel } from '../src/chat/chatPanel';
import { CHAT_PANEL_STYLE } from '../src/chat/chatPanelStyle';
import { openPopup } from '../src/popup/popup';
import { POPUP_STYLE } from '../src/popup/popupStyle';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClickHandlerDeps } from '../src/clickHandler';
import type { Popup, PopupAnchor } from '../src/popup/popup';
import { installSelection, SELECTION_UI_ID } from '../src/selection';
import { applyTheme, followTheme, resolveTheme, THEME_VARS, watchTheme } from '../src/theme';

const html = document.documentElement;

/** A fake `prefers-color-scheme: dark` query whose answer the test can change. */
function fakeSystem(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return dark;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  const spy = vi.spyOn(window, 'matchMedia').mockReturnValue(query as unknown as MediaQueryList);
  return {
    spy,
    listeners,
    set(next: boolean) {
      dark = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** Sets GitHub's appearance attributes on <html>. */
function setGitHub(mode: string, light = 'light', dark = 'dark'): void {
  html.setAttribute('data-color-mode', mode);
  html.setAttribute('data-light-theme', light);
  html.setAttribute('data-dark-theme', dark);
}

/** Lets a MutationObserver callback run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  // jsdom has no matchMedia; most tests use a light system.
  window.matchMedia ??= (() => ({ matches: false })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of ['data-color-mode', 'data-light-theme', 'data-dark-theme']) {
    html.removeAttribute(name);
  }
  document.body.innerHTML = '';
});

describe('resolveTheme', () => {
  it.each([
    ['light', 'light', 'dark', 'light'],
    ['dark', 'light', 'dark', 'dark'],
    ['dark', 'light', 'dark_dimmed', 'dark'],
    ['dark', 'light', 'dark_high_contrast', 'dark'],
    ['light', 'light_colorblind', 'dark', 'light'],
    // A user can pick a dark theme for "day" and a light one for "night".
    ['light', 'dark_dimmed', 'light', 'dark'],
    ['dark', 'light', 'light_high_contrast', 'light'],
  ])('mode %s with day theme %s and night theme %s is %s', (mode, light, dark, expected) => {
    fakeSystem(true);
    setGitHub(mode, light, dark);
    expect(resolveTheme(document)).toBe(expected);
  });

  it('follows the system in auto mode', () => {
    const system = fakeSystem(false);
    setGitHub('auto');
    expect(resolveTheme(document)).toBe('light');
    system.set(true);
    expect(resolveTheme(document)).toBe('dark');
    expect(system.spy).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
  });

  it('follows the system when the page has no GitHub attributes', () => {
    fakeSystem(true);
    expect(resolveTheme(document)).toBe('dark');
  });

  it('uses the mode when the theme name is missing or unknown', () => {
    fakeSystem(false);
    html.setAttribute('data-color-mode', 'dark');
    expect(resolveTheme(document)).toBe('dark');
    html.setAttribute('data-dark-theme', 'something_new');
    expect(resolveTheme(document)).toBe('dark');
  });
});

describe('watchTheme', () => {
  it('reports a change of GitHub setting once, and not attribute changes that keep the theme', async () => {
    fakeSystem(false);
    setGitHub('light');
    const onChange = vi.fn();
    const stop = watchTheme(document, onChange);
    html.setAttribute('data-color-mode', 'dark');
    await flush();
    expect(onChange).toHaveBeenCalledExactlyOnceWith('dark');
    html.setAttribute('data-dark-theme', 'dark_dimmed');
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('reports a system change in auto mode, and nothing after it stops', () => {
    const system = fakeSystem(false);
    setGitHub('auto');
    const onChange = vi.fn();
    const stop = watchTheme(document, onChange);
    system.set(true);
    expect(onChange).toHaveBeenCalledExactlyOnceWith('dark');
    stop();
    expect(system.listeners.size).toBe(0);
    system.set(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('panels in light and dark mode', () => {
  it('applyTheme marks a host with the page theme', () => {
    fakeSystem(false);
    setGitHub('dark');
    const host = document.createElement('div');
    expect(applyTheme(host)).toBe('dark');
    expect(host.dataset.theme).toBe('dark');
  });

  it('opens the popup and the chat panel in the page theme', () => {
    fakeSystem(false);
    setGitHub('dark');
    const popup = openPopup({ top: 0, bottom: 10, left: 0 });
    expect(popup.host.dataset.theme).toBe('dark');
    popup.close();
    setGitHub('light');
    const chat = openChatPanel({ subject: { filePath: 'a.ts', startLine: 1 } });
    expect(chat.host.dataset.theme).toBe('light');
    chat.close();
  });

  it('switches an open popup and chat panel when GitHub switches, and stops watching once closed', async () => {
    const system = fakeSystem(false);
    setGitHub('auto');
    const popup = openPopup({ top: 0, bottom: 10, left: 0 });
    const chat = openChatPanel({ subject: { filePath: 'a.ts', startLine: 1 } });
    expect(popup.host.dataset.theme).toBe('light');
    system.set(true);
    expect(popup.host.dataset.theme).toBe('dark');
    expect(chat.host.dataset.theme).toBe('dark');
    html.setAttribute('data-color-mode', 'light');
    await flush();
    expect(chat.host.dataset.theme).toBe('light');
    popup.close();
    chat.close();
    expect(system.listeners.size).toBe(0);
  });

  it('followTheme keeps a host in step until stopped', async () => {
    fakeSystem(false);
    setGitHub('light');
    const host = document.createElement('div');
    const stop = followTheme(host);
    html.setAttribute('data-color-mode', 'dark');
    await flush();
    expect(host.dataset.theme).toBe('dark');
    stop();
    html.setAttribute('data-color-mode', 'light');
    await flush();
    expect(host.dataset.theme).toBe('dark');
  });

  it('defines every color the popup and chat styles use, for both themes', () => {
    const used = new Set(
      [...`${POPUP_STYLE}${CHAT_PANEL_STYLE}`.matchAll(/var\((--pe-[a-z-]+)\)/g)].map((m) => m[1]),
    );
    const [light, dark] = THEME_VARS.split(":host([data-theme='dark'])");
    const defined = (block: string) =>
      new Set([...block!.matchAll(/(--pe-[a-z-]+):/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(10);
    for (const name of used) {
      expect(defined(light!), name).toContain(name);
      expect(defined(dark!), name).toContain(name);
    }
  });

  it('leaves no fixed colors in the popup and chat styles', () => {
    const own = (style: string) => style.replace(THEME_VARS, '');
    for (const style of [POPUP_STYLE, CHAT_PANEL_STYLE]) {
      expect(own(style)).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });
});

describe('the Explain selection bar', () => {
  const ANCHOR = 'diff-6a17656d764b8e1930354f341cf7f47960b63845c3046edcd8bbf282aaa2f464';
  const code = (id: string) =>
    document.querySelector(`td[data-line-anchor="${ANCHOR}${id}"] .diff-text-inner`)!;
  const bar = () => document.getElementById(SELECTION_UI_ID);
  const click = (target: Element, shiftKey = false) => {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, shiftKey }));
    }
  };
  const deps = {
    explain: () => ({ result: new Promise<never>(() => {}), stop: () => {} }),
    openPopup: (_: PopupAnchor, hooks: Parameters<ClickHandlerDeps['openPopup']>[1]) =>
      ({ close: () => hooks.onClose() }) as Popup,
  };

  it('opens in the page theme, switches while shown, and stops watching once gone', () => {
    const system = fakeSystem(true);
    setGitHub('auto');
    document.body.innerHTML = readFileSync(
      resolve(import.meta.dirname, 'fixtures', 'github-diff-new.html'),
      'utf8',
    );
    const uninstall = installSelection(deps);
    click(code('R43'));
    click(code('R45'), true);
    expect(bar()?.dataset.theme).toBe('dark');
    system.set(false);
    expect(bar()?.dataset.theme).toBe('light');
    // A new bar replaces the old one, and only the new one is watched.
    click(code('R44'));
    click(code('R45'), true);
    expect(system.listeners.size).toBe(1);
    uninstall();
    expect(bar()).toBeNull();
    expect(system.listeners.size).toBe(0);
  });
});
