# PR Explainer: Roadmap

This roadmap breaks the project into **milestones** and **PRs**.

- A **milestone** ends with something you can demo in an interesting way.
- A **PR** is a small change. Every PR is either **Small** (under 10 minutes to review) or **Medium** (under 20 minutes to review). If a PR grows past Medium while it is being written, split it before opening it.
- Every PR lists why it is needed, the problem it solves, the unit tests it adds, and step-by-step instructions for testing it.
- Every PR that changes something you can see (the popup, a badge, the toolbar icon, the settings page) includes screenshots of it in the PR description, saved under `docs/screenshots/pr-<number>/`, so a reviewer can see what to look for and where to find it.

## Technical choices

| Area | Choice | Reason |
|---|---|---|
| Extension platform | Chrome Manifest V3 | Required for new Chrome extensions |
| Language | TypeScript | Type safety across content script, service worker, and UI |
| Build | Vite, one entry per extension part, `manifest.json` copied from `public/` | Fast builds and a watch mode for reloading the extension, with no extra plugin while the manifest is static |
| Unit tests | Vitest + jsdom | Fast, works with TypeScript, can test DOM code against saved HTML fixtures |
| Local LLM | Ollama HTTP API (`/api/tags`, `/api/chat`) | Easy to install on a laptop, streams responses, many code models available |
| UI inside GitHub | Shadow DOM | Keeps GitHub's CSS from breaking our popup and keeps ours from breaking GitHub |

All calls to the LLM go through the extension's **service worker**, not the content script. That keeps the LLM address out of the GitHub page and avoids most CORS problems.

### Setup used by every "How to test" section
See [InstallingExtension.md](InstallingExtension.md) for a step-by-step version of steps 1, 3 and 4, including how to check out a PR's branch and how to confirm the extension loaded.

1. Install Node 22.22.2+ (or 24.15+) and run `npm install`.
2. Install Ollama and pull a model, for example `ollama pull qwen2.5-coder:7b`.
3. Run `npm run build` (or `npm run dev` for watch mode).
4. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the `dist/` folder. After rebuilding, click the reload icon on the extension card.
5. Run `npm test` to run the unit tests.

## PR status

