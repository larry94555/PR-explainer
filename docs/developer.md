# Developer guide

Everything you need to work on PR Explainer: requirements, commands, the project layout, tests, demo pages, benchmarks, and how to build from a PR branch or cut a release.

[← Back to the README](../README.md)

## Requirements

- **Node.js 22.22.2 or newer** on the 22 line, or **24.15.0 or newer** (jsdom and Vitest need these). CI tests both 22.22.2 and the latest 24. The repo has an `.nvmrc`, so `nvm use` picks the right version.
- **Google Chrome** or another Chromium browser.
- **Ollama** with at least one model, for trying the extension and running benchmarks. Unit tests do not need it.

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm test` | Run unit tests (Vitest + jsdom) |
| `npm run test:watch` | Run unit tests on every change |
| `npm run lint` | Run ESLint and check Prettier formatting |
| `npm run format` | Fix formatting with Prettier |
| `npm run build` | Type-check and build into `dist/` |
| `npm run dev` | Rebuild into `dist/` on every change (development mode: source maps and debug helpers) |
| `npm run package` | Build and zip the extension into `release/pr-explainer-<version>.zip` |
| `npm run bench -- [model ...]` | Time explanations on the local Ollama and add the results to `docs/latency.md` (`--ahead`: time clicks after Explain ahead instead) |
| `npm run bench:history -- [model ...]` | Run the benchmark with the code after each latency PR (8.2 to now), time fresh answers and clicks after Explain ahead, measure the floor, and add the latency report to `docs/latency.md` |
| `npm run demo:popup` | Open a demo page for the explanation popup, with fake data |
| `npm run demo:chat` | Open a demo page for the chat panel, with fake messages |
| `npm run demo:debug` | Open a demo page for the debug window, playing a recorded flow with a click that runs live |

## Day-to-day workflow

1. Run `npm run dev` and load `dist/` with **Load unpacked** on `chrome://extensions` (see [Installing the extension](InstallingExtension.md)).
2. After a change is rebuilt, click the **reload** icon on the PR Explainer card, then **reload any open GitHub tabs** (pages opened before the reload still run the old code).
3. Before pushing, run the same checks as CI: `npm run lint`, `npm test`, `npm run build`.

### Debugging

- **Service worker console:** on `chrome://extensions`, click **service worker** on the PR Explainer card. In a `npm run dev` build, `debugLlm` and `debugSettings` are available there, for example `await debugLlm.listModels()` or `await debugLlm.explainSample()`.
- **Page console:** in a dev build, the content script logs the prompt, the PR description and the file context it sent, and every build logs a timing line per explanation.
- **Show prompt (debug):** tick it on the settings page to see the exact prompt, and what was trimmed, under each explanation.
- **Debug log:** with **Debug window** ticked on the settings page, the service worker keeps every round trip to GitHub and Ollama (prompt, reply and time) and each click's tasks, the last 200, in `chrome.storage.session` under `debugLog`. In the service worker console, run `chrome.storage.session.get('debugLog').then(console.log)`, or `await debugLlm.log()` in a dev build. Unticking it empties the log.
- **Debug window:** with the same setting on, click **Debug** in the popup (or right-click the toolbar button and choose **Open debug window**) to follow every round trip live, open one to see its prompt and reply, and **Copy as JSON** to share it. `npm run demo:debug` shows it with a recorded flow, without the extension or Ollama.
- **Details:** the popup's **Details** button shows a bar for each task of the click (finding the code, the GitHub fetches, the service worker's steps, and the model's Load, Read prompt, Think and Write answer), and the console logs the same tasks.

## Project layout

