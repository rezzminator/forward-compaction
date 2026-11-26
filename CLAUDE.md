# forward-compaction

A Claude Code function-hooks plugin; `docs/spec.md` is the behavioural spec.

## Function

Claude Code's own compaction has a separate call summarize the transcript. Here the working model, main chat or sub-agent, writes its own frontier at a milestone it picks, sending only the changes to the numbered lists the plugin holds on disk, and the plugin installs it with the user's words and standing orders verbatim and the facts it recorded as they happened, so the party continues with no decision, order or open thread lost. Under `FORWARD_COMPACTION_MAIN_FORK` a fork of main itself (`$.model.fork`), never a separate summarizer, writes main's frontier at a `/compact` the user types.

## Spine

`model works -> plugin nudges as its context grows -> from a notice on, model picks its milestone and calls forward_compaction -> frontier stored -> Claude Code's next compaction ask -> plugin installs the frontier -> model wakes`

- The model chooses when to compact, from a notice on: the plugin only nudges, first at a party's nudge-start (absolute), then one per nudge-every; after a wake, a nudge-start above its floor (`roomAbove`, held two nudge-every below the ceiling). A set nudge-room moves the first nudge, after a wake too, that far above the floor (`nudgeStart`). Floor (`floor.json`): a party's first reading ever; after an install, the larger of its first two readings, as only the second request carries what Claude Code sends back (`Held.settling` between them); any reading below a settled floor, which restarts the nudges and the finish notice.
- A `forward_compaction` call always stores, and compacts (`callCompacts`, `Parties.compacts`) only once the party's context has reached a notice point since its last install: main's finish notice point (`finishReached`) or a nudge point, after a wake its room (`roomAbove`) above the wake's floor. Below it a call only updates the held frontier: nothing compacts, and nudges and the finish notice still go out when due. Not judged, so its call compacts: a party with no marks (its window unknown), an ignored model, a party with no reading yet, a sub-agent of a type in `FORWARD_COMPACTION_SUBAGENT_CALL_COMPACTS`; a woken party with no reading since its wake does not compact.
- Each nudge names the context's size and asks for a frontier in the words of its count since the party's last install (`nudgeBody`), each firmer than the one before, the first three timing the call between two steps, the last before the ceiling saying the plugin compacts next; it names no max context and no ceiling, and prints no list: a party holding a frontier is asked for its changes by item number, one holding none for a first frontier.
- Main also compacts when its whole work is finished, before the final report, so the user's reply meets a small context: its first three nudges carry that rule (`FINISH_RULE`), and at or past `FORWARD_COMPACTION_MAIN_FINISH_START` and one nudge-every above its floor (`finishReached`), with no nudge sent, it reads the finish notice once per install (`finishDue`); a sub-agent, whose context ends with its report, is never asked, its first three nudges saying when it may skip (`SKIP_RULES`).
- The plugin holds Claude Code's compaction. `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` exists only so Claude Code asks early, about every request from about 63k; it is never the compaction point.
- Each ask is skipped until a stored call compacts, and that ask installs it, or until its ceiling's mechanical wake: recorded facts and the held frontier as it stands. A call with a field repaired from broken JSON or a frontier lacking `objective` or `next` waits (`callWaits`), as a leaked tool-call tag can end a response: one more automatic ask is skipped, renewed by each further waiting call. Main's turn end (`$.session.compact()`) and a request too long install at once.
- Under `FORWARD_COMPACTION_MAIN_FORK` (`docs/spec.md` § A typed /compact written by a fork) a `/compact` typed in an idle main chat (`forkIdle`) awaits `$.model.fork` (`forkPrompt`, the text typed after `/compact`, `FORWARD_COMPACTION_MAIN_FORK_EFFORT`), stores the reply (`forkReply`) as a `forward_compaction` call with writer `fork`, and installs `forkWake`: facts, frontier, main's messages from its last assistant one on (`forkTrailing`); everywhere else the model writes its own frontier. A failed fork (`ForkFailure`, a TypeError from a missing `$.model.fork` is `no-fork`) gets Claude Code's own summary with the stored frontier dropped, an errors row and a screen line.
- The exceptions to "the model chooses" are only these:
  - the ceiling: the mechanical wake, or Claude Code's own summary under `FORWARD_COMPACTION_CEILING_NATIVE`;
  - a request too long (an ask following a held ask in the same turn that no request completed): the mechanical wake at once, below the ceiling;
  - an ignored model (`FORWARD_COMPACTION_IGNORE_MODELS`, Haiku by default): no nudges, its asks held to its ceiling and then compacted mechanically, never at Claude Code's early ask; its `forward_compaction` call is stored like any other's;
  - an error, which never holds a compaction: the party gets the mechanical wake, and if that fails too, Claude Code's own summary runs; every failure is logged with context;
  - the user's own `/compact`: Claude Code's own summary, and the stored frontier is dropped, said only for a call that compacts; or the fork's frontier, under `FORWARD_COMPACTION_MAIN_FORK`;
  - Claude Code's own fork, a party not ours: its ask passes.
