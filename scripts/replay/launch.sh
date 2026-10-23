#!/usr/bin/env bash
# Starts the recording session: Claude Code at the version types/claude-code.d.ts names, the assembled recording
# plugin, scripts/replay/settings.json plus every plugin the seat enables switched off, cwd the record root.
# Runs on the seat's own config (CLAUDE_CONFIG_DIR as set, never a copy of its credentials).
# Usage: launch.sh [--dry-run]   env: FC_RECORD_ROOT (default ${TMPDIR:-/tmp}/forward-compaction/record), CLAUDE_BIN
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
root=${FC_RECORD_ROOT:-${TMPDIR:-/tmp}/forward-compaction/record}
version=$(sed -n '1s/^\/\/ Written by Claude Code \([0-9][0-9.]*\)\.$/\1/p' "$repo/types/claude-code.d.ts")
[ -n "$version" ] || { echo "launch: line 1 of types/claude-code.d.ts names no Claude Code version" >&2; exit 1; }
bin=${CLAUDE_BIN:-$HOME/.local/share/claude/versions/$version}
[ -x "$bin" ] || bin=$(command -v claude || true)
[ -n "$bin" ] || { echo "launch: no Claude Code binary (set CLAUDE_BIN)" >&2; exit 1; }
got=$("$bin" --version | sed -n 's/^\([0-9][0-9.]*\).*/\1/p')
[ "$got" = "$version" ] || { echo "launch: $bin is Claude Code $got, the types are $version: record on $version (D1)" >&2; exit 1; }

"$here/assemble.sh" "$root" >/dev/null
node "$here/filler.mjs" "$root/filler" >/dev/null
# Every plugin the seat enables is off for the recording, so only forward-compaction's hooks see the session (O4).
config=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
node -e '
  const [base, seat, out] = process.argv.slice(1);
  const fs = require("fs");
  const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { if (e.code === "ENOENT") return {}; throw new Error(`${p}: ${e.message}`); } };
  const settings = read(base);
  settings.enabledPlugins = Object.fromEntries(Object.keys(read(seat).enabledPlugins ?? {}).map((id) => [id, false]));
  fs.writeFileSync(out, JSON.stringify(settings, null, 2) + "\n");
' "$here/settings.json" "$config/settings.json" "$root/settings.json"

session=$(node -e 'console.log(require("crypto").randomUUID())')
cmd=("$bin" --model sonnet --permission-mode dontAsk --session-id "$session" --plugin-dir "$root/plugin" --settings "$root/settings.json" --name forward-compaction-replay)
if [ "${1:-}" = "--dry-run" ]; then
  echo "launch (dry run): cd $root && CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 ${cmd[*]}"
  exit 0
fi
unset CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_PROJECT_DIR
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
cd "$root"
exec "${cmd[@]}"
