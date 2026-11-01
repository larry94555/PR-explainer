# PR Explainer: Roadmap

This roadmap breaks the project into **milestones** and **PRs**.

- A **milestone** ends with something you can demo in an interesting way.
- A **PR** is a small change. Every PR is either **Small** (under 10 minutes to review) or **Medium** (under 20 minutes to review). If a PR grows past Medium while it is being written, split it before opening it.
- Every PR lists why it is needed, the problem it solves, the unit tests it adds, and step-by-step instructions for testing it.

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
| 3.5 | Wire clicks to explanations | Small | Not started |
| 3.6 | Toolbar on/off toggle | Small | Not started |
| 4.1 | Streaming in the Ollama client | Medium | Not started |
| 4.2 | Stream to the popup with a Stop button | Medium | Not started |
| 4.3 | Explanation cache and Regenerate | Small | Not started |
| 4.4 | Multi-line selection | Medium | Not started |
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

### PR 3.5: Wire clicks to explanations (Small)
- **Why it's needed:** This joins the locator, context, service worker, and popup into the full feature.
- **Problem it solves:** Adds a click listener on the diff that ignores clicks on GitHub's own buttons (comment "+" button, links, menus), shows the popup in the loading state, sends an `explain` request, and fills in the result.
- **Unit tests added:** `clickHandler.test.ts` checks that clicks on code lines trigger a request, that clicks on the comment button or links do not, and that a second click while a request is pending replaces the first popup.
- **How to test:**
  1. Build, reload, and open a PR's **Files changed** tab.
  2. Click an added line and confirm a popup with a spinner appears and is replaced by the three sections.
  3. Click GitHub's blue "+" comment button and confirm GitHub's comment box opens and no popup appears.
  4. Stop Ollama, click a line, and confirm the friendly error appears in the popup.

### PR 3.6: Toolbar on/off toggle (Small)
- **Why it's needed:** Users sometimes want to click and select code on GitHub without triggering popups.
- **Problem it solves:** Adds a toolbar action that toggles click-to-explain for all tabs, saves the state, and shows "ON" or "OFF" on the icon badge. The page badge from PR 1.3 reflects the state too.
- **Unit tests added:** `toggle.test.ts` checks that the state flips and persists and that the click handler does nothing when off.
- **How to test:**
  1. Click the toolbar icon and confirm the badge says "OFF".
  2. Click a diff line and confirm no popup appears.
  3. Click the icon again, confirm "ON", and confirm popups work again.

---

## Milestone 4: Fast, smooth explanations

**Demo:** Click a line and watch the explanation type itself out live. Press **Stop** midway. Click the same line again and it appears instantly from the cache. Drag across five lines and get one explanation of the whole block.

### PR 4.1: Streaming in the Ollama client (Medium)
- **Why it's needed:** Local models can take 10 to 30 seconds to finish. Watching text appear feels much faster than staring at a spinner.
- **Problem it solves:** Adds `chatStream(messages, signal)` to the client. It reads Ollama's newline-delimited JSON stream and yields text chunks, and it stops cleanly when the `AbortSignal` fires.
- **Unit tests added:** `chatStream.test.ts` with a fake `ReadableStream` covers chunks split across JSON lines, the final `done` message, aborting mid-stream, and a stream that errors halfway.
- **How to test:**
  1. Run `npm test`.
  2. In the service worker console, run `for await (const c of self.debugLlm.streamSample()) console.log(c)` and confirm text arrives in pieces.

### PR 4.2: Stream to the popup with a Stop button (Medium)
- **Why it's needed:** The streaming client is only useful if the popup shows text as it arrives.
- **Problem it solves:** Switches `explain` to a long-lived port (`chrome.runtime.connect`) that sends chunks to the content script. The popup renders partial markdown as it arrives, parses sections at the end, and has a **Stop** button that aborts the request. Closing the popup also aborts.
- **Unit tests added:** `streamPort.test.ts` checks that chunks are forwarded in order, that Stop and popup close both abort the request, and that a disconnected port does not crash the service worker. `popup.test.ts` gets a case for partial rendering.
- **How to test:**
  1. Build, reload, and click a diff line.
  2. Confirm text appears gradually.
  3. Click another line and press **Stop** right away; confirm text stops and Ollama's log shows the request ended.

### PR 4.3: Explanation cache and Regenerate (Small)
- **Why it's needed:** Users often click the same line twice, and repeat requests to a local model are slow.
- **Problem it solves:** Adds a cache keyed by PR, commit SHA, file, line range, and model, stored in `chrome.storage.session` with a size limit (oldest entries dropped first). Adds a **Regenerate** button that skips the cache.
- **Unit tests added:** `cache.test.ts` covers hit, miss, different model means a miss, a new commit means a miss, eviction at the size limit, and Regenerate bypassing the cache.
- **How to test:**
  1. Click a line and wait for the explanation.
  2. Close the popup and click the same line; confirm it appears instantly.
  3. Click **Regenerate** and confirm a new answer streams in.

### PR 4.4: Multi-line selection (Medium)
- **Why it's needed:** Many changes only make sense as a block, such as a whole `if` statement or function.
- **Problem it solves:** Lets the user drag across lines (or shift-click a second line) to select a range in one file. The range is highlighted and an "Explain selection" button appears. The prompt is adjusted to explain the block as a whole. Selections across files are rejected with a short note.
- **Unit tests added:** `selection.test.ts` (jsdom with fixtures) covers drag and shift-click ranges, ranges with mixed added and removed lines, reversed ranges (bottom to top), and cross-file selections being rejected.
- **How to test:**
  1. On a PR files page, drag across 5 lines in one file.
  2. Confirm they are highlighted and an "Explain selection" button appears.
  3. Click it and confirm the explanation covers the whole block.
  4. Try selecting across two files and confirm the "one file at a time" note.

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

## Ideas after 1.0
These are not planned yet and would each get their own milestone:
- Support other local servers (LM Studio, llama.cpp server) through the `LlmClient` interface.
- "Explain this whole file" and "Summarize this PR" buttons.
- Turn a concern into a draft GitHub review comment with one click.
- Firefox support.
