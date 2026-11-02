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
cached prompt counts fewer. **Tokens/s** is how fast the answer was written. A failed run
is listed under its table and counted in **Runs**, never dropped.
