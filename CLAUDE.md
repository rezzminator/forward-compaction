# forward-compaction

A Claude Code function-hooks plugin: the model writes its own handoff through
one tool, and the plugin installs it at Claude Code's compaction. `README.md`
is the behavioural spec.

## Spine

`model works -> plugin nudges as its context grows -> model picks its milestone and calls forward_compaction -> handoff stored -> Claude Code's next compaction ask -> plugin installs the handoff -> model wakes`

- The model always chooses when to hand off: the plugin only nudges, as a party's context crosses its nudge levels, and a nudge says to pick the milestone, not whether.
- The plugin holds Claude Code's compaction. `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` exists only so Claude Code asks early, about every request from about 63k; it is never the compaction point.
- Each ask is skipped until a handoff is stored, and that ask installs it; or until the party reaches its ceiling, and it gets the mechanical wake: recorded facts, no frontier from the model. Main also installs a stored handoff at its own turn end, through `$.session.compact()`.
- The exceptions to "the model chooses" are only these:
  - the ceiling: the mechanical wake, or Claude Code's own summary under `FORWARD_COMPACTION_CEILING_NATIVE`;
  - a request too long (an ask following a held ask in the same turn that no request completed): the mechanical wake at once, below the ceiling;
  - an ignored model (`FORWARD_COMPACTION_IGNORE_MODELS`, Haiku by default): no nudges, its `forward_compaction` call refused, its asks held to its ceiling and then compacted mechanically, never at Claude Code's early ask;
  - an error, which never holds a compaction: the party gets the mechanical wake, and if that fails too, Claude Code's own summary runs; every failure is logged with context;
  - the person's own `/compact`: Claude Code's own summary, and the stored handoff is dropped;
  - Claude Code's own fork, a party not ours: its ask passes.
- A party with no reading yet is held until its next reading; one whose window is unknown never reaches its ceiling. A precompute ask is always skipped.
- Parties: the main chat and each sub-agent by its agentId, each with its own state, max context, ceiling and nudge levels, set by `FORWARD_COMPACTION_MAIN_{MAX_CONTEXT|CEILING|NUDGE_START|NUDGE_EVERY}` and `FORWARD_COMPACTION_SUBAGENT_{…}`.
- The install: the handoff, the recorded facts (the person's messages or the brief and the coordinator's, skills, agents, shells, the files touched, the task list), the `load_files`, and every message after the call kept verbatim.

## Layout

