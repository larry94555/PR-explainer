// Content script, injected on GitHub PR pages (see public/manifest.json).
// Detects the PR, shows the "PR Explainer active" badge, and checks that the
// service worker answers.
//
// Chrome runs content scripts as classic scripts, not ES modules, so this
// entry must not share imports with other entries: Vite would move shared
// code into a chunk loaded with `import`, which fails in a content script.
// Type-only imports (such as src/messaging/protocol.ts) are fine.
import { setBadgeStatus, syncBadge } from './badge';
import { extractContext, formatContext } from './lineContext';
import { sendRequest } from './messaging/client';

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

// For now, log which diff line was clicked (file, line number, side, text)
// and the context block that will be sent to the model. Later PRs use this
// to explain the line. Clicks outside a diff log nothing.
document.addEventListener('click', (event) => {
  const context = extractContext(event.target);
  if (!context) return;
  console.log('[PR Explainer] clicked line', context.line);
  const text = formatContext(context);
  console.log(`[PR Explainer] context for the model:\n${text}`);
  // Dev builds also ask the local model to explain the line and log the
  // answer, so the prompt and parser can be tried on real PRs before the
  // popup arrives (PR 3.4 and 3.5 replace this). Models can take a while on a
  // laptop, so the timeout is longer than the default.
  if (import.meta.env.MODE === 'development') {
    console.log('[PR Explainer] asking the model…');
    sendRequest('explain', { context: text }, { timeoutMs: EXPLAIN_TIMEOUT_MS }).then(
      (result) => console.log('[PR Explainer] explanation', result),
      (error: Error) => console.warn('[PR Explainer] explain failed', error),
    );
  }
});
