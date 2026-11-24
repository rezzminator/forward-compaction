#!/usr/bin/env bash
# One benchmark run: one interactive Claude Code chat on Sonnet under its own tmux server, typed the scenario's turns
# one by one, each awaited by the Stop hook the run's settings install; then the transcript is copied in, the chat
# and its tmux server killed, and the run metered and scored.
# Usage: run-one.sh <arm> <seed> <out-dir>
#   env: BENCH_CLAUDE_BIN (required), BENCH_PLUGIN_DIR (required by an arm with a plugin), BENCH_TURNS (reading
#   turns, default 9), BENCH_TURN_LIMIT_S (default 1500), CLAUDE_CONFIG_DIR (the seat; default ~/.claude)
# Exit: 0 done, 1 failed run, 3 a usage or rate limit was hit (the caller stops starting runs).
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
arm=${1:?usage: run-one.sh <arm> <seed> <out-dir>} seed=${2:?seed} out=${3:?out-dir}
bin=${BENCH_CLAUDE_BIN:?set BENCH_CLAUDE_BIN to the Claude Code binary}
turns_n=${BENCH_TURNS:-9}
limit_s=${BENCH_TURN_LIMIT_S:-1500}
config=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
dir=$out/$arm/run-$seed
[ ! -e "$dir/meter.json" ] || { echo "run-one: $dir already holds a metered run" >&2; exit 1; }
mkdir -p "$dir"
dir=$(cd "$dir" && pwd)
ws=$dir/ws
log() { echo "[$arm/run-$seed $(date +%H:%M:%S)] $*" | tee -a "$dir/drive.log" >&2; }

