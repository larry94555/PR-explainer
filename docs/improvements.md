# Opportunities for improvement

PR Explainer does everything in its [feature list](features.md), but there is plenty of room to make it faster, easier to install and more useful. This page collects the biggest opportunities, starting with the one that matters most.

[← Back to the README](../README.md)

## 1. LLM latency (the big one)

An explanation that takes close to a minute breaks the flow of a code review. Milestone 8 set a goal of **under 10 seconds** from click to "Answered in …" and attacked every part of the time. The [latency report](latency.md) has the full numbers from a real laptop.

**Where things stand** (Windows 11, Intel i7-1360P, Intel Iris Xe graphics, `deepseek-r1:7b` running 100% on the CPU):

| Step | Median | Slowest |
|---|---:|---:|
| Baseline (PR 8.2) | 94.2 s | 206.3 s |
| Model kept loaded (8.3) | 104.5 s | 187.5 s |
| Shorter answers (8.4) | 53.2 s | 95.7 s |
| Smaller prompts (8.5) | 52.6 s | 85.7 s |
| Now (8.6 to 8.8) | 53.3 s | 86.4 s |

**The goal was not met on that laptop.** The floor (shortest sample, an answer of at most 150 tokens, model already loaded) is **24.8 s**, and 24.0 s of that is the model writing the answer at about 6.4 tokens per second. Loading and reading the prompt take well under a second each. No prompt or setting change can get a 7B model on a CPU under 10 seconds.

**What would help most, in order:**

1. **A smaller coding model.** A 1.5B model such as `qwen2.5-coder:1.5b` usually writes four to five times faster than a 7B model on a laptop CPU, which would put a typical answer at roughly 5 to 15 seconds. The next step is to benchmark it (`ollama pull qwen2.5-coder:1.5b`, then `npm run bench -- qwen2.5-coder:1.5b`) and check the answers are still useful.
2. **Avoid reasoning models.** `deepseek-r1` writes a hidden `<think>` section before answering. With the 300-token limit it often spent the whole budget thinking and sent no answer at all. A model that answers directly is both faster and more useful here.
3. **Use the GPU.** Ollama did not use the Intel Iris Xe GPU on Windows, so the model ran entirely on the CPU. A supported GPU (or freeing video memory so the whole model fits) makes generation several times faster. The settings page already shows whether the model runs on the GPU and suggests a fix.
4. **Pick a model for the user.** First-run setup could run the speed test automatically and recommend the fastest model that gives good answers, instead of leaving users to discover it.
5. **Shorter, more focused answers.** A compact mode (for example, only *Concerns*, or one sentence per section) would cut the dominant term, answer tokens, directly.
6. **Hide the wait.** Explain on hover already starts early. Prefetching the next likely lines, or explaining a whole hunk in the background when it scrolls into view, could make many clicks instant on capable hardware.
7. **Other runtimes.** llama.cpp server or LM Studio, through the existing `LlmClient` interface, may be faster on some machines (for example with better support for integrated GPUs).

## 2. Easier setup for non-developers

From the gaps listed in the [release guide](release.md#3-what-is-left-after-the-roadmap):

| Gap | Opportunity |
|---|---|
| **Ollama onboarding** (G1) | The biggest gap. A guided first run that checks Ollama is running, suggests a model sized for the laptop's memory, and fixes `OLLAMA_ORIGINS` if needed. Today users learn this from error messages. |
| **Plain user docs** (G2) | A short user guide for the store listing, separate from the developer install guide. |
| **Chrome Web Store release** | Store listing, hosted privacy policy, license, store-sized screenshots and release automation (G5, G7, G8). |
| **Badge as a setting** (G6) | The "PR Explainer active" badge was added to prove the content script runs. Make it optional, off by default. |

## 3. Production hardening

| Gap | Opportunity |
|---|---|
| **Narrower localhost access** (G3) | Ask for only the configured LLM address at runtime (`optional_host_permissions`) instead of any port on `localhost`. |
| **Quiet production console** (G4) | Put the service worker and timing log lines behind a "Debug logging" setting. |
| **Catch GitHub markup changes** (G9) | A scheduled smoke test against a public PR, so a GitHub change is noticed before users report it. |
| **Support without telemetry** (G10) | A **Copy diagnostics** button (versions, model, last error, no code) and an issue template. |
| **Minimum Chrome version** (G11) | Declare `minimum_chrome_version` in the manifest. |

## 4. New features

Ideas from the end of the [roadmap](roadmap.md#ideas-after-10), each big enough for its own milestone:

- **"Explain this whole file" and "Summarize this PR"** buttons.
- **Turn a concern into a draft review comment** with one click.
- **Other local servers** (LM Studio, llama.cpp server) through the `LlmClient` interface.
- **Firefox support.**

Other directions worth considering:

- **Persist chats** per PR across reloads (opt-in, stored locally).
- **Better token counting** with a real tokenizer for common models, so less of the context window is held back as a safety margin.
- **Reuse the context window across lines** of the same file, so a review of a single file pays the prompt cost once.
