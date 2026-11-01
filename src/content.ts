// Content script, injected on GitHub PR pages (see public/manifest.json).
// Detects the PR, shows the "PR Explainer active" badge, checks that the
// service worker answers, and explains diff lines when they are clicked.
//
// Chrome runs content scripts as classic scripts, not ES modules, so this
// entry must not share imports with other entries: Vite would move shared
// code into a chunk loaded with `import`, which fails in a content script.
// Type-only imports (such as src/messaging/protocol.ts) are fine.
import { setBadgeStatus, syncBadge } from './badge';
import { createClickHandler } from './clickHandler';
import { sendRequest } from './messaging/client';
import { openPopup } from './popup/popup';

const EXPLAIN_TIMEOUT_MS = 120_000;

let workerStatus = 'Service worker: checking…';

function update(): void {
  if (syncBadge(document, location.href)) setBadgeStatus(document, workerStatus);
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

// Click a diff line to explain it: a popup opens next to the line and fills
// in with the model's answer (see src/clickHandler.ts). Models can take a
// while on a laptop, so the timeout is longer than the default.
document.addEventListener(
  'click',
  createClickHandler({
    explain: (context) => sendRequest('explain', { context }, { timeoutMs: EXPLAIN_TIMEOUT_MS }),
    openPopup: (anchor) => openPopup(anchor),
    // Dev builds also log the context block sent to the model.
    onContext:
      import.meta.env.MODE === 'development'
        ? (context) => console.log(`[PR Explainer] context for the model:\n${context}`)
        : undefined,
    // Every build logs how long each explanation took, to track the local
    // model's latency.
    onTiming: ({ elapsedMs, status, model }) =>
      console.info(
        `[PR Explainer] ${status === 'done' ? 'explained' : 'failed'} in ${(elapsedMs / 1000).toFixed(1)} s` +
          (model ? ` (${model})` : ''),
      ),
  }),
);