# The arm, by data: whether it loads the plugin, and its extra environment pairs.
mapfile -t arm_lines < <(node -e '
  const [file, name] = process.argv.slice(1);
  const arm = JSON.parse(require("fs").readFileSync(file, "utf8")).arms.find((a) => a.name === name);
  if (!arm) { console.error(`run-one: no arm named ${name} in ${file}`); process.exit(2); }
  console.log(arm.plugin ? "plugin" : "none");
  for (const [k, v] of Object.entries(arm.env ?? {})) console.log(`${k}=${v}`);
' "$here/arms.json" "$arm")
plugin_args=()
if [ "${arm_lines[0]}" = plugin ]; then
  plugin=${BENCH_PLUGIN_DIR:?arm $arm loads the plugin: set BENCH_PLUGIN_DIR}
  [ -f "$plugin/.claude-plugin/plugin.json" ] || { echo "run-one: $plugin/.claude-plugin/plugin.json missing" >&2; exit 1; }
  plugin_args=(--plugin-dir "$plugin")
fi

rm -rf "$ws"
node "$here/scenario.mjs" "$dir" "$seed" "$turns_n" >/dev/null
version=$("$bin" --version | sed -n 's/^\([0-9][0-9.]*\).*/\1/p')
sid=$(node -e 'console.log(require("crypto").randomUUID())')
: > "$dir/stops.txt"
: > "$dir/turns.log"
# Settings: only these apply (--setting-sources project, and the workspace has no project settings): no seat plugin,
# hook, env, effort or window setting reaches the chat. The Stop hook marks each turn end for the driver.
node -e '
  const [out, stops, logs] = process.argv.slice(1);
  const settings = {
    autoCompactEnabled: true, autoMemoryEnabled: false, autoContinueAtUsageLimit: false,
    env: { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000", PLUGIN_LOG_DIR: logs },
    permissions: { allow: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "mcp__forward-compaction__*"], defaultMode: "dontAsk" },
    hooks: { Stop: [{ hooks: [{ type: "command", command: `date +%s%3N >> ${JSON.stringify(stops)}` }] }] },
  };
  require("fs").writeFileSync(out, JSON.stringify(settings, null, 2) + "\n");
' "$dir/settings.json" "$dir/stops.txt" "$dir/logs"
sock=fcb-$arm-$seed-$$
# Every API request's usage and duration reach otel.jsonl through a local OTLP receiver (the transcript loses a
# request whose response a compaction overtakes, and never holds the summarizer's).
rm -f "$dir/otel.jsonl" "$dir/otel.port"
node "$here/otlp.mjs" "$dir/otel.jsonl" "$dir/otel.port" &
otlp_pid=$!
for _ in $(seq 1 50); do [ -s "$dir/otel.port" ] && break; sleep 0.2; done
[ -s "$dir/otel.port" ] || { echo "run-one: the OTLP receiver never wrote its port" >&2; kill "$otlp_pid"; exit 1; }
kill_chat() { tmux -L "$sock" kill-server 2>/dev/null || true; kill "$otlp_pid" 2>/dev/null || true; }
trap kill_chat EXIT
# The launch environment is built from nothing: no FORWARD_COMPACTION_* or other variable of the host reaches it.
{
  echo '#!/usr/bin/env bash'
  printf 'cd %q\n' "$ws"
  printf 'exec env -i HOME=%q PATH=%q USER=%q SHELL=/bin/bash TERM=tmux-256color LANG=C.UTF-8' "$HOME" "$PATH" "${USER:-bench}"
  [ -z "${CLAUDE_CONFIG_DIR:-}" ] || printf ' CLAUDE_CONFIG_DIR=%q' "$CLAUDE_CONFIG_DIR"
  printf ' CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000 DISABLE_AUTOUPDATER=1 PLUGIN_LOG_DIR=%q' "$dir/logs"
  printf ' CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_LOGS_EXPORTER=otlp OTEL_METRICS_EXPORTER=none OTEL_EXPORTER_OTLP_PROTOCOL=http/json OTEL_LOGS_EXPORT_INTERVAL=1000 OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:%s' "$(cat "$dir/otel.port")"
  for pair in "${arm_lines[@]:1}"; do printf ' %q' "$pair"; done
  printf ' %q' "$bin" --model sonnet --session-id "$sid" --setting-sources project --settings "$dir/settings.json" --permission-mode dontAsk --debug-file "$dir/debug.log" "${plugin_args[@]}"
  echo
} > "$dir/launch.sh"
chmod +x "$dir/launch.sh"
printf '{"arm":"%s","seed":%s,"session":"%s","claude":"%s","turns":%s}\n' "$arm" "$seed" "$sid" "$version" "$turns_n" > "$dir/run.json"

tmux -L "$sock" new-session -d -s chat -x 200 -y 50 "$dir/launch.sh"
pane() { tmux -L "$sock" capture-pane -p -t chat 2>/dev/null || true; }
limit_hit() { pane | grep -qiE 'usage limit|rate limit|limit reached|limit will reset|out of extra usage'; }

# Startup: the folder trust dialog opens on "No, exit": Down picks "Yes, I trust this folder", Enter confirms.
ready=
for _ in $(seq 1 60); do
  p=$(pane)
  if grep -q 'Yes, I trust this folder' <<<"$p"; then tmux -L "$sock" send-keys -t chat Down; sleep 1; tmux -L "$sock" send-keys -t chat Enter; sleep 2; continue; fi
  if grep -qE 'for shortcuts|❯' <<<"$p"; then ready=1; break; fi
  sleep 2
done
[ -n "$ready" ] || { pane > "$dir/pane-fail.txt"; log "the chat never showed its prompt; pane in pane-fail.txt"; exit 1; }
sleep 3

transcript() { find -L "$config/projects/" -name "$sid.jsonl" 2>/dev/null | head -1; }
quiet_s() { local t; t=$(transcript); [ -n "$t" ] || { echo 0; return; }; echo $(( $(date +%s) - $(stat -c %Y "$t") )); }

n=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).length)' "$dir/turns.json")
for k in $(seq 1 "$n"); do
  turn=$(node -e 'const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2] - 1]; console.log(JSON.stringify({ id: t.id, final: !!t.final, prompt: t.prompt }))' "$dir/turns.json" "$k")
  id=$(node -e 'console.log(JSON.parse(process.argv[1]).id)' "$turn")
  if [ "$(node -e 'console.log(JSON.parse(process.argv[1]).final)' "$turn")" = true ]; then
    # The answers are recalled, not re-read: the records and the summaries leave the workspace before the last turn.
    mkdir -p "$dir/hidden"
    mv "$ws/records" "$dir/hidden/records"
    mv "$ws/out" "$dir/hidden/out"
    mkdir -p "$ws/out"
  fi
  prompt=$(node -e 'console.log(JSON.parse(process.argv[1]).prompt)' "$turn")
  echo "$id $(date +%s%3N)" >> "$dir/turns.log"
  log "$id sent"
  tmux -L "$sock" send-keys -t chat -l -- "$prompt"
  sleep 2
  tmux -L "$sock" send-keys -t chat Enter
  deadline=$((SECONDS + limit_s))
  until [ "$(wc -l < "$dir/stops.txt")" -ge "$k" ] && [ "$(quiet_s)" -ge 8 ]; do
    if limit_hit; then pane > "$dir/pane-fail.txt"; log "usage or rate limit on screen at $id"; touch "$out/STOP"; exit 3; fi
    if pane | grep -q 'Do you want to'; then pane > "$dir/pane-fail.txt"; log "a permission prompt holds $id"; exit 1; fi
    [ $SECONDS -lt $deadline ] || { pane > "$dir/pane-fail.txt"; log "$id did not end within ${limit_s}s"; exit 1; }
    sleep 4
  done
  log "$id done"
done
t=$(transcript)
[ -n "$t" ] || { log "no transcript $sid.jsonl under $config/projects"; exit 1; }
cp "$t" "$dir/transcript.jsonl"
pane > "$dir/pane-end.txt"
tmux -L "$sock" send-keys -t chat -l -- "/exit"
tmux -L "$sock" send-keys -t chat Enter
# Claude Code flushes its telemetry as it exits: the receiver stops only once the chat is gone.
for _ in $(seq 1 30); do tmux -L "$sock" has-session -t chat 2>/dev/null || break; sleep 1; done
sleep 2
kill_chat
# Written whole or not at all: a failed meter or score leaves no file, so the seed can run again and the report skips it.
node "$here/meter.mjs" "$dir" > "$dir/meter.json.part" && mv "$dir/meter.json.part" "$dir/meter.json"
node "$here/score.mjs" "$dir" > "$dir/score.json.part" && mv "$dir/score.json.part" "$dir/score.json"
log "metered and scored: $(node -e 'const m = require(process.argv[1]), s = require(process.argv[2]); console.log(`${m.run.compactions} compactions, $${m.run.cost_usd.toFixed(2)}, facts ${s.facts.both}/${s.facts.n}`)' "$dir/meter.json" "$dir/score.json")"
