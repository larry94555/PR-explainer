import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import manifest from '../public/manifest.json';
import pkg from '../package.json';

const root = resolve(import.meta.dirname, '..');
// Every github.com page, since GitHub moves to a PR without a reload and
// Chrome injects content scripts only on a full load (PR 7.1).
const GITHUB_PATTERN = 'https://github.com/*';

// Turns a Chrome match pattern (scheme://host/path, no wildcards in scheme or
// host) into a RegExp. In Chrome, `*` in the path matches any characters,
// including `/`, and the path is matched together with the query string.
function matchPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchesContentScript(url: string): boolean {
  const { protocol, host, pathname, search } = new URL(url);
  const target = `${protocol}//${host}${pathname}${search}`;
  return manifest.content_scripts.some((cs) =>
    cs.matches.some((p) => matchPatternToRegExp(p).test(target)),
  );
}

// Reads width and height from a PNG's IHDR chunk.
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('manifest.json', () => {
  it('is a Manifest V3 extension with a name, version and description', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('PR Explainer');
    expect(manifest.version).toMatch(/^\d+(\.\d+){0,3}$/);
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(manifest.description.length).toBeLessThanOrEqual(132); // Chrome Web Store limit
  });

  it('uses a module service worker, not an MV2 background page', () => {
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' });
    expect(manifest).not.toHaveProperty('background.scripts');
    expect(manifest).not.toHaveProperty('background.page');
  });

  it('injects one content script, on github.com pages only', () => {
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts[0]?.matches).toEqual([GITHUB_PATTERN]);
    expect(manifest.content_scripts[0]?.js).toEqual(['content.js']);
  });

  it.each([
    'https://github.com/owner/repo/pull/1',
    'https://github.com/owner/repo/pull/123/files',
    'https://github.com/owner/repo/pull/123/commits',
    'https://github.com/owner/repo/pull/123/files?w=1#diff-abc',
    // Pages a PR is often reached from without a reload.
    'https://github.com/owner/repo',
    'https://github.com/owner/repo/pulls',
    'https://github.com/owner/repo/issues/1',
    'https://github.com/pulls',
  ])('runs the content script on %s', (url) => {
    expect(matchesContentScript(url)).toBe(true);
  });

  it.each([
    'http://github.com/owner/repo/pull/1',
    'https://gist.github.com/owner/repo/pull/1',
    'https://example.com/owner/repo/pull/1',
  ])('does not run the content script on %s', (url) => {
    expect(matchesContentScript(url)).toBe(false);
  });

  it('requests only storage, the toolbar menu, the side panel, github.com, and this computer for the LLM', () => {
    // contextMenus: Open debug window on the toolbar button's menu (PR 9.4).
    // sidePanel: the chat in Chrome's side panel (PR 11.8).
    expect(manifest.permissions).toEqual(['storage', 'contextMenus', 'sidePanel']);
    // Loopback only, matching the hosts settings.ts accepts for the LLM URL.
    // A match pattern with no port covers every port, so any local port works.
    expect(manifest.host_permissions).toEqual([
      'https://github.com/*',
      'http://localhost/*',
      'https://localhost/*',
      'http://127.0.0.1/*',
      'https://127.0.0.1/*',
      'http://[::1]/*',
      'https://[::1]/*',
    ]);
    for (const key of [
      'optional_permissions',
      'optional_host_permissions',
      'externally_connectable',
      'web_accessible_resources',
      'content_security_policy',
    ]) {
      expect(manifest).not.toHaveProperty(key);
    }
  });

  it('can reach no host but GitHub and this computer (PR 7.4)', () => {
    // Whatever is added later, code must not be able to leave the laptop.
    const allowed = /^https:\/\/github\.com\/\*$|^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])\/\*$/;
    for (const pattern of manifest.host_permissions) expect(pattern).toMatch(allowed);
    for (const cs of manifest.content_scripts) {
      for (const pattern of cs.matches) expect(pattern).toBe(GITHUB_PATTERN);
    }
    const text = JSON.stringify(manifest);
    for (const broad of ['<all_urls>', '*://*/*', 'https://*/*', 'http://*/*', '*.github.com']) {
      expect(text).not.toContain(broad);
    }
    // No permission that reads other sites or browsing data.
    for (const p of ['tabs', 'webRequest', 'cookies', 'history', 'scripting', 'debugger']) {
      expect(manifest.permissions).not.toContain(p);
    }
  });

  it('shows the chat in the side panel from sidepanel.html (PR 11.8)', () => {
    expect(manifest.side_panel).toEqual({ default_path: 'sidepanel.html' });
  });

  it('has the same version as package.json, so the packaged .zip is named after it', () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it('has a toolbar button with no popup, so a click turns click-to-explain on or off', () => {
    expect(manifest.action).toEqual({
      default_title: 'PR Explainer',
      default_icon: manifest.icons,
    });
    // chrome.action.onClicked only fires when the button has no popup page.
    expect(manifest.action).not.toHaveProperty('default_popup');
  });

  it('opens the options page in a tab', () => {
    expect(manifest.options_ui).toEqual({ page: 'options.html', open_in_tab: true });
  });

  it('points every script and page at a source file that the build turns into it', () => {
    // vite.config.ts builds src/<name>.ts to dist/<name>.js and copies HTML by name.
    const built = [manifest.background.service_worker, ...manifest.content_scripts[0]!.js];
    for (const file of built) {
      expect(existsSync(resolve(root, 'src', file.replace(/\.js$/, '.ts'))), file).toBe(true);
    }
    expect(existsSync(resolve(root, 'src', manifest.options_ui.page))).toBe(true);
  });

  it('has 16, 48 and 128 px PNG icons of the right size', () => {
    expect(Object.keys(manifest.icons).sort()).toEqual(['128', '16', '48']);
    for (const [size, file] of Object.entries(manifest.icons)) {
      const { width, height } = pngSize(resolve(root, 'public', file));
      expect({ width, height }).toEqual({ width: Number(size), height: Number(size) });
    }
  });
});
