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
  .title { font-weight: 600; }
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
  .stop, .regenerate, .details {
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
  .details:hover, .details:focus-visible, .details[aria-expanded='true'] { background: var(--pe-hover-bg); }
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
    grid-template-columns: 12em 1fr 6.5em;
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
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
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
  /* Ask a question only makes sense once there is an explanation to ask about. */
  .popup:not([data-state='done']) .footer, .footer:empty { display: none; }
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
  .partial { padding-top: 8px; }
  /* The Show prompt debug section (PR 6.2). */
  .prompt { margin-top: 12px; border-top: 1px solid var(--pe-border-muted); padding-top: 8px; font-size: 12px; }
  .prompt summary { cursor: pointer; color: var(--pe-muted); }
  .prompt pre { white-space: pre-wrap; word-break: break-word; max-height: 240px; font-size: 11px; }
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
