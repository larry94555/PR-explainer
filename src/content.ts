// Content script, injected on every github.com page (see public/manifest.json)
// because GitHub moves between pages without a reload (PR 7.1). On PR pages
// it shows the "PR Explainer active" badge and checks that the service worker
// answers; on a PR's Files changed and commit pages it explains diff lines
// when they are clicked. Elsewhere it only waits for a move to a PR.
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
import { closeDetached, DiffPageFeatures, watchNavigation } from './navigation';
import { currentPopup, openPopup } from './popup/popup';
import { createFileContextLoader, type CodeSpan } from './fileContext';
import type { FileContext } from './explain/explainPrompt';
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

// The function or block around clicked code, from the full file at the PR's
// head (PR 6.3). Files are fetched once per page, from the page's own raw
// URL (signed in, so private repos work) or raw.githubusercontent.com.
const fileContexts = createFileContextLoader({
  doc: document,
  fetchText: async (url, signal) => {
    const response = await fetch(url, { credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return response.text();
  },
});

/** Starts reading the block around `code`, if on a PR and it is in the new file. */
function loadFileContext(code: CodeSpan | undefined): Promise<FileContext | undefined> {
  const pr = parsePrUrl(location.href);
  return pr && code ? fileContexts.load(pr, code) : Promise.resolve(undefined);
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

let pinged = false;
/** Checks once, on the first PR page, that the service worker answers. */
function pingWorker(): void {
  if (pinged) return;
  pinged = true;
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
}

function update(): void {
  // Moving to another PR (or off PRs) without a reload closes its chat.
  currentChat.leave(prName(location.href));
  if (!syncBadge(document, location.href)) return;
  pingWorker();
  setBadgeStatus(document, workerStatus);
  const value = enabled.current();
  if (value !== null) setBadgeEnabled(document, value);
}

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
  // The block around the code in the full file goes too (PR 6.3).
  explain: (context, onChunk, { fresh, code }) => {
    const pr = prName(location.href);
    const ready = Promise.all([loadPrMetadata(), loadFileContext(code)]);
    return openAfter(ready, ([prInfo, fileContext]) => {
      if (import.meta.env.MODE === 'development') {
        if (prInfo) {
          console.log(
            `[PR Explainer] PR title for the model: ${prInfo.title || '(none)'}\n` +
              `PR description for the model:\n${prInfo.description || '(none)'}`,
          );
        }
        console.log(
          '[PR Explainer] full file context for the model: ' +
            (fileContext
              ? `${fileContext.kind}, lines ${fileContext.startLine} to ` +
                `${fileContext.startLine + fileContext.lines.length - 1}`
              : '(none)'),
        );
      }
      return openExplainStream({ context, pr, fresh, prInfo, fileContext }, onChunk);
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
const onClick = createClickHandler(explainDeps);
// Click-to-explain is attached only while a PR's diffs are shown, once
// however often GitHub re-renders the page, and taken off when the user
// moves elsewhere (PR 7.1).
const features = new DiffPageFeatures(() => {
  document.addEventListener('click', onClick);
  // Drag across lines, or click one and Shift-click another, to explain the
  // block as a whole (src/selection.ts).
  const removeSelection = installSelection(explainDeps);
  return () => {
    document.removeEventListener('click', onClick);
    removeSelection();
    // Closing the popup also stops its request.
    currentPopup()?.close();
  };
});

update();
features.sync(location.href);
// Read the description ahead of the first click, so it does not wait.
void loadPrMetadata();

// GitHub changes pages without a full reload (Turbo, or pushState in its
// React views), so this script keeps running when the user moves from a PR
// to, say, an issue, or from the Conversation tab to Files changed. Each move
// to another page updates the badge and attaches or removes click-to-explain.
// It may also come back from editing the PR's title or description, or Turbo
// may redraw the same page after an edit or a push, so the description and
// the files are read again (PR 6.1, 6.3).
function onPageChanged(url: string): void {
  // A popup or chat whose part of the page GitHub replaced is closed, so
  // its request stops and clicks do not go to it.
  closeDetached([currentPopup(), currentChatPanel()]);
  // A redraw can also drop the badge.
  update();
  features.sync(url);
  prMetadata.forget();
  fileContexts.forget();
  void loadPrMetadata();
}
watchNavigation(window, onPageChanged, { onRedraw: onPageChanged });
