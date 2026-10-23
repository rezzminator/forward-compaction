#!/usr/bin/env bash
# Types each step of scenario.md into the recording session and waits for its condition in the recorder's rows.
# Usage: drive.sh <tmux-target> [record-root] | drive.sh --dry-run
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STEP_LIMIT_S=${FC_STEP_LIMIT_S:-900}

steps() { grep -E '^\| S[0-9]+ \|' "$here/scenario.md" | sed -E 's/^\| (S[0-9]+) \| ([a-z-]+) \| (.*) \|$/\1\t\2\t\3/'; }

if [ "${1:-}" = "--dry-run" ]; then
  n=$(steps | wc -l)
  [ "$n" -ge 8 ] || { echo "drive: scenario.md has $n steps, expected S1-S8" >&2; exit 1; }
  steps | while IFS=$'\t' read -r id wait prompt; do
    case $wait in main-turn|manual-compact|notification) ;; *) echo "drive: $id has unknown wait '$wait'" >&2; exit 1 ;; esac
    echo "drive (dry run): $id waits for $wait: ${prompt:0:60}..."
  done
  exit 0
fi

target=${1:?usage: drive.sh <tmux-target> [record-root]}
root=${2:-${FC_RECORD_ROOT:-${TMPDIR:-/tmp}/forward-compaction/record}}
rows="$root/rows"

# Rows whose start is of hook $1, for main only (no agentId), whose text holds $2.
count() { grep -l "\"phase\":\"start\",\"hook\":\"$1\"" "$rows"/*.json 2>/dev/null | xargs -r grep -L '"agentId"' | xargs -r grep -l -- "${2:-}" | wc -l; }
# Start rows of prompt.submit or session.receive (any party) that name $1: the typed prompt is one, the notification the next.
notices() { grep -lE '"phase":"start","hook":"(prompt.submit|session.receive)"' "$rows"/*.json 2>/dev/null | xargs -r grep -l -- "$1" | wc -l; }

wait_for() { # $1 label, $2 command that succeeds when the condition holds
  local deadline=$((SECONDS + STEP_LIMIT_S))
  until eval "$2"; do
    [ $SECONDS -lt $deadline ] || { echo "drive: $1 did not happen within ${STEP_LIMIT_S}s" >&2; exit 1; }
    sleep 5
  done
}

# The folder trust dialog takes the first Enter; the session has started once session.start is recorded.
for _ in $(seq 1 12); do
  [ "$(count session.start)" -gt 0 ] && break
  tmux capture-pane -p -t "$target" | grep -qi 'trust' && tmux send-keys -t "$target" Enter
  sleep 5
done
wait_for "session.start" '[ "$(count session.start)" -gt 0 ]'

steps | while IFS=$'\t' read -r id wait prompt; do
  turns=$(count turn.complete)
  manual=$(count session.compact '"trigger":"manual"')
  done_rows=$(notices replay-done)
  echo "drive: $id ($wait)"
  tmux send-keys -t "$target" -l -- "$prompt"
  sleep 1
  tmux send-keys -t "$target" Enter
  case $wait in
    main-turn) wait_for "$id main turn.complete" "[ \$(count turn.complete) -gt $turns ]" ;;
    manual-compact) wait_for "$id manual session.compact" "[ \$(count session.compact '\"trigger\":\"manual\"') -gt $manual ]" ;;
    notification)
      wait_for "$id main turn.complete" "[ \$(count turn.complete) -gt $turns ]"
      wait_for "$id replay-done notification" "[ \$(notices replay-done) -gt $((done_rows + 1)) ]"
      turns=$(count turn.complete)
      wait_for "$id notification turn" "[ \$(count turn.complete) -gt $turns ]" ;;
  esac
done
echo "drive: scenario done"
