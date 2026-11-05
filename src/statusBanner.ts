// The Ollama status banner (PR 11.6), the content script's side of
// src/llm/ollamaStatus.ts. While Ollama is not running, or does not have the
// explanation model, a PR's diffs show one slim banner at the top of the
// window with the fix and a Try again button, instead of every click and
// background request failing with its own error. It goes away by itself
// when the service worker finds Ollama up again.
//
// The service worker keeps the status in chrome.storage.local, so every tab
// follows it from there and shows (or removes) its banner at once. Like the
// badge, the banner lives in a Shadow DOM so GitHub's CSS cannot restyle it.
//
// It imports types only from the service worker's side, as the content
// script cannot share runtime code with it (see src/content.ts).

import type { OLLAMA_STATUS_KEY as WORKER_STATUS_KEY, OllamaStatus } from './llm/ollamaStatus';
import { applyTheme, THEME_VARS, watchTheme } from './theme';

/** The chrome.storage.local key the service worker keeps the status under. */
export const OLLAMA_STATUS_KEY: typeof WORKER_STATUS_KEY = 'ollamaStatus';

export const BANNER_ID = 'pr-explainer-status';

export type BannerPlatform = 'windows' | 'mac' | 'other';

/** Guesses the platform from a user agent, for how to start Ollama. */
export function bannerPlatform(userAgent: string): BannerPlatform {
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(userAgent)) return 'mac';
  return 'other';
}

export interface BannerText {
  /** What is wrong, in one short sentence. */
  message: string;
  /** What to do about it. */
  fix: string;
  /** A command to run, shown as code after the fix. */
  command?: string;
}

/** The banner's words for `status`, or null when there is nothing to show. */
export function bannerText(status: OllamaStatus, platform: BannerPlatform): BannerText | null {
  if (status.state === 'down') {
    return {
      message: 'Ollama is not running.',
      fix:
        platform === 'windows'
          ? 'Start it from the Start menu.'
          : platform === 'mac'
            ? 'Open the Ollama app.'
            : 'Start the Ollama app, or run',
      ...(platform === 'other' && { command: 'ollama serve' }),
    };
  }
  if (status.state === 'model-missing') {
    const model = status.model?.trim();
    const shell =
      platform === 'windows' ? 'Command Prompt' : platform === 'mac' ? 'Terminal' : 'a terminal';
    return {
      message: model
        ? `The model "${model}" is not installed in Ollama.`
        : 'The model is not installed in Ollama.',
      fix: `Pick another in the settings, or install it in ${shell}:`,
      command: `ollama pull ${model || '<model>'}`,
    };
  }
  return null;
}

const STYLE = `
  :host {
    all: initial;
    position: fixed;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483645;
    max-width: calc(100vw - 32px);
  }
  ${THEME_VARS}
  .banner {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px 6px 12px;
    background: var(--pe-danger-subtle-bg);
    color: var(--pe-fg);
    border: 1px solid var(--pe-danger-border);
    border-radius: 6px;
    box-shadow: 0 4px 12px var(--pe-shadow);
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
  }
  :host([data-theme='dark']) .banner { background: var(--pe-bg); }
  .icon { flex: none; color: var(--pe-danger); font-weight: 700; }
  .text { min-width: 0; }
  .text strong { font-weight: 600; }
  .brand { color: var(--pe-muted); }
  code {
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--pe-code-bg);
    font: 12px ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    white-space: nowrap;
  }
  .retry {
    flex: none;
    padding: 3px 10px;
    border: 1px solid var(--pe-border);
    border-radius: 6px;
    background: var(--pe-subtle-bg);
    color: var(--pe-fg);
    font: inherit;
    font-weight: 500;
    cursor: pointer;
  }
  .retry:hover:not(:disabled) { background: var(--pe-hover-bg); }
  .retry:disabled { color: var(--pe-muted); cursor: default; }
  .retry:focus-visible { outline: 2px solid var(--pe-focus); outline-offset: 1px; }
`;

export function findStatusBanner(doc: Document): HTMLElement | null {
  return doc.getElementById(BANNER_ID);
}

const stopTheme = new WeakMap<HTMLElement, () => void>();

export function removeStatusBanner(doc: Document): void {
  const host = findStatusBanner(doc);
  if (!host) return;
  stopTheme.get(host)?.();
  host.remove();
}

