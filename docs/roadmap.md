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
| 2.2 | Ollama client: list models and non-streaming chat | Medium | ✅ Done |
| 2.3 | Settings page UI | Medium | Not started |
| 2.4 | Friendly LLM error messages | Small | Not started |
| 3.1 | Diff line locator | Medium | Not started |
| 3.2 | Hunk context extractor | Small | Not started |
| 3.3 | Explanation prompt and response parser | Medium | Not started |
| 3.4 | Popup component | Medium | Not started |
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
- **Status:** Done.
- **Why it's needed:** The extension needs one place that knows how to talk to the local LLM.
- **Problem it solves:** Adds an `LlmClient` interface (`src/llm/types.ts`) and an `OllamaClient` (`src/llm/ollamaClient.ts`) with `listModels()` (calls `/api/tags`) and `chat(messages, options)` (calls `/api/chat` with `stream: false`, passing temperature and max response length as Ollama's `temperature` and `num_predict`). Every failure becomes an `LlmError` with a `kind`: `connection`, `model-not-found`, `origin-blocked`, `no-model`, `bad-response`, `http`, or `aborted`, which PR 2.4 turns into friendly messages. `createLlmClient(settings)` builds the client from the saved URL. Adds `host_permissions` for `localhost`, `127.0.0.1` and `[::1]` (any port), the same hosts the settings accept. Keeping it behind an interface makes it possible to add other local servers (such as LM Studio) later. Dev builds expose `debugLlm` in the service worker console.
- **Unit tests added:** `ollamaClient.test.ts` with a mocked `fetch` covers parsing the model list, building the chat request body, parsing the reply, and raising typed errors for connection refused, HTTP 404 (model missing), HTTP 403 (CORS or origin blocked), other HTTP errors, bad JSON, a missing model name, and a cancelled request. `manifest.test.ts` checks the new host permissions.
- **How to test:**
  1. Run `npm test` and confirm the `ollamaClient` tests pass.
  2. Make sure Ollama is running (`ollama list` works) and note one model name.
  3. Run `npm run dev`, wait for `built in`, then reload the extension (see [InstallingExtension.md](InstallingExtension.md)).
  4. On `chrome://extensions`, click the **service worker** link on the PR Explainer card and use the **Console** tab of the DevTools window that opens.
  5. Run `await debugLlm.listModels()` and confirm your models are listed.
  6. Run `await debugSettings.save({ model: '<a model from step 2>' })`, then `await debugLlm.chat('Reply with OK')` and confirm the reply.

### PR 2.3: Settings page UI (Medium)
- **Why it's needed:** Users need a way to point the extension at their LLM and choose a model without editing code.
- **Problem it solves:** Builds the options page: URL field, model dropdown filled from `listModels()`, temperature slider, max response length, **Save**, and **Test connection** (sends "Reply with OK" and shows the reply and response time).
- **Unit tests added:** `optionsPage.test.ts` (jsdom) covers loading saved values into the form, filling the dropdown from a mocked model list, showing a validation error for a bad URL, and showing the test result or error text.
- **How to test:**
  1. Build and reload the extension.
  2. Open the extension's options page.
  3. Confirm the dropdown lists the models from `ollama list`.
  4. Pick a model, click **Save**, reload the page, and confirm the choice was kept.
  5. Click **Test connection** and confirm a reply such as "OK" and a time in milliseconds.

### PR 2.4: Friendly LLM error messages (Small)
- **Why it's needed:** The most common first-run problems are "Ollama isn't running", "model not pulled", and "origin blocked". Users need to know how to fix them.
- **Problem it solves:** Adds `describeLlmError(error)`, which turns each typed error into a short message and a fix, for example "Start Ollama with `ollama serve`", "Run `ollama pull <model>`", or "Set `OLLAMA_ORIGINS=chrome-extension://*` and restart Ollama". Uses it on the settings page.
- **Unit tests added:** `describeLlmError.test.ts` checks the message and fix for each error type and a generic fallback for unknown errors.
- **How to test:**
  1. Stop Ollama, click **Test connection**, and confirm the "not running" message.
  2. Start Ollama, type a model name that is not installed, and confirm the "run `ollama pull`" message.
  3. Pick a real model and confirm the test succeeds.

---

## Milestone 3: Click-to-explain

**Demo:** Open the **Files changed** tab of a real PR. Click any added line. A popup appears next to the line with three sections, **What it does**, **Why it's needed**, and **Concerns**, written by your local model.

### PR 3.1: Diff line locator (Medium)
- **Why it's needed:** Before we can explain a click, we must turn it into "which file, which line, which side of the diff".
- **Problem it solves:** Adds a `DiffDom` adapter with `locateLine(element)`, which returns `{filePath, lineNumber, side: 'added' | 'removed' | 'context', text}`. All GitHub-specific CSS selectors live in this one file so GitHub markup changes only need a fix here.
- **Unit tests added:** `diffDom.test.ts` runs against saved HTML fixtures of GitHub's unified diff. It covers added, removed, and context lines, clicks on the line number versus the code, and clicks outside a diff (returns `null`).
- **How to test:**
  1. Run `npm test`.
  2. Build, reload, and open a PR's **Files changed** tab.
  3. Click several lines and confirm the console logs the right file path, line number, and side for each.
  4. Click the PR title and confirm nothing is logged.

### PR 3.2: Hunk context extractor (Small)
- **Why it's needed:** One line alone is rarely enough for the model to explain it well.
- **Problem it solves:** Adds `extractContext(line, {before, after})`, which collects the surrounding lines from the same hunk with `+`, `-`, or space markers, plus the hunk header (`@@ ... @@`) and the file's language from its extension.
- **Unit tests added:** `extractContext.test.ts` covers a line in the middle of a hunk, lines near the start and end of a hunk (no crossing into other hunks), mixed added and removed lines, and language detection for common extensions.
- **How to test:**
  1. Run `npm test`.
  2. On a PR files page, click a line and confirm the console shows the context block that will be sent to the model.

### PR 3.3: Explanation prompt and response parser (Medium)
- **Why it's needed:** The model must return the three sections in a predictable shape so the popup can show them.
- **Problem it solves:** Adds `buildExplainPrompt(context)`, a system prompt plus user message asking for markdown with exactly the headings "What it does", "Why it's needed", and "Concerns". Adds `parseExplanation(text)`, which splits the reply into the three sections and copes with small format mistakes (missing headings, extra text, different heading levels). Adds an `explain` message handler in the service worker that ties the client, prompt, and parser together.
- **Unit tests added:** `explainPrompt.test.ts` snapshot-tests the prompt for a sample context. `parseExplanation.test.ts` covers a well-formed reply, missing "Concerns" (becomes "None found"), headings with different levels or bold text, and a reply with no headings (all text goes under "What it does").
- **How to test:**
  1. Run `npm test`.
  2. In the service worker console, run the dev hook `await self.debugLlm.explainSample()` and confirm it returns an object with `what`, `why`, and `concerns`.

### PR 3.4: Popup component (Medium)
- **Why it's needed:** Users need to see the explanation next to the code they clicked.
- **Problem it solves:** Adds a popup rendered in a Shadow DOM root: positioned next to the clicked line, three titled sections, loading spinner, error state (using `describeLlmError`), close button, and closing on **Esc** or a click outside. Markdown in the answer is rendered safely (sanitized, no raw HTML).
- **Unit tests added:** `popup.test.ts` (jsdom) covers the loading, success, and error states, closing on **Esc** and outside click, that styles stay inside the shadow root, and that `<script>` or `onerror` in model output is not executed.
- **How to test:**
  1. Run `npm test`.
  2. Run `npm run demo:popup` (a static demo page with fake data, added in this PR) and check each state looks right.

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
