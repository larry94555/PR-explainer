// Light and dark colors for everything PR Explainer draws on GitHub (PR 7.3).
//
// GitHub keeps the user's appearance setting on <html>:
//   <html data-color-mode="auto" data-light-theme="light" data-dark-theme="dark_dimmed">
// `data-color-mode` is "light", "dark", or "auto" (follow the system, read
// from the `prefers-color-scheme` media query). The theme names say which
// light or dark theme is used; every GitHub theme is either light_* or
// dark_*, so the name's start decides when the mode alone does not. A page
// with no attributes (such as the demo pages) follows the system.
//
// The popup, the chat panel and the selection bar each live in a shadow
// root. Their CSS uses the variables in THEME_VARS, and the host element gets
// `data-theme="light"` or `data-theme="dark"` (applyTheme). watchTheme keeps
// it in step when the user changes GitHub's or the system's setting while a
// panel is open.

export type Theme = 'light' | 'dark';

/** The attributes on <html> that GitHub changes with its appearance setting. */
export const THEME_ATTRIBUTES = ['data-color-mode', 'data-light-theme', 'data-dark-theme'];

const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemTheme(win: Window | null): Theme {
  return win?.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';
}

/** A theme name such as "dark_dimmed" or "light_high_contrast", as light or dark. */
function themeOfName(name: string | null): Theme | null {
  if (name?.startsWith('dark')) return 'dark';
  if (name?.startsWith('light')) return 'light';
  return null;
}

/** Whether GitHub is showing its light or dark colors on `doc`. */
export function resolveTheme(doc: Document): Theme {
  const html = doc.documentElement;
  const mode = html.getAttribute('data-color-mode');
  if (mode === 'light') return themeOfName(html.getAttribute('data-light-theme')) ?? 'light';
  if (mode === 'dark') return themeOfName(html.getAttribute('data-dark-theme')) ?? 'dark';
  return systemTheme(doc.defaultView);
}

/** Sets `data-theme` on a panel's host to the page's theme, and returns it. */
export function applyTheme(host: HTMLElement, doc: Document = host.ownerDocument): Theme {
  const theme = resolveTheme(doc);
  host.dataset.theme = theme;
  return theme;
}

/**
 * Calls `onChange` with the new theme whenever GitHub's setting or the
 * system's changes it. Returns a function that stops watching.
 */
export function watchTheme(doc: Document, onChange: (theme: Theme) => void): () => void {
  let last = resolveTheme(doc);
  const check = () => {
    const next = resolveTheme(doc);
    if (next === last) return;
    last = next;
    onChange(next);
  };
  const win = doc.defaultView;
  const observer = win ? new win.MutationObserver(check) : null;
  observer?.observe(doc.documentElement, { attributes: true, attributeFilter: THEME_ATTRIBUTES });
  const query = win?.matchMedia?.(DARK_QUERY);
  query?.addEventListener?.('change', check);
  return () => {
    observer?.disconnect();
    query?.removeEventListener?.('change', check);
  };
}

/**
 * Keeps `host`'s `data-theme` matching the page from now on. Returns a
 * function that stops.
 */
export function followTheme(host: HTMLElement, doc: Document = host.ownerDocument): () => void {
  applyTheme(host, doc);
  return watchTheme(doc, (theme) => {
    host.dataset.theme = theme;
  });
}

// The colors, as CSS variables on the shadow host. Light values match
// GitHub's light theme and dark values its dark theme (Primer).
export const THEME_VARS = `
  :host {
    color-scheme: light;
    --pe-bg: #ffffff;
    --pe-fg: #1f2328;
    --pe-muted: #59636e;
    --pe-border: #d0d7de;
    --pe-border-muted: #eaeef2;
    --pe-subtle-bg: #f6f8fa;
    --pe-hover-bg: #e6eaef;
    --pe-code-bg: #eff1f3;
    --pe-shadow: rgba(140, 149, 159, 0.3);
    --pe-accent: #0969da;
    --pe-accent-bg: #ddf4ff;
    --pe-accent-border: #b6e3ff;
    --pe-danger: #d1242f;
    --pe-danger-bg: #ffebe9;
    --pe-danger-subtle-bg: #fff8f8;
    --pe-danger-border: #ffcecb;
    --pe-attention: #9a6700;
    --pe-success: #1f883d;
    --pe-success-hover: #1a7f37;
    --pe-success-disabled: #94d3a2;
    --pe-on-success: #ffffff;
    --pe-focus: #0969da;
  }
  :host([data-theme='dark']) {
    color-scheme: dark;
    --pe-bg: #151b23;
    --pe-fg: #f0f6fc;
    --pe-muted: #9198a1;
    --pe-border: #3d444d;
    --pe-border-muted: #2a313c;
    --pe-subtle-bg: #0d1117;
    --pe-hover-bg: #262c36;
    --pe-code-bg: #262c36;
    --pe-shadow: rgba(1, 4, 9, 0.85);
    --pe-accent: #4493f8;
    --pe-accent-bg: rgba(56, 139, 253, 0.15);
    --pe-accent-border: rgba(56, 139, 253, 0.4);
    --pe-danger: #f85149;
    --pe-danger-bg: rgba(248, 81, 73, 0.15);
    --pe-danger-subtle-bg: rgba(248, 81, 73, 0.1);
    --pe-danger-border: rgba(248, 81, 73, 0.4);
    --pe-attention: #d29922;
    --pe-success: #238636;
    --pe-success-hover: #2ea043;
    --pe-success-disabled: #105823;
    --pe-on-success: #ffffff;
    --pe-focus: #1f6feb;
  }
`;
