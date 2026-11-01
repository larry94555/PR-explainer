// Content script, injected on GitHub PR pages (see public/manifest.json).
// Empty for now: PR 1.3 adds PR detection and the "active" badge.
//
// Chrome runs content scripts as classic scripts, not ES modules, so this
// entry must not share imports with other entries: Vite would move shared
// code into a chunk loaded with `import`, which fails in a content script.
console.info('[PR Explainer] content script loaded');