Update this table (and the PR's heading) when a roadmap PR merges.

| PR | Title | Size | Status |
|---|---|---|---|
| 1.1 | Project scaffold and test runner | Small | ✅ Done ([#2](https://github.com/larry94555/PR-explainer/pull/2)) |
| 1.2 | Manifest V3 and empty extension parts | Small | ✅ Done ([#4](https://github.com/larry94555/PR-explainer/pull/4)) |
| 1.3 | PR page detection and "active" badge | Small | ✅ Done ([#5](https://github.com/larry94555/PR-explainer/pull/5)) |
| 1.4 | Message passing between content script and service worker | Small | ✅ Done ([#6](https://github.com/larry94555/PR-explainer/pull/6)) |
| 2.1 | Settings storage | Small | ✅ Done ([#7](https://github.com/larry94555/PR-explainer/pull/7)) |
| 2.2 | Ollama client: list models and non-streaming chat | Medium | ✅ Done ([#8](https://github.com/larry94555/PR-explainer/pull/8)) |
| 2.3 | Settings page UI | Medium | ✅ Done ([#9](https://github.com/larry94555/PR-explainer/pull/9)) |
| 2.4 | Friendly LLM error messages | Small | ✅ Done ([#10](https://github.com/larry94555/PR-explainer/pull/10)) |
| 3.1 | Diff line locator | Medium | ✅ Done ([#11](https://github.com/larry94555/PR-explainer/pull/11)) |
| 3.2 | Hunk context extractor | Medium | ✅ Done ([#12](https://github.com/larry94555/PR-explainer/pull/12)) |
| 3.3 | Explanation prompt and response parser | Medium | ✅ Done ([#13](https://github.com/larry94555/PR-explainer/pull/13)) |
| 3.4 | Popup component | Medium | ✅ Done ([#14](https://github.com/larry94555/PR-explainer/pull/14)) |
| 3.5 | Wire clicks to explanations | Small | ✅ Done ([#15](https://github.com/larry94555/PR-explainer/pull/15)) |
| 3.6 | Toolbar on/off toggle | Small | ✅ Done ([#16](https://github.com/larry94555/PR-explainer/pull/16)) |
| 4.1 | Streaming in the Ollama client | Medium | ✅ Done ([#17](https://github.com/larry94555/PR-explainer/pull/17)) |
| 4.2 | Stream to the popup with a Stop button | Medium | ✅ Done ([#18](https://github.com/larry94555/PR-explainer/pull/18)) |
| 4.3 | Explanation cache and Regenerate | Medium | ✅ Done ([#19](https://github.com/larry94555/PR-explainer/pull/19)) |
| 4.4 | Multi-line selection | Medium | ✅ Done ([#20](https://github.com/larry94555/PR-explainer/pull/20)) |
| 5.1 | Chat session model | Small | Not started |
| 5.2 | Chat panel UI | Medium | Not started |
| 5.3 | Connect chat to the LLM with streaming | Medium | Not started |
| 5.4 | Chat about a new line from the same panel | Small | Not started |
| 6.1 | Include PR title and description | Small | Not started |
| 6.2 | Token budget and context trimming | Medium | Not started |
| 6.3 | Expanded file context | Medium | Not started |
| 7.1 | Handle GitHub's in-page navigation | Small | Not started |
| 7.2 | Split view and lazy-loaded diffs | Medium | Not started |
| 7.3 | Theme support and accessibility | Small | Not started |
| 7.4 | Privacy check and packaging | Small | Not started |
| 8.1 | Latency breakdown in the popup | Small | Not started |
| 8.2 | Latency benchmark script and baseline | Medium | Not started |
| 8.3 | Keep the model loaded and warm it up | Small | Not started |
| 8.4 | Shorter answers | Small | Not started |
| 8.5 | Smaller, cache-friendly prompts | Medium | Not started |
| 8.6 | Model and GPU check on the settings page | Medium | Not started |
| 8.7 | Explain on hover (prefetch) | Medium | Not started |
| 8.8 | Latency report and faster defaults | Small | Not started |

## Milestone overview

| # | Milestone | Demo at the end |
|---|---|---|
| 1 | Extension skeleton | The extension loads, and a "PR Explainer active" badge appears on any GitHub PR page |
| 2 | Talking to the local LLM | The settings page lists your installed Ollama models and a **Test** button gets a reply from the model |
| 3 | Click-to-explain | Click a line in a PR diff and a popup explains what it does, why it's needed, and concerns |
| 4 | Fast, smooth explanations | Explanations stream in live, can be stopped, are cached, and work on multi-line selections |
| 5 | Chat box | Open a chat from the popup and ask follow-up questions about the code |
| 6 | Smarter context | Explanations use the PR description and more of the file, and stay within the model's context limit |
| 7 | Robust on real GitHub | Works across split view, dark mode, lazy-loaded diffs, and in-page navigation; ready to share |
| 8 | Optimize LLM latency | An explanation finishes in under 10 seconds on your laptop, or a report shows the lowest time that laptop can reach and why |

---

## Milestone 1: Extension skeleton

**Demo:** Load the unpacked extension, open any GitHub pull request, and see a small "PR Explainer active" badge in the corner. Open a GitHub issue page and see no badge.

### PR 1.1: Project scaffold and test runner (Small) ✅ Done
- **Status:** Done, merged in [#2](https://github.com/larry94555/PR-explainer/pull/2).
- **Why it's needed:** Every later PR needs a build, a linter, and a test runner.
- **Problem it solves:** There is no code yet. This sets up TypeScript, Vite, Vitest, ESLint, Prettier, and `npm` scripts (`build`, `dev`, `test`, `lint`), plus a CI workflow that runs lint and tests on each PR.
- **Unit tests added:** One trivial test (`sanity.test.ts`) that proves Vitest runs.
- **How to test:**
  1. Run `npm install`.
  2. Run `npm test` and confirm 1 test passes.
  3. Run `npm run lint` and confirm no errors.
  4. Run `npm run build` and confirm a `dist/` folder is created.

### PR 1.2: Manifest V3 and empty extension parts (Small) ✅ Done
- **Status:** Done, merged in [#4](https://github.com/larry94555/PR-explainer/pull/4).
- **Why it's needed:** Chrome needs a manifest and entry points before it will load the extension.
- **Problem it solves:** Adds `manifest.json` with a service worker, a content script that matches `https://github.com/*/*/pull/*`, an empty options page, and an icon. Permissions are limited to `storage` and host access for `github.com`.
- **Unit tests added:** `manifest.test.ts` checks that the manifest is valid MV3, that the content script only matches PR URLs, and that no extra permissions are requested.
- **How to test:**
  1. Run `npm run build`.
  2. Load `dist/` as an unpacked extension.
  3. Confirm the extension card shows no errors.
  4. Click **Details**, then **Extension options**, and confirm a blank options page opens.

### PR 1.3: PR page detection and "active" badge (Small) ✅ Done
- **Status:** Done, merged in [#5](https://github.com/larry94555/PR-explainer/pull/5).
- **Why it's needed:** The content script must know it is on a PR page and show the user it is running.
- **Problem it solves:** Adds `parsePrUrl(url)`, which returns `{owner, repo, number, tab}` or `null`, and shows a small badge (in a Shadow DOM) in the bottom right corner on PR pages. The badge is re-checked after GitHub's in-page (Turbo) navigations, so it disappears when you leave the PR without a reload.
- **Unit tests added:** `parsePrUrl.test.ts` covers the conversation, commits, checks, and files tabs, URLs with query strings and hashes, issue URLs (returns `null`), and non-GitHub URLs (returns `null`). `badge.test.ts` checks that the badge is added once, lives in a shadow root, and is removed on non-PR pages.
- **How to test:**
  1. Build and reload the extension (see [InstallingExtension.md](InstallingExtension.md)).
  2. Open any public PR, for example `https://github.com/microsoft/vscode/pulls`, and pick one.
  3. Confirm the "PR Explainer active" badge appears.
  4. Open an issue page in the same repo and confirm no badge appears.

### PR 1.4: Message passing between content script and service worker (Small) ✅ Done
- **Status:** Done, merged in [#6](https://github.com/larry94555/PR-explainer/pull/6).
- **Why it's needed:** All LLM calls will run in the service worker, so the content script needs a reliable way to ask it for things.
- **Problem it solves:** Adds a small typed messaging layer in `src/messaging/`: `sendRequest(type, payload)` for the content script and a `MessageRouter` handler registry for the service worker, with timeouts and error forwarding. Request types and their payloads and results are declared once in `protocol.ts` (types only, so the content script still builds without shared chunks). Adds a `ping` message as the first use, and the badge tooltip shows whether the service worker answered.
- **Unit tests added:** `messaging.test.ts` uses a fake `chrome.runtime` to check that requests reach the right handler (sync and async), that handler errors come back as rejected promises with their name and message, that unknown types are rejected, that a missing listener or a failing `sendMessage` is reported, that timeouts fire, and that messages from other extensions or without our tag are ignored. `badge.test.ts` checks the new status line in the tooltip.
- **How to test:**
  1. Build and reload the extension (see [InstallingExtension.md](InstallingExtension.md)).
  2. Open a PR page.
  3. Hover the badge and confirm its tooltip says "Service worker: connected" (it sends `ping` on load).
  4. In `chrome://extensions`, click **service worker** under the extension to open its console, reload the PR tab, and confirm a `ping received` log line.

---

## Milestone 2: Talking to the local LLM

**Demo:** Open the extension's settings page. It shows the Ollama URL, a dropdown filled with your installed models, and a **Test** button. Click it and see a short reply from your local model. Stop Ollama and click **Test** again to see a clear "Ollama is not running" message with a fix.

### PR 2.1: Settings storage (Small) ✅ Done
- **Status:** Done, merged in [#7](https://github.com/larry94555/PR-explainer/pull/7).
- **Why it's needed:** The LLM URL, model name, and options must persist and be read from several places.
- **Problem it solves:** Adds `src/settings.ts` with a typed `Settings` schema, defaults (`http://localhost:11434`, no model, temperature 0.2, max response length 1024 tokens), `getSettings()`, `saveSettings(partialUpdate)`, and `validateSettings()`. The URL must be `http://` or `https://` on `localhost`, `127.0.0.1` or `[::1]`, with no path. Only values the user saved are stored, in `chrome.storage.sync` with one key per field (`settings.model` and so on), so a save writes only the fields it changes and two pages saving different fields at once can't overwrite each other. A bad stored value falls back to its default. Dev builds expose `debugSettings` in the service worker console for manual testing.
- **Unit tests added:** `settings.test.ts` with a fake `chrome.storage` covers defaults on first run, saving and reloading, merging partial updates, two overlapping saves of different fields both surviving, storing only saved fields, trimming input, rejecting invalid URLs (remote, LAN, lookalike hosts, paths, other schemes) and out-of-range temperatures and response lengths, storing nothing when a save is rejected, and falling back to defaults for bad stored values.
- **How to test:**
  1. Run `npm test` and confirm the settings tests pass.
  2. Run `npm run dev`, wait for `built in`, then reload the extension (see [InstallingExtension.md](InstallingExtension.md)).
  3. On `chrome://extensions`, click the **service worker** link on the PR Explainer card and use the **Console** tab of the DevTools window that opens.
  4. Run `await chrome.storage.sync.get(null)` and confirm it is `{}` (defaults live in code).
  5. Run `await debugSettings.get()` and confirm the defaults, then `await debugSettings.save({ model: 'qwen2.5-coder:7b' })` and `await debugSettings.save({ llmUrl: 'http://example.com' })` (the second is rejected).

### PR 2.2: Ollama client: list models and non-streaming chat (Medium) ✅ Done
- **Status:** Done, merged in [#8](https://github.com/larry94555/PR-explainer/pull/8).
- **Why it's needed:** The extension needs one place that knows how to talk to the local LLM.
- **Problem it solves:** Adds an `LlmClient` interface (`src/llm/types.ts`) and an `OllamaClient` (`src/llm/ollamaClient.ts`) with `listModels()` (calls `/api/tags`) and `chat(messages, options)` (calls `/api/chat` with `stream: false`, passing temperature and max response length as Ollama's `temperature` and `num_predict`). Every failure becomes an `LlmError` with a `kind`: `connection`, `model-not-found`, `origin-blocked`, `no-model`, `bad-response`, `http`, or `aborted`, which PR 2.4 turns into friendly messages. `createLlmClient(settings)` builds the client from the saved URL. Adds `host_permissions` for `localhost`, `127.0.0.1` and `[::1]` (any port), the same hosts the settings accept. Keeping it behind an interface makes it possible to add other local servers (such as LM Studio) later. Dev builds expose `debugLlm` in the service worker console.
- **Unit tests added:** `ollamaClient.test.ts` with a mocked `fetch` covers parsing the model list, building the chat request body, parsing the reply, and raising typed errors for connection refused, HTTP 404 (model missing), HTTP 403 (CORS or origin blocked), other HTTP errors, bad JSON, a missing model name, and a cancelled request. `manifest.test.ts` checks the new host permissions.
- **How to test:**
  1. Run `npm test` and confirm the `ollamaClient` tests pass.
  2. Make sure Ollama is running (`ollama list` works) and note one model name. Ollama refuses chat requests from extensions unless `OLLAMA_ORIGINS` allows them, so set it to `chrome-extension://*` and restart Ollama (on macOS: `launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"`; on Windows, in Command Prompt: `setx OLLAMA_ORIGINS "chrome-extension://*"`; then quit Ollama and open it again).
  3. Run `npm run dev` (not `npm run build`, which leaves the debug helpers out), wait for `built in`, then reload the extension (see [InstallingExtension.md](InstallingExtension.md)).
  4. On `chrome://extensions`, click the **service worker** link on the PR Explainer card and use the **Console** tab of the DevTools window that opens (not the PR page's console).
  5. Run `typeof debugLlm` and confirm it says `'object'`. If it says `'undefined'`, `dist/` is a production build: run `npm run dev` and reload the extension again.
  6. Run `await debugLlm.listModels()` and confirm your models are listed.
  7. Run `await debugSettings.save({ model: '<a model from step 2>' })`, then `await debugLlm.chat('Reply with OK')` and confirm the reply.

### PR 2.3: Settings page UI (Medium) ✅ Done
- **Status:** Done, merged in [#9](https://github.com/larry94555/PR-explainer/pull/9).
- **Why it's needed:** Users need a way to point the extension at their LLM and choose a model without editing code.
- **Problem it solves:** Builds the options page (`src/options.html`, `src/options/optionsPage.ts`): URL field, model dropdown filled from `listModels()` (with a **Refresh** button, and reloaded when the URL changes), temperature slider, max response length, **Save**, and **Test connection** (sends "Reply with OK" using the values in the form, saved or not, and shows the reply and response time). Each invalid field shows its own error, and nothing is saved until all are valid. A saved model the server does not have stays selected and is marked "(not installed)". The page calls the LLM client directly: it is an extension page with the same host permissions as the service worker, and this keeps the typed `LlmError` for PR 2.4. Errors show the raw message for now; PR 2.4 makes them friendly.
- **Unit tests added:** `optionsPage.test.ts` (jsdom, against the real `options.html`) covers loading saved values into the form, filling the dropdown from a mocked model list, the "Choose a model" placeholder, keeping a saved model that is not installed, the "no models" hint, a failed model load, reloading models when the URL changes, ignoring a stale model list (including after the URL is changed to an invalid one), showing a validation error for a bad URL, saving (by method and by the **Save** button), per-field errors with nothing saved, and showing the test reply and time or the error text.
- **How to test:**
  1. Run `npm test` and confirm the `optionsPage` tests pass.
  2. Make sure Ollama is running and allows the extension (see step 2 of PR 2.2: `OLLAMA_ORIGINS` set to `chrome-extension://*`, then restart Ollama).
  3. Run `npm run dev`, wait for `built in`, then reload the extension (see [InstallingExtension.md](InstallingExtension.md)).
  4. Open the settings page. Either copy the **ID** from the PR Explainer card on `chrome://extensions` and open `chrome-extension://<ID>/options.html` in a new tab, or click **Details** on the card and scroll to the very bottom (below **Site access** and **Allow in Incognito**) to the **Extension options** link.
  5. Confirm the dropdown lists the models from `ollama list` and the status says how many were found.
  6. Pick a model, click **Save**, reload the page, and confirm the choice was kept.
  7. Click **Test connection** and confirm a reply such as "OK" and a time in milliseconds.
  8. Change the URL to `http://example.com` and click **Save**: confirm the URL error appears and, after reloading, the old URL is still there.

### PR 2.4: Friendly LLM error messages (Small) ✅ Done
- **Status:** Done ([#10](https://github.com/larry94555/PR-explainer/pull/10)).
- **Why it's needed:** The most common first-run problems are "Ollama isn't running", "model not pulled", and "origin blocked". Users need to know how to fix them.
- **Problem it solves:** Adds `describeLlmError(error, context)` (`src/llm/describeLlmError.ts`), which turns each `LlmError` kind into a short message and a fix, for example "Start Ollama (open the Ollama app, or run `ollama serve`)", "Run `ollama pull <model>`, then click Refresh", or the `OLLAMA_ORIGINS` command for the user's system (`setx` on Windows, `launchctl setenv` on macOS, a generic hint elsewhere, picked from the browser's user agent). Unknown errors get a generic fallback. The settings page uses it for **Refresh** and **Test connection** failures, showing the fix on its own line with commands as code.
- **Unit tests added:** `describeLlmError.test.ts` checks the message and fix for each error kind (with and without a known URL or model), the `OLLAMA_ORIGINS` command for each platform, the generic fallback for unknown errors, and platform detection from user agents. `optionsPage.test.ts` now checks the friendly text for a failed model load, a failed test, and a blocked origin on Windows.
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test` and confirm the `describeLlmError` and `optionsPage` tests pass.
  2. Run `npm run dev`, wait for `built in`, then reload the extension (see [InstallingExtension.md](InstallingExtension.md)) and open the settings page (see step 4 of PR 2.3).
  3. Stop Ollama: right-click the Ollama icon in the system tray and choose **Quit Ollama** (or run `taskkill /F /IM "ollama app.exe"` and `taskkill /F /IM ollama.exe`). Click **Refresh** and confirm "Could not load models. Ollama is not running at http://localhost:11434." with a "Start Ollama" fix below it. Click **Test connection** and confirm the same message after "Test failed."
  4. Start Ollama from the Start menu, click **Refresh**, and confirm the models load.
  5. Make the saved model one that is not installed: on `chrome://extensions`, open the PR Explainer **service worker** console and run `await debugSettings.save({ model: 'not-a-model:1b' })`. Reload the settings page, confirm the dropdown shows "not-a-model:1b (not installed)", click **Test connection**, and confirm the message says to run `ollama pull not-a-model:1b`.
  6. Pick a real model, click **Test connection**, and confirm the reply.
  7. Optional, origin blocked: run `setx OLLAMA_ORIGINS ""`, quit and reopen Ollama, click **Test connection**, and confirm the fix shows `setx OLLAMA_ORIGINS "chrome-extension://*"`. Run that command, quit and reopen Ollama, and confirm the test succeeds again. (Newer Ollama versions may already allow extensions, in which case this step cannot fail.)

---

## Milestone 3: Click-to-explain

**Demo:** Open the **Files changed** tab of a real PR. Click any added line. A popup appears next to the line with three sections, **What it does**, **Why it's needed**, and **Concerns**, written by your local model.

### PR 3.1: Diff line locator (Medium) ✅ Done
- **Status:** Done ([#11](https://github.com/larry94555/PR-explainer/pull/11)).
- **Why it's needed:** Before we can explain a click, we must turn it into "which file, which line, which side of the diff".
- **Problem it solves:** Adds `locateLine(target)` (`src/diffDom.ts`), which returns `{filePath, lineNumber, side: 'added' | 'removed' | 'context', text}` for a click anywhere on a diff line (code, line number, or `+`/`-` marker), or `null` for hunk headers, expand rows, comments, and anything outside a diff. Removed lines use the old file's line number; added and context lines use the new file's. All GitHub-specific CSS selectors live in this one file so GitHub markup changes only need a fix here. GitHub serves two diff layouts, the classic one and the newer React one (used by the new "Files changed" experience), and both are supported in unified view; split view comes in PR 7.2. The content script logs each located click to the page console.
- **Unit tests added:** `diffDom.test.ts` runs against two saved HTML fixtures (`tests/fixtures/github-diff-classic.html` and `github-diff-new.html`, trimmed from real GitHub pages). For each layout it covers added, removed, and context lines, clicks on the line number or marker versus the code, nested highlight spans and text nodes, hunk headers and expand rows (return `null`), clicks outside a diff (return `null`), and where the file path comes from.
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test` and confirm the `diffDom` tests pass.
  2. Run `npm run dev`, wait for `built in`, then reload the extension (see [InstallingExtension.md](InstallingExtension.md)).
  3. Open the **Files changed** tab of a PR, for example `https://github.com/larry94555/PR-explainer/pull/10/files`, make sure the diff is in **Unified** view (the gear or "Diff view" setting at the top), then press `F12` and open the **Console** tab.
  4. Click the code of a green (added) line. Confirm the console logs `[PR Explainer] clicked line` with the right `filePath`, the `lineNumber` shown in the right-hand number column, `side: "added"`, and the line's text.
  5. Click a red (removed) line and confirm `side: "removed"` with the left-hand line number, then a plain (context) line and confirm `side: "context"` with the right-hand number.
  6. Click a line number instead of the code and confirm the same line is logged.
  7. Click the PR title, a file name, or a `@@ ... @@` hunk header and confirm nothing is logged.

### PR 3.2: Hunk context extractor (Medium) ✅ Done
- **Status:** Done ([#12](https://github.com/larry94555/PR-explainer/pull/12)). Grew from Small to Medium because `diffDom.ts` was reshaped so both layouts can walk neighbouring rows.
- **Why it's needed:** One line alone is rarely enough for the model to explain it well.
- **Problem it solves:** Adds `locateHunk(target)` to `src/diffDom.ts`, which returns every code line of the clicked line's hunk plus its `@@ ... @@` header, never crossing into another hunk and skipping inline comment rows. Adds `extractContext(target, {before, after})` (`src/lineContext.ts`, default 10 lines each way), which returns the clicked line, the surrounding lines with `+`, `-`, or space markers, the hunk header, and the file's language from its extension or name, and `formatContext(context)`, the plain-text block that PR 3.3 will send to the model. The content script logs that block on each click.
- **Unit tests added:** `extractContext.test.ts` runs on both saved fixtures and covers a line in the middle of a hunk, lines at the start and end of a hunk, a second hunk header inserted mid-hunk (no crossing), mixed added and removed lines, skipped comment rows, `null` for hunk headers and outside a diff, the default window, the formatted block, and language detection for common extensions, special file names, dotfiles, and unknown extensions.
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test` and confirm the `extractContext` and `diffDom` tests pass.
  2. Run `npm run dev`, wait for `built in`, then reload the extension (see [InstallingExtension.md](InstallingExtension.md)).
  3. Open the **Files changed** tab of a PR in **Unified** view, for example `https://github.com/larry94555/PR-explainer/pull/11/files`, press `F12`, and open the **Console** tab.
  4. Click a line in the middle of a hunk. Confirm `[PR Explainer] context for the model:` is logged with the file name and language, the clicked line, the `@@ ... @@` header, and up to 10 lines before and after, each starting with `+`, `-`, or a space.
  5. Click the first line under a `@@` header and confirm no lines from the hunk above appear.
  6. Click a hunk header or the PR title and confirm nothing is logged.

### PR 3.3: Explanation prompt and response parser (Medium) ✅ Done
- **Status:** Done ([#13](https://github.com/larry94555/PR-explainer/pull/13)).
- **Why it's needed:** The model must return the three sections in a predictable shape so the popup can show them.
- **Problem it solves:** Adds `buildExplainPrompt(contextText)` (`src/explain/explainPrompt.ts`), a system prompt plus a user message that wraps the `formatContext` block and asks for markdown with exactly the headings "What it does", "Why it's needed", and "Concerns". It takes the formatted text, not a `LineContext`, so the service worker never imports content-script code. Adds `parseExplanation(text)` (`src/explain/parseExplanation.ts`), which splits the reply into `{what, why, concerns}` and copes with format mistakes: other heading levels, bold, numbered or colon headings, text on the heading line, filler before the first heading, `<think>` blocks from reasoning models, missing sections, and no headings at all. Adds an `explain` request that the service worker answers with the parsed sections, or with `describeLlmError`'s message and fix when the LLM call fails (the messaging layer only carries an error's name and message, and the popup needs the fix). Dev builds add `debugLlm.explain(text)` and `debugLlm.explainSample()` in the service worker console, and log an explanation for each clicked diff line in the page console (PRs 3.4 and 3.5 replace that log with the popup).
- **Unit tests added:** `explainPrompt.test.ts` snapshot-tests the prompt for a sample context and checks the headings and the code block. `parseExplanation.test.ts` covers a well-formed reply, missing or empty "Concerns" (becomes "None found."), missing "Why it's needed", heading levels 1 and 3, bold, bold with a colon, numbered and mixed-case headings, Windows line endings, text on the heading line, a sentence that only starts like a heading, filler and `<think>` blocks, a reply with no headings (all text goes under "What it does"), and an empty reply. `explainHandler.test.ts` checks that the saved model, temperature and length are used, that LLM errors come back as a message and fix, and that an empty context is rejected without calling the model.
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test` and confirm the `explainPrompt`, `parseExplanation`, and `explainHandler` tests pass.
  2. Make sure Ollama is running (`ollama list` works), `OLLAMA_ORIGINS` is set (`setx OLLAMA_ORIGINS "chrome-extension://*"`, then quit Ollama from the system tray and open it again), and a model is chosen on the settings page.
  3. Run `npm run dev`, wait for `built in`, then reload the extension (see [InstallingExtension.md](InstallingExtension.md)).
  4. On `chrome://extensions`, click the **service worker** link on the PR Explainer card and open the **Console** tab. Run `await debugLlm.explainSample()` and confirm it returns `status: "done"` and an `explanation` with `what`, `why`, and `concerns`.
  5. Open the **Files changed** tab of a PR in **Unified** view, press `F12`, open the **Console** tab, and click an added line. Confirm `[PR Explainer] asking the model…` is logged, then (after a few seconds to a minute) `[PR Explainer] explanation` with the three sections.
  6. Quit Ollama from the system tray, click a line again, and confirm the explanation has `status: "failed"` with a message saying Ollama is not running and a fix. Open Ollama again afterwards.

### PR 3.4: Popup component (Medium) ✅ Done
- **Status:** Done ([#14](https://github.com/larry94555/PR-explainer/pull/14)).
- **Why it's needed:** Users need to see the explanation next to the code they clicked.
- **Problem it solves:** Adds `openPopup(anchor)` (`src/popup/popup.ts`), a popup rendered in a Shadow DOM root with a loading state (spinner and model name), a done state (the three titled sections), and an error state (the message and fix from `describeLlmError`, with commands shown as code). It sits below the clicked line, or above it when there is no room below, and when neither fits it moves up just enough to stay fully inside the window. It stays inside the window horizontally too, and scrolls with the page. It closes with its close button, **Esc**, or a click outside, and opening a new popup closes the old one. Model output is untrusted, so `renderMarkdown` (`src/popup/renderMarkdown.ts`) builds DOM nodes for a small markdown subset (paragraphs, lists, code blocks, inline code, bold, italic) and never parses HTML: tags show as text and links show as their text only. Adds `npm run demo:popup`, a static demo page with fake data (`demo/`, not part of the extension build). Nothing on GitHub changes yet; PR 3.5 opens the popup on clicks.
- **Unit tests added:** `popup.test.ts` (jsdom) covers the loading, done, and error states, closing with the button, **Esc**, and an outside click (but not an inside click), that listeners are removed after closing, one popup at a time, ignoring updates after closing, that styles stay inside the shadow root, positioning next to an element, that `<script>`, `onerror`, and `javascript:` links in model output or errors create no elements and do not run, and `computePosition` (below, above, no room either way for a line mid-window, a popup taller than the window, window edges, page scroll). `renderMarkdown.test.ts` covers paragraphs, inline code, bold, italic, lists with continuation lines, code blocks, headings, links, and escaped HTML.
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test` and confirm the `popup` and `renderMarkdown` tests pass.
  2. Run `npm run demo:popup`. Your browser opens the demo page (if it does not, open the `Local:` address it prints, adding `/popup.html`). Press `Ctrl+C` in Command Prompt to stop it when you are done.
  3. With **Explanation** selected, click a line of the fake diff. Confirm a popup appears just below the line with **What it does**, **Why it's needed**, and **Concerns**, a bullet list, inline code, and a code block, and the model name in the header.
  4. Select **Loading, then explanation** and click a line. Confirm a spinner and "Asking qwen2.5-coder:7b…" show for two seconds, then the three sections replace them.
  5. Select **Error** and click a line. Confirm a red "Ollama is not running at http://localhost:11434." and a fix with `ollama serve` shown as code.
  6. Select **Unsafe model output** and click a line. Confirm the `<img>`, `<script>`, `<b>`, and `<iframe>` tags appear as plain text, no alert box opens, and "A link that goes nowhere" is not a link.
  7. Press **Esc** and confirm the popup closes and "Last event: closed" shows. Open it again, click inside the popup (it stays open), then click on the page outside it (it closes). Open it again and click the **×** button (it closes).
  8. Scroll down to the second fake diff, scroll so its lines sit near the bottom of the window, and click one. Confirm the popup opens above the line. Scroll the page and confirm the popup moves with the line.
  9. Run `npm run build` and confirm it still succeeds (the demo is not part of `dist/`).

### PR 3.5: Wire clicks to explanations (Small) ✅ Done
- **Status:** Done ([#15](https://github.com/larry94555/PR-explainer/pull/15)).
- **Why it's needed:** This joins the locator, context, service worker, and popup into the full feature.
- **Problem it solves:** Adds `createClickHandler` (`src/clickHandler.ts`), which the content script attaches to the page. A click on a diff code line opens the popup in the loading state next to the line's row (found by the new `locateRow` in `src/diffDom.ts`), sends an `explain` request with the line's context, and fills in the three sections or the error's message and fix. If the service worker cannot answer at all (timeout, or "Extension context invalidated" after a reload), the popup shows a friendly message and fix too. Clicks are left alone when they land on GitHub's own controls (the comment "+" button, links, buttons, menus, form fields), when they finish a text selection, or when Shift, Ctrl, Alt, or Cmd is held, so selecting and copying code still works. Clicking another line while a request is pending replaces the popup, and the late answer is dropped. To track the local model's latency, the popup header shows the elapsed time: a live timer while loading, then "Answered in 12.4 s" or "Failed after 0.8 s", measured from the click. Every build also logs `[PR Explainer] explained in 12.4 s (model)` to the page console, so times can be compared across models and future speed-ups (streaming in 4.1 and 4.2, caching in 4.3, context trimming in 6.2). Dev builds still log the context block sent to the model; the old "explanation" console log is gone.
- **Unit tests added:** `clickHandler.test.ts` runs on both saved fixtures and checks that a click on a code line sends one request with the right context and anchors the popup to the line's row, that done, failed, and unreachable-service-worker results reach the popup, that hunk headers, clicks outside a diff, the comment button (and the icon inside it), links, menu items, modified clicks, and clicks that end a text selection send nothing, and that a second click while the first request is pending replaces the popup and drops the late answer. They also check that each answer or error reports its elapsed time once, and that a dropped late answer reports nothing. One test uses the real popup to check the loading state, the three sections, and that clicks inside the popup send nothing. `popup.test.ts` adds elapsed-time tests with a fake clock: the timer counts up while loading, freezes at "Answered in …" or "Failed after …", stops when the popup closes, and formats seconds and minutes.
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test` and confirm the `clickHandler` tests pass (and all the others still do).
  2. Make sure Ollama is running (`ollama list` works), `OLLAMA_ORIGINS` is set (see PR 3.3), and a model is chosen on the settings page.
  3. Run `npm run dev`, wait for `built in`, then reload the extension (see [InstallingExtension.md](InstallingExtension.md)).
  4. Open the **Files changed** tab of a PR in **Unified** view, for example `https://github.com/larry94555/PR-explainer/pull/14/files`, and refresh the page so the new content script loads.
  5. Click the code of a green (added) line. Confirm a popup opens just below the line with a spinner and "Asking the model…", and a timer in the header counting up (`0.1 s`, `0.2 s`, …). After a few seconds to a minute, confirm **What it does**, **Why it's needed**, and **Concerns** appear, the header shows the model name and "Answered in" with the final time, and the timer stops. Press `F12`, open the **Console** tab, and confirm `[PR Explainer] explained in … s (model name)` shows the same time.
  6. Click a different line before the first answer arrives. Confirm the first popup closes, a new one opens next to the new line, and only the new line's explanation appears.
  7. Hover a line and click GitHub's blue **+** comment button. Confirm GitHub's comment box opens and no popup appears. Also click a file name link and confirm no popup appears.
  8. Drag across some code to select it, then release. Confirm no popup opens and the text stays selected (`Ctrl+C` copies it). `Ctrl`+click a line and confirm no popup opens either.
  9. Press **Esc**, or click outside the popup, and confirm it closes.
  10. Quit Ollama from the system tray, click a line, and confirm the popup shows the red "Ollama is not running" message, a fix, and "Failed after" with a short time in the header. Open Ollama again afterwards.
  11. On `chrome://extensions`, click the extension's reload icon, go back to the PR tab **without** refreshing it, and click a line. Confirm the popup says "PR Explainer did not get an answer. Could not reach the service worker: Extension context invalidated." and suggests reloading the page. Refresh the page and confirm clicks work again.

### PR 3.6: Toolbar on/off toggle (Small) ✅ Done
- **Status:** Done ([#16](https://github.com/larry94555/PR-explainer/pull/16)).
- **Why it's needed:** Users sometimes want to click and select code on GitHub without triggering popups.
- **Problem it solves:** Clicking the PR Explainer icon in Chrome's toolbar now turns click-to-explain off or on for every tab at once. The icon shows a green "ON" or grey "OFF" badge, and its tooltip says what a click will do. The choice is saved in `chrome.storage.local` (not synced, so turning it off on one laptop leaves another alone) and survives browser restarts. While it is off, clicks on diff lines do nothing, and turning it off also closes an open popup. The page badge from PR 1.3 changes from blue "PR Explainer active" to grey "PR Explainer off", and back. The service worker side is `setupToolbarToggle` (`src/toolbarToggle.ts`), which handles quick clicks one at a time so two clicks always end where they started. The content script side is `trackEnabled` (`src/enabledState.ts`), which reads the state and hears about changes through `chrome.storage.onChanged`. Clicks are ignored until the saved state is known, and a change that arrives while the first read is pending wins over that read's older answer. The content script cannot share code with the service worker, so each file keeps its own copy of the storage key, and a test checks that they match. The manifest gains an `action` entry (toolbar button with no popup page) and no new permissions.
- **Unit tests added:** `toggle.test.ts` checks that the state is on by default, flips and persists on each toggle, and ignores stored values that are not true or false; that the content script hears changes to its key only (not other keys or `sync` storage); that the icon shows the saved state when the service worker starts, shows "ON" and "OFF" with the right tooltip after each click, handles three quick clicks in order, and keeps working after a storage error; that `trackEnabled` is unknown until the read finishes, ignores a pending read overtaken by an OFF change, and falls back to on when the read fails; and that both files use the same key and default. `clickHandler.test.ts` checks, on both saved diff layouts, that a click sends nothing and opens no popup while off and works again once on. `badge.test.ts` checks the "PR Explainer off" text and grey style and switching back. `manifest.test.ts` checks the toolbar button and that it has no popup page.
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test` and confirm the `toggle` tests pass (and all the others still do).
  2. Make sure Ollama is running (`ollama list` works) and a model is chosen on the settings page.
  3. Run `npm run dev`, wait for `built in`, then reload the extension (see [InstallingExtension.md](InstallingExtension.md)). The manifest changed, so use the reload icon on the extension card, not just a page refresh.
  4. Chrome hides new extension icons, so pin it first. Click the puzzle-piece **Extensions** icon at the right end of the address bar, then the **⋮** next to **PR Explainer**, then **Pin to toolbar** (older Chrome versions show a pin icon instead of **⋮**). The PR Explainer icon now sits just left of the puzzle piece. Confirm it shows a green **ON** badge, and hovering it says "PR Explainer is on. Click to turn it off." Screenshots: [the Extensions menu](screenshots/pr-3.6/1-extensions-menu.png), [Pin to toolbar](screenshots/pr-3.6/2-pin-to-toolbar.png), [the pinned icon showing ON](screenshots/pr-3.6/3-icon-on.png).
  5. Open the **Files changed** tab of a PR in **Unified** view, for example `https://github.com/larry94555/PR-explainer/pull/15/files`, and refresh the page. Confirm the blue "PR Explainer active" badge in the bottom right corner, and click a line to confirm a popup still opens.
  6. Click a line, and while the popup is still loading, click the toolbar icon. Confirm the badge on the icon changes to a grey **OFF** ([screenshot](screenshots/pr-3.6/4-icon-off.png)), the popup closes, and the page badge changes to a grey "PR Explainer off" without refreshing the page ([on and off](screenshots/pr-3.6/5-page-badge-on-off.png)).
  7. Click a few diff lines and confirm no popup opens. Drag across some code and confirm it selects and copies (`Ctrl+C`) normally.
  8. Open a second PR in another tab and confirm its page badge also says "PR Explainer off" and clicks open no popup there either.
  9. Close Chrome completely and open it again. Confirm the icon still shows **OFF** and a PR page still shows "PR Explainer off".
  10. Click the icon again. Confirm it shows **ON**, both tabs' page badges go back to blue "PR Explainer active", and clicking a line opens a popup with an explanation.

---

## Milestone 4: Fast, smooth explanations

**Demo:** Click a line and watch the explanation type itself out live. Press **Stop** midway. Click the same line again and it appears instantly from the cache. Drag across five lines and get one explanation of the whole block.

### PR 4.1: Streaming in the Ollama client (Medium) ✅ Done
- **Status:** Done ([#17](https://github.com/larry94555/PR-explainer/pull/17)).
- **Why it's needed:** Local models can take 10 to 30 seconds to finish. Watching text appear feels much faster than staring at a spinner.
- **Problem it solves:** Adds `chatStream(messages, options)` to `LlmClient` and `OllamaClient` (`src/llm/ollamaClient.ts`). It calls `/api/chat` with `stream: true`, reads Ollama's newline-delimited JSON as it arrives, and yields each piece of text, then returns the model name and why it stopped (`stop`, or `length` when it hit the response limit). It joins JSON lines and multi-byte characters that are split across network chunks. It takes the same options as `chat()` (model, temperature, max length, and an `AbortSignal`), and raises the same `LlmError` kinds: `aborted` when the signal fires, `connection` when the stream breaks or ends before Ollama's final `done` line, `http` when Ollama sends an `{"error": ...}` line mid-reply, and `bad-response` for a line that is not valid. Aborting, or leaving a `for await` loop early, cancels the HTTP request so Ollama stops generating. `chat()` and `chatStream()` now share the code that sends a request and turns failures into errors. Nothing on the page changes yet; PR 4.2 shows the stream in the popup. Dev builds add `debugLlm.streamSample()`, which streams the sample explanation in the service worker console.
- **Unit tests added:** `chatStream.test.ts` uses fake `ReadableStream` bodies to check the request body (`stream: true` and the model options), text pieces in order and the return value, JSON lines split across chunks, several lines in one chunk and a character split between chunks, a last line with no newline and blank lines, text on the `done` line and the `length` reason, ignoring anything after `done`, aborting mid-stream (the read in progress ends and the body is cancelled), an already-aborted signal (no request is sent, even with a fetch that ignores the signal), a fetch that fails after an abort, leaving the loop early (the body is cancelled), a stream that errors halfway, a stream that ends before `done`, an error line from Ollama, invalid lines, the HTTP and connection errors from before the stream starts, and a missing model.
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test` and confirm the `chatStream` tests pass (and all the others still do).
  2. Make sure Ollama is running (`ollama list` works), `OLLAMA_ORIGINS` is set (see PR 2.2), and a model is chosen on the settings page.
  3. Run `npm run dev` (not `npm run build`, which leaves the debug helpers out), wait for `built in`, then reload the extension (see [InstallingExtension.md](InstallingExtension.md)).
  4. On `chrome://extensions`, click the **service worker** link on the PR Explainer card and use the **Console** tab of the DevTools window that opens (not the PR page's console).
  5. Run `for await (const c of debugLlm.streamSample()) console.log(c)`. Confirm many short log lines appear one after another while the model writes (a word or part of a word each), not all at once at the end, and that together they read as an explanation with **What it does**, **Why it's needed**, and **Concerns** headings.
  6. To see the return value, run `const s = debugLlm.streamSample(); let n; while (!(n = await s.next()).done) {}; n.value` and confirm it shows `{model: '<your model>', doneReason: 'stop'}` (or `'length'` if the reply hit the response limit on the settings page).
  7. To check stopping, run `const ac = new AbortController(); setTimeout(() => ac.abort(), 2000); for await (const c of debugLlm.streamSample(ac.signal)) console.log(c)`. Confirm pieces stop after about two seconds and the console shows an `LlmError: The request was cancelled.` error. Open Task Manager (`Ctrl+Shift+Esc`) and confirm the `ollama` process's CPU or GPU use drops back down within a few seconds, which shows Ollama stopped generating.
  8. Quit Ollama from the system tray, run the command from step 5 again, and confirm it fails with `LlmError: Could not connect to http://localhost:11434.` Open Ollama again afterwards.

### PR 4.2: Stream to the popup with a Stop button (Medium) ✅ Done
- **Status:** Done ([#18](https://github.com/larry94555/PR-explainer/pull/18)).
- **Why it's needed:** The streaming client from PR 4.1 is only useful if the popup shows text as it arrives. A slow local model also needs a way out other than waiting or closing the popup.
- **Problem it solves:** Explanations now travel over a long-lived port (`chrome.runtime.connect`) instead of a one-shot message. The content script opens the port and sends the line's context (`openExplainStream` in `src/messaging/client.ts`). The service worker (`listenForExplainPorts` in the new `src/messaging/streamPort.ts`) runs the `explain` handler, which now calls `chatStream`, forwards each piece of the reply as it arrives, and sends the parsed three sections at the end. While text streams in, the popup shows the reply so far as markdown with a blinking caret, and keeps the newest text in view unless the user scrolled up. When the reply is complete it switches to the three sections, as before. A **Stop** button in the popup header (shown only while the model is working) disconnects the port, which aborts the Ollama request; the text so far stays, and the header says "Stopped after 4.2 s". Closing the popup, or clicking another line, stops the request too, so Ollama is never left generating an answer nobody will see. The elapsed-time timer keeps counting while text streams, and the console line adds when the first text arrived: `[PR Explainer] explained in 12.4 s (qwen2.5-coder:7b, first text after 1.3 s)`, or `stopped in …`. The old 120-second timeout is gone, since Stop replaces it. A port the content script has closed never crashes the service worker. The `explain` one-shot message is removed; `debugLlm.explain` in dev builds still works. The port name is kept in two files (the content script cannot share code with the service worker) and a shared type makes TypeScript check they match.
- **Unit tests added:** `streamPort.test.ts` uses a fake `chrome.runtime` whose ports deliver messages asynchronously and throw when used after disconnecting, like Chrome's. It checks that chunks are forwarded in order and then the result, that Stop disconnects the port and aborts the request in the service worker (nothing more reaches the page and nothing throws), that a handler error arrives with its name and message, that the port closes after the result, that ports with another name or from another extension are ignored, that posting to a port that closed without notice does not crash the service worker and aborts the request, that only the first `start` message runs, that a reloaded extension ("Extension context invalidated") and a service worker that closes the port early give friendly reasons, and that Stop leaves no unhandled promise rejection. `popup.test.ts` adds partial rendering (markdown, replaced on each update, HTML shown as text), switching to the sections at the end, Stop keeping the text so far and ignoring later updates, Stop before any text, Stop after the answer doing nothing, the timer counting while streaming, and "Stopped after". `clickHandler.test.ts` adds the reply growing in the popup, Stop stopping the request and reporting "stopped", closing the popup or clicking another line stopping the request, and the first-text time; one test with the real popup checks the streamed markdown. `explainHandler.test.ts` now checks that each piece reaches `onChunk` with the abort signal passed to `chatStream`, and that a stream that breaks midway gives a friendly error.
- **Screenshots** (taken on PR #17's **Files changed** tab, with a fake Ollama that streams a canned reply): [loading with the Stop button](screenshots/pr-4.2/1-loading.png), [text streaming in](screenshots/pr-4.2/2-streaming.png), [the finished three sections](screenshots/pr-4.2/3-done.png), [stopped midway](screenshots/pr-4.2/4-stopped.png).
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test` and confirm the `streamPort` tests pass (and all the others still do).
  2. Make sure Ollama is running (`ollama list` works), `OLLAMA_ORIGINS` is set (see PR 2.2), and a model is chosen on the settings page.
  3. Run `npm run dev`, wait for `built in`, then reload the extension (see [InstallingExtension.md](InstallingExtension.md)).
  4. Open the **Files changed** tab of a PR in **Unified** view, for example `https://github.com/larry94555/PR-explainer/pull/17/files`, and refresh the page so the new content script loads.
  5. Click the code of a green (added) line. Confirm the popup opens with a spinner, "Asking the model…", a timer counting up, and a **Stop** button next to the timer. After the model loads, confirm text starts appearing a few words at a time with a blinking blue caret after it, while the timer keeps counting. When it finishes, confirm the text is replaced by **What it does**, **Why it's needed**, and **Concerns**, the header shows the model name and "Answered in …", and the **Stop** button is gone.
  6. Press `F12` and open the **Console** tab. Confirm a line like `[PR Explainer] explained in 9.8 s (qwen2.5-coder:7b, first text after 1.2 s)`. The first-text time should be well below the total.
  7. Click another line and, once a few words have appeared, click **Stop**. Confirm the words stop, the text so far stays in the popup, the header says "Stopped after …", the **Stop** button disappears, and the console says `[PR Explainer] stopped in …`. Open Task Manager (`Ctrl+Shift+Esc`) and confirm the `ollama` process's CPU or GPU use drops back down within a few seconds, which shows Ollama stopped generating.
  8. Click a line and press **Stop** before any text appears. Confirm the popup says "Stopped before the model wrote anything."
  9. Click a line, and while text is streaming, press **Esc** (or click another line). Confirm the popup closes (or the new one opens) and, in Task Manager, Ollama's CPU or GPU use drops as in step 7.
  10. While a long answer streams, scroll up inside the popup. Confirm it stops jumping to the newest text until you scroll back to the bottom.
  11. Quit Ollama from the system tray, click a line, and confirm the red "Ollama is not running" message with a fix and "Failed after …" in the header. Open Ollama again afterwards.
  12. On `chrome://extensions`, click the extension's reload icon, go back to the PR tab **without** refreshing it, and click a line. Confirm the popup says "PR Explainer did not get an answer. Could not reach the service worker: Extension context invalidated." Refresh the page and confirm clicks work again.

### PR 4.3: Explanation cache and Regenerate (Medium) ✅ Done
- **Status:** Done ([#19](https://github.com/larry94555/PR-explainer/pull/19)). Grew from Small to Medium because Regenerate needed the popup to go back to loading and the click handler to replace a running request.
- **Why it's needed:** Users often click the same line twice, and repeat requests to a local model are slow.
- **Problem it solves:** Adds a cache of finished explanations (`src/explain/explainCache.ts`) in the service worker, stored in `chrome.storage.session` so it survives the service worker going idle and is cleared when Chrome closes. Each entry's key is a SHA-256 hash of everything that shapes the answer: the PR (`owner/repo#17`, from the page URL), the model, the temperature and response limit from the settings, and the full prompt sent to the model (the instructions plus the file, line, and the code around it). So changing a setting, or a later build changing the prompt, is a miss. The roadmap first planned to key on the commit SHA, but GitHub's diff pages do not show it reliably; keying on the code itself means a new commit that changes the code around the line is a miss, and one that does not touch it still hits. It keeps the newest 100 entries and drops the oldest first; a hit counts as new again. Only finished answers are saved, never errors or stopped replies. A broken or full cache never breaks an explanation: a failed read is a miss and a failed write is ignored. A cached answer arrives at once and the popup header says "From cache · took 9.8 s" (how long the model took the first time) instead of "Answered in …". A **Regenerate** button in the header, shown once the model has finished, failed, or been stopped, puts the popup back in the loading state, restarts the timer, and asks again with `fresh: true`, which skips the cache and saves the new answer over the old one. Nothing from the replaced request can reach the popup. The console line adds `from cache` for cached answers. Dev builds add `debugLlm.cache()` in the service worker console to list what the cache holds.
- **Unit tests added:** `cache.test.ts` covers the key (fixed length, same input gives the same key, a different PR, model, temperature, response limit, code, or prompt instructions gives a different one, parts that run together are not mixed up), hit, miss, saving again under the same key, eviction at the size limit, a recently used entry outliving older ones, two answers saved at the same moment both kept, stored values in an unexpected shape ignored, and the cache working again after a storage call fails. With the explain handler it covers a miss then a hit (the model is asked once and the hit carries the first time taken), a different model is a miss, a changed temperature or response limit is a miss while unchanged settings still hit, changed code (a new commit) is a miss, another PR is a miss, Regenerate (`fresh`) bypassing the cache and saving the new answer, failures and requests without a PR not being cached, and a failing cache storage still giving an answer. `popup.test.ts` adds the Regenerate button (only shown when finished, failed, or stopped, going back to loading and calling `onRegenerate`, keeping the model name, doing nothing while the model works) and the timer ("From cache · took …", restarting from zero on Regenerate). `clickHandler.test.ts` adds asking for a cached answer first, Regenerate asking again with `fresh` and showing the new answer, and Regenerate after Stop ignoring the stopped request. `streamPort.test.ts` adds passing the PR and `fresh` through the port, and ignoring them when they have the wrong type.
- **Screenshots** (taken on PR #10's **Files changed** tab, with a fake Ollama that streams a canned reply): [first answer with Regenerate](screenshots/pr-4.3/1-fresh-answer.png), [the same line again, from the cache](screenshots/pr-4.3/2-from-cache.png), [regenerating](screenshots/pr-4.3/3-regenerating.png), [the regenerated answer](screenshots/pr-4.3/4-regenerated.png).
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test` and confirm the `cache` tests pass (and all the others still do).
  2. Make sure Ollama is running (`ollama list` works), `OLLAMA_ORIGINS` is set (see PR 2.2), and a model is chosen on the settings page.
  3. Run `npm run dev`, wait for `built in`, then reload the extension (see [InstallingExtension.md](InstallingExtension.md)).
  4. Open the **Files changed** tab of a PR in **Unified** view, for example `https://github.com/larry94555/PR-explainer/pull/18/files`, and refresh the page so the new content script loads. Press `F12` and open the **Console** tab.
  5. Click the code of a green (added) line and wait for the answer. Confirm the header shows "Answered in …" and a **Regenerate** button (it is not shown while the text streams in, only the **Stop** button is).
  6. Press **Esc** and click the same line again. Confirm the three sections appear at once, with no spinner, and the header says "From cache · took …" with the same time as step 5. The console shows `[PR Explainer] explained in 0.0 s (<model>, from cache)`.
  7. Click **Regenerate**. Confirm the popup goes back to "Asking <model>…" with the timer starting again from 0.0 s, the new answer streams in, and the header ends with "Answered in …". Close the popup, click the line again, and confirm the cached answer is now the new one ("From cache · took" shows the time from this step).
  8. Click a different line and confirm it is asked fresh (spinner, then streaming).
  9. On the settings page, change the **Temperature** (for example from 0.2 to 0.5) and save, go back to the PR tab, and click the line from step 5. Confirm it is asked fresh, since the cache is per model and settings. Set it back to 0.2, click the line again, and confirm the answer comes from the cache. Picking a different model, or changing the response limit, is asked fresh the same way.
  10. Click a new line, press **Stop** after a few words, then click **Regenerate**. Confirm the popup asks again and shows a full answer. Close and click the line again; it comes from the cache. A stopped reply is never cached: click another new line, press **Stop**, close the popup, click that line again, and confirm it is asked fresh.
  11. On `chrome://extensions`, click the **service worker** link on the PR Explainer card and run `await debugLlm.cache()` in its console. Confirm it lists the saved entries, newest last, each with a `key`, `model`, `elapsedMs`, and the three sections.
  12. Close every Chrome window, open Chrome again, open the same PR, and click the line from step 5. Confirm it is asked fresh, since the cache only lasts for the browser session.

### PR 4.4: Multi-line selection (Medium) ✅ Done
- **Status:** Done ([#20](https://github.com/larry94555/PR-explainer/pull/20)).
- **Why it's needed:** Many changes only make sense as a block, such as a whole `if` statement or function.
- **Problem it solves:** Adds `src/selection.ts`. The user picks a range of lines in one file by dragging across them (a text selection that covers two or more rows) or by clicking one line and Shift-clicking another, in either direction. The rows are tinted blue with a blue bar on the left, and an **Explain selection (N lines)** button appears under the last one. Pressing it opens the usual popup, pointed at the whole block (below it, or above it when there is no room below, instead of covering it), with the same streaming, elapsed time, **Stop**, cache and **Regenerate** as a single line: the shared part of the click handler is now `explainInPopup` in `src/clickHandler.ts`. `locateRange` in `src/diffDom.ts` collects the rows between the two ends, keeping the header of any hunk the range crosses, and `formatSelection` in `src/lineContext.ts` sends the model the file, a summary (`Selection: 5 lines (3 added, 2 unchanged); lines 144 to 150 of the new file`), up to 10 lines before, the selected lines, and up to 10 lines after. The service worker sees the `Selection:` line and uses a system prompt that asks for the block to be explained as a whole, not line by line; the single-line prompt is unchanged, so cached single-line answers still hit. A range across two files shows "Select lines in one file at a time." for four seconds instead of a button, and a range over 100 lines asks for a smaller one (the full token budget is PR 6.2). Esc, or a mousedown anywhere else, clears the highlight and the button; while the block's popup is open the highlight stays until the popup closes. Nothing happens while the toolbar button has click-to-explain off, and a plain click on one line works as before.
- **Unit tests added:** `selection.test.ts` (jsdom with both diff fixtures) covers `locateRange` (a range with mixed added and removed lines, the same range selected bottom to top, keeping a crossed hunk header, rejecting a range across two files, and ends that are not on a code line), `formatSelection` (the summary, lines before and after, a block of only added lines), the block prompt being used for a selection while a single line keeps the line prompt (this also checks the `Selection:` text matches in the content script and the service worker), and the page behavior: a drag highlights the rows and the button explains them as one block, Shift-click in either direction, a selection inside one line being ignored, the cross-file note (and it going away), the line limit, Esc and a click elsewhere clearing the highlight, a later click not bringing back an old selection the browser still shows (the full mousedown, mouseup, click sequence), nothing happening while turned off, and a new selection replacing the highlight of a block whose popup is still open. All the click handler tests still pass against the shared `explainInPopup`.
- **Screenshots** (taken on PR #19's **Files changed** tab with a fake Ollama that streams a canned reply; GitHub's own stylesheet is blocked in the screenshot sandbox, so the diff uses a small stand-in style): [a Shift-click selection with the Explain selection button](screenshots/pr-4.4/1-selected.png), [the block's explanation streaming in](screenshots/pr-4.4/2-streaming.png), [the finished explanation above the block](screenshots/pr-4.4/3-done.png), [the note for a range across two files](screenshots/pr-4.4/4-other-file.png).
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test` and confirm the `selection` tests pass (and all the others still do).
  2. Make sure Ollama is running (`ollama list` works), `OLLAMA_ORIGINS` is set (see PR 2.2), and a model is chosen on the settings page.
  3. Run `npm run dev`, wait for `built in`, then reload the extension (see [InstallingExtension.md](InstallingExtension.md)).
  4. Open the **Files changed** tab of a PR in **Unified** view, for example `https://github.com/larry94555/PR-explainer/pull/19/files`, and refresh the page so the new content script loads. Press `F12` and open the **Console** tab.
  5. In `src/clickHandler.ts`, press the mouse on the code of one line and drag down across about five lines, then let go. Confirm the five rows turn light blue with a blue bar on the left, and a green **Explain selection (5 lines)** button appears under the last row. No popup opens yet.
  6. Click **Explain selection**. Confirm the popup opens below the block (or above it, near the bottom of the window) without covering it, the timer counts up with a **Stop** button, the answer streams in, and it ends with **What it does**, **Why it's needed**, and **Concerns** about the block as a whole, then "Answered in …" and **Regenerate**. The rows stay highlighted while the popup is open.
  7. In the console, confirm `[PR Explainer] context for the model:` shows a `Selection: 5 lines (…)` line and a `Selected lines:` section, and then `[PR Explainer] explained in …`.
  8. Press **Esc**. Confirm the popup closes and the highlight goes away. Drag across the same five lines again and click **Explain selection**; confirm the answer appears at once with "From cache · took …". Click **Regenerate** and confirm it asks again.
  9. Click one line (its popup opens; press **Esc**), then hold **Shift** and click a line about six rows above it. Confirm the rows between the two are highlighted with the button, as in step 5. Press **Stop** partway through an explanation to confirm Stop still works for a block.
  10. Click a line in one file, press **Esc**, then **Shift**-click a line in a different file. Confirm a small "Select lines in one file at a time." note appears and fades after about four seconds, with nothing highlighted.
  11. Drag across a selection inside a single line (a few words). Confirm nothing is highlighted and no button appears, so copying text still works.
  12. Click a single line without Shift and confirm it is explained on its own, as before.
  13. Click the PR Explainer toolbar button to turn it off, drag across several lines, and confirm nothing is highlighted. Turn it back on.

---

## Milestone 5: Chat box

**Demo:** After an explanation appears, click **Ask a question**. A chat panel opens with the code and explanation already in context. Ask "How would I unit test this?" and get a streamed answer, then ask a follow-up that relies on the first answer.

### PR 5.1: Chat session model (Small)
- **Why it's needed:** Chat needs a clear record of messages and what context they carry, separate from the UI.
- **Problem it solves:** Adds a `ChatSession` that holds the system prompt, the code context, the original explanation, and the list of user and assistant messages. It builds the message list for the LLM and keeps one session per PR in memory while the tab is open.
- **Unit tests added:** `chatSession.test.ts` covers creating a session from an explanation, adding turns, the exact message list sent to the model, and one session per PR being reused.
- **How to test:**
  1. Run `npm test` and confirm the chat session tests pass. (There is no UI yet; this PR is logic only.)

### PR 5.2: Chat panel UI (Medium)
- **Why it's needed:** Users need a place to type questions and read answers.
- **Problem it solves:** Adds a chat panel in the Shadow DOM: message list, text box, **Send** (and **Enter** to send, **Shift+Enter** for a new line), auto-scroll, and a header showing which file and lines are being discussed. Answers are rendered as sanitized markdown with code blocks.
- **Unit tests added:** `chatPanel.test.ts` (jsdom) covers rendering a conversation, Enter versus Shift+Enter, the Send button being disabled for empty input, and auto-scroll on new messages.
- **How to test:**
  1. Run `npm run demo:chat` (added in this PR) and check the panel with fake messages.
  2. Type a message and confirm Enter sends it and Shift+Enter adds a line.

### PR 5.3: Connect chat to the LLM with streaming (Medium)
- **Why it's needed:** This turns the chat panel into a working feature.
- **Problem it solves:** Adds an **Ask a question** button to the popup that opens the chat panel with the session from PR 5.1. Sending a message streams the reply through the same port mechanism as PR 4.2, with **Stop** and error states.
- **Unit tests added:** `chatFlow.test.ts` with a mocked client checks that the first message includes the code and explanation, that follow-ups include earlier turns, and that Stop and errors leave the session in a usable state.
- **How to test:**
  1. Click a diff line and wait for the explanation.
  2. Click **Ask a question**, type "How would I unit test this?", and confirm a streamed answer about that code.
  3. Ask "Can you show that in Jest?" and confirm the answer builds on the previous one.
  4. Press **Stop** during an answer and confirm you can send another message after.

### PR 5.4: Chat about a new line from the same panel (Small)
- **Why it's needed:** Users reading a PR jump between lines and should not lose the conversation each time.
- **Problem it solves:** While the chat is open, clicking another line adds it to the conversation as new context ("Now looking at `file.ts` line 42") instead of starting over. A **New chat** button clears the session.
- **Unit tests added:** `chatSession.test.ts` gets cases for adding context mid-conversation and for **New chat** resetting the session.
- **How to test:**
  1. Open a chat about one line and ask a question.
  2. Click a different line and ask "How does this relate to the previous line?"; confirm the answer refers to both.
  3. Click **New chat** and confirm the history clears.

---

## Milestone 6: Smarter context

**Demo:** Click a line whose purpose is only clear from the PR description (for example, a feature flag). The **Why it's needed** section now quotes the PR's stated goal. On a very large file, explanations still work instead of failing with a context error.

### PR 6.1: Include PR title and description (Small)
- **Why it's needed:** "Why it's needed" is much better when the model knows what the PR is trying to do.
- **Problem it solves:** Reads the PR title and description from the page (falling back to the conversation tab's HTML if not on the page) and adds them to the prompt.
- **Unit tests added:** `prMetadata.test.ts` with HTML fixtures covers reading the title and body, an empty description, and very long descriptions being trimmed.
- **How to test:**
  1. Open a PR with a clear description.
  2. Click a line related to the stated goal.
  3. Confirm **Why it's needed** refers to the PR's goal.

### PR 6.2: Token budget and context trimming (Medium)
- **Why it's needed:** Local models often have small context windows (4k to 8k tokens). Too much context gives errors or silently cut prompts.
- **Problem it solves:** Adds `estimateTokens(text)` and `fitToBudget(parts, budget)`, which keep the most important parts (clicked code, then nearby lines, then PR description, then extra file context) and trim the rest. The budget is read from the model's info (`/api/show`) or a setting.
- **Unit tests added:** `tokenBudget.test.ts` covers estimates within a tolerance on sample code, required parts never being dropped, trimming order, and a budget too small even for the clicked code (returns a clear error).
- **How to test:**
  1. In settings, set the context size to 2048.
  2. Click a line in a large PR and confirm an explanation still appears.
  3. Turn on **Show prompt** in settings (a debug option added in this PR) and confirm the prompt was trimmed.

### PR 6.3: Expanded file context (Medium)
- **Why it's needed:** The diff often hides the function or class the changed line belongs to.
- **Problem it solves:** Fetches the full file at the PR's head commit from `raw.githubusercontent.com` (or the page's own raw URL for private repos while signed in) and adds the enclosing function or block around the clicked line, within the token budget.
- **Unit tests added:** `fileContext.test.ts` covers finding the enclosing block by indentation and braces for a few languages, falling back to a fixed window of lines, and handling a fetch failure gracefully (explanation still works without it).
- **How to test:**
  1. Open a PR where a change sits inside a long function that is mostly collapsed in the diff.
  2. Click the changed line.
  3. Confirm the explanation mentions the function's purpose, and with **Show prompt** on, confirm the function body is in the prompt.

---

## Milestone 7: Robust on real GitHub

**Demo:** Move between the Conversation and Files changed tabs without reloading, switch to split view and dark mode, scroll through a huge PR where diffs load lazily, and click-to-explain keeps working everywhere. A packaged `.zip` is ready to share.

### PR 7.1: Handle GitHub's in-page navigation (Small)
- **Why it's needed:** GitHub changes pages without a full reload, so a content script that only runs on load stops working after you switch tabs.
- **Problem it solves:** Listens for GitHub's navigation events and URL changes, and re-attaches handlers (and removes old ones) when the PR or tab changes.
- **Unit tests added:** `navigation.test.ts` checks that handlers attach on entering the Files tab, detach on leaving, and do not attach twice.
- **How to test:**
  1. Open a PR's Conversation tab.
  2. Click **Files changed** (no reload) and confirm click-to-explain works.
  3. Go back and forth several times and confirm only one popup appears per click.

### PR 7.2: Split view and lazy-loaded diffs (Medium)
- **Why it's needed:** Many reviewers use split view, and large PRs load file diffs as you scroll.
- **Problem it solves:** Extends `DiffDom` to handle split view (left side is the old file, right is the new file) and uses a `MutationObserver` so files that load later are supported.
- **Unit tests added:** `diffDom.test.ts` gets split-view fixtures for both sides; `lazyLoad.test.ts` checks that diffs added to the DOM after start-up become clickable.
- **How to test:**
  1. In the Files tab, switch to **Split** view.
  2. Click a line on the left and confirm it is treated as removed; click one on the right and confirm it is treated as added.
  3. Open a PR with 50+ files, scroll to the bottom, click a line in a late-loading file, and confirm the popup works.

### PR 7.3: Theme support and accessibility (Small)
- **Why it's needed:** The popup and chat should look native in GitHub's light and dark themes and be usable from the keyboard.
- **Problem it solves:** Reads GitHub's color mode and uses matching colors. Adds focus handling (focus moves into the popup and returns on close), ARIA roles and labels, and a keyboard shortcut (**Alt+E**) to explain the focused or selected line.
- **Unit tests added:** `theme.test.ts` checks the right theme is picked from GitHub's attributes; `a11y.test.ts` checks roles, labels, and focus return on close.
- **How to test:**
  1. Switch GitHub to dark mode and confirm the popup matches.
  2. Select a line with the keyboard, press **Alt+E**, and confirm the popup opens with focus inside it.
  3. Press **Esc** and confirm focus returns to the code.

### PR 7.4: Privacy check and packaging (Small)
- **Why it's needed:** Users must be able to trust that code stays local, and the extension needs an easy way to install.
- **Problem it solves:** Adds a test that fails if code ever calls `fetch` to an address other than the configured LLM URL or GitHub, a short `PRIVACY.md` note in the settings page, and an `npm run package` script that builds a versioned `.zip`.
- **Unit tests added:** `networkGuard.test.ts` checks that requests to unknown hosts are refused by the shared fetch wrapper, and `manifest.test.ts` is extended to check that host permissions are only GitHub and localhost.
- **How to test:**
  1. Run `npm run package` and confirm a `.zip` appears in `release/`.
  2. Remove the dev extension, unzip the file, load that folder with **Load unpacked**, and confirm everything works.
  3. Use the extension for a few clicks with the DevTools **Network** tab open and confirm requests only go to github.com and localhost.

---

## Milestone 8: Optimize LLM latency

**Goal:** an explanation finishes in **under 10 seconds**, measured from the click to "Answered in …" in the popup (the timer added in PR 3.5), on the laptop the extension is used on. If that is not possible on that hardware, find the lowest latency that is, and explain what limits it.

**Demo:** Run `npm run bench` and show the before and after table in `docs/latency.md`. Then open a PR, click a line, and watch the popup say "Answered in" with a time under 10 seconds (or at the floor the report predicts). Open the latency details in the popup to show where the time went.

**How the time breaks down.** Every Ollama reply reports `load_duration` (loading the model into memory), `prompt_eval_count` and `prompt_eval_duration` (reading the prompt), and `eval_count` and `eval_duration` (writing the answer). So:

> total ≈ load time + prompt tokens ÷ prompt speed + answer tokens ÷ generation speed + extension overhead

Each PR below attacks one term. Load time can be removed entirely by keeping the model loaded (8.3). Answer tokens are usually the biggest term, so 8.4 makes answers shorter. Prompt tokens are cut and cached by 8.5. Generation and prompt speed depend on the model and on whether it runs on the GPU (8.6). Prefetching (8.7) hides time the user would otherwise wait. The **floor** is the time for the smallest prompt and the shortest useful answer on the fastest model that still gives good explanations, with no load time. 8.8 measures it.

This milestone comes last because it builds on streaming (4.1, 4.2), caching (4.3), and the token budget (6.2). PR 8.1 and 8.2 only measure, so they can be done earlier if wanted.

### PR 8.1: Latency breakdown in the popup (Small)
- **Why it's needed:** "Answered in 14.2 s" says the explanation was slow but not why. We can't fix what we can't see.
- **Problem it solves:** The Ollama client returns Ollama's timing fields with each reply, and the `explain` result carries them to the content script. The popup gets a small **Details** toggle next to the time showing load, prompt (tokens and time), and answer (tokens, time, and tokens per second), plus the time spent outside Ollama (messaging and parsing). The console log from PR 3.5 adds the same numbers.
- **Unit tests added:** `ollamaClient.test.ts` checks the timing fields are read (nanoseconds converted to milliseconds) and missing fields are tolerated. `latencyBreakdown.test.ts` checks the split, tokens per second, and the "other" time never going negative. `popup.test.ts` checks the Details toggle.
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test` and confirm the new tests pass.
  2. Run `npm run dev`, reload the extension, and refresh a PR's **Files changed** tab.
  3. Quit Ollama and open it again so the model is not loaded. Click a line, open **Details**, and confirm "Load" is several seconds.
  4. Click another line and confirm "Load" is now close to zero and the numbers add up to roughly the total.

### PR 8.2: Latency benchmark script and baseline (Medium)
- **Why it's needed:** Clicking lines by hand gives noisy numbers. Each later PR needs a repeatable before and after measurement.
- **Problem it solves:** Adds `npm run bench`, a Node script (`scripts/bench.ts`) that sends the real explain prompt for 5 fixed sample contexts (short, long, and a few languages, stored in `bench/`) to the local Ollama, 3 runs each, for each model named on the command line (or the first installed model when none is named, since Node cannot read the extension's settings). It prints and saves a markdown table to `docs/latency.md` with median and slowest total time, load, prompt and answer tokens, tokens per second, and time to first token. It records the machine (CPU, RAM, GPU name if Ollama reports it) so results from different laptops are not mixed up. The first run is committed as the baseline.
- **Unit tests added:** `benchStats.test.ts` covers median and slowest-run math, table formatting, and handling a failed run (marked, not dropped). The script itself talks to a real Ollama and is tested by hand.
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test` and confirm `benchStats` passes.
  2. Make sure Ollama is running, then run `npm run bench -- qwen2.5-coder:7b`.
  3. Confirm progress prints for each sample and run, and the table appears at the end.
  4. Open `docs/latency.md` and confirm the table and your machine details were added under a dated heading.

### PR 8.3: Keep the model loaded and warm it up (Small)
- **Why it's needed:** Ollama unloads a model after 5 idle minutes, and loading a 7B model can take 5 to 20 seconds. That alone can blow the 10 second goal on the first click.
- **Problem it solves:** Sends `keep_alive` (a new setting, default 30 minutes) with every request so the model stays in memory while you review. When a PR's **Files changed** tab opens, the service worker sends a tiny warm-up request so the model is loaded before the first click. Warm-up is skipped if the model is already loaded (`/api/ps`).
- **Unit tests added:** `ollamaClient.test.ts` checks `keep_alive` is sent. `warmup.test.ts` checks warm-up runs once per tab, is skipped when `/api/ps` lists the model, and never shows an error to the user if it fails. `settings.test.ts` covers the new setting's range.
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test`.
  2. Run `npm run dev`, reload the extension. Quit Ollama and open it again.
  3. Open a PR's **Files changed** tab, wait 15 seconds, then run `ollama ps` in Command Prompt and confirm the model is listed with an "UNTIL" about 30 minutes away.
  4. Click a line, open **Details**, and confirm "Load" is close to zero.
  5. Run `npm run bench` and confirm load time no longer appears in the median.

### PR 8.4: Shorter answers (Small)
- **Why it's needed:** Writing the answer is usually the slowest part: at 20 tokens per second, a 500 token answer takes 25 seconds on its own.
- **Problem it solves:** Tightens the explain prompt to ask for at most 2 sentences per section and at most 3 concerns, and lowers the default answer limit (`maxResponseTokens`) from 1024 to 300, with the parser marking an answer that was cut off. Users who want more can still raise the limit in settings.
- **Unit tests added:** `explainPrompt.test.ts` snapshot is updated for the new wording. `parseExplanation.test.ts` covers an answer cut off mid-section. `settings.test.ts` checks the new default.
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test`.
  2. Run `npm run bench` and compare with the previous table: answer tokens and total time should both drop.
  3. Click 5 lines in a real PR and confirm the explanations are shorter but still say what the code does, why, and real concerns.

### PR 8.5: Smaller, cache-friendly prompts (Medium)
- **Why it's needed:** On a laptop CPU, reading a long prompt can take several seconds before the first word appears. Ollama can reuse work for a prompt that starts the same way as the previous one, but only if the unchanging parts come first.
- **Problem it solves:** Orders the prompt so the fixed instructions come first, then the PR title and description, then the file, then the clicked line, so consecutive clicks in the same PR reuse Ollama's cached prefix. Shortens the system prompt, lowers the default context window around the clicked line from 10 to 6 lines each way, and sets `num_ctx` to just what the prompt and answer need (smaller context windows are faster and use less memory). The bench script reports prompt tokens so the saving is visible.
- **Unit tests added:** `explainPrompt.test.ts` checks the order of the parts, that two prompts from the same PR share the same prefix, and the new snapshot. `numCtx.test.ts` checks `num_ctx` is rounded up from the prompt and answer size and stays within the model's limit.
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test`.
  2. Run `npm run bench` and confirm prompt tokens and prompt time dropped compared with the previous table.
  3. In a PR, click one line, then a nearby line in the same file. Open **Details** on the second popup and confirm its prompt time is much lower than the first.

### PR 8.6: Model and GPU check on the settings page (Medium)
- **Why it's needed:** The biggest speed difference comes from the model's size and whether it runs on the GPU. A 7B model on CPU can be 5 to 10 times slower than a 1.5B or 3B model, or the same model on a GPU, and users can't easily tell which they have.
- **Problem it solves:** The settings page gets a **Speed test** button that runs one short sample explanation on each installed coding model and shows a table of total time and tokens per second, marks the fastest model that finishes under 10 seconds, and lets the user pick it. It reads `/api/ps` to show whether the loaded model is fully on the GPU, partly, or on CPU, and suggests a fix (for example a smaller quantization such as `q4_K_M`, or closing apps that use video memory) when it is not fully on the GPU.
- **Unit tests added:** `speedTest.test.ts` (fake client) covers ranking, marking the under-10-second pick, models that fail, and stopping the test. `gpuStatus.test.ts` covers full GPU, partial, CPU only, and missing data. `optionsPage.test.ts` checks the table and the "Use this model" button.
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test`.
  2. Pull a second, smaller model: `ollama pull qwen2.5-coder:3b`.
  3. Run `npm run dev`, reload the extension, open the settings page, and click **Speed test**.
  4. Confirm both models are timed, the faster one is marked, and **Use this model** switches the setting.
  5. Confirm the GPU line matches what `ollama ps` shows in the "PROCESSOR" column.

### PR 8.7: Explain on hover (prefetch) (Medium)
- **Why it's needed:** Even a fast model takes a few seconds. If the explanation starts while the user is still reading the line, it can be ready (or nearly ready) when they click.
- **Problem it solves:** Adds an optional setting, off by default, that starts an explanation after the pointer rests on a diff line for 800 ms. The result goes into the cache from PR 4.3, so a click shows it at once or joins the request that is already running. Moving to another line cancels a prefetch that has not finished, and only one runs at a time so the laptop is not flooded.
- **Unit tests added:** `prefetch.test.ts` (fake timers) checks the delay, cancelling on move, one prefetch at a time, a click joining a running prefetch instead of starting a second request, and nothing happening when the setting is off.
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test`.
  2. Turn on **Explain on hover** on the settings page, run `npm run dev`, reload the extension, and refresh a PR.
  3. Rest the pointer on a line for 5 seconds, then click it. Confirm the popup's time is much shorter than a normal click.
  4. Move the pointer quickly down 20 lines and confirm (in the service worker console or `ollama ps`) that only one request ran at a time.

### PR 8.8: Latency report and faster defaults (Small)
- **Why it's needed:** The milestone needs a clear answer: did we reach under 10 seconds, and if not, what is the lowest time possible on this laptop?
- **Problem it solves:** Runs `npm run bench` with every change in place and writes the result to `docs/latency.md`: the baseline, the time after each PR from 8.3 to 8.7, and the final median and slowest times. If the goal is met, it says so with the settings used. If not, it states the measured floor (no load time, the shortest prompt, a 150-token answer, on the fastest model whose answers were still useful) and which term of the formula above dominates, with the next step that would help (for example a GPU, or a smaller model). The defaults are updated to the best combination found (model suggestion, answer limit, keep-alive, context lines).
- **Unit tests added:** `settings.test.ts` checks the new defaults. No new code beyond that.
- **How to test (Windows 11, Command Prompt):**
  1. Run `npm test`.
  2. Read `docs/latency.md` and confirm it has the baseline, a row per optimization, and a clear conclusion (goal met, or the floor and why).
  3. Run `npm run bench` yourself and confirm your numbers are close to the report.
  4. Reset the extension's settings to defaults, click 5 lines on a real PR, and confirm each popup says "Answered in" with a time at or near the reported result.

---

## Ideas after 1.0
These are not planned yet and would each get their own milestone:
- Support other local servers (LM Studio, llama.cpp server) through the `LlmClient` interface.
- "Explain this whole file" and "Summarize this PR" buttons.
- Turn a concern into a draft GitHub review comment with one click.
- Firefox support.
