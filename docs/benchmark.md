# Benchmark: Claude Code's native compaction against forward-compaction

The README's [Benchmark](../README.md#benchmark) section shows six rows of this table.

One scripted ten-turn chat, run five times each on Claude Code's native compaction and on forward-compaction, on 2026-11-24 and 25: Sonnet 5.5 (`claude-sonnet-5-5`) at medium effort, Claude Code 2.1.331, no other plugin loaded. The forward-compaction column ran with `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` and the native column with `143000`, so that both compact at about the same context size (see the first note under the table). The first turn states four rules and the second a note to keep word for word; nine turns each read two record files and summarize every crate in them; the fifth turn changes one rule; the last turn forbids opening any file and asks for every crate's item and shelf and the total weight. Every figure comes from the runs' own records: each API request's usage and duration, each compaction's boundary record, and the files the chat wrote, scored against the scenario's truth.

| Median (p90) of 5 runs | Native compaction | forward-compaction |
| --- | --- | --- |
| Compactions in the run | 3 | 3 |
| Time one compaction stalls the chat | 17.4 s (20.3 s) | **5.6 s** (7.3 s) |
| Context when it started | 113.6k tokens (116.6k) | 120.2k (120.8k) |
| Context of the first request after | 36.1k tokens (62.5k) | **28.8k** (29.5k) |
| Tokens written per compaction | 3.0k (3.6k) | **768** (941) |
| Cost of one compaction | $0.153 ($0.263) | **$0.035** ($0.037) |
| Whole run: wall time | 4.0 min (4.1 min) | 3.5 min (3.6 min) |
| Whole run: requests | 33 | 33 |
| Whole run: input · cache read · cache write · output tokens | 86.3k · 1964.7k · 316.3k · 17.0k | 1.4k · 2095.1k · 295.8k · 10.8k |
| Whole run: cost | $1.80 ($1.82) | **$1.50** ($1.51) |
| Crate items recalled at the end | 133 of 180 | **180 of 180** |
| Crate shelves recalled at the end | **24 of 180** | 0 of 180 |
| User's rules obeyed after a compaction | 110 of 110 | 110 of 110 |
| Changed rule obeyed after a compaction | 16 of 16 | 15 of 15 |
| User's note quoted back word for word | 5 of 5 runs | 5 of 5 runs |
| Files re-read after a compaction | 0 | 0 |
| Final answers complete, total weight right | 1 of 5 runs | **5 of 5 runs** |

Cost is every API request at Anthropic's list prices for the model, USD per million tokens: input 2, output 10, cache read 0.1, cache write 2.5 (5 minutes) and 4 (1 hour). One compaction's cost is the requests that wrote it plus the uncached input and cache write of the first request after it.

- **The same compaction point.** One window setting does not make the two compact at the same point: at a 100k window Claude Code's own compaction starts at about 77k tokens, while forward-compaction holds that ask until a frontier is stored and compacts at about 120k. The native column therefore ran with a 143k window, which starts its compactions at about 114k, three a run like forward-compaction's. At the 100k window native compacted eight times a run: 15.5 s a compaction, 5.1 min and $2.39 a run, 132 of 180 items, 20 of 180 shelves, final answers right in 1 of 5 runs (the `native` column of the results file; the table's column is `native-matched`).
- **Items against shelves.** Every record line names a crate's item, weight and shelf. Each turn's summary asks for the item, so the work has needed it; the shelf sits in the files and is asked for only in the last turn. forward-compaction kept every item and no shelf: a frontier carries what the work has needed so far, and a detail nobody has asked for yet is not in it. The native summary kept 133 of 180 items, and 24 shelves: the 4 read after its last compaction and 20 of the 56 read one compaction earlier, none older.
- **Limits.** One scenario, one model, five runs a column, one window a column (an arm's `window` in `scripts/bench/arms.json`). `scripts/bench/bench.sh run --arm {native|native-matched|fc} --runs 5 --claude {binary} --out {dir}` runs a column on your own account and `scripts/bench/bench.sh report {dir}` prints the table; each run's numbers are in [`scripts/bench/results/sonnet-2026-11-24.json`](../scripts/bench/results/sonnet-2026-11-24.json).
