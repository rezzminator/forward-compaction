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

# Rows whose start is of hook $1, for main only (no agentId key; an escaped one inside a text does not count), whose text holds $2.
# Subshells without pipefail: a grep that matches nothing is a count of 0, never an exit under set -e.
count() ( set +o pipefail; grep -l "\"phase\":\"start\",\"hook\":\"$1\"" "$rows"/*.json 2>/dev/null | xargs -r grep -L '"agentId":"' | xargs -r grep -l -- "${2:-}" | wc -l )
# Start rows of prompt.submit or session.receive (any party) that name $1 and are not the typed S5 prompt (it says
# run_in_background): the shell's notification. notice_rows lists them; notices counts them.
notice_rows() ( set +o pipefail; grep -lE '"phase":"start","hook":"(prompt.submit|session.receive)"' "$rows"/*.json 2>/dev/null | xargs -r grep -l -- "$1" | xargs -r grep -L 'run_in_background' | sort )
notices() ( set +o pipefail; notice_rows "$1" | wc -l )
# Main turn.complete start rows written after row file $1 (row files sort by their zero-padded seq).
turns_after() ( set +o pipefail; grep -l '"phase":"start","hook":"turn.complete"' "$rows"/*.json 2>/dev/null | xargs -r grep -L '"agentId":"' | awk -v mark="$1" '$0 > mark' | wc -l )

# The newest row file, and the newest main prompt.submit start row after row file $2 whose text holds $1.
newest() { ls "$rows" | grep -E '^[0-9]+\.json' | sort | tail -1 | sed "s#^#$rows/#"; }
typed_after() ( set +o pipefail; grep -l '"phase":"start","hook":"prompt.submit"' "$rows"/*.json 2>/dev/null | xargs -r grep -L '"agentId":"' | xargs -r grep -lF -- "$1" | awk -v mark="$2" '$0 > mark' | sort | tail -1 )

wait_for() { # $1 label, $2 command that succeeds when the condition holds, $3 seconds (default STEP_LIMIT_S)
  local deadline=$((SECONDS + ${3:-$STEP_LIMIT_S}))
  until eval "$2"; do
    [ $SECONDS -lt $deadline ] || { echo "drive: $1 did not happen within ${3:-$STEP_LIMIT_S}s" >&2; exit 1; }
    sleep 5
  done
}

# The folder trust dialog opens on "No, exit": Down picks "Yes, I trust this folder", Enter confirms it.
# The session has started once session.start is recorded.
for _ in $(seq 1 12); do
  [ "$(count session.start)" -gt 0 ] && break
  if tmux capture-pane -p -t "$target" | grep -q 'Yes, I trust this folder'; then
    tmux send-keys -t "$target" Down
    sleep 1
    tmux send-keys -t "$target" Enter
  fi
  sleep 5
done
wait_for "session.start" '[ "$(count session.start)" -gt 0 ]'

steps | while IFS=$'\t' read -r id wait prompt; do
  turns=$(count turn.complete)
  manual=$(count session.compact '"trigger":"manual"')
  done_rows=$(notices replay-done)
  before=$(newest)
  key=${prompt%%\"*}
  key=${key:0:30}
  echo "drive: $id ($wait)"
  tmux send-keys -t "$target" -l -- "$prompt"
  sleep 1
  tmux send-keys -t "$target" Enter
  case $wait in
    main-turn)
      # A background agent's notification can start a main turn of its own: the step's turn is the first main
      # turn.complete after the step's own prompt.submit row. With no such row seen, any new main turn.complete.
      if (wait_for "$id prompt.submit" "[ -n \"\$(typed_after \"$key\" \"$before\")\" ]" 120); then
        typed=$(typed_after "$key" "$before")
        wait_for "$id main turn.complete" "[ \$(turns_after $typed) -gt 0 ]"
      else
        echo "drive: $id saw no prompt.submit row holding \"$key\"; waiting for any new main turn" >&2
        wait_for "$id main turn.complete" "[ \$(count turn.complete) -gt $turns ]"
      fi ;;
    manual-compact) wait_for "$id manual session.compact" "[ \$(count session.compact '\"trigger\":\"manual\"') -gt $manual ]" ;;
    notification)
      wait_for "$id main turn.complete" "[ \$(count turn.complete) -gt $turns ]"
      # The notification's own turn is the first main turn.complete after its row; with no row seen, the next one.
      mark=$(ls "$rows"/*.json | sort | tail -1)
      if (wait_for "$id replay-done notification" "[ \$(notices replay-done) -gt $done_rows ]" 300); then
        mark=$(notice_rows replay-done | tail -1)
      else
        echo "drive: $id saw no replay-done row in prompt.submit or session.receive; waiting for the next main turn instead" >&2
      fi
      wait_for "$id notification turn" "[ \$(turns_after $mark) -gt 0 ]" ;;
  esac
done
# Background agents may still run: the session is done once no row has been written for 90 seconds.
quiet() { local n; n=$(newest); [ -n "$n" ] && [ $(( $(date +%s) - $(stat -c %Y "$n") )) -ge ${FC_QUIET_S:-90} ]; }
wait_for "rows quiet for 90s" quiet
echo "drive: scenario done"
