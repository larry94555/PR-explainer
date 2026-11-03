# PR Explainer and your privacy

**Your code stays on your computer.** PR Explainer reads code from the GitHub pull request you are looking at and sends it only to the LLM you set on the settings page, which must run on this computer (`localhost`, `127.0.0.1` or `[::1]`). It sends nothing anywhere else.

## Where requests go

| Part of the extension | Talks to | What it sends |
|---|---|---|
| The script on GitHub pages | `https://github.com` and `https://raw.githubusercontent.com` only | Requests for the PR's description and the full files it changes, from raw.githubusercontent.com (public repositories) or from the file's page on github.com with your GitHub sign-in (private repositories). This is what GitHub's own pages load. |
| The service worker and the settings page | The LLM URL on the settings page only (default `http://localhost:11434`) | The prompt: the clicked code, the code around it, the PR's title and description, and your chat questions. |

Nothing else is contacted: no analytics, no tracking, no error reporting, no update checks, and no fonts, scripts or images from the web.

## How this is enforced

- The settings page refuses an LLM URL that is not on this computer.
- Every request goes through one of two guarded fetches (`src/net/githubFetch.ts` and `src/net/llmFetch.ts`). A request to any other address is refused before it is sent, and the LLM side refuses any address but the one you set.
- Redirects are refused, not followed: a server that answers with a redirect elsewhere makes the request fail, so the browser never sends anything to the new address. Tests check this against real HTTP servers. (GitHub's `/raw/` file links always redirect, so they are not used; private files are read from the file's page instead.)
- A unit test (`tests/networkGuard.test.ts`) scans the source and fails if any code reaches the network another way (a direct `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, or a script, image or stylesheet loaded from the web).
- The manifest asks Chrome for access to `github.com` and this computer only, and `tests/manifest.test.ts` fails if a broader permission is added.

## What is stored

In Chrome's extension storage: your settings (synced with your Chrome profile if you have Chrome sync on, like other extension settings), whether click-to-explain is on, and recent explanations, so clicking the same line again is instant. Explanations are kept in memory only and are gone when Chrome closes. Chats are kept only while the page is open. Removing the extension deletes all of it.

**Debug window (off by default).** If you tick **Debug window** on the settings page, the extension also keeps a log of its last 200 requests, for the debug window: for each request to the LLM, the prompt it sent (which includes code from the PR, its title and description, and your chat questions) and the model's reply; for each request to GitHub, its address, time and size (not the page or file it read); and the steps and times of each click. The log is kept in Chrome's session storage, which is in memory: it is gone when Chrome closes, and unticking **Debug window** empties it at once. Like everything else here, it never leaves your computer.

## Check it yourself

On `chrome://extensions`, click **service worker** on the PR Explainer card to open its DevTools, and choose the **Network** tab. Click a few lines in a PR: every request listed goes to your LLM URL. The PR page's own DevTools shows GitHub's requests too; the extension's are the ones to `github.com` and `raw.githubusercontent.com` started by `content.js` (see the **Initiator** column).
