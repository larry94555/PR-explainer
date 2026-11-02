# PR Explainer: Features

PR Explainer is a Chrome extension that explains code in GitHub pull requests and lets you chat about it. All inference runs on a local LLM installed on your laptop, so code never leaves your machine.

## 1. Click-to-explain popup
Open a pull request on github.com, go to the **Files changed** tab, and click any line of code. A popup anchored next to that line explains it in three sections:
- **What it does:** a plain-language description of the code.
- **Why it's needed:** the role the change plays in the PR, inferred from the diff, the file, and the PR title and description.
- **Concerns:** possible bugs, edge cases, security, performance, or style issues. It says "None found" when there are none.

## 2. Multi-line selection
Drag to select several lines (or a whole hunk) and get one explanation for the selection rather than for a single line.

## 3. Context-aware prompts
Every request includes the surrounding context the model needs: the file path and language, the diff hunk around the clicked line (added, removed, and unchanged lines), and the PR title and description. Context is trimmed to fit the model's context window.

## 4. Chat box
From any popup, open a chat panel to ask follow-up questions ("Is this thread safe?", "How would you test this?"). The chat keeps the code you clicked and the explanation as context, and keeps one conversation per PR while the tab is open. While the chat is open, clicking another line adds it to the same conversation, and **New chat** starts over.

## 5. Streaming responses
Explanations and chat replies appear token by token as the local model generates them, with a loading state and a **Stop** button.

## 6. Local LLM only
Talks to a local LLM server (Ollama by default, at `http://localhost:11434`). No cloud API keys and no telemetry. The extension only makes network requests to github.com pages it runs on and to the local LLM address you configure.

## 7. Settings page
An options page to set the LLM server URL, pick an installed model from a dropdown, test the connection, and adjust response length and temperature. Settings are saved in Chrome storage.

## 8. Clear error handling
Friendly messages with fix-it hints when the LLM server is not running, the model is missing, the request is blocked by CORS, or a request times out.

## 9. Response caching
Explanations are cached per PR, file, and line range, so clicking the same code again returns instantly. A **Regenerate** button forces a fresh answer.

## 10. Works with GitHub's page behavior
Supports unified and split diff views, light and dark themes, lazily loaded diffs, and GitHub's in-page navigation between PR tabs without a page reload.

## 11. On/off toggle
A toolbar button turns click-to-explain on or off, so normal GitHub clicking (commenting, selecting text) is never blocked when you don't want explanations.
