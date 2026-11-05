import {
  BANNER_ID,
  bannerPlatform,
  bannerText,
  findStatusBanner,
  followOllamaStatus,
  OLLAMA_STATUS_KEY,
  removeStatusBanner,
  showStatusBanner,
  toBannerStatus,
  type BannerOptions,
  type StatusChangedEvent,
} from '../src/statusBanner';

const options = (overrides: Partial<BannerOptions> = {}): BannerOptions => ({
  platform: 'windows',
  onRetry: async () => {},
  ...overrides,
});

const parts = (host: HTMLElement) => {
  const shadow = host.shadowRoot!;
  return {
    banner: shadow.querySelector<HTMLElement>('.banner')!,
    text: shadow.querySelector<HTMLElement>('.text')!.textContent,
    retry: shadow.querySelector<HTMLButtonElement>('.retry')!,
  };
};

afterEach(() => {
  removeStatusBanner(document);
  document.body.replaceChildren();
});

describe('the banner text (PR 11.6)', () => {
  it('says how to start Ollama on each platform', () => {
    expect(bannerText({ state: 'down' }, 'windows')).toEqual({
      message: 'Ollama is not running.',
      fix: 'Start it from the Start menu.',
    });
    expect(bannerText({ state: 'down' }, 'mac')).toEqual({
      message: 'Ollama is not running.',
      fix: 'Open the Ollama app.',
    });
    expect(bannerText({ state: 'down' }, 'other')).toMatchObject({ command: 'ollama serve' });
  });

  it('names a missing model and the command that installs it', () => {
    expect(bannerText({ state: 'model-missing', model: 'qwen2.5-coder:7b' }, 'windows')).toEqual({
      message: 'The model "qwen2.5-coder:7b" is not installed in Ollama.',
      fix: 'Pick another in the settings, or install it in Command Prompt:',
      command: 'ollama pull qwen2.5-coder:7b',
    });
    expect(bannerText({ state: 'model-missing' }, 'mac')).toMatchObject({
      message: 'The model is not installed in Ollama.',
      command: 'ollama pull <model>',
    });
  });

  it('has nothing to say while Ollama is up or not checked yet', () => {
    expect(bannerText({ state: 'up' }, 'windows')).toBeNull();
    expect(bannerText({ state: 'unknown' }, 'windows')).toBeNull();
  });

  it('guesses the platform from the user agent', () => {
    expect(bannerPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(bannerPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('mac');
    expect(bannerPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('other');
  });
});

describe('the status banner (PR 11.6)', () => {
  it('shows one banner however often the status is told', () => {
    showStatusBanner(document, { state: 'down' }, options());
    showStatusBanner(document, { state: 'down' }, options());
    showStatusBanner(document, { state: 'model-missing', model: 'qwen' }, options());
    expect(document.querySelectorAll(`#${BANNER_ID}`)).toHaveLength(1);
    expect(parts(findStatusBanner(document)!).text).toBe(
      'PR Explainer: The model "qwen" is not installed in Ollama. ' +
        'Pick another in the settings, or install it in Command Prompt: ollama pull qwen',
    );
  });

  it('shows the fix for Ollama not running', () => {
    const host = showStatusBanner(document, { state: 'down' }, options())!;
    expect(parts(host).text).toBe(
      'PR Explainer: Ollama is not running. Start it from the Start menu.',
    );
    expect(host.dataset.state).toBe('down');
  });

  it('goes away when Ollama is back', () => {
    showStatusBanner(document, { state: 'down' }, options());
    expect(showStatusBanner(document, { state: 'up' }, options())).toBeNull();
    expect(findStatusBanner(document)).toBeNull();
  });

  it('is announced to screen readers with its whole message', () => {
    const { banner, retry } = parts(showStatusBanner(document, { state: 'down' }, options())!);
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('aria-label')).toBe(
      'PR Explainer: Ollama is not running. Start it from the Start menu.',
    );
    expect(retry.tagName).toBe('BUTTON');
    expect(retry.textContent).toBe('Try again');
  });

  it('checks again on Try again, once at a time', async () => {
    let finish!: () => void;
    const onRetry = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { retry } = parts(showStatusBanner(document, { state: 'down' }, options({ onRetry }))!);
    retry.click();
    retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(retry.disabled).toBe(true);
    expect(retry.textContent).toBe('Checking…');
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(retry.disabled).toBe(false);
    expect(retry.textContent).toBe('Try again');
  });

  it('follows GitHub dark mode', () => {
    document.documentElement.setAttribute('data-color-mode', 'dark');
    const host = showStatusBanner(document, { state: 'down' }, options())!;
    expect(host.dataset.theme).toBe('dark');
    document.documentElement.removeAttribute('data-color-mode');
  });
});

describe('following the status in every tab (PR 11.6)', () => {
  function fakeEvents() {
    type Listener = Parameters<StatusChangedEvent['addListener']>[0];
    const listeners: Listener[] = [];
    return {
      addListener: (listener: Listener) => void listeners.push(listener),
      fire: (value: unknown, areaName = 'local') =>
        listeners.forEach((l) => l({ [OLLAMA_STATUS_KEY]: { newValue: value } }, areaName)),
    };
  }

  it('hears each change the service worker stores, once', () => {
    const events = fakeEvents();
    const onChange = vi.fn();
    const follower = followOllamaStatus(events, onChange);
    expect(follower.current()).toEqual({ state: 'unknown' });
    events.fire({ state: 'down' });
    events.fire({ state: 'down' });
    events.fire({ state: 'up' });
    events.fire({ state: 'down' }, 'sync');
    expect(onChange.mock.calls.map(([s]) => s.state)).toEqual(['down', 'up']);
  });

  it('takes the answer the worker gives a page that just opened', () => {
    const onChange = vi.fn();
    const follower = followOllamaStatus(fakeEvents(), onChange);
    follower.set({ state: 'model-missing', model: 'qwen' });
    expect(follower.current()).toEqual({ state: 'model-missing', model: 'qwen' });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('treats anything that is not a status as not known', () => {
    expect(toBannerStatus(undefined)).toEqual({ state: 'unknown' });
    expect(toBannerStatus({ state: 'broken' })).toEqual({ state: 'unknown' });
    expect(toBannerStatus({ state: 'down', model: 5 })).toEqual({ state: 'down' });
  });
});
