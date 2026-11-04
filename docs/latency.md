# Explanation latency

Measured with `npm run bench` (roadmap PR 8.2), which sends the extension's real explain
prompt for the samples in `bench/` to the local Ollama and times each answer. Each run
below adds a dated section at the end, with the computer it ran on, so numbers from different
laptops are not compared by mistake.

How to read a table: every time is the median of the runs that finished, except **Slowest**.
**Median** and **Slowest** run from sending the request to the end of the answer, like
"Answered in …" in the popup without the time spent on the GitHub page. **First token** is
when the first word arrived. **Load** is Ollama loading the model into memory (near zero
once it is loaded). **Prompt tokens** counts only the tokens Ollama had to read, so a
cached prompt counts fewer. **Tokens/s** is how fast the answer was written. **Think tokens**
and **Think time** are the part of the answer a reasoning model spent inside `<think>`,
estimated from its share of the reply (PR 9.1). A failed run is listed under its table and
counted in **Runs**, never dropped.

`npm run bench:history -- [model ...]` (roadmap PR 8.8) adds a **Latency report** section: the
same benchmark run with the code as it was after each latency PR, a row per step, and a
conclusion. Reports from before PR 9.11 measure against 10 seconds (Milestone 8). Since PR 9.11
the goal is 2 seconds, and the report also times **fresh answers** (every sample with the
current code, the model warm, no cache) and **clicks after Explain ahead** (each added line of a
saved diff page explained ahead, then a click on each timed; `npm run bench -- --ahead` runs
only this part). The conclusion says whether the goal is met for fresh answers, only for clicks
after Explain ahead (at least 90% of them within 2 seconds), or for neither, and then gives the
floor (the shortest sample, an answer of at most 150 tokens, the model already loaded), which
part of the time limits it, and what would help next.

## Latency report 2026-11-02 03:49

Every step below ran `npm run bench` (3 runs per sample) with the code as it was when that PR merged, one after another on this computer, each starting with the model unloaded. Times are the median, and the slowest run, of every sample. Keeping the model loaded (8.3) mostly helps the first click after a pause, which back-to-back runs do not show, and Explain on hover (8.7) hides time while you read rather than cutting it.

| Step | deepseek-r1:7b median | deepseek-r1:7b slowest |
| --- | ---: | ---: |
| Baseline (8.2) | 94.2 s | 206.3 s |
| Model kept loaded (8.3) | 104.5 s | 187.5 s |
| Shorter answers (8.4) | 53.2 s | 95.7 s |
| Smaller prompts (8.5) | 52.6 s | 85.7 s |
| Now (8.6 to 8.8) | 53.3 s | 86.4 s |

### Conclusion

**Goal not met.** The fastest model, deepseek-r1:7b, takes 53.3 s (median of every sample, on 100% CPU).

The floor on this laptop is **24.8 s**: Short TypeScript line, an answer of at most 150 tokens, model already loaded. Of that, 606 ms is loading, 136 ms reading the prompt, 24.0 s writing the answer and 22 ms outside Ollama, so writing the answer limits it.

Next step: The model runs on 100% CPU, so a GPU (or freeing video memory so all of it fits) would write the answer several times faster. Without one, a smaller model (1.5B or 3B) writes faster.

### Notes on this run

Added by hand after the run, from the tables below.

