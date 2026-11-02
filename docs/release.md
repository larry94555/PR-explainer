# Releasing PR Explainer

This guide covers three things:

1. How to build a production release (not a developer build).
2. How to publish it on the Chrome Web Store and ship updates.
3. What is still missing, after every PR in the [roadmap](roadmap.md) is done, for a production-quality extension. It ends with a proposed Milestone 9 of small PRs that close those gaps.

To build and try a branch as a developer, see [InstallingExtension.md](InstallingExtension.md) instead.

Chrome Web Store rules, fees, and image sizes change from time to time. The numbers below were right when this was written; check the [Chrome Web Store developer docs](https://developer.chrome.com/docs/webstore) before a real submission.

## 1. Build a production release

### Developer build vs. production build

| | `npm run dev` | `npm run build` |
|---|---|---|
| Vite mode | `development` | `production` |
| Source maps | Yes | No |
| `debugLlm` helpers in the service worker console | Yes | No |
| Prompt, PR description, and file context logged to the page console | Yes | No |
| Timing line (`[PR Explainer] explained in 12.4 s`) and service worker start/ping lines | Yes | Yes (see gap G4) |

Only a `npm run build` output is ever released.

### Steps

1. Start from a clean, up-to-date `main`: `git checkout main && git pull && git status` (nothing to commit).
2. Pick the new version (see [Versioning](#versioning)) and set it in **both** `package.json` and `public/manifest.json`. Today they must be kept in step by hand (gap G7).
3. Add a short entry to the release notes (a `CHANGELOG.md` does not exist yet, gap G7).
4. Run the same checks as CI, with a clean install:

   ```sh
   npm ci
   npm run lint
   npm test
   npm run build
   ```

5. Package `dist/` as a `.zip` with `manifest.json` at the **root** of the zip (not inside a `dist/` folder). Roadmap PR 7.4 adds `npm run package`, which writes `release/pr-explainer-<version>.zip`. Until then, from the repo folder:

   ```sh
   cd dist && zip -r ../pr-explainer-<version>.zip . && cd ..
   ```

   On Windows, open `dist`, select everything inside it, right-click, and choose **Compress to ZIP file**.
6. Smoke-test the zip, not `dist/`: remove the dev copy of the extension, unzip into a new folder, load that folder with **Load unpacked**, and walk through the "How to test" steps of PR 7.4 (click a line, ask a question in the chat, toggle the extension off and on, open the settings page). Keep DevTools' **Network** tab open and confirm requests only go to `github.com`, `raw.githubusercontent.com`, and the local LLM address.
7. Tag the commit you built from: `git tag v<version> && git push origin v<version>`, and attach the zip to a GitHub Release so anyone can install it without the store.

### Versioning

- Chrome's `version` is one to four dot-separated numbers (for example `1.2.0`). Each upload to the store must have a **higher** version than the last one; the store refuses equal or lower versions.
- Use `MAJOR.MINOR.PATCH`: patch for fixes (for example a GitHub markup change), minor for new features, major for breaking changes such as a new settings format.
- There is no "roll back" in the store. To undo a bad release, upload the previous code with a **higher** version number.
- Suggested plan: stay on `0.x` while Milestones 7 to 9 land, and call the first public store release `1.0.0`.

### Sharing without the store

The GitHub Release zip can be installed with **Load unpacked** (Developer mode on). That is fine for testers but not for real users: Chrome shows a developer-mode warning, the extension never updates itself, and people must re-download each version. Chrome on Windows and macOS does not allow installing a packaged `.crx` from outside the store except through enterprise policy, so the store is the only normal route for non-developers.

## 2. Publish on the Chrome Web Store

### One-time setup

1. Sign in at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) with the Google account that will own the extension. Consider a dedicated account (or a Google Group as owner) so ownership is not tied to one person's personal account.
2. Pay the one-time registration fee (US $5 when written) and accept the developer agreement.
3. Turn on 2-Step Verification for the account; the store requires it to publish.
4. Fill in the account's contact email and verify it. Declare whether you are a **trader** (selling or acting commercially) or a **non-trader**; this is required for listings shown in the EU. A free, open-source hobby project is normally a non-trader.

### Create the item

Click **New item** and upload the release zip. The store gives the extension its permanent **extension ID** at this point. The ID is the same for every user, so the onboarding page (gap G1) can show the exact `OLLAMA_ORIGINS` value, `chrome-extension://<id>`, instead of the wildcard `chrome-extension://*`.

Then fill in each tab.

**Store listing**

| Field | What to use |
|---|---|
| Name and summary | From the manifest (`PR Explainer`, "Explains code in GitHub pull requests using a local LLM."). The summary is limited to 132 characters. |
| Description | What it does, that it needs **Ollama installed and running on the same computer**, which models work well, that it only works on github.com (not GitHub Enterprise Server), and a link to the setup guide. Base it on [features.md](features.md). |
| Category | Developer Tools. |
| Icon | 128×128 PNG (already in `public/icons/icon128.png`; the store recommends 96×96 artwork with transparent padding). |
| Screenshots | 1 to 5, at 1280×800 or 640×400. Good candidates: the popup on a diff, the chat panel, dark mode, and the settings page with a model picked. The PR screenshots under `docs/screenshots/` are a start but most are not at those sizes. |
| Small promo tile | 440×280 PNG. Required. |
| Support / homepage URL | The GitHub repo, or its Issues page. |

**Privacy practices**

This tab is where most rejections come from. Answer it precisely.

- **Single purpose:** "Explains code in GitHub pull requests, and answers questions about it, using an LLM running on the user's own computer."
- **Permission justifications** (one per permission in `public/manifest.json`):

  | Permission | Justification |
  |---|---|
  | `storage` | Saves the user's settings (LLM address, model, answer length) in `chrome.storage.sync`, the on/off state in `chrome.storage.local`, and recent explanations in `chrome.storage.session` so clicking the same code again is instant. |
  | Host `https://github.com/*` | The content script shows the popup and chat on pull request pages. It is matched on all of github.com because GitHub moves into a PR without a page load, and it reads the PR's title, description, and the file at the PR's head commit from github.com using the user's own session. |
  | Hosts `http(s)://localhost/*`, `127.0.0.1`, `[::1]` | The service worker sends the code to the local LLM server (Ollama, `http://localhost:11434` by default). Any port is allowed because the user can change the port on the settings page. Nothing is sent to any other computer. |

- **Remote code:** "No, I am not using remote code." All JavaScript is bundled in the zip. (Model output is shown as text, never run; see `src/popup/renderMarkdown.ts`.)
- **Data usage:** the extension reads **website content** (the PR's code, title, and description) and sends it only to a server on the user's own computer. It sends nothing to the developer or any third party, has no analytics, and stores no personal data. Tick **Website content**, then certify that data is not sold, not used for unrelated purposes, and not used for credit decisions. Ticking it is the safer choice even though the data never leaves the machine; a reviewer who sees the code reading page content and finds the box unticked can reject the item.
- **Privacy policy URL:** required once any data box is ticked. Host the `PRIVACY.md` from roadmap PR 7.4 at a stable public URL (a GitHub Pages page, or the file's URL on `main`). It must name every network destination: github.com, `raw.githubusercontent.com` (used for the file context of public repos, `src/fileContext.ts`), and the local LLM address. It should also say that settings sync with the user's Google account through Chrome Sync, and that explanations are kept only until the browser closes.

**Distribution**

- **Visibility:** start as **Unlisted** (only people with the link can install it) or **Private** (a list of testers' Google accounts) for a first round of real users. Switch to **Public** when ready.
- **Regions:** all regions, unless there is a reason not to.
- **Pricing:** free.

### Review

Click **Submit for review**. Most reviews finish within a few days, but a new developer account and host permissions on a popular site such as github.com can trigger a longer, in-depth review. Use the option to **publish manually after approval** so a release goes out when you are ready, not the moment review finishes.

Common reasons for rejection, and how this project avoids them:

| Reason | Status here |
|---|---|
| Permission not needed or not explained | Only `storage` plus the hosts above; each is justified. Narrowing the localhost hosts (gap G3) makes this stronger. |
| Missing or vague privacy policy | Needs the hosted `PRIVACY.md` (gap G5). |
| Description does not say what is needed to use it | The listing must say Ollama is required, or reviewers (and users) find it "does nothing". |
| Code that is hard to review | Production build is minified but not obfuscated, which is allowed. Keep it that way. |

### Shipping updates

1. Bump the version, build, and package as in [section 1](#1-build-a-production-release).
2. In the dashboard, open the item, choose **Package → Upload new package**, update the listing or privacy answers if anything changed (for example a new permission), and submit.
3. Every update is reviewed again. A **new permission** shows users a prompt and disables the extension until they accept it, so add permissions rarely and say why in the release notes.
4. After it is published, Chrome updates installed copies on its own, usually within a few hours. Users can force it with **Update** on `chrome://extensions` (Developer mode on).
5. Once there are enough users, the dashboard can roll an update out to a percentage of users first.

The most likely reason for an urgent release is GitHub changing its page markup. All GitHub selectors are in `src/diffDom.ts`, so a fix is usually small; plan for the review delay by keeping a smoke test that catches breakage early (gap G9).

## 3. What is left after the roadmap

The roadmap ends with Milestone 8 (latency). Its remaining PRs are 7.4 (privacy check and packaging) and 8.1 to 8.8. After all of them, the extension works well for someone who builds it from source. The gaps below are what stands between that and something a stranger can install from the store and get working.

| # | Gap | What exists today | Why it matters for production |
|---|---|---|---|
| G1 | **Ollama onboarding** | Nothing on first install. Users find out about Ollama, models, and `OLLAMA_ORIGINS` from error messages on the settings page (`src/llm/describeLlmError.ts`) or from the roadmap's test steps. | This is the biggest gap. A store user does not have Ollama, does not know which model to pull, and will see blocked-origin errors. Without a guided first run, most installs will fail and leave bad reviews. |
| G2 | **Plain setup docs for users** | `InstallingExtension.md` is for developers building from a branch. | The listing needs a short user guide: install Ollama, pull a model sized for your RAM, allow the extension, open a PR. |
| G3 | **Narrower localhost access** | `host_permissions` grant http and https on any port of `localhost`, `127.0.0.1`, and `[::1]` (six patterns). | Reviewers ask about broad host access. Requesting only the configured address at runtime (`optional_host_permissions`) is easier to justify and shows a clearer install prompt. |
| G4 | **Quiet production console** | Production builds still log `service worker started`, `ping received`, `production build: debug helpers are off`, and a timing line per explanation (`src/background.ts`, `src/content.ts`). | Harmless, but noise in every GitHub tab's console. Put it behind a "Debug logging" setting. |
| G5 | **Privacy policy, license, and store assets** | PR 7.4 adds `PRIVACY.md`. There is no `LICENSE` file, no hosted policy URL, and no store-sized screenshots or promo tile. | The store requires the policy URL and images. Without a license, nobody else is allowed to reuse or contribute to the code. |
| G6 | **"PR Explainer active" badge** | Shown on every PR page (`src/badge.ts`). It was added in PR 1.3 to prove the content script runs. | Useful while developing, clutter for users. The toolbar icon already shows on/off (PR 3.6). Make the badge a setting, off by default. |
| G7 | **One version number and release notes** | The version is `0.1.0` in both `package.json` and `public/manifest.json`, set by hand. No `CHANGELOG.md`. | Two copies drift. The build should write the manifest version from `package.json`, and each release needs notes. |
| G8 | **Release automation** | CI lints, tests, and builds, but does not keep the result. | A tag should build the zip in CI and attach it to a GitHub Release, so the uploaded zip is reproducible and never built from a dirty local folder. |
| G9 | **Catching GitHub markup changes** | Unit tests use saved HTML fixtures. Nothing checks the live site. | GitHub changes its diff markup without notice, and a store update takes days to review. A scheduled smoke test on a public PR gives warning before users notice. |
| G10 | **Support without telemetry** | No analytics, by design. Errors are shown only to the user. | When something breaks, users need an easy way to report it: a **Copy diagnostics** button (extension, Chrome, and Ollama versions, model, last error, no code) and an issue template. |
| G11 | **Supported browsers stated** | No `minimum_chrome_version` in the manifest. | Stops installs on Chrome versions too old for the module service worker and modern JavaScript the build emits. Edge Add-ons could reuse the same zip later. |

Two things to fix in roadmap PR 7.4 when it is written, both found while checking the code for this guide:

- Its network test is described as allowing only "the configured LLM URL or GitHub", but `src/fileContext.ts` also fetches `raw.githubusercontent.com` for public repos. The allow-list (and `PRIVACY.md`) must include it, or the test will fail on purpose-built code.
- `raw.githubusercontent.com` is not in `host_permissions`; it works because that site allows any origin. That is fine and keeps permissions small, but it is worth a comment in the manifest test so nobody "fixes" it by adding a permission.

Known limits to state in the listing rather than fix:

- Only github.com, not GitHub Enterprise Server or GitLab.
- PR content goes into the prompt, so a PR can try to steer the model ("prompt injection"). The answer is always shown as text and can never run code or follow links, but users should treat explanations as hints, not a review verdict.
- Speed depends on the laptop and model; Milestone 8's latency report gives realistic numbers to quote.

### Proposed Milestone 9: Ready for the Chrome Web Store

**Demo:** On a computer that has never had Ollama, install PR Explainer from an unlisted store link, follow the welcome page to a working setup, and explain a line on a real PR, with no terminal commands beyond the ones the welcome page shows.

These follow the roadmap's rules (Small or Medium, each with tests and test steps). They live here for now; if they look right, they can be moved into `roadmap.md` as a separate PR.

| PR | Size | Closes | What it does | Unit tests |
|---|---|---|---|---|
| 9.1 Version from `package.json`, minimum Chrome version, changelog | Small | G7, G11 | The build writes `version` into the manifest from `package.json`; adds `minimum_chrome_version` and `CHANGELOG.md`. | `manifest.test.ts`: built manifest version equals `package.json`; `minimum_chrome_version` is set. |
| 9.2 Quiet production build | Small | G4, G6 | Adds **Debug logging** and **Show page badge** settings, both off by default; start, ping, and timing logs only print when debug logging is on. | `settings.test.ts` for the new defaults; `badge.test.ts` for hidden by default; a test that production code paths log nothing with defaults. |
| 9.3 First-run welcome page: Ollama check | Medium | G1 | `runtime.onInstalled` opens a welcome tab that checks, in order: Ollama reachable, extension origin allowed, at least one model installed, and a test reply. Each failed step shows the fix for the user's OS and a **Check again** button. | `welcome.test.ts` (fake client): each step's pass and fail state, order, retry, and that it opens only on first install, not on update. |
| 9.4 Welcome page: model suggestion and exact origin | Small | G1 | Suggests a model by the computer's memory (for example 3B under 16 GB, 7B above) with the `ollama pull` command, and shows `OLLAMA_ORIGINS` with the extension's own ID once it has a store ID. | Tests for the memory-to-model table and for the origin string with and without a fixed ID. |
| 9.5 Request only the configured LLM address | Medium | G3 | Moves the localhost patterns to `optional_host_permissions`; the settings and welcome pages ask for access to the exact address when it is saved, and the error message explains a refused permission. | `manifest.test.ts` (no localhost in `host_permissions`); `optionsPage.test.ts` for asking, granting, and refusing; `describeLlmError.test.ts` for the new error. |
| 9.6 User guide, license, privacy page, and store listing | Small | G2, G5 | Adds `LICENSE`, `docs/user-guide.md`, a GitHub Pages copy of `PRIVACY.md`, and `docs/store/` with the listing text, permission justifications, and screenshots and promo tile at store sizes. | None (docs and images); a link check in CI is optional. |
| 9.7 Release workflow | Small | G8 | A GitHub Actions workflow on `v*` tags runs lint, tests, and `npm run package`, checks the tag matches the version, and attaches the zip to a GitHub Release. | Workflow tested on a test tag; a unit test for the tag-vs-version check script. |
| 9.8 Copy diagnostics and issue template | Small | G10 | A **Copy diagnostics** button on the settings page and in the error popup, and `.github/ISSUE_TEMPLATE/bug.md` that asks for it. | `diagnostics.test.ts`: fields present, no code, PR text, or URLs beyond the LLM address included. |
| 9.9 Live GitHub smoke test | Medium | G9 | A scheduled (weekly) Playwright job loads the built extension, opens a fixed public PR in unified and split view, and checks that a click finds the line and its context (with a fake LLM). | The job itself; fails on purpose if `locateLine` returns `null` on the known line. |

After Milestone 9: submit `1.0.0` as unlisted, collect feedback from a few testers, then switch it to public.
