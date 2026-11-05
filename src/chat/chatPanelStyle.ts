// CSS for the chat panel. It is put inside the panel's shadow root, so none of
// these rules reach GitHub's page and GitHub's rules do not reach the panel.
// The colors are the theme variables in src/theme.ts, shared with the popup,
// so the panel follows GitHub's light or dark mode (PR 7.3).

import { THEME_VARS } from '../theme';

export const CHAT_PANEL_STYLE = `
  :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; }
  ${THEME_VARS}
  /* In Chrome's side panel (PR 11.8) the chat fills the page. */
  :host([data-layout='fill']) { position: static; display: block; height: 100vh; }
  :host([data-layout='fill']) .chat {
    width: 100%;
    height: 100%;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
  .chat {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    width: min(420px, calc(100vw - 32px));
    height: min(70vh, 600px);
    background: var(--pe-bg);
    color: var(--pe-fg);
    border: 1px solid var(--pe-border);
    border-radius: 8px;
    box-shadow: 0 8px 24px var(--pe-shadow);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
    overflow: hidden;
  }
  button:focus-visible { outline: 2px solid var(--pe-focus); outline-offset: 1px; }
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--pe-subtle-bg);
    border-bottom: 1px solid var(--pe-border);
  }
  .title { font-weight: 600; }
  .subject {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 6px;
    color: var(--pe-muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .subject .file { overflow: hidden; text-overflow: ellipsis; }
  .subject .lines { flex: none; }
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
  .new-chat {
    flex: none;
    border: 1px solid var(--pe-border);
    background: var(--pe-bg);
    color: var(--pe-fg);
    font: inherit;
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 6px;
    cursor: pointer;
  }
  .new-chat:hover, .new-chat:focus-visible { background: var(--pe-hover-bg); border-color: var(--pe-muted); }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .message { max-width: 92%; padding: 8px 10px; border-radius: 8px; overflow-wrap: anywhere; }
  .message.user {
    align-self: flex-end;
    background: var(--pe-accent-bg);
    border: 1px solid var(--pe-accent-border);
    white-space: pre-wrap;
  }
  .message.assistant { align-self: flex-start; background: var(--pe-subtle-bg); border: 1px solid var(--pe-border-muted); }
  .message > :last-child { margin-bottom: 0; }
  /* "Now looking at …": where the user moved on to other code. */
  .note {
    align-self: center;
    margin: 4px 0;
    color: var(--pe-muted);
    font-size: 12px;
    text-align: center;
  }
  p, ul, ol, pre { margin: 0 0 8px; }
  ul, ol { padding-left: 20px; }
  code {
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 12px;
    background: var(--pe-code-bg);
    padding: 1px 4px;
    border-radius: 4px;
  }
  .subject code { background: none; padding: 0; }
  pre { background: var(--pe-bg); border: 1px solid var(--pe-border-muted); padding: 8px; border-radius: 6px; overflow: auto; }
  pre code { background: none; padding: 0; }
  .composer {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 8px;
    padding: 8px 12px 6px;
    border-top: 1px solid var(--pe-border);
  }
  .input {
    box-sizing: border-box;
    width: 100%;
    max-height: 120px;
    resize: none;
    font: inherit;
    color: inherit;
    padding: 6px 8px;
    border: 1px solid var(--pe-border);
    border-radius: 6px;
    background: var(--pe-bg);
  }
  .input:focus { outline: 2px solid var(--pe-focus); outline-offset: -1px; border-color: var(--pe-focus); }
  .send {
    align-self: end;
    border: 1px solid var(--pe-success);
    background: var(--pe-success);
    color: var(--pe-on-success);
    font: inherit;
    font-weight: 600;
    padding: 5px 14px;
    border-radius: 6px;
    cursor: pointer;
  }
  .send:hover:not(:disabled) { background: var(--pe-success-hover); }
  .send:disabled { background: var(--pe-success-disabled); border-color: var(--pe-success-disabled); cursor: not-allowed; }
  .stop {
    align-self: end;
    border: 1px solid var(--pe-border);
    background: var(--pe-bg);
    color: var(--pe-fg);
    font: inherit;
    font-weight: 600;
    padding: 5px 14px;
    border-radius: 6px;
    cursor: pointer;
  }
  .stop:hover, .stop:focus-visible { background: var(--pe-danger-bg); border-color: var(--pe-danger); color: var(--pe-danger); }
  /* Stop takes Send's place while an answer is being written. */
  .chat[data-busy='true'] .send, .chat:not([data-busy='true']) .stop { display: none; }
  /* An answer that has no text yet. */
  .message.assistant:empty::before { content: 'Thinking…'; color: var(--pe-muted); }
  /* How long the answer above took (PR 8.1). */
  .elapsed { align-self: flex-start; margin: -4px 0 0 2px; color: var(--pe-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .message[data-status='failed'] { background: var(--pe-danger-subtle-bg); border-color: var(--pe-danger-border); }
  .error-message { color: var(--pe-danger); font-weight: 600; }
  .stopped-note { color: var(--pe-muted); font-style: italic; }
  .hint { grid-column: 1 / -1; color: var(--pe-muted); font-size: 11px; }
`;