- A party with no reading yet is held until its next reading; one whose window is unknown never reaches its ceiling. A precompute ask is always skipped.
- Parties: the main chat and each sub-agent by its agentId, each with its own state, max context, ceiling and nudge levels, set by `FORWARD_COMPACTION_MAIN_{MAX_CONTEXT|CEILING|NUDGE_ROOM|NUDGE_START|NUDGE_EVERY}` and `FORWARD_COMPACTION_SUBAGENT_{…}`.
- Model switch (`switchStepOf`): main's call `model`, sent only on the user's ask, is set only once `$.model.complete` answered one trial request naming it (`switchTry`); an unanswered trial sets nothing. From main's next request, or after its next compaction for a call that compacts (`switchAfterCompaction`), it renames each main request's model in `turn.step`, Claude Code's model, `/model` and saved default untouched, while Claude Code names main its `from`: another model given (`/model`, a relaunch, Claude Code's fallback), `from` asked back or a first answer by `from` (an alias) ends it. Begin, each end and a refused name each say a screen line (`switchApply`); a sub-agent's `model` changes nothing.
- Each party's files live in `$HOME/.local/state/forward-compaction/{project}/{session id}/` (a sub-agent's under `agents/{agent id}/`), written by the plugin alone and never deleted: `orders.json`, `data/{objective|decisions|done|remaining|next|blocked|findings}.json`, `storage.json`, `storage/{name}.md`, `rounds.json`, `floor.json`, `done-earlier.{md|json}`, main's `model-switch.json` and `history` (every value that leaves), as `docs/spec.md` § State on disk details. An item's `added` is the only date or time a file holds, and nothing the model reads or the transcript draws shows it.
- The install: everything `docs/wake-contract.md` holds, the frontier, the recorded facts (the messages delivered to the party, agents, shells, the files touched, the shell commands run, the task list, plan mode and the plan file), the documents a sub-agent's brief names, the `load_files` (a mechanical wake: the party's newest files, re-read from disk), the storage entries, listed and never read, the newest messages after the call that fit, kept verbatim, and every delivery recorded after the call that those messages lack.
- A sub-agent's party lives across its runs: one waiting on its background children ends a turn and is resumed by each child's notification, so a turn end is never its finish.

## On demand

- Before changing what the wake carries or `plugins/forward-compaction/src/wake.ts`: read `docs/wake-contract.md`
- Before a live check of a real session or an audit of a run: read `docs/live-run.md`

## Layout

- `plugins/forward-compaction/`: everything that installs, and nothing else — the directory scans only this folder, so dev files never go in it.
- `plugins/forward-compaction/hooks/forward-compaction.ts`: the adapter, the only file that touches `$`.
- `plugins/forward-compaction/contract.d.ts`: the session state the host keeps for the plugin (`$.state`, by party: its newest prompts, its loaded skills, its ignore judgement, and the standing orders an earlier build kept there, read once to seed its numbered orders); `plugin.json` names it in `types`.
- `plugins/forward-compaction/src/`: every decision, pure and unit-tested, the per-session files reached only through the `Fs` the adapter hands in (`disk.ts`, `storage.ts`); `tests/` holds one vitest file per concern.
- `types/claude-code.d.ts`: the plugin API (from `/plugin-types`), the truth for every hook's shape; grep it before using an event.
- `plugins/forward-compaction/.claude-plugin/`: `plugin.json` (manifest) and `icon.svg`; the plugin installs as `forward-compaction@professor`.
- `scripts/bench/`: the compaction benchmark, Claude Code's native compaction against the plugin on main chats; `scripts/bench/bench.sh run --arm {native|native-matched|fc} --runs {n} --claude {binary} --out {dir}`, then `bench.sh report {dir}`, which prints the README benchmark's table; paid and live, never in CI.

## Commands

`npm test`, `npm run typecheck` and `npm run validate:plugin` all pass before a commit. `make release-check` runs every check `ci.yml` runs on a `develop → main` pull request, the same make targets (`check`, `release`) under Node 22. A live check loads the checkout with `--plugin-dir plugins/forward-compaction`: the installed copy is disabled in the same `--settings`, whose `env` carries the plugin's options, as the user's own settings `env` wins over a variable on the launch line.

Refresh the installed copy with `claude plugin marketplace update` as written, never under a `CLAUDE_CONFIG_DIR` override pointing at `~/.claude`: `claude` then writes `.claude.json` and `backups/` into the shared store.

## Rules

