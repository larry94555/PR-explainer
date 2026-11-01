// Content script, injected on GitHub PR pages (see public/manifest.json).
// Detects the PR, shows the "PR Explainer active" badge, and checks that the
// service worker answers.
//
// Chrome runs content scripts as classic scripts, not ES modules, so this
// entry must not share imports with other entries: Vite would move shared
// code into a chunk loaded with `import`, which fails in a content script.
// Type-only imports (such as src/messaging/protocol.ts) are fine.
import { setBadgeStatus, syncBadge } from './badge';
import { sendRequest } from './messaging/client';

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
