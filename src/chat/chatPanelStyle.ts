// CSS for the chat panel. It is put inside the panel's shadow root, so none of
// these rules reach GitHub's page and GitHub's rules do not reach the panel.
// The colors match the popup (src/popup/popupStyle.ts). Dark mode comes in
// PR 7.3.

export const CHAT_PANEL_STYLE = `
  :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; }
  .chat {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    width: min(420px, calc(100vw - 32px));
    height: min(70vh, 600px);
    background: #ffffff;
    color: #1f2328;
    border: 1px solid #d0d7de;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(140, 149, 159, 0.3);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
    overflow: hidden;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #f6f8fa;
    border-bottom: 1px solid #d0d7de;
  }
  .title { font-weight: 600; }
  .subject {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 6px;
    color: #59636e;
    font-size: 12px;
    white-space: nowrap;
  }
  .subject .file { overflow: hidden; text-overflow: ellipsis; }
  .subject .lines { flex: none; }
  .close {
    border: 0;
    background: transparent;
    color: #59636e;
    font-size: 18px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 4px;
    cursor: pointer;
  }
  .close:hover, .close:focus-visible { background: #e6eaef; color: #1f2328; }
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
    background: #ddf4ff;
    border: 1px solid #b6e3ff;
    white-space: pre-wrap;
  }
  .message.assistant { align-self: flex-start; background: #f6f8fa; border: 1px solid #eaeef2; }
  .message > :last-child { margin-bottom: 0; }
  p, ul, ol, pre { margin: 0 0 8px; }
  ul, ol { padding-left: 20px; }
  code {
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 12px;
    background: #eff1f3;
    padding: 1px 4px;
    border-radius: 4px;
  }
  .subject code { background: none; padding: 0; }
  pre { background: #ffffff; border: 1px solid #eaeef2; padding: 8px; border-radius: 6px; overflow: auto; }
  pre code { background: none; padding: 0; }
  .composer {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 8px;
    padding: 8px 12px 6px;
    border-top: 1px solid #d0d7de;
  }
  .input {
    box-sizing: border-box;
    width: 100%;
    max-height: 120px;
    resize: none;
    font: inherit;
    color: inherit;
    padding: 6px 8px;
    border: 1px solid #d0d7de;
    border-radius: 6px;
  }
  .input:focus { outline: 2px solid #0969da; outline-offset: -1px; border-color: #0969da; }
  .send {
    align-self: end;
    border: 1px solid #1f883d;
    background: #1f883d;
    color: #ffffff;
    font: inherit;
    font-weight: 600;
    padding: 5px 14px;
    border-radius: 6px;
    cursor: pointer;
  }
  .send:hover:not(:disabled) { background: #1a7f37; }
  .send:disabled { background: #94d3a2; border-color: #94d3a2; cursor: not-allowed; }
  .stop {
    align-self: end;
    border: 1px solid #d0d7de;
    background: #ffffff;
    color: #1f2328;
    font: inherit;
    font-weight: 600;
    padding: 5px 14px;
    border-radius: 6px;
    cursor: pointer;
  }
  .stop:hover, .stop:focus-visible { background: #ffebe9; border-color: #d1242f; color: #d1242f; }
  /* Stop takes Send's place while an answer is being written. */
  .chat[data-busy='true'] .send, .chat:not([data-busy='true']) .stop { display: none; }
  /* An answer that has no text yet. */
  .message.assistant:empty::before { content: 'Thinking…'; color: #59636e; }
  .message[data-status='failed'] { background: #fff8f8; border-color: #ffcecb; }
  .error-message { color: #d1242f; font-weight: 600; }
  .stopped-note { color: #59636e; font-style: italic; }
  .hint { grid-column: 1 / -1; color: #59636e; font-size: 11px; }
`;
