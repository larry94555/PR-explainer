// Content script, injected on GitHub PR pages (see public/manifest.json).
// Detects the PR, shows the "PR Explainer active" badge, checks that the
// service worker answers, and explains diff lines when they are clicked.
//
// Chrome runs content scripts as classic scripts, not ES modules, so this
// entry must not share imports with other entries: Vite would move shared
// code into a chunk loaded with `import`, which fails in a content script.
// Type-only imports (such as src/messaging/protocol.ts) are fine.
import { setBadgeEnabled, setBadgeStatus, syncBadge } from './badge';
import { createClickHandler, type ClickHandlerDeps } from './clickHandler';
import { trackEnabled } from './enabledState';
import { openExplainStream, sendRequest } from './messaging/client';
import { currentPopup, openPopup } from './popup/popup';
import { parsePrUrl } from './prUrl';
import { installSelection } from './selection';

/** "owner/repo#17" for the PR on this page, or undefined (no caching). */
function prName(url: string): string | undefined {
  const pr = parsePrUrl(url);
  return pr ? `${pr.owner}/${pr.repo}#${pr.number}` : undefined;
}

let workerStatus = 'Service worker: checking…';
// The toolbar button turns click-to-explain on and off for every tab (see
// src/toolbarToggle.ts). Until the saved state is read, clicks are ignored
// and the badge keeps its default look.
const enabled = trackEnabled(chrome.storage.local, chrome.storage.onChanged, (value) => {
  // Turning it off also closes an open popup; a late answer is then ignored.
  if (!value) currentPopup()?.close();
  update();
});

function update(): void {
  if (!syncBadge(document, location.href)) return;
  setBadgeStatus(document, workerStatus);
  const value = enabled.current();
  if (value !== null) setBadgeEnabled(document, value);
}

update();

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
document.addEventListener('turbo:load', update);
document.addEventListener('turbo:render', update);
window.addEventListener('popstate', update);

// Click a diff line to explain it: a popup opens next to the line and the
// model's answer streams into it (see src/clickHandler.ts). There is no
// timeout: the popup's Stop button ends a request that takes too long.
const explainDeps: ClickHandlerDeps = {
  isEnabled: () => enabled.current() === true,
  // The PR names the cache entry, so the same code in two PRs is asked
  // separately (src/explain/explainCache.ts).
  explain: (context, onChunk, { fresh }) =>
    openExplainStream({ context, pr: prName(location.href), fresh }, onChunk),
  openPopup: (anchor, options) => openPopup(anchor, options),
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
