#!/usr/bin/env bash
# Builds the recording plugin: the real forward-compaction plugin (same name, so tool names match production)
# with scripts/replay/recorder.ts as its only hooks module, plus the replay-rules skill.
# Usage: assemble.sh [record-root]   (default ${FC_RECORD_ROOT:-${TMPDIR:-/tmp}/forward-compaction/record})
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
root=${1:-${FC_RECORD_ROOT:-${TMPDIR:-/tmp}/forward-compaction/record}}
src="$repo/plugins/forward-compaction"
out="$root/plugin"
[ -f "$src/hooks/forward-compaction.ts" ] || { echo "assemble: $src/hooks/forward-compaction.ts missing" >&2; exit 1; }
rm -rf "$out"
mkdir -p "$out/.claude-plugin" "$out/hooks" "$out/skills"
cp "$src/.claude-plugin/plugin.json" "$src/.claude-plugin/icon.svg" "$out/.claude-plugin/"
cp -R "$src/src" "$out/src"
cp "$src/hooks/forward-compaction.ts" "$out/hooks/forward-compaction.ts"
sed "s#'../../plugins/forward-compaction/hooks/forward-compaction.ts'#'./forward-compaction.ts'#" "$here/recorder.ts" > "$out/hooks/recorder.ts"
grep -q "from './forward-compaction.ts'" "$out/hooks/recorder.ts" || { echo "assemble: recorder import was not rewritten" >&2; exit 1; }
printf '{ "modules": ["./recorder.ts"] }\n' > "$out/hooks/hooks.json"
cp -R "$here/skills/replay-rules" "$out/skills/replay-rules"
mkdir -p "$root/rows"
echo "$out"
