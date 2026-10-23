#!/usr/bin/env bash
# The live recording (npm run replay:record): a real interactive Claude Code session in tmux, driven through
# scenario.md, its rows sanitized into tests/fixtures/replay/{version}/session.jsonl.gz. Paid; never in CI.
# Usage: record.sh [--dry-run]   env: FC_RECORD_ROOT, CLAUDE_BIN, FC_STEP_LIMIT_S
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
root=${FC_RECORD_ROOT:-${TMPDIR:-/tmp}/forward-compaction/record}
export FC_RECORD_ROOT=$root
tmux_session=forward-compaction-replay

if [ "${1:-}" = "--dry-run" ]; then
  plugin=$("$here/assemble.sh" "$root")
  CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate --strict "$plugin"
  "$here/launch.sh" --dry-run
  "$here/drive.sh" --dry-run
  echo "record (dry run): would run tmux session $tmux_session, drive it, then sanitize $root/rows"
  exit 0
fi

command -v tmux >/dev/null || { echo "record: tmux is required" >&2; exit 1; }
if tmux has-session -t "$tmux_session" 2>/dev/null; then echo "record: tmux session $tmux_session already runs; kill it first" >&2; exit 1; fi
rm -rf "$root/rows"
mkdir -p "$root/rows"
# A running tmux server hands a new session its own global environment, not this shell's: carry the seat, the root
# and the tools across explicitly, so the recording runs on the seat that ran this script.
env_args=(-e "FC_RECORD_ROOT=$root" -e "PATH=$PATH" -e "HOME=$HOME")
for name in CLAUDE_CONFIG_DIR TMPDIR CLAUDE_BIN; do
  if [ -n "${!name:-}" ]; then env_args+=(-e "$name=${!name}"); fi
done
unset_args=()
[ -n "${CLAUDE_CONFIG_DIR:-}" ] || unset_args=(env -u CLAUDE_CONFIG_DIR)
tmux new-session -d -s "$tmux_session" -x 200 -y 50 "${env_args[@]}" "${unset_args[@]}" "$here/launch.sh"
stop() { tmux kill-session -t "$tmux_session" 2>/dev/null || true; }
trap stop EXIT
"$here/drive.sh" "$tmux_session" "$root"
# The last rows (session.end) are written as the session exits.
tmux send-keys -t "$tmux_session" -l -- "/exit"
tmux send-keys -t "$tmux_session" Enter
for _ in $(seq 1 30); do tmux has-session -t "$tmux_session" 2>/dev/null || break; sleep 2; done
stop
node "$here/sanitize.mjs" "$root/rows"
echo "record: done. Commit the new tests/fixtures/replay/{version}/ and delete the previous version's directory in the same commit."
