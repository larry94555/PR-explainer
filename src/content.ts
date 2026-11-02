// Content script, injected on GitHub PR pages (see public/manifest.json).
// Detects the PR, shows the "PR Explainer active" badge, checks that the
// service worker answers, and explains diff lines when they are clicked.
//
// Chrome runs content scripts as classic scripts, not ES modules, so this
// entry must not share imports with other entries: Vite would move shared
// code into a chunk loaded with `import`, which fails in a content script.
// Type-only imports (such as src/messaging/protocol.ts) are fine.
import { setBadgeEnabled, setBadgeStatus, syncBadge } from './badge';
import { chatSessionFor, CurrentChat, startChat } from './chat/chatFlow';
import { currentChatPanel, openChatPanel } from './chat/chatPanel';
import { ChatSessions } from './chat/chatSession';
import { createClickHandler, type ClickHandlerDeps } from './clickHandler';
import { trackEnabled } from './enabledState';
import { openAfter, openChatStream, openExplainStream, sendRequest } from './messaging/client';
import { currentPopup, openPopup } from './popup/popup';
import { createPrMetadataLoader, type PrMetadata } from './prMetadata';
import { parsePrUrl } from './prUrl';
import { installSelection } from './selection';

/** "owner/repo#17" for the PR on this page, or undefined (no caching). */
function prName(url: string): string | undefined {
  const pr = parsePrUrl(url);
  return pr ? `${pr.owner}/${pr.repo}#${pr.number}` : undefined;
}

// The PR's title and description (PR 6.1), read from the page or fetched
// from its Conversation tab once per PR, with the user's GitHub cookies.
const prMetadata = createPrMetadataLoader({
  doc: document,
  fetchHtml: async (path, signal) => {
    const response = await fetch(path, { credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return response.text();
  },
});

/** Starts reading the current PR's title and description, if on a PR. */
function loadPrMetadata(): Promise<PrMetadata | undefined> {
  const pr = parsePrUrl(location.href);
  return pr ? prMetadata.load(pr) : Promise.resolve(undefined);
}

let workerStatus = 'Service worker: checking…';
// The chat panel opened last; clicks on other code in its PR go to it while
// it is open (PR 5.4).
const currentChat = new CurrentChat();
// The toolbar button turns click-to-explain on and off for every tab (see
// src/toolbarToggle.ts). Until the saved state is read, clicks are ignored
// and the badge keeps its default look.
const enabled = trackEnabled(chrome.storage.local, chrome.storage.onChanged, (value) => {
  // Turning it off also closes an open popup or chat; a late answer is then
  // ignored.
  if (!value) {
    currentPopup()?.close();
    currentChatPanel()?.close();
  }
  update();
});

function update(): void {
  // Moving to another PR (or off PRs) without a reload closes its chat.
  currentChat.leave(prName(location.href));
  if (!syncBadge(document, location.href)) return;
  setBadgeStatus(document, workerStatus);
  const value = enabled.current();
  if (value !== null) setBadgeEnabled(document, value);
}

update();
// Read the description ahead of the first click, so it does not wait.
void loadPrMetadata();

sendRequest('ping', undefined).then(
  () => {
    workerStatus = 'Service worker: connected';
    update();
  },
  (error: Error) => {
    workerStatus = `Service worker: not connected (${error.message})`;
    console.warn('[PR Explainer]', error);
    update();
  },
);

// GitHub changes pages without a full reload (Turbo), so this script keeps
// running when the user moves from a PR to, say, an issue. Re-check the URL
// after each of those navigations and on back/forward.
document.addEventListener('turbo:load', () => {
  update();
  void loadPrMetadata();
});
document.addEventListener('turbo:render', update);
window.addEventListener('popstate', update);

// Click a diff line to explain it: a popup opens next to the line and the
// model's answer streams into it (see src/clickHandler.ts). There is no
// timeout: the popup's Stop button ends a request that takes too long.
// One chat per PR, kept for as long as the tab is open (never stored).
const chats = new ChatSessions();
const explainDeps: ClickHandlerDeps = {
  isEnabled: () => enabled.current() === true,
  // The PR names the cache entry, so the same code in two PRs is asked
  // separately (src/explain/explainCache.ts). The PR's title and description
  // go with the code, so the answer can say why the PR needs it (PR 6.1).
  explain: (context, onChunk, { fresh }) => {
    const pr = prName(location.href);
    return openAfter(loadPrMetadata(), (prInfo) => {
      if (import.meta.env.MODE === 'development' && prInfo) {
        console.log(
          `[PR Explainer] PR title for the model: ${prInfo.title || '(none)'}\n` +
            `PR description for the model:\n${prInfo.description || '(none)'}`,
        );
      }
      return openExplainStream({ context, pr, fresh, prInfo }, onChunk);
    });
  },
  openPopup: (anchor, options) => openPopup(anchor, options),
  // The popup's Ask a question button: chat about the explained code, with
  // answers streamed from the service worker (src/chat/chatFlow.ts).
  openChat: ({ subject, regenerated, ...seed }) => {
    const pr = prName(location.href);
    const session = chatSessionFor(chats, pr, seed, { regenerated });
    const chat = startChat(
      {
        ask: (messages, onChunk) => openChatStream({ messages }, onChunk),
        openPanel: (options) => openChatPanel(options),
      },
      session,
      subject,
    );
    currentChat.set(chat, pr);
    chat.focus();
  },
  // While the chat is open, clicked code in its PR joins the conversation (PR 5.4).
  addToChat: ({ text, subject }) => currentChat.addCode(prName(location.href), text, subject),
  // Dev builds also log the context block sent to the model.
  onContext:
    import.meta.env.MODE === 'development'
      ? (context) => console.log(`[PR Explainer] context for the model:\n${context}`)
      : undefined,
  // Every build logs how long each explanation took, to track the local
  // model's latency.
  onTiming: ({ elapsedMs, status, model, firstChunkMs, cached }) => {
    const verb = { done: 'explained', failed: 'failed', stopped: 'stopped' }[status];
    const details = [
      model,
      firstChunkMs === undefined ? '' : `first text after ${(firstChunkMs / 1000).toFixed(1)} s`,
      cached ? 'from cache' : '',
    ].filter(Boolean);
    console.info(
      `[PR Explainer] ${verb} in ${(elapsedMs / 1000).toFixed(1)} s` +
        (details.length ? ` (${details.join(', ')})` : ''),
    );
  },
};
document.addEventListener('click', createClickHandler(explainDeps));
// Drag across lines, or click one and Shift-click another, to explain the
// block as a whole (src/selection.ts).
installSelection(explainDeps);
