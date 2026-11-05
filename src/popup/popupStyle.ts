// CSS for the popup. It is put inside the popup's shadow root, so none of
// these rules reach GitHub's page and GitHub's rules do not reach the popup.
// `all: initial` on the host also stops GitHub's inherited styles (font,
// color, line height) from leaking in. The colors are the theme variables in
// src/theme.ts, so the popup follows GitHub's light or dark mode (PR 7.3).

import { THEME_VARS } from '../theme';

export const POPUP_STYLE = `
  :host { all: initial; }
  ${THEME_VARS}
  .popup {
    box-sizing: border-box;
    width: min(520px, calc(100vw - 16px));
    max-height: min(60vh, 520px);
    overflow: auto;
    background: var(--pe-bg);
    color: var(--pe-fg);
    border: 1px solid var(--pe-border);
    border-radius: 8px;
    box-shadow: 0 8px 24px var(--pe-shadow);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
  }
  /* The panel takes focus when it opens; the buttons show where focus is. */
  .popup:focus { outline: none; }
  button:focus-visible { outline: 2px solid var(--pe-focus); outline-offset: 1px; }
  .header {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--pe-subtle-bg);
    border-bottom: 1px solid var(--pe-border);
  }
  .title { font-weight: 600; white-space: nowrap; }
  /* The buttons keep their size; the model's name gives way first. */
  .header > button { flex-shrink: 0; }
  /* One line, cut short with … when the header is full; the whole name is its tooltip. */
  .model { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pe-muted); font-size: 12px; }
  .elapsed { color: var(--pe-muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .close {
    border: 0;
    background: transparent;
    color: var(--pe-muted);
    font-size: 18px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 4px;
    cursor: pointer;
  }
  .close:hover, .close:focus-visible { background: var(--pe-hover-bg); color: var(--pe-fg); }
  .stop, .regenerate, .details, .debug, .copy, .pin {
    border: 1px solid var(--pe-border);
    background: var(--pe-bg);
    color: var(--pe-fg);
    font: inherit;
    font-size: 12px;
    line-height: 1;
    padding: 4px 10px;
    border-radius: 6px;
    cursor: pointer;
  }
  .stop:hover, .stop:focus-visible { background: var(--pe-danger-bg); border-color: var(--pe-danger); color: var(--pe-danger); }
  /* Stop only makes sense while the model is working. */
  .popup:not([data-state='loading']):not([data-state='streaming']) .stop { display: none; }
  .details[hidden] { display: none; }
  .debug:hover, .debug:focus-visible { background: var(--pe-hover-bg); }
  .details:hover, .details:focus-visible, .details[aria-expanded='true'] { background: var(--pe-hover-bg); }
  /* Facts known without the model (PR 9.12): one muted line under the header. */
  .facts {
    margin: 0;
    padding: 6px 12px;
    border-bottom: 1px solid var(--pe-border-muted);
    color: var(--pe-muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .facts .where { color: var(--pe-fg); }
  /* Where the time went (PR 9.1): a waterfall under the header, one row per task. */
  .latency {
    margin: 0;
    padding: 8px 12px;
    background: var(--pe-subtle-bg);
    border-bottom: 1px solid var(--pe-border-muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .latency[hidden] { display: none; }
  .tasks { list-style: none; margin: 0; padding: 0; }
  .task {
    display: grid;
    grid-template-columns: 11.5em 1fr 9.5em;
    align-items: center;
    gap: 8px;
    line-height: 18px;
  }
  .task-label { color: var(--pe-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .task[data-source='model'] .task-label { color: var(--pe-fg); }
  .task-time { text-align: right; white-space: nowrap; }
  .track { position: relative; height: 10px; border-radius: 2px; background: var(--pe-border-muted); }
  .bar { position: absolute; top: 0; bottom: 0; border-radius: 2px; background: var(--pe-muted); }
  .task[data-source='worker'] .bar { background: var(--pe-attention); }
  .task[data-source='model'] .bar { background: var(--pe-accent); }
  .task[data-task='think'] .bar { background: var(--pe-danger); }
  .task[data-status='failed'] .bar { background: var(--pe-danger); }
  .task[data-status='skipped'] .bar { display: none; }
  .task[data-status] .task-time { color: var(--pe-muted); }
  .first-token { position: absolute; top: -2px; bottom: -2px; width: 0; border-left: 1px dashed var(--pe-fg); }
  .trace-total { margin: 6px 0 0; color: var(--pe-muted); }
  /* The click's round trips (PR 9.2); one opens to show its prompt and reply. */
  .trip-count { margin: 8px 0 4px; font-weight: 600; }
  .round-trips { list-style: none; margin: 0; padding: 0; }
  .round-trip { border-top: 1px solid var(--pe-border-muted); padding: 3px 0; }
  .round-trip summary { cursor: pointer; overflow-wrap: anywhere; }
  .round-trip:not([data-cause='click']) summary { color: var(--pe-muted); }
  .round-trip[data-status='failed'] summary, .round-trip[data-status='refused'] summary { color: var(--pe-danger); }
  .trip-facts, .prompt-size { margin: 4px 0; color: var(--pe-muted); overflow-wrap: anywhere; }
  .trip-part h4 { margin: 6px 0 2px; font-size: 11px; color: var(--pe-muted); }
  .trip-part pre {
    margin: 0; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow: auto;
    font-size: 11px; padding: 4px 6px; border-radius: 4px; background: var(--pe-hover-bg);
  }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
  /* Copy and Pin (PR 11.10). Copy is in the footer, shown once the answer is. */
  .footer { gap: 8px; }
  .copy:hover, .copy:focus-visible, .pin:not(:disabled):hover, .pin:focus-visible { background: var(--pe-hover-bg); }
  .pin[aria-pressed='true'] { background: var(--pe-accent-bg); border-color: var(--pe-accent); color: var(--pe-accent); }
  .pin:disabled { opacity: 0.5; cursor: not-allowed; }
  /* A pinned popup is dragged by its header. */
  .popup[data-pinned] .header { cursor: move; }
  .popup[data-pinned] { border-color: var(--pe-accent); }
  .regenerate:hover, .regenerate:focus-visible { background: var(--pe-accent-bg); border-color: var(--pe-accent); color: var(--pe-accent); }
  /* Regenerate only makes sense once the model has stopped working. */
  .popup:not([data-state='done']):not([data-state='failed']):not([data-state='stopped']) .regenerate { display: none; }
  .footer {
    position: sticky;
    bottom: 0;
    display: flex;
    justify-content: flex-end;
    padding: 8px 12px;
    background: var(--pe-bg);
    border-top: 1px solid var(--pe-border-muted);
  }
  /* Copy and Ask a question only make sense once there is an explanation. */
  .popup:not([data-state='done']) .footer { display: none; }
  .ask {
    border: 1px solid var(--pe-success);
    background: var(--pe-success);
    color: var(--pe-on-success);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 5px 12px;
    border-radius: 6px;
    cursor: pointer;
  }
  .ask:hover, .ask:focus-visible { background: var(--pe-success-hover); }
  /* Rating (PR 11.11): 👍 and 👎 at the footer's start, Regenerate after 👎. */
  .rate { display: flex; align-items: center; gap: 4px; margin-right: auto; }
  .rate-label { color: var(--pe-muted); font-size: 12px; margin-right: 2px; }
  .rate-button {
    border: 1px solid var(--pe-border);
    background: var(--pe-bg);
    font: inherit;
    font-size: 13px;
    line-height: 1;
    padding: 3px 7px;
    border-radius: 6px;
    cursor: pointer;
    filter: grayscale(1);
    opacity: 0.75;
  }
  .rate-button:hover, .rate-button:focus-visible { background: var(--pe-hover-bg); filter: none; opacity: 1; }
  .rate-button[aria-pressed='true'] { filter: none; opacity: 1; }
  .rate-button[data-rating='up'][aria-pressed='true'] { background: var(--pe-accent-bg); border-color: var(--pe-accent); }
  .rate-button[data-rating='down'][aria-pressed='true'] { background: var(--pe-danger-bg); border-color: var(--pe-danger); }
  .retry {
    margin-left: 4px;
    border: 1px solid var(--pe-border);
    background: var(--pe-bg);
    color: var(--pe-fg);
    font: inherit;
    font-size: 12px;
    line-height: 1;
    padding: 4px 10px;
    border-radius: 6px;
    cursor: pointer;
  }
  .retry[hidden] { display: none; }
  .retry:hover, .retry:focus-visible { background: var(--pe-accent-bg); border-color: var(--pe-accent); color: var(--pe-accent); }
  .partial { padding-top: 8px; }
  /* A blinking caret after the newest text while the model is still writing. */
  .popup[data-state='streaming'] .partial > :last-child::after {
    content: '▍';
    color: var(--pe-accent);
    animation: blink 1s steps(1) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
  .stopped-note { padding-top: 12px; color: var(--pe-muted); }
  .cut-off-note { margin: 0; padding-top: 8px; border-top: 1px solid var(--pe-border-muted); color: var(--pe-muted); font-size: 12px; }
  .body { padding: 4px 12px 12px; }
  .loading { display: flex; align-items: center; gap: 8px; padding: 12px 0 4px; color: var(--pe-muted); }
  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--pe-border);
    border-top-color: var(--pe-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* The loading state's placeholders (PR 9.6): where each section's answer will go. */
  .placeholder-line {
    display: block;
    height: 10px;
    margin: 6px 0;
    border-radius: 5px;
    background: var(--pe-border-muted);
    animation: pulse 1.6s ease-in-out infinite;
  }
  .placeholder section:last-child .placeholder-line:last-child { margin-bottom: 8px; }
  @keyframes pulse { 50% { opacity: 0.45; } }
  @media (prefers-reduced-motion: reduce) {
    .placeholder-line, .spinner { animation: none; }
  }
  section + section { border-top: 1px solid var(--pe-border-muted); }
  h3 { margin: 12px 0 4px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.02em; color: var(--pe-muted); }
  section[data-section='concerns'] h3 { color: var(--pe-attention); }
  p, ul, ol, pre { margin: 0 0 8px; }
  ul, ol { padding-left: 20px; }
  code {
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 12px;
    background: var(--pe-code-bg);
    padding: 1px 4px;
    border-radius: 4px;
  }
  pre { background: var(--pe-subtle-bg); padding: 8px; border-radius: 6px; overflow: auto; }
  pre code { background: none; padding: 0; }
  .error { padding-top: 12px; }
  .error .message { color: var(--pe-danger); font-weight: 600; }
`;
