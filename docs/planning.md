# Features and roadmap

PR Explainer was planned with two documents before any code was written, and they stayed the source of truth for the whole build. This page explains how they worked together and where the project ended up.

[← Back to the README](../README.md)

## The two documents

| Document | Question it answers | Shape |
|---|---|---|
| [features.md](features.md) | **What** should the extension do? | A short list of twelve features, each described in a paragraph from the user's point of view |
| [roadmap.md](roadmap.md) | **How**, and in **what order**, do we build it? | Eight milestones broken into 37 small PRs, each with its reason, the problem it solves, its unit tests and step-by-step testing instructions |

`features.md` stays short on purpose. It describes the finished product, so anyone can read it in two minutes and know what the extension is for. `roadmap.md` is long on purpose. It is the working plan, and every PR updates it.

## How the roadmap is structured

### Milestones that can be demonstrated

Each milestone ends with something you can show to someone in an interesting way, not just "the code is in":

| # | Milestone | Demo at the end |
|---|---|---|
| 1 | Extension skeleton | The extension loads, and a "PR Explainer active" badge appears on any GitHub PR page |
| 2 | Talking to the local LLM | The settings page lists your installed Ollama models and gets a reply from the model |
| 3 | Click-to-explain | Click a line in a PR diff and a popup explains what it does, why it's needed, and concerns |
| 4 | Fast, smooth explanations | Explanations stream in live, can be stopped, are cached, and work on multi-line selections |
| 5 | Chat box | Open a chat from the popup and ask follow-up questions about the code |
| 6 | Smarter context | Explanations use the PR description and more of the file, and stay within the model's context limit |
| 7 | Robust on real GitHub | Works across split view, dark mode, lazy-loaded diffs, and in-page navigation; ready to share |
| 8 | Optimize LLM latency | An explanation in under 10 seconds, or a report that shows the lowest time the laptop can reach and why |

The order matters. Milestone 3 gives a working end-to-end feature as early as possible, so every later milestone improves something real. Latency comes last because it builds on streaming, caching and the token budget, and because it needs real measurements to act on.

### PRs small enough to review well

Every PR is **Small** (under 10 minutes to review) or **Medium** (under 20 minutes). If a PR grew past Medium while it was being written, it was split before it was opened. Each PR entry in the roadmap records:

- **Why it's needed:** the user-facing reason.
- **Problem it solves:** what was wrong or missing, and how the change fixes it.
- **Unit tests added:** what is now checked automatically.
- **How to test:** numbered steps a reviewer can follow on a Windows laptop, including the expected test count.
- **Screenshots:** for any change you can see, saved under `docs/screenshots/pr-<number>/`.

When a PR merges, its row in the status table and its heading say **Done** with a link to the GitHub PR. So the roadmap doubles as a changelog: you can read it top to bottom and see every decision, in order, with its tests.

## How the two documents worked together

1. **Features first.** The feature list fixed the scope: click-to-explain, multi-line selection, context-aware prompts, chat, streaming, local LLM only, settings, error handling, caching, GitHub page behaviour, an on/off toggle, and accessibility.
2. **Roadmap from features.** Each feature was traced to the milestone that delivers it and broken into PRs. Supporting work with no feature of its own (messaging, the diff locator, the token budget) was placed right before the first PR that needed it.
3. **Build one PR at a time.** Each PR followed its roadmap entry, and the entry was updated with what was actually built, the real test names and counts, and screenshots.
4. **Update the plan when reality changed.** When something turned out to need more (for example, GitHub's in-page navigation, its new React diff view, or private-repository file access), the roadmap entry and, where it changed what users see, the feature list were updated in the same PR.
5. **Measure before optimizing.** Milestone 8 started with two PRs that only measure (a latency breakdown in the popup and a benchmark script), then attacked one term of the latency formula per PR, and ended with a report on real hardware.

## Where it ended up

All 37 PRs in Milestones 1 to 8 are done, and every feature in [features.md](features.md) is implemented and covered by unit tests.

**The open problem is LLM latency.** On the test laptop (CPU only), a 7B model takes about 53 seconds per explanation, down from 94 seconds at the start of Milestone 8, and the floor for that model on that hardware is about 25 seconds. Almost all of that time is the model writing its answer, so the next gains come from smaller coding models and GPUs rather than from the extension. See the [latency report](latency.md) for the measurements and [Opportunities for improvement](improvements.md) for what to try next.

The [release guide](release.md) proposes the next milestone: closing the gaps between a working developer build and a Chrome Web Store release, starting with a guided Ollama setup.
