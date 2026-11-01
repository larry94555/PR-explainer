# PR-explainer
Chrome extension that explains code in GitHub pull requests using a local LLM.
See [features.md](features.md) and [roadmap.md](roadmap.md).

## Development

Requires Node 22.22 or newer (current test tooling needs it).

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm test` | Run unit tests (Vitest + jsdom) |
| `npm run lint` | Run ESLint and check Prettier formatting |
| `npm run format` | Fix formatting with Prettier |
| `npm run build` | Type-check and build into `dist/` |
| `npm run dev` | Rebuild into `dist/` on every change |
