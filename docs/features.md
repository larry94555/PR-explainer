# PR Explainer: Features

PR Explainer is a Chrome extension that explains code in GitHub pull requests and lets you chat about it. All inference runs on a local LLM installed on your laptop, so code never leaves your machine.

## 1. Click-to-explain popup
Open a pull request on github.com, go to the **Files changed** tab, and click any line of code. A popup anchored next to that line explains it in three sections:
- **What it does:** a plain-language description of the code.
- **Why it's needed:** the role the change plays in the PR, inferred from the diff, the file, and the PR title and description.
- **Concerns:** possible bugs, edge cases, security, performance, or style issues. It says "None found" when there are none.

## 2. Multi-line selection
Drag to select several lines (or a whole hunk) and get one explanation for the selection rather than for a single line. In split view, a selection down one side covers that side's lines (old or new).

## 3. Context-aware prompts
Every request includes the surrounding context the model needs: the file path and language, the diff hunk around the clicked line (added, removed, and unchanged lines), the function or block the line sits in (read from the full file at the PR's head, even when the diff hides most of it), and the PR title and description. Context is trimmed to fit the model's context window: the full-file block first, then the PR description, then the lines farthest from the clicked code, which is never cut.

## 4. Chat box
From any popup, open a chat panel to ask follow-up questions ("Is this thread safe?", "How would you test this?"). The chat keeps the code you clicked and the explanation as context, and keeps one conversation per PR while the tab is open. While the chat is open, clicking another line adds it to the same conversation, and **New chat** starts over.

## 5. Whole answers, streamed underneath
Replies stream from the local model, but by default the popup waits and shows the whole answer at once: until then it shows the three section headings with placeholder lines, a spinner, a ticking time and a **Stop** button, and the chat shows "Thinking…". **Stop** cancels at once and keeps what the model had written. The **Show answers as they are written** setting shows explanations and chat replies word by word instead.

## 6. Local LLM only
Talks to a local LLM server (Ollama by default, at `http://localhost:11434`). No cloud API keys and no telemetry. The extension only makes network requests to GitHub (for the PR's description and files) and to the local LLM address you configure; anything else is refused, a test enforces it, and [PRIVACY.md](../PRIVACY.md) explains how.

## 7. Settings page
An options page to set the LLM server URL, pick an installed model from a dropdown, test the connection, and adjust response length, temperature, context size (automatic by default, read from the model), whether answers appear word by word or whole, and how long the model stays loaded between clicks (30 minutes by default; opening a PR's **Files changed** tab also loads it ahead of the first click). A **Debug** section has **Show prompt**, which shows the prompt sent under each explanation, and **Debug window**, which keeps every request to GitHub and the model (prompt, reply and time) in a log for the browser session and shows it live in a debug window, opened from the popup's **Debug** button or the toolbar button's right-click menu. The page says whether the model runs on the GPU, partly, or on the CPU, with a fix when it is not fully on the GPU, and a **Speed test** times a short explanation on each installed coding model, marks the fastest one under 10 seconds, and switches to it in one click. Settings are saved in Chrome storage.

## 8. Clear error handling
Friendly messages with fix-it hints when the LLM server is not running, the model is missing, the request is blocked by CORS, or a request times out.

## 9. Response caching
Explanations are cached per PR, file, and line range, so clicking the same code again returns instantly. A **Regenerate** button forces a fresh answer. An optional **Explain on hover** setting (off by default) starts explaining a line once the pointer rests on it, so the answer is often ready by the click.

## 10. Works with GitHub's page behavior
Supports unified and split diff views, light and dark themes, lazily loaded diffs, and GitHub's in-page navigation between PR tabs without a page reload.

## 11. On/off toggle
A toolbar button turns click-to-explain on or off, so normal GitHub clicking (commenting, selecting text) is never blocked when you don't want explanations.

## 12. Keyboard and screen reader support
Press **Alt+E** to explain the diff line that has keyboard focus (or holds the text cursor), or the selected block of lines. Focus moves into the popup when it opens and returns to the code when it closes, **Esc** closes the popup and the chat, and both are labelled for screen readers. The popup, chat, and selection button follow GitHub's light or dark theme.