```text
public/             manifest.json and icons, copied into dist/ as they are
src/
  content.ts        content script entry (github.com pages)
  background.ts     service worker entry
  options.html      settings page; logic in src/options/
  chat/             chat session, panel, flow, and the worker's chat handler
  explain/          prompt, token budget, parser, cache, and the worker's explain handler
  llm/              LlmClient interface, Ollama client, context size, warm-up, GPU check, speed test
  messaging/        typed requests and stream ports between content script and worker
  net/              the two guarded fetches (GitHub and local LLM)
  popup/            explanation popup, Markdown renderer, latency breakdown
  *.ts              diff reading, selection, navigation, theme, badge, settings, toggle
tests/              one test file per module, plus fixtures/ with saved GitHub pages
demo/               popup and chat demo pages (npm run demo:*)
bench/              benchmark samples
scripts/            bench, bench:history, latency report, package, zip
docs/               features, roadmap, latency report, release guide, these pages
```

See [Object design](object-design.md) for what each module does, and [Design and data flow](design-and-data-flow.md) for how they work together.

### Build notes

- Vite builds one entry per extension part (`content.js`, `background.js`, `options.html`) and copies `public/manifest.json` as it is.
- **The content script must not share runtime imports with the other entries.** Chrome runs it as a classic script, and a shared module would become a chunk loaded with `import`, which fails. Share types only (`import type`). Where both sides need the same constant, keep a copy on each side and add a test that checks they match. `npm run package` compiles `content.js` as a classic script to catch mistakes.
- **All network access goes through `src/net/`.** `tests/networkGuard.test.ts` fails if any other file calls `fetch` or uses another way to reach the network.
- **GitHub selectors live only in `src/diffDom.ts`.** When GitHub changes its markup, fix it there and add a new fixture.

## Tests

- `npm test` runs the whole suite (over 1,000 tests in Vitest with jsdom). No browser or Ollama is needed.
- DOM code is tested against saved GitHub pages in `tests/fixtures/`: classic and new diff layouts in unified and split view, PR conversation pages, and a file page.
- The LLM client is tested against fake `fetch` responses and, for the network guards, against real local HTTP servers.
- `tests/__snapshots__/` holds a snapshot of the explain prompt, so prompt changes show up in review.
- Cross-cutting tests guard the design: `networkGuard`, `manifest` (permissions and version), constant copies between content script and worker, and `package` (the release zip).

## Demo pages

`npm run demo:popup` and `npm run demo:chat` open the popup and chat panel on a fake diff with canned data, so you can work on the UI without GitHub or Ollama. The popup demo has states for loading, a finished explanation, an error, unsafe model output and a cut-off answer, plus Light, Dark and System theme buttons. Most screenshots in the README and PRs were taken from these pages or from saved GitHub pages with a fake model.

## Benchmarks

- `npm run bench -- qwen2.5-coder:7b qwen2.5-coder:3b` sends the extension's real explain prompt for each sample in `bench/` to Ollama, times each answer (median, slowest, first token, load, prompt and answer tokens, tokens per second), and appends a dated section with the machine details to [`docs/latency.md`](latency.md). Options: `--runs N`, `--url URL`, `--no-save`, and `--ahead`, which instead explains each added line of a saved GitHub diff page ahead (as **Explain ahead** does) and then times a click on each, to show how many clicks are answered within 2 seconds.
- `npm run bench:history -- [model ...]` reruns the benchmark with the code as it was after each latency PR of Milestones 8 and 9 (in temporary git worktrees), times fresh answers with the model warm and clicks after Explain ahead, measures the floor, and writes a latency report with a conclusion against 2 seconds. It takes 20 to 40 minutes on a laptop.
- The settings page's **Speed test** is the quick, in-browser version: it times one short explanation on each installed coding model and offers to switch to the fastest.

## Building from a PR branch

[Installing the extension from a PR](InstallingExtension.md) walks through checking out a branch, building, loading `dist/` into Chrome, confirming it loaded, and troubleshooting.

## Releasing

The [release guide](release.md) covers building a production zip, versioning, publishing on the Chrome Web Store, and what is still missing for a production-quality extension.

## Contributing

The project is built in small PRs that each take under 20 minutes to review. Each PR in the [roadmap](roadmap.md) lists why it is needed, the problem it solves, the unit tests it adds, and step-by-step testing instructions, and any PR that changes the UI includes screenshots under `docs/screenshots/pr-<number>/`. New work should follow the same shape; see [Features and roadmap](planning.md).
