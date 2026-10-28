#!/usr/bin/env bash
# Release integrity: the version agrees in every place that carries it,
# CHANGELOG.md has a dated section for it, and the README tests badge states
# the count of tests the run passes (the run is made here, so it needs
# node_modules). With a base version argument (the version on main), the
# version must also have moved past it.
# Prints one line per failure and exits 1; exits 2 when a file cannot be read.
set -uo pipefail
cd "$(dirname "$0")/.."
read_json() { node -e 'const [f, e] = process.argv.slice(1); const j = JSON.parse(require("fs").readFileSync(f, "utf8")); process.stdout.write(String(e.split(".").reduce((o, k) => o?.[k], j) ?? ""))' "$1" "$2" || { echo "ERROR cannot read $1"; exit 2; }; }
v=$(read_json plugins/forward-compaction/.claude-plugin/plugin.json version)
[ -n "$v" ] || { echo "ERROR plugin.json has no version"; exit 2; }
fail=0
p=$(read_json package.json version)
b=$(grep -oE 'badge/version-[0-9A-Za-z.-]+-blue' README.md | sed -E 's/badge\/version-|-blue$//g; s/--/-/g')
[ "$p" = "$v" ] || { echo "FAIL package.json says $p, plugin.json $v"; fail=1; }
[ "$b" = "$v" ] || { echo "FAIL README badge says ${b:-nothing}, plugin.json $v"; fail=1; }
grep -qE "^## \[$v\] — [0-9]{4}-[0-9]{2}-[0-9]{2}$" CHANGELOG.md || { echo "FAIL CHANGELOG.md has no dated section for $v"; fail=1; }
tb=$(grep -oE 'badge/tests-[0-9]+%20passing' README.md | sed -E 's/badge\/tests-|%20passing//g' | head -1)
[ -x node_modules/.bin/vitest ] || { echo "ERROR cannot read the test count: run npm ci"; exit 2; }
errors=$(mktemp) || { echo "ERROR mktemp failed"; exit 2; }
trap 'rm -f "$errors"' EXIT
report=$(node_modules/.bin/vitest run --dir tests --reporter=json 2>"$errors"); ran=$?
counts=$(printf '%s' "$report" | node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(`${j.numPassedTests} ${j.numFailedTests} ${j.numFailedTestSuites}`)' 2>/dev/null) ||
  { echo "ERROR cannot read the test count: vitest gave no JSON report (exit $ran): $(grep -m 1 -E '^[A-Za-z]*Error: ' "$errors" || tail -n 1 "$errors")"; exit 2; }
read -r passed failed broken <<<"$counts"
if [ -z "$tb" ]; then echo "FAIL README has no tests badge (tests-N%20passing)"; fail=1
elif [ "$broken" != 0 ] && [ "$failed" = 0 ]; then echo "FAIL the run has $broken test file$([ "$broken" = 1 ] || echo s) that failed to run, so the README tests badge cannot be checked"; fail=1
elif [ "$failed" != 0 ]; then echo "FAIL the run has $failed failing test$([ "$failed" = 1 ] || echo s), so the README tests badge cannot be checked"; fail=1
elif [ "$tb" != "$passed" ]; then echo "FAIL README tests badge says $tb, the run passes $passed"; fail=1
fi
if [ -n "${1:-}" ]; then
  newest=$(printf '%s\n%s\n' "$1" "$v" | sort -V | tail -1)
  { [ "$v" != "$1" ] && [ "$newest" = "$v" ]; } || { echo "FAIL version $v has not moved past main's $1"; fail=1; }
fi
[ $fail -eq 0 ] && echo "PASS release $v: versions agree, CHANGELOG dated, README badge counts $passed passing tests${1:+, past $1}"
exit $fail
