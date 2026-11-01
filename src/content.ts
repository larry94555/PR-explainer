// Content script, injected on GitHub PR pages (see public/manifest.json).
// Detects the PR and shows the "PR Explainer active" badge.
//
// Chrome runs content scripts as classic scripts, not ES modules, so this
// entry must not share imports with other entries: Vite would move shared
// code into a chunk loaded with `import`, which fails in a content script.
import { syncBadge } from './badge';

function update(): void {
  syncBadge(document, location.href);
}

update();

// GitHub changes pages without a full reload (Turbo), so this script keeps
// running when the user moves from a PR to, say, an issue. Re-check the URL
// after each of those navigations and on back/forward.
document.addEventListener('turbo:load', update);
document.addEventListener('turbo:render', update);
window.addEventListener('popstate', update);
