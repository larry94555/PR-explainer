// Entry for the debug window (src/debug.html, PR 9.4). See debugWindow.ts.
//
// It talks to the service worker directly with chrome.runtime, not through
// src/messaging/client.ts: the content script imports that module, and code
// shared with the content script must not end up in a chunk (see src/content.ts).
import './debugWindow.css';
import { createDebugWindow, DEBUG_PORT_NAME, type DebugPort } from './debugWindow';

createDebugWindow(document.getElementById('app')!, {
  connect: () => chrome.runtime.connect({ name: DEBUG_PORT_NAME }) as DebugPort,
  clear: async () => {
    const response = (await chrome.runtime.sendMessage({
      source: 'pr-explainer',
      type: 'debugLogClear',
      payload: undefined,
    })) as { ok?: boolean; error?: { message?: string } } | undefined;
    if (!response?.ok) throw new Error(response?.error?.message ?? 'No answer from the extension.');
  },
  copy: (text) => navigator.clipboard.writeText(text),
});