export interface BannerOptions {
  platform: BannerPlatform;
  /** The Try again button: resolves once the check is done. */
  onRetry(): Promise<unknown>;
}

/**
 * Shows the banner for `status`, or updates the one already on the page (a
 * tab has at most one), and removes it when Ollama is up. Returns the
 * banner's host, or null when none is shown.
 */
export function showStatusBanner(
  doc: Document,
  status: OllamaStatus,
  options: BannerOptions,
): HTMLElement | null {
  const text = bannerText(status, options.platform);
  if (!text) {
    removeStatusBanner(doc);
    return null;
  }
  let host = findStatusBanner(doc);
  if (!host) {
    host = doc.createElement('div');
    host.id = BANNER_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = STYLE;
    const banner = doc.createElement('div');
    banner.className = 'banner';
    banner.setAttribute('role', 'status');
    const icon = doc.createElement('span');
    icon.className = 'icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '!';
    const body = doc.createElement('span');
    body.className = 'text';
    const retry = doc.createElement('button');
    retry.type = 'button';
    retry.className = 'retry';
    retry.textContent = 'Try again';
    banner.append(icon, body, retry);
    shadow.append(style, banner);
    doc.body.append(host);
    applyTheme(host, doc);
    const themed = host;
    stopTheme.set(
      host,
      watchTheme(doc, (theme) => {
        themed.dataset.theme = theme;
      }),
    );
  }
  host.dataset.state = status.state;
  const shadow = host.shadowRoot!;
  const banner = shadow.querySelector<HTMLElement>('.banner')!;
  const body = shadow.querySelector<HTMLElement>('.text')!;
  const strong = doc.createElement('strong');
  strong.textContent = text.message;
  const brand = doc.createElement('span');
  brand.className = 'brand';
  brand.textContent = 'PR Explainer: ';
  const parts: Node[] = [brand, strong, doc.createTextNode(` ${text.fix}`)];
  if (text.command) {
    const code = doc.createElement('code');
    code.textContent = text.command;
    parts.push(doc.createTextNode(' '), code);
  }
  body.replaceChildren(...parts);
  const spoken = [text.message, text.fix, text.command].filter(Boolean).join(' ');
  banner.setAttribute('aria-label', `PR Explainer: ${spoken}`);
  // The latest options, so a retry uses this page's.
  const retry = shadow.querySelector<HTMLButtonElement>('.retry')!;
  retry.onclick = () => {
    if (retry.disabled) return;
    retry.disabled = true;
    retry.textContent = 'Checking…';
    const done = () => {
      retry.disabled = false;
      retry.textContent = 'Try again';
    };
    options.onRetry().then(done, done);
  };
  return host;
}

/** A stored status read back, or unknown when it is not one (it is checked, not trusted). */
export function toBannerStatus(value: unknown): OllamaStatus {
  if (typeof value !== 'object' || value === null) return { state: 'unknown' };
  const { state, model } = value as { state?: unknown; model?: unknown };
  if (state !== 'up' && state !== 'down' && state !== 'model-missing') return { state: 'unknown' };
  return { state, ...(typeof model === 'string' && model && { model }) };
}

export interface StatusChangedEvent {
  addListener(
    listener: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void,
  ): void;
}

export interface StatusFollower {
  current(): OllamaStatus;
  /** The status as the service worker answered it (a page asks when its diffs open). */
  set(status: unknown): void;
}

/**
 * Follows the status the service worker keeps in chrome.storage.local, from
 * each change. It does not read what is stored when the page opens, which
 * may be from before Chrome restarted: the page asks the worker instead,
 * which checks first (`set`).
 */
export function followOllamaStatus(
  events: StatusChangedEvent,
  onChange: (status: OllamaStatus) => void,
): StatusFollower {
  let current: OllamaStatus = { state: 'unknown' };
  const update = (value: unknown) => {
    const next = toBannerStatus(value);
    if (next.state === current.state && next.model === current.model) return;
    current = next;
    onChange(next);
  };
  events.addListener((changes, areaName) => {
    if (areaName === 'local' && Object.hasOwn(changes, OLLAMA_STATUS_KEY)) {
      update(changes[OLLAMA_STATUS_KEY]!.newValue);
    }
  });
  return { current: () => current, set: update };
}
