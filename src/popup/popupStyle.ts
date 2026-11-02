// CSS for the popup. It is put inside the popup's shadow root, so none of
// these rules reach GitHub's page and GitHub's rules do not reach the popup.
// `all: initial` on the host also stops GitHub's inherited styles (font,
// color, line height) from leaking in. Dark mode comes in PR 7.3.

export const POPUP_STYLE = `
  :host { all: initial; }
  .popup {
    box-sizing: border-box;
    width: min(520px, calc(100vw - 16px));
    max-height: min(60vh, 520px);
    overflow: auto;
    background: #ffffff;
    color: #1f2328;
    border: 1px solid #d0d7de;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(140, 149, 159, 0.3);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
  }
  .header {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #f6f8fa;
    border-bottom: 1px solid #d0d7de;
  }
  .title { font-weight: 600; }
  .model { flex: 1; color: #59636e; font-size: 12px; }
  .elapsed { color: #59636e; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
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
  .stop, .regenerate {
    border: 1px solid #d0d7de;
    background: #ffffff;
    color: #1f2328;
    font: inherit;
    font-size: 12px;
    line-height: 1;
    padding: 4px 10px;
    border-radius: 6px;
    cursor: pointer;
  }
  .stop:hover, .stop:focus-visible { background: #ffebe9; border-color: #d1242f; color: #d1242f; }
  /* Stop only makes sense while the model is working. */
  .popup:not([data-state='loading']):not([data-state='streaming']) .stop { display: none; }
  .regenerate:hover, .regenerate:focus-visible { background: #ddf4ff; border-color: #0969da; color: #0969da; }
  /* Regenerate only makes sense once the model has stopped working. */
  .popup:not([data-state='done']):not([data-state='failed']):not([data-state='stopped']) .regenerate { display: none; }
  .footer {
    position: sticky;
    bottom: 0;
    display: flex;
    justify-content: flex-end;
    padding: 8px 12px;
    background: #ffffff;
    border-top: 1px solid #eaeef2;
  }
  /* Ask a question only makes sense once there is an explanation to ask about. */
  .popup:not([data-state='done']) .footer, .footer:empty { display: none; }
  .ask {
    border: 1px solid #1f883d;
    background: #1f883d;
    color: #ffffff;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 5px 12px;
    border-radius: 6px;
    cursor: pointer;
  }
  .ask:hover, .ask:focus-visible { background: #1a7f37; }
  .partial { padding-top: 8px; }
  /* A blinking caret after the newest text while the model is still writing. */
  .popup[data-state='streaming'] .partial > :last-child::after {
    content: '▍';
    color: #0969da;
    animation: blink 1s steps(1) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
  .stopped-note { padding-top: 12px; color: #59636e; }
  .body { padding: 4px 12px 12px; }
  .loading { display: flex; align-items: center; gap: 8px; padding: 12px 0 4px; color: #59636e; }
  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid #d0d7de;
    border-top-color: #0969da;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  section + section { border-top: 1px solid #eaeef2; }
  h3 { margin: 12px 0 4px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.02em; color: #59636e; }
  section[data-section='concerns'] h3 { color: #9a6700; }
  p, ul, ol, pre { margin: 0 0 8px; }
  ul, ol { padding-left: 20px; }
  code {
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 12px;
    background: #eff1f3;
    padding: 1px 4px;
    border-radius: 4px;
  }
  pre { background: #f6f8fa; padding: 8px; border-radius: 6px; overflow: auto; }
  pre code { background: none; padding: 0; }
  .error { padding-top: 12px; }
  .error .message { color: #d1242f; font-weight: 600; }
`;
