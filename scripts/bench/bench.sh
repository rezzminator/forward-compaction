#!/usr/bin/env bash
# The compaction benchmark: Claude Code's native compaction against forward-compaction, main chats on Sonnet, one
# blind scripted scenario per seed, identical in every arm. Paid and live; never in CI.
#
# Files:
#   bench.sh        this front door: run, score, report, arms
#   arms.json       the arms, by data: name, whether the plugin loads, extra environment pairs
#   scenario.mjs    the scenario for one seed: records with planted facts, truth.json, turns.json (filler from ../replay/filler.mjs)
#   run-one.sh      one run: an interactive chat in its own tmux server, driven turn by turn, then metered and scored
#   transcript.mjs  reads a run folder's records (transcript, turns.log, stops.txt)
#   otlp.mjs        a local OTLP/HTTP JSON receiver: every API request's usage and duration -> otel.jsonl
#   meter.mjs       per compaction and per run: stall, context, tokens, cost, each with its source
#   score.mjs       exact scoring against the truth: facts, rules, quote, rework, final answers
#   report.mjs      every run -> results.json and the README table in Markdown
#   prices.json     list prices, USD per million tokens; BENCH_PRICES overrides
#
# Commands:
#   bench.sh run --arm <name> --runs <n> --claude <binary> --out <dir> [--plugin-dir <dir>] [--first-seed 1] [--parallel 2]
#       (each flag also reads env: BENCH_ARM, BENCH_RUNS, BENCH_CLAUDE_BIN, BENCH_OUT, BENCH_PLUGIN_DIR, BENCH_FIRST_SEED,
#        BENCH_PARALLEL; BENCH_TURNS sets the reading turns, default 9)
#   bench.sh score <run-dir> [answers-file]     rescore one run; a deliberately wrong answers file shows the score separating
#   bench.sh report <out-dir> [results-file]    results.json plus the Markdown table
#   bench.sh arms                               the arms' names
# A run stops starting new chats once <out>/STOP exists (written at the first usage or rate limit on screen).
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

run() {
  local arm=${BENCH_ARM:-} runs=${BENCH_RUNS:-} out=${BENCH_OUT:-} first=${BENCH_FIRST_SEED:-1} parallel=${BENCH_PARALLEL:-2}
  while [ $# -gt 0 ]; do
    case $1 in
      --arm) arm=$2 ;; --runs) runs=$2 ;; --out) out=$2 ;; --first-seed) first=$2 ;; --parallel) parallel=$2 ;;
      --claude) export BENCH_CLAUDE_BIN=$2 ;; --plugin-dir) export BENCH_PLUGIN_DIR=$2 ;;
      *) echo "bench run: unknown argument $1" >&2; exit 2 ;;
    esac
    shift 2
  done
  [ -n "$arm" ] && [ -n "$runs" ] && [ -n "$out" ] && [ -n "${BENCH_CLAUDE_BIN:-}" ] || { echo "bench run: --arm, --runs, --claude and --out are required" >&2; exit 2; }
  command -v tmux >/dev/null || { echo "bench run: tmux is required" >&2; exit 1; }
  mkdir -p "$out"
  local seed failed=0
  for seed in $(seq "$first" $((first + runs - 1))); do
    while [ "$(jobs -rp | wc -l)" -ge "$parallel" ]; do wait -n || failed=$((failed + 1)); done
    [ ! -e "$out/STOP" ] || { echo "bench run: $out/STOP exists (a usage or rate limit was hit); no new run starts" >&2; break; }
    "$here/run-one.sh" "$arm" "$seed" "$out" &
    sleep 5
  done
  while [ "$(jobs -rp | wc -l)" -gt 0 ]; do wait -n || failed=$((failed + 1)); done
  [ "$failed" -eq 0 ] || { echo "bench run: $failed run(s) failed; see each run's drive.log" >&2; exit 1; }
}

case ${1:-} in
  run) shift; run "$@" ;;
  score) shift; node "$here/score.mjs" "$@" ;;
  report) shift; node "$here/report.mjs" "$@" ;;
  arms) node -e 'for (const a of require(process.argv[1]).arms) console.log(a.name)' "$here/arms.json" ;;
  *) sed -n '2,26p' "$0" >&2; exit 2 ;;
esac
