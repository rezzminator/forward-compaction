# sub-agent-compact

A Claude Code function-hooks plugin: per-party compaction policy, nudges, and
self-compaction at a milestone the model picks. `README.md` is the
behavioural spec.

## Layout

- `plugins/sub-agent-compact/`: everything that installs, and nothing else — the directory scans only this folder, so dev files never go in it.
- `plugins/sub-agent-compact/hooks/sub-agent-compact.ts`: the adapter, the only file that touches `$`.
- `plugins/sub-agent-compact/src/`: every decision, pure and unit-tested; `tests/` holds one vitest file per concern.
- `types/claude-code.d.ts`: the plugin API (from `/plugin-types`), the truth for every hook's shape; grep it before using an event.
- `plugins/sub-agent-compact/.claude-plugin/`: `plugin.json` (manifest, no `userConfig`) and `icon.svg`; the root `.claude-plugin/marketplace.json` makes the repo its own marketplace, with `source: ./plugins/sub-agent-compact`.

## Commands

`npm test`, `npm run typecheck` and `npm run validate:plugin` all pass before a commit. A live check loads the checkout with `--plugin-dir plugins/sub-agent-compact`: the installed copy is disabled in the same `--settings`. `npm run probe:installed`, with `SUB_AGENT_COMPACT_PROBE_DIR` naming an installed copy, checks it registers `forward_handoff` from its variable alone.

Refresh the installed copy with `claude plugin marketplace update` as written, never under a `CLAUDE_CONFIG_DIR` override pointing at `~/.claude`: `claude` then writes `.claude.json` and `backups/` into the shared store, and `pfm`'s store-guard hook denies it.

## Rules

- A new behaviour lands in `plugins/sub-agent-compact/src/` as a pure function with a test watched failing first; the adapter only wires it.
- An error never holds a compaction: log it with context, let the compaction pass.
- A bad option is logged by its variable and falls back to its default.
- Every option is read from a variable `SUB_AGENT_COMPACT_{OPTION}`, upper snake, and nowhere else: the plugin declares no `userConfig`, and a non-empty options object handed to `register` is named in one warning and not applied. Flags `1|0|true|false`, any case; sizes, dirs and log file the option's grammar; unset, empty or blank is absent; a bad value is named by its variable and the default applies.
- A new option adds its variable to `OPTION_ENV` (`plugins/sub-agent-compact/src/limits.ts`), a literal `readOptionVar` line to the adapter and its README options-table entry; `tests/register.test.ts` holds the literals and the table to `OPTION_ENV`.
- A version bump moves `plugins/sub-agent-compact/.claude-plugin/plugin.json`, `marketplace.json`, `package.json` (and its lockfile) and the README badge together; installed copies update only on a new version.
- The README tests badge states the count of tests `npm test` passes; `npm run release:check` runs the suite and fails when they differ, so the badge is set last, after the final test is added.
- Defaults agree in two places: `plugins/sub-agent-compact/src/limits.ts` (`DEFAULT_MAIN`, `DEFAULT_SUBAGENT`) and the README options table; `tests/register.test.ts` holds them equal.
- The README benchmark reports measured runs only; a figure the code has changed since is labelled not re-measured.
- Public repo: no machine-absolute paths, personal data or private project names in a tracked file.
- `$` is passed only to functions declared at the top level of the hooks file and always spelled `$.noun.event(...)`: Claude Code checks this statically and otherwise loads the module with zero hooks. `npm run validate:plugin` catches it.

## Branches and releases

- `develop` is the default branch: every change lands there, by a commit or a pull request, and CI (`.github/workflows/ci.yml`) runs the three gates on it.
- `main` is release-only. It moves only by merging the `develop → main` pull request, with a merge commit and never a squash, so both branches share one history. The marketplace installs the plugin from `main` (`git-subdir`, `ref: main`), so users only ever get a released version.
- A release, in order:
  1. On `develop`: bump the version in all four places, and move `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] — date`. `npm run release:check` passes.
  2. Open the `develop → main` pull request. Its `release` check requires the version to have moved past `main`'s.
  3. Merge once CI is green.
  4. On `main`: `claude plugin tag --push plugins/sub-agent-compact` creates and pushes `sub-agent-compact--vX.Y.Z`. `release.yml` then publishes the GitHub release from the CHANGELOG section.
- Semantic versioning: a fix is a patch; a new option or behaviour is a minor; a renamed or removed option is a major, and its CHANGELOG entry says how to migrate.
- Publishing: README and marketing changes on `develop` are pushed as soon as they are committed. Code is pushed, and a release is cut, only when the owner asks.
- Git writes go through this repo's gitter, `.claude/agents/gitter.md`.
