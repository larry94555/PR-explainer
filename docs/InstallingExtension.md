# Installing the extension from a PR

This guide shows how to build PR Explainer from any branch (for example, an open pull request) and load it into Chrome so you can try it out. It also shows how to check that it loaded correctly.

The extension is not in the Chrome Web Store. You build it on your laptop and load the `dist/` folder with Chrome's **Load unpacked** button. Nothing is uploaded anywhere.

## What you need

- **Google Chrome** (or another Chromium browser such as Edge or Brave; the menu names below are Chrome's).
- **Git**.
- **Node.js 22.22.2 or newer** on the 22 line, or **24.15.0 or newer**. Check with:

  ```sh
  node --version
  ```

  If you use [nvm](https://github.com/nvm-sh/nvm), run `nvm install 22` and then `nvm use` in the repo folder (the repo has an `.nvmrc`).

## Step 1: Get the code for the PR

If you don't have the repo yet:

```sh
git clone https://github.com/larry94555/PR-explainer.git
cd PR-explainer
```

Then switch to the PR's branch. The branch name is at the top of the PR page on GitHub, next to "wants to merge ... from". Copy it with the copy button there.

```sh
git fetch origin
git checkout <branch-name>
git pull
```

If you have the [GitHub CLI](https://cli.github.com/), you can use the PR number instead: `gh pr checkout 5`.

To go back to the latest merged code later, run `git checkout main && git pull`.

## Step 2: Build it

From the repo folder:

```sh
npm install
npm run build
```

`npm run build` type-checks the code and writes the extension into a `dist/` folder. When it finishes you should see lines ending in `background.js`, `content.js` and `options.html`, then `✓ built in ...`. Check that the folder has the extension in it:

```sh
ls dist
```

You should see `manifest.json`, `background.js`, `content.js`, `options.html` and an `icons/` folder.

Optional: `npm test` runs the unit tests, and `npm run dev` rebuilds `dist/` every time you save a file.

## Step 3: Load it into Chrome

1. Open a new tab and go to `chrome://extensions`.
2. Turn on **Developer mode** with the switch in the top right corner. A new row of buttons appears.
3. Click **Load unpacked**.
4. In the file picker, go to the repo folder and select the **`dist`** folder itself (not the repo folder and not a file inside `dist`). Click **Select** (or **Open**).
5. A **PR Explainer** card appears on the page.
6. Optional: click the puzzle-piece icon in the Chrome toolbar and click the pin next to PR Explainer so its icon stays visible.

## Step 4: Confirm it loaded

On `chrome://extensions`, check the **PR Explainer** card:

- It shows the name **PR Explainer**, version **0.1.0**, and the blue icon.
- Its switch is **on** (blue).
- There is **no red "Errors" button** on the card. If there is one, click it to see the error (see Troubleshooting below).
- Clicking **Details** shows the description "Explains code in GitHub pull requests using a local LLM."

Then check that it runs on GitHub (needs the code from roadmap PR 1.3 or later):

1. Open any pull request on github.com, for example one from `https://github.com/microsoft/vscode/pulls`.
2. A small blue **"PR Explainer active"** badge appears in the bottom right corner of the GitHub page. (This is on the PR page, not on `chrome://extensions`. There, hovering the extension's icon shows Chrome's own "Unpacked extension" tooltip, which is unrelated.)
3. Hover over it. The tooltip shows the PR, for example `microsoft/vscode#12345 (conversation)`. With roadmap PR 1.4 or later, a second line says `Service worker: connected`.
4. Open an issue page instead (for example from the repo's **Issues** tab). The badge does not appear there.

If you want more proof (roadmap PR 1.4 or later), open the service worker's console: on `chrome://extensions`, click the blue **service worker** link on the PR Explainer card. A DevTools window opens. Its **Console** tab shows `[PR Explainer] service worker started`. The console only shows messages from the moment it opens, so keep it open and reload the PR tab: `[PR Explainer] ping received` then appears.

## Trying a different PR, or new commits on the same PR

Chrome keeps using the `dist/` folder you loaded, so you don't need to load it again. After switching branches or pulling new commits:

1. Run `git checkout <branch-name>` and `git pull`, then `npm install` (in case dependencies changed) and `npm run build`.
2. On `chrome://extensions`, click the **reload** icon (circular arrow) on the PR Explainer card.
3. **Reload any open GitHub tabs.** Pages that were open before the reload still run the old code.

## Removing the extension

On `chrome://extensions`, click **Remove** on the PR Explainer card.

## Troubleshooting

| What you see | What to do |
|---|---|
| "Manifest file is missing or unreadable" | You selected the wrong folder. Select the `dist` folder inside the repo, and make sure `npm run build` finished. |
| `npm install` or `npm run build` fails with an engine or syntax error | Your Node version is too old. Run `node --version` and install 22.22.2+ or 24.15+. |
| A red **Errors** button on the card | Click it to read the error, then click **Clear all**, rebuild, and reload the extension. If it comes back, copy the error into the PR. |
| No badge on a PR page | Reload the GitHub tab. Make sure the URL contains `/pull/<number>` and that the extension's switch is on. If you arrived at the PR by clicking a link from a non-PR GitHub page, reload once (Chrome only starts the extension on pages that load as a PR). |
| The tooltip says `Service worker: not connected (...)` | The text in brackets is the reason. If it says "Extension context invalidated", the extension was reloaded after the tab opened: reload the tab. Otherwise check the card for a red **Errors** button. |
| The badge is there but changes from the PR don't show | Rebuild, click reload on the extension card, then reload the GitHub tab. |