- `plugins/forward-compaction/`: everything that installs, and nothing else — the directory scans only this folder, so dev files never go in it.
- `plugins/forward-compaction/hooks/forward-compaction.ts`: the adapter, the only file that touches `$`.
- `plugins/forward-compaction/contract.d.ts`: the session state the host keeps for the plugin (`$.state`, each party's newest prompts and its skills); `plugin.json` names it in `types`.
- `plugins/forward-compaction/src/`: every decision, pure and unit-tested; `tests/` holds one vitest file per concern.
- `types/claude-code.d.ts`: the plugin API (from `/plugin-types`), the truth for every hook's shape; grep it before using an event.
- `plugins/forward-compaction/.claude-plugin/`: `plugin.json` (manifest, no `userConfig`) and `icon.svg`; the root `.claude-plugin/marketplace.json` makes the repo its own marketplace, with a `git-subdir` source at `plugins/forward-compaction`.

## Commands

`npm test`, `npm run typecheck` and `npm run validate:plugin` all pass before a commit. `make release-check` runs every check the release workflow runs on a `develop → main` pull request, the same make targets (`check`, `release`) under Node 22. A live check loads the checkout with `--plugin-dir plugins/forward-compaction`: the installed copy is disabled in the same `--settings`.

Refresh the installed copy with `claude plugin marketplace update` as written, never under a `CLAUDE_CONFIG_DIR` override pointing at `~/.claude`: `claude` then writes `.claude.json` and `backups/` into the shared store, and `pfm`'s store-guard hook denies it.

## Rules

- Every number the plugin decides on or reports comes from Claude Code's plugin API, as far as it reaches: `$.session.usage()` (window, auto-compact threshold), `turn.step` usage (each party's reading), `session.compact`'s `tokensBefore`/`tokensAfter`, `$.agent.list()`, `$.session.messages()`.
- No guessed, estimated or invented number: no character-count token estimates, no hard-coded model-window tables.
- Where the API gives nothing, a value a user tunes (a max context, ceiling or nudge level) is a named option with its default; a design budget (the wake's section shares, the `load_files` share, a format cap such as `HANDOFF_MAX_CHARS`) is a named constant whose one-line comment says why, and is never reported as a measured size.
- A number with no source is unknown and is said as unknown.
- Every step writes a debug row (`debug.jsonl`), so any decision traces back to its inputs.
- A new behaviour lands in `plugins/forward-compaction/src/` as a pure function with a test watched failing first; the adapter only wires it.
- A bad option is logged by its variable and falls back to its default.
- Every option is read from a variable `FORWARD_COMPACTION_{OPTION}`, upper snake, and nowhere else: the plugin declares no `userConfig`, and a non-empty options object handed to `register` is named in one warning and not applied. Flags `1|0|true|false`, any case; sizes, dirs and log file the option's grammar; unset, empty or blank is absent; a bad value is named by its variable and the default applies.
- A new option adds its variable to `OPTION_ENV` (`plugins/forward-compaction/src/options.ts`), a literal `readOptionVar` line to the adapter and its README options-table entry; `tests/register.test.ts` holds the literals to `OPTION_ENV`.
- A version bump moves `plugins/forward-compaction/.claude-plugin/plugin.json`, `marketplace.json`, `package.json` (and its lockfile) and the README badge together; installed copies update only on a new version.
- The README tests badge states the count of tests `npm test` passes; `npm run release:check` runs the suite and fails when they differ, so the badge is set last, after the final test is added.
- Defaults live in two places only, and agree: `plugins/forward-compaction/src/options.ts` (`DEFAULT_*`) and the README options table; this file names an option, never its default number.
- The README benchmark reports measured runs only; a figure the code has changed since is labelled not re-measured.
- Public repo: no machine-absolute paths, personal data or private project names in a tracked file.
- `$` is passed only to functions declared at the top level of the hooks file and always spelled `$.noun.event(...)`: Claude Code checks this statically and otherwise loads the module with zero hooks. `npm run validate:plugin` catches it.

## Branches and releases

- `develop` is the default branch: every change lands there, by a commit or a pull request, and no CI runs on a push. `.github/workflows/release.yml` runs on the `develop → main` pull request only. `develop` is protected by the ruleset `develop keeps its history`: never force-push or delete it.
- `main` is release-only (ruleset `main is release-only`). It moves only by merging the `develop → main` pull request, with a merge commit and never a squash, so both branches share one history, and only after `check` and `release` pass: never a direct push, never an admin override. The marketplace installs the plugin from `main` (`git-subdir`, `ref: main`), so users only ever get a released version.
- A release, in order:
  1. On `develop`: bump the version in all four places, and move `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] — date`. Every merge into `main` publishes, so a pre-release suffix (`-dev.N`, `-alpha`) becomes the real release version here.
  2. `make release-check` passes, after `git fetch origin main`.
  3. Open the `develop → main` pull request. Its `check` and `release` checks run the same make targets; `release` requires the version to have moved past `main`'s and the CHANGELOG section to yield notes.
  4. Merge once both are green. The merge is the release: `release.yml`'s `publish` job tags the merge commit `forward-compaction--vX.Y.Z` and publishes the GitHub release from the CHANGELOG section. No tag is pushed by hand.
- Semantic versioning: a fix is a patch; a new option or behaviour is a minor; a renamed or removed option is a major, and its CHANGELOG entry says how to migrate.
- Publishing: README and marketing changes on `develop` are pushed as soon as they are committed. Code is pushed, and a release is cut, only when the owner asks.
- Git writes go through this repo's gitter, `.claude/agents/gitter.md`.