- **Writing the answer is nearly all of the time.** deepseek-r1:7b writes about 6.4 tokens per second on this CPU, in every step. Reading the prompt takes well under a second, and so does loading once the model is in memory. At that speed even 60 tokens take about 9 seconds, so no prompt or setting change can get this model under 10 seconds on this laptop.
- **Most of the gain came from shorter answers (8.4).** The median dropped from 94.2 s to 53.2 s, and the slowest run from 206.3 s to 95.7 s, because answers are now capped at 300 tokens instead of running to 400 to 1,000. The smaller prompts from 8.5 cut about 30 to 70 prompt tokens per sample. At this prompt speed that saves only a fraction of a second, which is lost in run-to-run noise. 8.3 shows no gain in back-to-back runs, as expected: the model never had time to unload.
- **deepseek-r1 is a reasoning model, and that hurts here.** It writes a hidden `<think>` section before the answer. From 8.4 on, many runs show no first token ("–") and all of them hit the 300-token limit, which means Ollama sent no answer text at all: the model spent the whole limit thinking, and the popup would show every section as cut off. So the 53 s explanations are often cut off, and a model that answers directly would be faster and more useful.
- **The GPU is not used.** Intel Iris Xe graphics is not used by Ollama on Windows by default, so the model ran 100% on the CPU. That makes a smaller model the practical next step: a 1.5B coding model such as `qwen2.5-coder:1.5b` usually writes four to five times faster than a 7B model on a laptop CPU. That would put a 150 to 300-token answer at about 5 to 15 seconds. The way to check is `ollama pull qwen2.5-coder:1.5b` and then `npm run bench -- qwen2.5-coder:1.5b`, or the **Speed test** on the settings page.
- **Defaults are unchanged.** The run supports the defaults already in place: the 300-token answer limit (8.4) and keeping the model loaded (8.3). It gives no evidence for a different answer limit, keep-alive or number of context lines. A lower answer limit would cut a reasoning model off before it answers at all, and the model is picked from what is installed, so it has no default to change.

### Baseline (8.2)

#### 2026-11-02 03:49 · deepseek-r1:7b

- **Machine:** Windows 11 Home (10.0.26200); 13th Gen Intel(R) Core(TM) i7-1360P (16 threads); 15.7 GB RAM
- **GPU:** Intel(R) Iris(R) Xe Graphics
- **Ollama:** 0.32.1 at http://localhost:11434
- **Settings:** temperature 0.2, answers up to 1024 tokens, 3 runs per sample

##### deepseek-r1:7b (context 4096 tokens, ran on 100% CPU)

| Sample | Runs | Median | Slowest | First token | Load | Prompt tokens | Answer tokens | Tokens/s |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Short TypeScript line | 3 | 62.8 s | 66.6 s | 45.5 s | 383 ms | 378 | 366 | 7.3 |
| Long TypeScript selection | 3 | 128.9 s | 156.6 s | 103.1 s | 398 ms | 1,148 | 580 | 6.2 |
| Python line | 3 | 81.1 s | 88.7 s | 49.6 s | 355 ms | 562 | 421 | 6.5 |
| Go line | 3 | 94.4 s | 117.7 s | 73.7 s | 505 ms | 413 | 546 | 5.8 |
| Rust selection | 3 | 156.7 s | 206.3 s | 98.2 s | 663 ms | 469 | 887 | 5.7 |
| **All samples** | 15 | 94.2 s | 206.3 s | 62.5 s | 399 ms | 469 | 528 | 6.2 |

### Model kept loaded (8.3)

#### 2026-11-02 04:15 · deepseek-r1:7b

- **Machine:** Windows 11 Home (10.0.26200); 13th Gen Intel(R) Core(TM) i7-1360P (16 threads); 15.7 GB RAM
- **GPU:** Intel(R) Iris(R) Xe Graphics
- **Ollama:** 0.32.1 at http://localhost:11434
- **Settings:** temperature 0.2, answers up to 1024 tokens, 3 runs per sample

##### deepseek-r1:7b (context 4096 tokens, ran on 100% CPU)

| Sample | Runs | Median | Slowest | First token | Load | Prompt tokens | Answer tokens | Tokens/s |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Short TypeScript line | 3 | 79.3 s | 90.3 s | 59.6 s | 729 ms | 378 | 409 | 5.8 |
| Long TypeScript selection | 3 | 167.3 s | 187.5 s | 126.7 s | 608 ms | 1,148 | 776 | 5.5 |
| Python line | 3 | 75.6 s | 128.9 s | 58.8 s | 714 ms | 562 | 432 | 6.1 |
| Go line | 3 | 84.7 s | 155.5 s | 63.6 s | 645 ms | 413 | 493 | 6.1 |
| Rust selection | 3 | 111.9 s | 143.2 s | 88.1 s | 741 ms | 469 | 657 | 6.0 |
| **All samples** | 15 | 104.5 s | 187.5 s | 68.0 s | 699 ms | 469 | 617 | 6.0 |

### Shorter answers (8.4)

#### 2026-11-02 04:43 · deepseek-r1:7b

