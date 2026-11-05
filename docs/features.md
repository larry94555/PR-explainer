# PR Explainer: Features

PR Explainer is a Chrome extension that explains code in GitHub pull requests and lets you chat about it. All inference runs on a local LLM installed on your laptop, so code never leaves your machine.

## 1. Click-to-explain popup
Open a pull request on github.com, go to the **Files changed** tab, and click any line of code. A popup anchored next to that line explains it in three sections:
- **What it does:** a plain-language description of the code.
- **Why it's needed:** the role the change plays in the PR, inferred from the diff, the file, and the PR title and description.
- **Concerns:** possible bugs, edge cases, security, performance, or style issues. It says "None found" when there are none.

While the model works, a line at the top of the popup already shows facts that need no model: the file and line, the function from the diff, and what kind of change it is (added, removed, or changed with its old version; for a selection, how many lines of each kind). It stays above the answer.

## 2. Multi-line selection
Drag to select several lines (or a whole hunk) and get one explanation for the selection rather than for a single line. In split view, a selection down one side covers that side's lines (old or new).

## 3. Context-aware prompts
Every request includes the surrounding context the model needs: the file path and language, the diff hunk around the clicked line (added, removed, and unchanged lines), the function or block the line sits in (read from the full file at the PR's head, even when the diff hides most of it), and the PR title and description. Context is trimmed to fit the model's context window: the full-file block first, then the PR description, then the lines farthest from the clicked code, which is never cut.

## 4. Chat box
From any popup, open a chat panel to ask follow-up questions ("Is this thread safe?", "How would you test this?"). The chat opens in Chrome's side panel next to the page, so it never covers the code and stays open as you move around the PR, following the PR in the tab you are on (PR 11.8). A **Chat opens in** setting puts it back on the page instead, and the toolbar button's right-click menu has **Open chat**. The chat keeps the code you clicked and the explanation as context, and keeps one conversation per PR while the tab is open. While the chat is open, clicking another line adds it to the same conversation, and **New chat** starts over.

## 5. Whole answers, streamed underneath
Replies stream from the local model, but by default the popup waits and shows the whole answer at once: until then it shows the three section headings with placeholder lines, a spinner, a ticking time and a **Stop** button, and the chat shows "Thinking…". **Stop** cancels at once and keeps what the model had written. Each section appears whole as soon as the model has written it, so **What it does** shows before the rest while the time keeps running; a cached answer shows all three at once. The **Show answers as they are written** setting shows explanations and chat replies word by word instead.

## 6. Local LLM only
Talks to a local LLM server (Ollama by default, at `http://localhost:11434`). No cloud API keys and no telemetry. The extension only makes network requests to GitHub (for the PR's description and files) and to the local LLM address you configure; anything else is refused, a test enforces it, and [PRIVACY.md](../PRIVACY.md) explains how.

## 7. Settings page
An options page to set the LLM server URL, pick an installed model from a dropdown, optionally pick a different, bigger model for the chat (loaded when the chat opens, with a note on the memory two models need), test the connection, and adjust response length, temperature, context size (automatic by default, read from the model), whether answers appear word by word or whole, and how long the model stays loaded between clicks (30 minutes by default; opening a PR's **Files changed** tab also loads it ahead of the first click). A **Debug** section has **Show prompt**, which shows the prompt sent under each explanation, and **Debug window**, which keeps every request to GitHub and the model (prompt, reply and time) in a log for the browser session and shows it live in a debug window, opened from the popup's **Debug** button or the toolbar button's right-click menu. The page says whether the model runs on the GPU, partly, or on the CPU, with a fix when it is not fully on the GPU, and a **Speed test** times a short explanation on each installed coding model, marks the fastest one under 2 seconds (suggesting `qwen2.5-coder:1.5b` with the command to get it when none makes it), and switches to it in one click. A **Make Ollama faster** section lists Ollama's own speed settings (flash attention and a smaller context cache) with the command that sets each one on this computer, and **Measure** times the picked model before and after a change, side by side (PR 11.7). Settings are saved in Chrome storage.

## 8. Clear error handling
Friendly messages with fix-it hints when the LLM server is not running, the model is missing, the request is blocked by CORS, or a request times out. When Ollama stops, one banner over the diff says so and background work pauses; when Ollama comes back the banner goes away by itself and the model is loaded again (PR 11.6).

## 9. Response caching
Explanations are cached per PR, file, and line range, so clicking the same code again returns instantly. A request starts as soon as the mouse button goes down, before it is released, and is cancelled if the press turns into a drag. Answers are also kept on this computer after the browser closes, for 7 days by default (an answer not used for that long is removed, and at most 50 MB is kept), with a **Clear saved answers** button on the settings page. A **Regenerate** button forces a fresh answer. **Explain on hover** (on by default) starts explaining a line once the pointer has rested on it for the **Hover wait** (300 ms by default, from 150 to 2000), so the answer is often ready by the click. It sends one request at a time, and nothing while the model is still loading or the tab is hidden; the debug window counts the hover requests cancelled before they finished. Someone who turned it off keeps it off.

## 10. Works with GitHub's page behavior
Supports unified and split diff views, light and dark themes, lazily loaded diffs, and GitHub's in-page navigation between PR tabs without a page reload.

## 11. On/off toggle
A toolbar button turns click-to-explain on or off, so normal GitHub clicking (commenting, selecting text) is never blocked when you don't want explanations.

## 12. Keyboard and screen reader support
Press **Ctrl+Shift+E** (changeable on Chrome's shortcuts page, for example back to **Alt+E**), or right-click and choose **Explain with PR Explainer**, to explain the diff line that has keyboard focus (or holds the text cursor), or the selected block of lines. Focus moves into the popup when it opens and returns to the code when it closes, **Esc** closes the popup and the chat, and both are labelled for screen readers. The popup, chat, and selection button follow GitHub's light or dark theme.

## 13. Answers ready before you click (planned, Milestone 10)
An optional **Explain ahead** setting, off by default, explains changed lines in the background so a click is answered at once from the cache. **Lines on screen** explains the changed lines you can see; **Whole PR** works through every changed line in the PR, one diff hunk per request, starting with the code on screen and under the pointer. Only one background request runs at a time by default, since on a CPU parallel requests share the same cores, and your own click always goes first: background work for other lines is cancelled and picked up again after. A per-PR limit bounds battery and fan use, work pauses while the tab is hidden, and a new commit that changes the code is explained again. The toolbar badge shows how much of the PR is done. Prefetching hides the model's time rather than cutting it: a line it has not reached yet is answered as fast as a normal click.

## 14. Kind to the laptop (planned, Milestone 11)
Background work (hover, Explain ahead, whole-PR prefetch) pauses while the laptop runs on battery, unless you choose otherwise, and the toolbar badge says so (PR 11.3). It skips lockfiles, minified bundles, snapshots and files the repository marks as generated or vendored, so the model's time goes to code people read; you can still click those lines (PR 11.4). A long prefetch carries on even when Chrome stops and restarts the extension's service worker (PR 11.5). The settings page explains Ollama server settings that can make it faster, such as flash attention, and measures the difference before and after (PR 11.7).

## 15. Copy, pin and rate answers (planned, Milestone 11)
**Copy** puts an answer on the clipboard as Markdown, ready for a review comment, and **Pin** keeps a popup open and movable while you click elsewhere, so two answers can be compared (PR 11.10). 👍 and 👎 on each answer keep a private, local record of quality, never the code, and the Speed test shows how often each model's answers were liked next to its speed (PRs 11.11 and 11.12).

## 16. Chrome's built-in model as a fallback (planned, PR 11.13)
On machines that support it, Chrome's own on-device model can be used instead of Ollama, so the extension works before Ollama is installed. Code still stays on the laptop.
