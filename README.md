# PR-explainer
Chrome extension that explains code in GitHub pull requests using a local LLM.
See [docs/features.md](docs/features.md) and [docs/roadmap.md](docs/roadmap.md).

## Development

Requires Node 22.22.2 or newer on the 22 line, or Node 24.15.0 or newer (jsdom and Vitest need these). CI tests both 22.22.2 and the latest 24.

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm test` | Run unit tests (Vitest + jsdom) |
| `npm run lint` | Run ESLint and check Prettier formatting |
| `npm run format` | Fix formatting with Prettier |
| `npm run build` | Type-check and build into `dist/` |
| `npm run dev` | Rebuild into `dist/` on every change |