- forward-compaction NEVER blocks, refuses, delays or holds back any operation of any agent or of the main chat. Every tool call runs. The plugin nudges and compacts mechanically at a party's ceiling; under `FORWARD_COMPACTION_MAIN_FORK` it also writes main's frontier, by a fork awaited inside a compaction ask already under way, so no tool call waits on it; the one wait: main's own call naming a `model` awaits that name's trial request (`SWITCH_TRIAL`), its frontier already stored.
- Every number the plugin decides on or reports comes from Claude Code's plugin API, as far as it reaches: `$.session.usage()` (window, auto-compact threshold), `turn.step` usage (each party's reading), `session.compact`'s `tokensBefore`/`tokensAfter`, `$.agent.list()`, `$.session.messages()`; a sub-agent's window, which that API reports for the main chat's model alone, comes from the Anthropic Models API (`max_input_tokens`), asked through `$.session.authorize()` and `$.http.fetch`.
- No guessed, estimated or invented number: no character-count token estimates, no hard-coded model-window tables; the `[1m]` context marker in the model id a step reports is the API's own literal, not a model-name table.
- Where the API gives nothing, a value a user tunes (a max context, ceiling or nudge level) is a named option with its default; a sub-agent's max context, unset, is its model's window from the first source that knows it (that marker, main's reported window when its model id is the one main last named, the Models API), and while none does, the named fallback `DEFAULT_SUBAGENT_MAX_CONTEXT`, its `window` decision row saying the window is unknown and why; a design budget (the wake's section shares, the skills' character limits, a format cap such as `WHY_MAX_CHARS` or `LOAD_FILE_MAX_LINES`) is a named constant whose one-line comment says why, and is never reported as a measured size.
- A number with no source is unknown and is said as unknown.
- A model switch is only the `turn.step` rewrite, never `$.config.set` or `$.command.run` of `model`: both write the user's saved default model. A request is rewritten only to a name whose trial was answered: Claude Code drops a request naming a model it does not serve, no error to the hook, and gives main another model for the rest of the turn.
- Every step writes a debug row (`debug.jsonl`), so any decision traces back to its inputs; a transcript draw is no step and writes none.
- A new behaviour lands in `plugins/forward-compaction/src/` as a pure function with a test watched failing first; the adapter only wires it.
- Every option is read from a variable `FORWARD_COMPACTION_{OPTION}`, upper snake, and nowhere else: the plugin declares no `userConfig`, and a non-empty options object handed to `register` is named in one warning and not applied. Flags `1|0|true|false`, any case; sizes, dirs and log file the option's grammar; unset, empty or blank is absent; a bad value is logged by its variable and the default applies.
- A new option adds its variable to `OPTION_ENV` (`plugins/forward-compaction/src/options.ts`), a literal `readOptionVar` line to the adapter and its README options-table entry; `tests/register.test.ts` holds the literals to `OPTION_ENV`. A new option variable or `$` path also joins `ENV_NAMES` or `PATHS` in `scripts/replay/recorder.ts` (`$` paths wrapped there too), and an option `OPTIONS_SINCE_RECORDING` in `tests/fakes/replay-engine.ts`.
- A version bump moves `plugins/forward-compaction/.claude-plugin/plugin.json`, `package.json` (and its lockfile), `PLUGIN_VERSION` in `plugins/forward-compaction/src/wake.ts` and the README badge together; installed copies update only on a new version.
- The README tests badge states the count of tests `npm test` passes; `npm run release:check` runs the suite and fails when they differ, so the badge is set last, after the final test is added.
- Defaults live in two places only, and agree: `plugins/forward-compaction/src/options.ts` (`DEFAULT_*`, `MARKED_SUBAGENT_MAX_CONTEXT`) and the README options table; this file names an option, never its default number.
- The README benchmark reports measured runs only; a figure the code has changed since is labelled not re-measured.
- Public repo: no machine-absolute paths, personal data or private project names in a tracked file.
- `$` is passed only to functions declared at the top level of the hooks file and always spelled `$.noun.event(...)`: Claude Code checks this statically and otherwise loads the module with zero hooks. `npm run validate:plugin` catches it.

## Branches and releases

- `develop` is the default branch: every change lands there, by a commit or a pull request, and no CI runs on a push. `.github/workflows/ci.yml` runs on the `develop → main` pull request only, and `.github/workflows/publish.yml` on its merge. `develop` is protected by the ruleset `develop keeps its history`: never force-push or delete it.
- `main` is release-only (ruleset `main is release-only`). It moves only by merging the `develop → main` pull request, with a merge commit and never a squash, so both branches share one history, and only after its `ci` check passes: never a direct push, never an admin override. Professor's marketplace installs the plugin from `main` (`git-subdir`, `ref: main`), so users only ever get a released version.
- Before cutting a release: read `docs/release.md`
- Semantic versioning: a fix is a patch; a new option or behaviour is a minor; a renamed or removed option is a major, and its CHANGELOG entry says how to migrate.
- Publishing: code is pushed, and a release is cut, only when the owner asks.
- Git writes go through this repo's gitter, `.claude/agents/gitter.md`.