- **Machine:** Windows 11 Home (10.0.26200); 13th Gen Intel(R) Core(TM) i7-1360P (16 threads); 15.7 GB RAM
- **GPU:** Intel(R) Iris(R) Xe Graphics
- **Ollama:** 0.32.1 at http://localhost:11434
- **Settings:** temperature 0.2, answers up to 300 tokens, 3 runs per sample

##### deepseek-r1:7b (context 4096 tokens, ran on 100% CPU)

| Sample | Runs | Median | Slowest | First token | Load | Prompt tokens | Answer tokens | Tokens/s |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Short TypeScript line | 3 | 49.1 s | 65.4 s | 48.0 s | 588 ms | 389 | 300 | 7.1 |
| Long TypeScript selection | 3 | 54.0 s | 95.7 s | – | 615 ms | 1,159 | 300 | 6.5 |
| Python line | 3 | 53.3 s | 63.5 s | – | 570 ms | 573 | 300 | 6.2 |
| Go line | 3 | 53.2 s | 56.3 s | – | 692 ms | 424 | 300 | 6.3 |
| Rust selection | 3 | 52.8 s | 65.7 s | – | 653 ms | 480 | 300 | 6.8 |
| **All samples** | 15 | 53.2 s | 95.7 s | 48.0 s | 615 ms | 480 | 300 | 6.5 |

### Smaller prompts (8.5)

#### 2026-11-02 04:57 · deepseek-r1:7b

- **Machine:** Windows 11 Home (10.0.26200); 13th Gen Intel(R) Core(TM) i7-1360P (16 threads); 15.7 GB RAM
- **GPU:** Intel(R) Iris(R) Xe Graphics
- **Ollama:** 0.32.1 at http://localhost:11434
- **Settings:** temperature 0.2, answers up to 300 tokens, 3 runs per sample

##### deepseek-r1:7b (context up to 4096 tokens, ran on 100% CPU)

| Sample | Runs | Median | Slowest | First token | Load | Prompt tokens | Answer tokens | Tokens/s |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Short TypeScript line | 3 | 51.5 s | 68.1 s | – | 756 ms | 357 | 300 | 6.5 |
| Long TypeScript selection | 3 | 53.0 s | 85.7 s | – | 618 ms | 1,090 | 300 | 6.6 |
| Python line | 3 | 51.1 s | 64.0 s | – | 585 ms | 532 | 300 | 6.1 |
| Go line | 3 | 52.7 s | 53.2 s | – | 601 ms | 392 | 300 | 6.4 |
| Rust selection | 3 | 52.6 s | 57.0 s | – | 515 ms | 440 | 300 | 6.8 |
| **All samples** | 15 | 52.6 s | 85.7 s | – | 601 ms | 440 | 300 | 6.5 |

### Now (8.6 to 8.8)

#### 2026-11-02 05:11 · deepseek-r1:7b

- **Machine:** Windows 11 Home (10.0.26200); 13th Gen Intel(R) Core(TM) i7-1360P (16 threads); 15.7 GB RAM
- **GPU:** Intel(R) Iris(R) Xe Graphics
- **Ollama:** 0.32.1 at http://localhost:11434
- **Settings:** temperature 0.2, answers up to 300 tokens, 3 runs per sample

##### deepseek-r1:7b (context up to 4096 tokens, ran on 100% CPU)

| Sample | Runs | Median | Slowest | First token | Load | Prompt tokens | Answer tokens | Tokens/s |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Short TypeScript line | 3 | 50.7 s | 67.6 s | 35.5 s | 657 ms | 357 | 300 | 6.8 |
| Long TypeScript selection | 3 | 55.1 s | 86.4 s | – | 605 ms | 1,090 | 300 | 6.4 |
| Python line | 3 | 52.5 s | 66.1 s | 61.5 s | 641 ms | 532 | 300 | 5.9 |
| Go line | 3 | 53.3 s | 54.2 s | 43.9 s | 660 ms | 392 | 300 | 6.6 |
| Rust selection | 3 | 53.5 s | 57.7 s | – | 693 ms | 440 | 300 | 6.3 |
| **All samples** | 15 | 53.3 s | 86.4 s | 40.3 s | 657 ms | 440 | 300 | 6.4 |
