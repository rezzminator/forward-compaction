# Changelog

Every release of forward-compaction, named sub-agent-compact before 1.0.0. Versions follow [semantic versioning](https://semver.org); each release is the `main` commit tagged `forward-compaction--v<version>` (`sub-agent-compact--v<version>` before 1.0.0), with a GitHub release carrying the section below.

## [1.0.0] — 2026-10-27

A breaking major: sub-agent-compact is rewritten and renamed forward-compaction, in the same repository, `github.com/rezzminator/sub-agent-compact`. The model writes its own handoff through one tool, `forward_compaction`; the plugin installs it at Claude Code's compaction with facts recorded from typed hook events, and every message after the call is kept verbatim. No summarizer request runs. The 1.0.0-dev sections below record how it got here; this section is what a 0.8.0 user needs.

### Changed

- **Renamed.** Plugin and marketplace `sub-agent-compact` → `forward-compaction`; install id `sub-agent-compact@sub-agent-compact` → `forward-compaction@forward-compaction`; tool server `sub-agent-compact` → `forward-compaction`; release tags `sub-agent-compact--v*` → `forward-compaction--v*`. The repository and its URL are unchanged.
- **One handoff tool.** `forward_handoff` → `forward_compaction({objective, done, remaining, next, blocked?, findings?, drop_skills?, load_files?})`: the text of each section as its own argument, `load_files` as `{path, lines?, why}`, at most 8 files. `drop_skills` drops a skill or command only when two handoffs in a row name it; a skill or command whose frontmatter sets `forward-compaction-keep: true`, or named in `FORWARD_COMPACTION_KEEP_SKILLS`, is never dropped. The `compact` and `handoff` tools are gone. `look_back` keeps its arguments under the new server.
- **Sizes are per party, against each party's max context.** Main is nudged from 15% of its window every 5% and gets a mechanical wake at 60% with no handoff stored; a sub-agent (max context 200k) from 40% every 10%, mechanically at 80%.
- **Models on the ignore list (`haiku` by default) take no handoff** and are held to their ceiling, where they get the mechanical wake.

### Fixed

- **A log lock no longer wedges when the writer breaking it dies.** A writer that took a stale lock's token to break it and was killed before finishing left the lock with no token, which no later writer would break: every row to that log directory was dropped with `lock held by another writer` until the lock was removed by hand. A waiter now puts back a claim whose writer is gone or that has been held past a minute, and the lock is broken as any stale one. A claim's age is its own, carried in its name, never the age of the token it took, so a live claimer's claim is never put back.
- **A `forward_compaction` call from behind another plugin's hook is no longer refused.** `requestMeta` and `consent`, which the `tool.call` event may carry beside the arguments, were read as unknown fields.
- **`look_back` says so when entries went unread.** A search with entries it could not read now states how many and that they were not searched, so a miss never reads as nothing there.
- **A denied or failed read of a party's window is not repeated on every step.** The read for the ratio base backs off, the gap doubling with each miss.

### Migrating from 0.8.0

1. Uninstall the old plugin and its marketplace: `claude plugin uninstall sub-agent-compact@sub-agent-compact`, then `claude plugin marketplace remove sub-agent-compact`.
2. Add the marketplace again and install: `claude plugin marketplace add https://github.com/rezzminator/sub-agent-compact.git`, then `claude plugin install forward-compaction@forward-compaction`.
3. Rename or delete each variable by the table below. An old variable is no longer read and no warning names it.
4. Delete the settings keys `autoCompact.pinSkills` and `autoCompact.dropSkills` and every `autoCompact` key in agent frontmatter: none is read.
5. Replace `mcp__sub-agent-compact__forward_handoff` and `mcp__sub-agent-compact__look_back` in prompts, agents and rules with `mcp__forward-compaction__forward_compaction` and `mcp__forward-compaction__look_back`.
6. Delete `~/.local/state/sub-agent-compact/` yourself; forward-compaction never reads it.

| 0.8.0 variable | 1.0.0 variable | How to migrate |
| --- | --- | --- |
| `SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT` | `FORWARD_COMPACTION_MAIN_CEILING` | A token count or a percentage of main's max context; default `60%`. Applies only when no handoff is stored. |
| `SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT` | `FORWARD_COMPACTION_SUBAGENT_CEILING` | As above, of the sub-agent max context; default `80%`. |
| `SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_NUDGE_START` | `FORWARD_COMPACTION_MAIN_NUDGE_START` | Default `15%`. |
| `SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_NUDGE_START` | `FORWARD_COMPACTION_SUBAGENT_NUDGE_START` | Default `40%`. |
| `SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_NUDGE_EVERY` | `FORWARD_COMPACTION_MAIN_NUDGE_EVERY` | Default `5%`. |
| `SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_NUDGE_EVERY` | `FORWARD_COMPACTION_SUBAGENT_NUDGE_EVERY` | Default `10%`. |
| `SUB_AGENT_COMPACT_LOG_FILE` | `FORWARD_COMPACTION_LOG_FILE` | Still an absolute path; each session writes its own file beside it. |
| `SUB_AGENT_COMPACT_PIN_SKILLS` | `FORWARD_COMPACTION_KEEP_SKILLS` | Names never dropped from a wake. |
| `SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_ENABLED`, `SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_ENABLED` | removed | To leave a model to Claude Code, list it in `FORWARD_COMPACTION_IGNORE_MODELS`; to leave every party, disable the plugin. |
| `SUB_AGENT_COMPACT_SUBAGENT_KEEP_BRIEF` | removed | A sub-agent's brief is always carried. |
| `SUB_AGENT_COMPACT_FORWARD_HANDOFF_TOOL`, `SUB_AGENT_COMPACT_HANDOFF_TOOL`, `SUB_AGENT_COMPACT_COMPACT_TOOL` | removed | `forward_compaction` is always registered; the other tools are gone. |
| `SUB_AGENT_COMPACT_AGENT_DIRS`, `SUB_AGENT_COMPACT_DROP_SKILLS`, `SUB_AGENT_COMPACT_PROBE_DIR` | removed | No agent definition is read; a party drops skills through `drop_skills`. |
| — | `FORWARD_COMPACTION_MAIN_MAX_CONTEXT`, `FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT` | New: the token counts percentages are taken of; main defaults to the window Claude Code reports, a sub-agent to `200k`. |
| — | `FORWARD_COMPACTION_CEILING_NATIVE` | New: `1` lets Claude Code's own summary run at the ceiling instead of the mechanical wake. |
| — | `FORWARD_COMPACTION_IGNORE_MODELS` | New: model-id substrings left to Claude Code's compaction; default `haiku`, empty ignores none. |
| — | `FORWARD_COMPACTION_DEBUG` | New: `0` turns off `debug.jsonl`; default `1`. |

## [1.0.0-dev.9] — 2026-10-26

### Added

- **A party drops a skill or command it no longer needs.** Every wake carried every skill and command the party had loaded, whole, however long ago it stopped mattering. `forward_compaction` takes `drop_skills`, a list of names: a name the party's previous handoff named too is left out of this wake and every later one, until the party loads it again. One handoff naming it is not enough, so a passing guess drops nothing. A skill or command whose frontmatter sets `forward-compaction-keep: true` is never dropped, and its wake block says so. The receipt answers each name.
- **`FORWARD_COMPACTION_KEEP_SKILLS` pins skills and commands by name.** A comma-separated list of names that are never dropped, as a file's `forward-compaction-keep: true` pins it: for a skill or command whose file you do not own. Unset, none is pinned by name.

## [1.0.0-dev.8] — 2026-10-25

### Fixed

- **A sub-agent keeps its state across its runs.** A sub-agent that waits on its background children ends a turn, and each child's notification resumes it. The plugin took every turn end as the agent's finish and forgot it: in live use an `rr-pro` agent ran 31 times, lost its reading, nudge level and gate each time, was never gated, and finished at 156k, 4k under its ceiling. An agent whose every run was one request would never have been compacted. Its reading, nudges, gate and stored handoff now stay until it ends.

### Added

- **Nothing delivered between a handoff and its install is lost.** A party that calls `forward_compaction` keeps working until Claude Code's next compaction ask installs it. A notification (an agent or command finishing), the person's message or a coordinator's message delivered in that gap could miss the messages Claude Code compacts, and the model woke without it. Every such delivery the kept messages lack now opens the wake, verbatim, under "Arrived after you wrote your handoff: you have not read these yet". A sub-agent's resuming message is now recorded too, and the sub-agent's section of delivered messages is renamed "Messages delivered to you".

## [1.0.0-dev.7] — 2026-10-24

### Fixed

- **The gate never deadlocks a sub-agent that cannot hand off.** In live use an agent whose definition lists its tools without `forward_compaction` was gated at 101k and refused 8 calls in a row: it had no way to hand off and returned with nothing done. The gate now refuses only the calls of the request that reached it; when the agent's next request makes any other call, that call runs and the gate stays open until its next install, with nudges and the mechanical wake at its ceiling as before. The refusal says so: if the tool is not in its list, repeat the call. A `gate-opened` row logs it once.

## [1.0.0-dev.6] — 2026-10-24

### Changed

- **The wake says the next handoff is free.** In a live run a sub-agent handed off by itself, woke at 39k, measured the files it had left and read 4 of the 49, cutting the task short with nothing pressing it. Every wake, handed off or mechanical, now carries the same line the nudges do: a handoff costs nothing, the model continues from it as many times as the work needs, and carries the task through to its end.

## [1.0.0-dev.5] — 2026-10-24

### Changed

- **A handoff is said to cost nothing.** In a live run a sub-agent handed off, woke, and at its next nudge quit at 17 of 94 files because "a second handoff would have been necessary". Every nudge and every gate refusal now says a handoff costs nothing, the model continues from it as many times as the work needs, and never cuts its task short to avoid one; the gate is named as a wait.
- **Every skill and command the party invoked is carried whole.** Skills had 25% of the wake budget, so a large one was named and left out; they now have the whole budget, fitted before the verbatim tail. Only a skill larger than the whole budget is named, with the call that loads it again.

## [1.0.0-dev.4] — 2026-10-24

### Changed

- **A sub-agent hands off before it runs past its milestones.** A live run showed a sub-agent reading whole files at 30–47k a request: nudged at 92k, 139k and 169k within 13 seconds, it never called `forward_compaction` and got the mechanical wake at the 160k ceiling, 47 messages dropped. Now, one nudge level past a sub-agent's first nudge since its last install (100k with the defaults), every call but `forward_compaction`, `look_back` and `ToolSearch` is refused unrun, with a line to hand off now and repeat the call; the first nudge names that point. The main chat is never gated.

## [1.0.0-dev.3] — 2026-10-24

### Added

- **Files touched.** The wake lists the files the party's finished calls read, edited or wrote, newest first, at most 15 paths, each with its strongest touch (R, E, W), as Claude Code's own compaction restores the recent files.
- **Tasks.** The wake carries the task list as last set (`TodoWrite`, or `TaskCreate`/`TaskUpdate`), whole within 5% of the wake budget or named as not carried.

### Changed

- **A handoff's landed line is logged, not printed.** `… handoff landed — 160k → 41k context, measured; …` is an info row in the level log (`info.jsonl`) and a `landed` row in the decision log; the screen no longer shows it. A mechanical wake's line is still printed, since that party lost its frontier.
- **The wake ends with the experimental line.** A handoff's wake and a mechanical wake both close with the line that says the plugin is experimental and where to note any trouble (`issues.md` in the level-log directory); the receipt it carries no longer holds a second copy.
- **Each party's newest ten prompts and its skills survive a plugin reload.** The main chat's wake carries at most the person's newest ten messages, a sub-agent's its brief and its coordinator's newest ten; these and the latest text of every skill the party loaded are kept in Claude Code's session state (`$.state` keys `prompts` and `skills`, declared in the shipped `contract.d.ts`) and put back once per process before the party's first write or wake, so a `/reload-plugins` no longer drops what came before it.

### Fixed

- **An ask after an idle gap is no longer read as a request too long.** A held ask followed by the next one with no completed request counted as too long even across turns, so a chat held overnight was compacted mechanically when its next prompt arrived (309k, no API error). Each new turn now clears that inference; inside a turn it stands as before.

## [1.0.0-dev.2] — 2026-10-24

### Changed

- **Breaking: `handoff` is split into one argument per section.** `forward_compaction({handoff, load_files?})` → `forward_compaction({objective, done, remaining, next, blocked?, findings?, load_files?})`. To migrate, pass the text under each heading as its own argument and drop the `## ` headings: `## Objective` → `objective`, `## Done` → `done`, `## Remaining` → `remaining`, `## Next` → `next`, `## Blocked` → `blocked`, `## Findings` → `findings`. A call that still sends `handoff` is refused as an unknown field. Each argument is checked on its own: a required one missing, not a string or blank, and an optional one given but not a string, are named in one refusal, one line each, and nothing is stored. The plugin assembles the handoff (`## Objective`, `## Done`, `## Remaining`, `## Next`, then `## Blocked` and `## Findings` when given), so the wake carries the same markdown as before; the 20,000-character cap applies to the assembled total, and its refusal states the total. The heading checker is gone.
- **The model picks the moment of its handoff, not whether.** The nudge has one wording: the context size in tokens and as a share of the model's window, that every call re-sends all of it, and `Hand off at your next clean milestone: once the step in hand is finished and its results are written down, and before you start the next step, call … with objective, done, remaining and next. You pick the milestone, not whether: skip it only if nothing is left but writing your result and your final answer.` The milestone is a finished step whose results are written: the earlier "before your next read or write" let a foreman hand off straight after twelve reads it had not yet written down, and their detail was lost to the frontier summary. It no longer turns to "Call … now" at Claude Code's ask point or after a held ask, and a held ask no longer adds a nudge of its own. `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` stays: it lets a handoff install whenever the model writes one, not force one at about 63k.
- **Breaking: every size is set per party, against the party's max context.** `FORWARD_COMPACTION_CEILING`, `FORWARD_COMPACTION_NUDGE_START` and `FORWARD_COMPACTION_NUDGE_EVERY` are gone and no longer read. To migrate, set each value under both new names: `FORWARD_COMPACTION_CEILING` → `FORWARD_COMPACTION_MAIN_CEILING` (default `60%`) and `FORWARD_COMPACTION_SUBAGENT_CEILING` (default `80%`); `FORWARD_COMPACTION_NUDGE_START` → `FORWARD_COMPACTION_MAIN_NUDGE_START` (`15%`) and `FORWARD_COMPACTION_SUBAGENT_NUDGE_START` (`40%`); `FORWARD_COMPACTION_NUDGE_EVERY` → `FORWARD_COMPACTION_MAIN_NUDGE_EVERY` (`5%`) and `FORWARD_COMPACTION_SUBAGENT_NUDGE_EVERY` (`10%`). A percentage is of the party's max context: `FORWARD_COMPACTION_MAIN_MAX_CONTEXT` (default: the window `$.session.usage()` reports) and `FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT` (default `200k`, every sub-agent, Haiku included, since Claude Code's API reports no sub-agent's window). With the defaults a sub-agent is nudged at 80k, 100k, 120k and 140k and compacted mechanically at 160k; the main chat from 15% of its window every 5% (150k and every 50k on 1M), mechanically at 60%. A max context is a token count; a percentage is refused by its variable. `FORWARD_COMPACTION_CEILING_NATIVE` is unchanged and applies to every party.
- **No re-nudge right after an install.** A sub-agent's floor (system prompt, tools, skills) is 55-60k, so its first reading after an install already sat past several nudge levels and drew a nudge at once; an agent could hand off eleven times in ten minutes. The first reading's level after an install is now absorbed silently, and the next nudge goes only when the context crosses the level above it.
- **The level log carries every operational event.** `info.jsonl` held only the lines said; every decision event that is not an error or a warning now lands there at level `info` (nudge, stored, refused, each compaction decision, skill, tool-registered, look-back), a held-ask streak folded into its first row and one `skips` row. The decision log, the screen policy and the row bound are unchanged.
- **The landed line is measured, and waits for its measurement.** It goes out at the party's first reading after the install, not at the install: `forward-compaction: {label} handoff landed — {before} → {after} context, measured; frontier {chars} characters, {facts} facts, {kept} messages kept verbatim.`, `before` the last reading before the install and `after` the first reading after it. The mechanical line takes the same form: `{label} had no handoff at {tokens} (ceiling {ceiling}) — mechanical wake installed, {before} → {after} context, measured.` A party that ends (its turn end, `SubagentStop`, the session end) before a reading arrives gets its line then, with `after` said as `unknown` and why, never guessed. The install's `compact` row is written at the install as before; a new `landed` row (`party`, `kind` `handoff` or `mechanical`, `before`, `after`, `null` for one never measured) records both readings. The character estimate behind the old figures ran about 40% low on Go source (a live `75k → 5k` was a 180k context).
- **Models on an ignore list take no handoff and are held to their ceiling.** `FORWARD_COMPACTION_IGNORE_MODELS` (new, default `haiku`) lists case-insensitive substrings of the model id a step reports; set empty, it ignores none. A party whose model matches gets no nudge; its `forward_compaction` call is refused with nothing stored (`forward_compaction refused, nothing stored: your model is on forward-compaction's ignore list ("haiku"), so it takes no handoff from you; carry on with your work, and at 160k the plugin compacts you mechanically.`); and every automatic ask is held (why `ignored-model`) until its ceiling, where it gets the mechanical wake, never Claude Code's compaction at its early ask: a Haiku sub-agent asked at 64k is held to 160k. An `ignore` row (`party`, `label`, `model`, `judged` `managed`, `ignored` or `unknown`, `matched` the entry or `null`) records each judgement when first made and each time it changes.
- **Claude Code's ask point comes from its API.** The plugin reads `$.session.usage({ breakdown: 'summary' })` at session start, at main's first request when not read yet, and after `/model`: main's `context.window` and the breakdown's `autoCompactThreshold`, held at or below each party's max context. When auto-compaction is off or no breakdown is reported, a warning row names which, and the ask point is taken as `rawMaxTokens`, else the window. The fixed 37k buffer, the model-window table and the read of `CLAUDE_CODE_AUTO_COMPACT_WINDOW` are gone; the start warning about a compaction window past 100k names the `rawMaxTokens`, source and ask point Claude Code reports, and a ceiling below the ask point is named for the main chat and for sub-agents.
- **Main's window unknown means no nudge and no ceiling for main.** Until `FORWARD_COMPACTION_MAIN_MAX_CONTEXT` is set or Claude Code reports main's window, main gets no nudge and no ceiling; the 200k stand-in is gone. A sub-agent never waits: its max context is its option.
- **A debug log at every step.** `debug.jsonl` beside `errors.jsonl`, `warnings.jsonl` and `info.jsonl`, under `FORWARD_COMPACTION_DEBUG` (new, default `1`): a row at each hook entry, each `$` answer the plugin decides on (`session.usage` figures, the `agent.list` count, each `turn.step` reading with its four counts and model, `fs.stat`), the variables and options resolved, each measured ratio with its inputs, each wake's section sizes and files carried or not, each nudge sent or withheld and why, and every decision row whole, numbers as the API gave them. A burst of level-log rows is now one append process.
- **Every `forward_compaction` answer, receipt and refusal alike, ends with an experimental line** asking the model to append a short note of any trouble to `issues.md` in the plugin's level-log directory, or to its reply when no directory resolves.

### Fixed

- **The model sees its own `forward_compaction` result.** The handoff message of the wake ends with the call's result verbatim, so the receipt and the experimental line reach the model; the install had replaced the message that held them.
- **A nudge names the max context it is measured against** (`42% of your 200k max context`), not a window: the sub-agent max context is a setting, not the model's window.
- **A sub-agent is judged `unknown` until a request names its model**, so a Haiku party is never logged `managed` before its first step.
- **Every size the model or the person sees, and every decision, is a measured reading.** A party's context is its last reading: the input, cache-read, cache-write and output tokens of its last completed request. The character estimate (3.5 characters a token) ran about 40% low on Go source, where the live ratio was near 2.0: a foreman told `152k` ran its next request at 173.1k. The nudge judges and prints the reading alone, so it may come one step late; the ceiling and the mechanical decision use the reading too. No size is estimated from characters at all: a party with no reading (none yet, or none since an install) gets no nudge and no ceiling, an automatic ask from it with nothing stored is held as `no-reading` until its next reading decides, and a stored handoff installs regardless. The `estimated` field is gone, and an install no longer reports a character-count `tokensAfter`: the landed line's after is the next reading.
- **The level log keeps the decision fields.** `info.jsonl` rows now carry `level` (nudge), `decision` and `trigger` (compact), and `count`, `from`, `to`, `firstTokens` and `lastTokens` (skips).
- **A folded `skips` row in the level log is stamped with its streak's time**, as in the decision log, not with the time the session-end flush wrote it.
- **A 1M window reads `1M`, not `1000k`**, in the nudge, the receipt and the wake lines; from a million up, sizes print as `1M` or `1.5M`.
- **A wake no longer lists the party it wakes, and a sub-agent's lists only its own children.** Under `## Agents, listed at install`, a sub-agent's wake keeps only the agents it spawned (`parentId` its own id), where a live foreman's wake listed its sibling foreman as running; main's keeps every agent. The background tasks leave the woken sub-agent out; each task shows its own type (`local_agent`, `local_bash`), where every one read `shell`.
- **The wake and the receipt print no size for the call.** The plugin measures no size at the moment of a `forward_compaction` call (the next request's reading is the first to carry its step's results), and the size it printed dropped them: a handoff written in a 173.1k request was woken as `at 120k tokens`. The wake's handoff header now reads `[forward-compaction: handoff] Below is the handoff you wrote with forward_compaction. It is your frontier: continue from its ## Next.`; the receipt drops `(you are at …)` and says `It replaces the handoff you stored before.` The `stored` row keeps the last reading as `tokens` (`null` with none), and `replaced` as the replaced handoff's.
- **Load files are checked against their room at the call, and the room is larger.** The room was 15% of half the ask point, about 16,000 characters, and a file past it was found out only at install, after the context was gone, while the receipt had counted it. The room for carried files is now 5% of the party's max context in tokens, turned into characters at the party's measured characters per token (measured on the growth, below), and the 40,000-character cap per file is gone; with no reading yet the files are accepted without a size check and a warning row says so. The wake's budget (half the ask point) and its section rooms are turned into characters at the same measured ratio, from the compaction transcript; with no reading nothing is fitted, a handoff's wake keeps every message after the call and a mechanical wake none earlier. A `forward_compaction` call whose load files, one or together, come to more than the room is refused with nothing stored, naming each file, its size and the room, and asking for `lines` ranges or fewer files; a file counts as read for the wake, a `lines` range by its lines alone. A file that has grown past the room by install is still named under `## Files not carried`.
- **The characters per token are measured on the growth, so the fixed overhead cancels.** The ratio was a transcript's characters over the party's whole reading, which also counts Claude Code's system prompt, tools and skills (20-60k tokens never in the transcript): live it came out at 1.05 to 2.64 characters a token, every wake section shrank to about a third of its room, and a sub-agent's normal 12,000-character brief was not carried. Each party now keeps a base, its live window's characters (from `$.session.messages({ as: 'api' })`, the messages its next request is built from: text, thinking, tool inputs and tool results) and its reading at its first reading ever and its first after each compaction of it (a handoff, mechanical, native or manual one, or one it did not handle), and the ratio is the characters grown over the tokens grown since, every count from the same read, so a session past the 4,096 entries the row form returns still measures its window. It is unmeasured until the reading has grown 5,000 tokens past the base (below it one tool result's tokenization dominates), and when it falls outside 1 to 8 characters a token; unmeasured, sections are uncapped as before. Each base and each ratio writes a debug row with the base's characters and tokens and the characters and reading now.
- **The nudge no longer forbids the task's last write.** The skip clause read "skip it only if your final answer is your very next message", which contradicted "once the step in hand is done" when that step was the last write; it now reads "skip it only if nothing is left but writing your result and your final answer."
- **A party's reading counts its response's own output.** A reading was the request's input context alone, but the next request also carries that response's output: a foreman whose request had 147.0K input and 12,878 output tokens (one big Write) was read at 147,055 by the held ask and 152,398 by the nudge, and its next request was 160.1K. A reading is now the input context plus `output_tokens` (absent counts 0), so the ceiling, the nudge and the size a handoff is stored at all start from the size the next request has.
- **A folded `skips` row carries one timestamp.** The decision log and `info.jsonl` stamped the same row from two clocks (`.793Z` and `.792Z`); both now come from one value.
- **A party's judgement is logged.** The `ignore` row, in the decision log and at info in `info.jsonl`, is written the first time a party is judged and each time the judgement changes: at a spawn or a sub-agent's first touch, when a step names its model, and when main's window is read. A quiet sub-agent that leaves no other row is no longer indistinguishable from one the plugin never saw.
- **`info.jsonl` `stored` rows carry `files`**, the count of load files, as the decision log does.
- **A held compaction ask says what is held and why**: `forward-compaction: holding Claude Code's compaction for {party} until its handoff is stored or the ceiling is reached`, not `waiting for {party}'s handoff` before any nudge asked for one.

## [1.0.0-dev.1] — 2026-10-23

A breaking major: the plugin is rewritten and renamed. sub-agent-compact is gone; forward-compaction replaces it in the same repository, `github.com/rezzminator/sub-agent-compact`. The model writes its own handoff through one tool, the plugin installs it at Claude Code's compaction with facts recorded from typed hook events, and every message after the call is kept verbatim. No summarizer request runs.

### Changed

- **Renamed.** Plugin `sub-agent-compact` → `forward-compaction`; marketplace name `sub-agent-compact` → `forward-compaction`; install id `sub-agent-compact@sub-agent-compact` → `forward-compaction@forward-compaction`; tool server `sub-agent-compact` → `forward-compaction`; release tags `sub-agent-compact--v*` → `forward-compaction--v*`. The repository and its URL are unchanged.
- **One tool, one markdown argument.** `forward_handoff` (`mcp__sub-agent-compact__forward_handoff`) → `forward_compaction` (`mcp__forward-compaction__forward_compaction`). The typed fields `objective`, `done`, `remaining`, `blocked`, `findings`, `next` and `drop_skills` are gone: the call is `forward_compaction({handoff, load_files?})`, where `handoff` is one markdown string of at most 20,000 characters with `## Objective`, `## Done`, `## Remaining` and `## Next` (each once, each with text under it; `## Blocked` and `## Findings` optional). `load_files` keeps its `{path, lines?, why}` shape, at most 8 files of at most 1,048,576 bytes each. Nothing is trimmed any more: a fault is refused with `forward_compaction refused, nothing stored:` and what to fix. The schema is in the tool list from the start (not deferred).
- `look_back` keeps its description and arguments, under the new server: `mcp__sub-agent-compact__look_back` → `mcp__forward-compaction__look_back`.
- The wake is built from facts recorded as they happened (the person's messages or a sub-agent's brief, coordinator messages and notifications, skills as loaded, agents, background shells), the handoff verbatim, and every message after the call, within a budget of half Claude Code's ask point. Nothing is read back from the transcript or from skill and agent files.
- A message the person sends after a handoff no longer cancels it: it is kept after the call.
- One ceiling for every party, as a percentage of its own model's window (60% by default), no longer held to `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. A party with no handoff at its ceiling gets a mechanical wake (the facts and its newest messages), or Claude Code's own summary with `FORWARD_COMPACTION_CEILING_NATIVE=1`.
- Nudges start at 50k tokens and come every 10k (were 20% and 10% of the window); they are the same for the main chat and sub-agents.
- The decision log is on by default, under `~/.local/state/forward-compaction/logs/decisions/` (or `$PLUGIN_LOG_DIR/forward-compaction/decisions/`); before, it was off unless `PLUGIN_LOG_DIR` or the log file was set.

### Options: old → new

Every variable is renamed or removed; an old one is no longer read and no warning names it, so rename or delete each.

| Old variable | New variable | How to migrate |
| --- | --- | --- |
| `SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT` | `FORWARD_COMPACTION_CEILING` | One ceiling for every party now, applied only when no handoff is stored. Keep the larger of your main and sub-agent values, or drop it for the `60%` default. |
| `SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT` | `FORWARD_COMPACTION_CEILING` | As above. |
| `SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_NUDGE_START` | `FORWARD_COMPACTION_NUDGE_START` | One value for every party; default `50k`. |
| `SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_NUDGE_START` | `FORWARD_COMPACTION_NUDGE_START` | As above. |
| `SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_NUDGE_EVERY` | `FORWARD_COMPACTION_NUDGE_EVERY` | One value for every party; default `10k`. |
| `SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_NUDGE_EVERY` | `FORWARD_COMPACTION_NUDGE_EVERY` | As above. |
| `SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_ENABLED` | removed | No per-party switch; to leave compaction to Claude Code, disable the plugin. |
| `SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_ENABLED` | removed | As above. |
| `SUB_AGENT_COMPACT_SUBAGENT_KEEP_BRIEF` | removed | A sub-agent's brief is always carried, verbatim, from the recorded spawn. |
| `SUB_AGENT_COMPACT_FORWARD_HANDOFF_TOOL` | removed | `forward_compaction` is always registered. |
| `SUB_AGENT_COMPACT_HANDOFF_TOOL` | removed | The `handoff` tool is gone; `forward_compaction` replaces it. |
| `SUB_AGENT_COMPACT_COMPACT_TOOL` | removed | The `compact` tool and the summarizer focus are gone; `forward_compaction` replaces them. |
| `SUB_AGENT_COMPACT_AGENT_DIRS` | removed | No agent definition is read. |
| `SUB_AGENT_COMPACT_PIN_SKILLS` | removed | Skills are carried as they were loaded, newest first, while they fit; one left out is named with the call that loads it again. |
| `SUB_AGENT_COMPACT_DROP_SKILLS` | removed | As above. |
| `SUB_AGENT_COMPACT_LOG_FILE` | `FORWARD_COMPACTION_LOG_FILE` | Still an absolute path; each session writes its own file beside it. Unset now logs under `~/.local/state/forward-compaction/logs/decisions/`. |
| `SUB_AGENT_COMPACT_PROBE_DIR` | removed | Not an option: the host probe (`npm run probe:installed`) that read it is gone. |
| — | `FORWARD_COMPACTION_CEILING_NATIVE` | New: `1` lets Claude Code's own summary run at the ceiling instead of the mechanical wake. |

The settings keys `autoCompact.pinSkills` and `autoCompact.dropSkills`, and every `autoCompact` key in agent frontmatter (`forceAt`, `nudgeFrom`, `nudgeEvery`, `enabled`, `pinSkills`, `dropSkills`, and the bare `autoCompact: <size>`), are no longer read: delete them.

### Removed

- The `compact` tool and the `handoff` tool, the `<compact-now>` and `<handoff>` markers, and the summarizer focus they armed.
- Per-agent policy from frontmatter, the central skill pin and drop lists, and agent-definition lookup.
- The Haiku pass-through: a Haiku party is nudged and compacted like any other.
- Brief seating after a native summary: the brief is a recorded fact of every wake.
- The disarm of a stored handoff by a person's message, an interrupt or a skipped compaction; a person's `/compact` still runs Claude Code's own summary and drops the stored handoff.
- The saved handoff files (`forward-handoff/{session}/{n}/` with `args.json`, `wake.txt`, `record.json`) and the restore of a handoff from them after a reload: a stored handoff lives in memory until it installs, and its text stays in the transcript as the call's input, where `look_back` finds it.
- Every transcript scan at handoff time: queued-prompt recovery, the file trail and outlines, the plan, task, git and path blocks, and the `answered` status of the person's last message.
- The host probe and `npm run probe:installed`.
- The benchmark figures: they measured sub-agent-compact's summarizer mechanism and are not claimed for forward-compaction, which has not been benchmarked yet.

### Migrating

1. Uninstall the old plugin and its marketplace: `claude plugin uninstall sub-agent-compact@sub-agent-compact`, then `claude plugin marketplace remove sub-agent-compact`.
2. Add the marketplace again and install: `claude plugin marketplace add https://github.com/rezzminator/sub-agent-compact.git`, then `claude plugin install forward-compaction@forward-compaction`.
3. Rename or delete each `SUB_AGENT_COMPACT_*` variable by the table above, and delete the `autoCompact` keys from settings and agent frontmatter.
4. Replace every prompt, agent or rule naming `mcp__sub-agent-compact__forward_handoff` or `mcp__sub-agent-compact__look_back` with `mcp__forward-compaction__forward_compaction` and `mcp__forward-compaction__look_back`, and rewrite any instruction that fills the old typed fields into one markdown handoff.
5. After uninstalling sub-agent-compact, delete ~/.local/state/sub-agent-compact/ yourself; forward-compaction never reads it. Its saved handoffs and logs are in a format the new plugin does not use, and it is neither moved nor deleted for you.

## [0.8.1-dev.8] — 2026-10-22

### Fixed

- A forward handoff's `Running` block names the sub-agents from Claude Code's agent list at handoff time, as ListAgents shows them: an agent resumed by `SendMessage` and the children a sub-agent spawned are no longer missing, each child is named with its parent, and a sub-agent's block names only its own descendants.
- The newest message a person wrote is tagged `answered`, `partially answered` or `unanswered` in the wake's `User` block, so a woken model knows whether its reply reached them without calling `look_back`; the status chains across handoffs, and task notifications after the message no longer hide it.
- Claude Code cuts a command's output at 4,194,304 characters: the transcript scans (queued prompts, and prompts and files before a native compaction) now read in pages under it, and the queued-prompt scan leaves out tool results and image data. A transcript line that cannot be read is skipped and named, instead of losing every queued prompt.
- `look_back` search stays under the same limit: image data is emptied before the search and the candidates passed on fit 3,000,000 bytes, so a query matching many large entries no longer fails with a missing completion marker.

## [0.8.1-dev.7] — 2026-10-22

### Added

- `autoCompact.pinSkills` and `autoCompact.dropSkills` lists in agent frontmatter and central settings, with optional environment overrides. Both default to empty; pins beat either drop list and are evicted after unpinned skills under the total cap. Policy conflicts, malformed lists and refused model drops name their source.
- Donor replays run the shipped hook in a separate process through storage, wake installation, install verification and a second carry, using the existing adapter harness and trimmed real transcript excerpts.

### Fixed

- Forward handoffs recover queued prompts on every call, including enqueues removed as `absorbed_mid_turn`. A carried transcript cursor preserves repeated instructions without replaying old deliveries.
- Native compaction falls back to the latest readable handoff record and reports recovery or loss. Wake blocks appearing later in the transcript are excluded from user history, and typed prompts outrank reports and notices at the 25-entry cap.
- Skills, Objective, Remaining and Next install as live instructions. Historical sections retain their explicit framing, while both old and new wakes remain recognizable.

## [0.8.1-dev.6] — 2026-10-19

### Fixed

- A background task that finishes while a handoff is being written is no longer lost by the reset. Claude Code attaches its notification to the turn after the handoff call's result, and the rows a compaction hands the plugin hold no attachment, so the installed context never showed it: the woken model waited for a task that had already finished. The install now reads the Messages API form of the transcript and carries every `<task-notification>` delivered after the handoff call, verbatim, in the message before the wake text (inside the framed handoff for `compact`), unless a kept message already holds it. When that transcript cannot be read, the handoff installs without them and says why; the decision log's `handoff` row counts them as `notices`.

## [0.8.1-dev.5] — 2026-10-19

### Fixed

- A `forward_handoff` list cut to fit no longer drops its tail silently: past its characters, every item keeps its head (a short item whole, each longer one cut to an equal share), only items past the item limit are dropped, and the cut field's last line in the wake says how many characters it was and is, how many items were shortened or dropped, and that the uncut field is in `<dir>/args.json`. A `load_files` list past its limit is named in `Unresolved` the same way.
- The reply to a stored forward handoff states only what holds for the caller: a sub-agent's handoff installs before its next request, so its reply no longer asks it to send cut fields again or to call again in the turn, and every fact about a cut is in the wake. The main chat's reply says it installs before its next request, else when the turn ends.
- A message the person, the coordinator or a sub-agent's parent agent sends while the party works (a `queued_command` in the transcript) is carried in the wake's `User` block as an instruction, like the brief; a message from any other agent is left out.
- A `next` that opens by reading a file `load_files` holds, or by checking the git state, is stored, no longer refused: the wake's `Next` ends with a line saying it is already loaded above, not to read it again. The decision log's `forward-reread` row now records `outcome` (`stored-with-note`, or `stored-not-held` when the file did not load) and the `note`.
- A party that woke from a forward handoff and has run a tool since (any but `ToolSearch` and the plugin's own) can hand off again below its first nudge point: the woken-party refusal no longer lasts for the rest of a sub-agent's run, and its text says it applies to a party that has done no work since.
- `load_files` takes several ranges (`1-60,160-185`), the lines between two named by one `[lines a-b not loaded]` line; a range past the file's end, or clipped by it, an empty file and a range of only blank lines are named in `Unresolved` instead of loading nothing; ranges load in file order, an overlap once.
- The install row of a forward handoff (`session.compact`, decision `handoff`) counts its `load_files` in `loads` and `loadsFailed`, which read 0 for every forward handoff; `record.json` keeps the counts as `loads`, and a record saved before counts its `Load` blocks with `loadsFailed` null.
- A trail file gone from disk is told once, in that handoff's wake, and left out of the trail its `record.json` carries, so later handoffs no longer re-outline and re-warn it; a directory a `cp` or `mv` wrote into no longer gets a file tag; a gone or non-file path and a file past the outline cap are logged as `forward-trail` info rows, no longer as `forward-invalid` warnings, which an outline read that failed alone still is.
- `look_back` strips the punctuation prose wraps a bare word in (`(KEY`, `review.md)`), counts a repeated word once, and ranks entries by how many terms they hold instead of requiring every term: a partial hit is marked `(k of n terms)` and the reply says when no entry holds every term; a query no entry holds any term of still answers `No entry before the compaction at line N matches: …`.
- A forward handoff is numbered past the handoff its context holds, so one armed unsaved (its number claim failed) and forgotten by a plugin restart is never numbered again, and the wake no longer names the call being stored as its own missing earlier handoff.
- The decision-log append and cleanup, the level-log append, the claim of a handoff number, `look_back`'s transcript reads and the forward handoff's transcript and `git -C` reads run from `/` when their paths are absolute, so a session standing in a removed worktree no longer fails every spawn with `posix_spawn ENOENT`; a failed decision-log write names the session's own file, never the configured `decisions/.jsonl` template.
- A skipped agent-definition link names its cause: `a link that leads nowhere or does not resolve`, `a link to a directory`, `a link to something not a regular file`, or `changed since it was listed` for a path replaced between listing and stat; a dangling link no longer reads as one to a non-file.

## [0.8.1-dev.4] — 2026-10-18

### Removed

- `look_back` no longer takes `why`: a call is `query` or `entry` alone, and the schema requires nothing. The notice line and the decision log's `look-back` row name the query or the entry that was looked up (a long query cut at 120 characters in the notice) in place of the caller's stated reason. A caller still sending `why` (a chat started before this version holds the old schema) is told `unknown argument why` and calls again without it.

## [0.8.1-dev.3] — 2026-10-18

### Fixed

- A hook's abort now ends its wait for tool registration at once: the dispatch's timer may never fire, and a hook waiting past its abort starved the hooks worker. An aborted wait is not reported as a slow registration. The same holds for the per-call work of `tool.call` (the nudge check, the manual look-back observation) and the readings after each `turn.step`: none holds its hook past the dispatch's abort, so another plugin's `tool.call` no longer fails open with "ignored its signal ... a runaway plugin in the hooks worker".
- A compaction that fails beneath the plugin (Claude Code's reactive compaction ending unsettled) is logged as the warning `compaction-failed`, not as an error `hook-threw`: the failure is the compaction's, and it passes on unchanged.

## [0.8.1-dev.2] — 2026-10-17

### Fixed

- Agent resolver skips and failures are logged once per path per plugin session; listed links to non-regular files (including dangling links) remain warning-log diagnostics, with screen fallback only when logging is unavailable or failing.
- Warning- and info-level diagnostics stay off screen while a decision log or plugin log keeps them, including resolver skips, registration still in progress and cleanup notices. They fall back to the screen when neither log is available, or logging is off or failing; a failing plugin log's own notice stays visible. Startup fallback warnings wait until the log destinations are known.
- Errors always reach the screen and the log. Broken or ignored settings, failed tool registration, unavailable nudging or timers, missing HOME access, failed plugin-skill discovery, broken handoff recovery, installation or verification, failed brief seating or sub-agent stop handling, incompatible native windows and missing token readings are now errors rather than warnings. Diagnostic log rows retain the line's full context. Tool replies and installed handoff text are unchanged.

## [0.8.1-dev.1] — 2026-10-17

### Changed

- The forward handoff's call shape (every field, its type, lists as arrays of strings, and its limit) is stated in the context nudge toward the tool, in the reply to a call missing a required field, which also names each field of the wrong type and what it got, and at the end of the wake's `Unresolved` block: the tool is deferred, so a model after a wake saw only its name.
- The wake's `Git` block ends with a line saying it was read when the handoff was stored, right before the wake, so it need not be read again.
- A party that woke from a forward handoff and is below its first nudge point gets its call through once a message the person wrote since the wake names compacting or a handoff with no negation before it (the word, not the intent); the refusal says so, and that `/compact` compacts at once.

### Fixed

- A chained forward handoff keeps the skills and commands the earlier wake carried: `record.json` lists them (`skills`), the next handoff carries them before those invoked since, minus `drop_skills`; an older record's are read from its `Skill` blocks by name. Before, a skill the wake had installed was lost at the next handoff unless invoked again.
- The stored reply names each field cut to fit, with its characters (and items) before and after, the marks left out, where the uncut arguments are, how to keep what was cut, and that a call again in the turn replaces the stored one; before, a cut was marked only in the wake.
- The stored reply names each skill or `load_files` entry the wake does not hold, and why (not found, too large, a directory, a refused read, the total cap); before, only the wake and the warning log did.
- A list sent as a string is still read, and the reply says it was converted and into how many items; a JSON array text gives its items and a one-line `1) … 2) …` numbering splits into its items, instead of one item each.
- A Haiku party's call, or one from a sub-agent whose `tools:` lacks the tool, is refused with that reason before its arguments are checked, instead of first being sent back to fix them.

## [0.8.0] — 2026-10-16

### Removed

- The plugin's `userConfig` (and with it `pluginConfigs["sub-agent-compact@sub-agent-compact"].options`, `/config` and the option layer): every option is read from its `SUB_AGENT_COMPACT_*` environment variable alone, an unset, empty or blank variable giving the default. A non-empty options object handed to the plugin is not applied; the plugin finds a leftover entry in any settings source and names its keys in one warning, once.

### Changed

- `resolveOptions` resolves variable over default; a bad value is named by its variable and the default applies, and so does a variable that could not be read.
- Migration: move each value from `pluginConfigs["sub-agent-compact@sub-agent-compact"].options` to the variable in the README options table (`mainAutoCompact: "600k"` becomes `SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT=600k`; `forwardHandoffTool: true` becomes `SUB_AGENT_COMPACT_FORWARD_HANDOFF_TOOL=1`), in the `env` block of `settings.json` or the shell that starts Claude Code, then delete the `pluginConfigs` entry.

### Fixed

- A log or lock directory that cannot be created names its path on stderr, so the error is useful where `mkdir` omits the path (uutils coreutils prints only `Permission denied`).
- A decision-log append that fails, such as one an interrupt aborts, keeps its rows for the next write instead of dropping them; rows still unwritten at session end, and any the 2,000-row hold let go, are counted on screen and as a `decision-log-rows-lost` error row.
- Cleaning up old decision logs runs one `find` instead of one per file (past 15 s under load at 200 files), after the session's first rows are written; its failure is also a `decision-retention-failed` decision row.
- A tool registration past 5s says it goes on, and its late finish is a `tools-late` row naming the tools and the wait.
- `drop_skills` naming a skill not invoked since the last compaction says so and to leave it out, instead of "not invoked".
- An install's after-size is labelled as the messages only (`tokens in messages (system prompt and tools not counted)`, row and forward `record.json` `tokensAfterScope`).
- `look_back` reads `\"` in a query as a literal quote, in a phrase or a word, and finds a term holding a quote or a backslash in a message or a tool call's input (the transcript stores them escaped in a string, bare in a tool input's JSON); a bad query, an entry at or after the boundary, or one not found is logged as a warning, not an error.
- A forward handoff claims its call number with one `mkdir` that sees the real directory, so a call the listing missed is never written over; the record of the handoff the session holds is also read through the `saved` path its text names, when that call is this party's own; a record still missing names the handoff's number, every place looked and a saved path that is not this chat's.

## [0.7.1-dev.3] — 2026-10-15

### Changed

- Haiku is left to Claude Code: no nudge, hold, forced point, brief re-seat or stored handoff for a Haiku party; every ask passes.
- Forward handoff records live under `$HOME/.local/state/sub-agent-compact/forward-handoff/`, so a `CLAUDE_CONFIG_DIR` or account switch keeps the chain; records under the config directory are still read.
- The decision log appends under a lock instead of rewriting the file: routine skips fold into `skips` rows, a file over 8 MiB moves to `.1`, rows queued at session end are flushed within the session-end bound, and other sessions' files (a file whose first line is a decision row) older than 14 days or beyond the newest 200, this session's counted, are removed.

### Fixed

- A failing plugin log also reaches the decision log (`plugin-log-failed`).
- A limit past the real window is clamped to Claude Code's ask point (`limit`, `limitSet`); the main window is re-read after `/model` (`window-changed`); a "prompt is too long" recovery ask passes (`unanswered`).
- After a compaction the plugin did not see, a `/clear` or a resume, the main chat's stored handoff is dropped and its nudges re-armed (`handoffDropped`, `cleared`); a failed native compaction no longer delays the forced one by a turn; a precompute no longer masks an unseen compaction.
- A sub-agent whose `tools:` lacks the forward handoff tool is never nudged toward it.
- Each warning is written once to the level log; level-log rotation holds a lock across sessions.
- A relative or non-string `logFile` falls back to the default instead of turning logging off; non-string `agentDirs` items, unknown option keys and a nudge start past the forced point are named.
- `look_back` reads task notifications, attachments, `system` and `summary` entries, reports an unreadable entry as an error, reads `entry: null` as absent, ranks the caller's own forward handoff last, and answers "nothing compacted yet" before checking arguments. Claude Code's bookkeeping entries (queue operations, request copies, titles, modes, file history, cost) are skipped silently rather than reported as unreadable; tool references are named and a document block is noted, not failed.
- A forward handoff stored before a plugin reload is installed from its saved files.
- A symlinked agent definition is guarded on the direct `<type>.md` route too; `plugin:agent` types read their plugin's agent definitions; agent policies and list misses are re-read after 60 s, and a failed listing is not cached.
- Haiku 5.5 (`claude-haiku-5-5`) is read as the 1M window Claude Code gives it, not 200k; Haiku 4.5 and older stay 200k. Haiku stays hands-off, so this corrects the logged `limit` and window only.
- A sub-agent's relative shell writes in the forward handoff's `Files` block resolve under the directory it was spawned in.

### Added

- Every option is also read from an environment variable, `SUB_AGENT_COMPACT_` plus the option in upper snake case (`SUB_AGENT_COMPACT_FORWARD_HANDOFF_TOOL`), ahead of the option and the default; tools register from the variable alone. A flag is `1`, `0`, `true` or `false`; a bad value is named by its variable and the default is used.

## [0.7.1-dev.2] — 2026-10-15

### Fixed

- A forward handoff's missing outline file names the path context to check (absolute or relative to the session cwd) instead of a bare "not found".

## [0.7.1-dev.1] — 2026-10-15

### Fixed

- Decision-log session lookup and write failures also reach the warning and error level files, and diagnostics queue before screen output.
- Plugin log creation uses plain create-and-append, keeping private modes for new objects.

## [0.7.1-dev.0] — 2026-10-15

### Fixed

- Plugin log appends work on macOS, including cap rotations and relative log roots beginning with a hyphen.

## [0.7.0-dev.23] — 2026-10-14

### Added

- Plugin diagnostics append bounded JSONL rows to errors, warnings and info files under `PLUGIN_LOG_DIR`, or the plugin's HOME state folder when unset. Logging failures report once per failing streak without changing work results.
- A blank `logFile` follows `PLUGIN_LOG_DIR` into per-session decision files. Explicit decision-log settings and existing screen notices are kept.

## [0.7.0-dev.22] — 2026-10-14

### Fixed

- A sub-agent whose definition in an agents directory is a symbolic link is found by its frontmatter name, as a regular file is. A link is read only when it leads to a regular file within the 4 MiB read limit; a link to a pipe, a device, a directory or nowhere, or to a larger file, is skipped and named on screen, never read.
- A decision log that cannot be written is named on screen once per distinct failure, not once per flush; a failure whose text differs only in a number (a size or an offset) counts as the same one.
- `npm run release:check` reads the test count from the run itself: a run with a failing test, or a test file that failed to run, is a failure, and a test runner that gives no report is named with its own error.

## [0.7.0-dev.21] — 2026-10-14

### Fixed

- The forward handoff's `Git` block describes the repositories the work touched instead of the directory the session started in. A chat started in a repository's main checkout that builds in a linked worktree, a submodule or another repository got the main checkout's branch and dirty files. The block now has a line per repository: those of the files made or edited, else those of the files read, newest first, each named by its root, at most 3, with the rest counted and named. When the files touched are in no repository, it keeps the session directory's repository (read at handoff time, so a shell `cd` counts), with the bare line as before. A directory git fails to look in is named in `Unresolved`.

## [0.7.0-dev.20] — 2026-10-14

### Added

- A `compact-unseen` row (`party`, `before`, `after`) in the decision log when the main chat's token reading falls to half the previous one or less with no `session.compact` handled in between. Claude Code 2.1.299 on a machine with managed settings compacts the main chat without dispatching `session.compact` to user plugins (its debug log reads `session.compact bypassed by cc-plugin-sec-default (tier user)`), so the plugin can neither hold nor see those compactions; the row makes each one visible. A compaction before the session's first reading, such as the first request after a resume, leaves no reading to compare and is not caught.

## [0.7.0-dev.19] — 2026-10-14

### Changed

- Every line the plugin says is also written to the decision log as a `said` row (`line`, `shown`), so a failure that only reached the screen, such as a forward handoff that could not be saved, can now be read back from the log.
- Routine successes — look back notices, a manual transcript read, a handoff or forward handoff installed with every block, a handoff recovered from the transcript — go to the decision log only; failures, skips, fallbacks and missing blocks still show on screen. With no `logFile`, or when the log is off for the session, routine lines show on screen as before.

## [0.7.0-dev.18] — 2026-10-13

### Fixed

- A transcript line whose JSON holds a raw U+2028 or U+2029 (Claude Code writes them unescaped) no longer fails `look_back` with `invalid numbered transcript output`, and is no longer skipped when a forward handoff carries the prompts and files from before Claude Code's own summary.

## [0.7.0-dev.17] — 2026-10-13

### Added

- Always-on `look_back` for the main chat and every sub-agent: search or fetch readable transcript entries before the latest compaction. Every call is a compaction miss shown to the person and recorded in the decision log; manual transcript reads count too. Forward handoffs carry a checked hint naming the tool.

## [0.7.0-dev.16] — 2026-10-13

### Fixed

- A file a shell command writes after `cd` (`cd pfm/internal && cat > doctor/a_test.go`, `(cd ~/x && … > out.log)`) is listed in the forward handoff's Files block where it landed, not under the session's working directory; after a `cd` it cannot place (`cd "$WT"`), a relative write is left out instead of named at a wrong path, which showed as `outline …: not found`.

## [0.7.0-dev.15] — 2026-10-13

### Removed

- The automatic load of a party's own notes (0.7.0-dev.14). In measured runs it never reached the notes it was for — they sat past the 15-entry file trail — and it loaded command output saved as `.txt` instead. A wake loads what `load_files` names, as before.

## [0.7.0-dev.14] — 2026-10-13

### Added

- A forward handoff loads the party's own notes: the newest two Markdown or text files it made or edited outside the repo (a plan, a run log, a checkpoint), as `Load <path> (own notes)` blocks, whether or not `load_files` named them. A file inside the repo stays a Files line.

## [0.7.0-dev.13] — 2026-10-13

### Changed

- A forward handoff whose `next` opens by re-reading a file its `load_files` already puts in the wake, or by checking git status, which the wake carries in its Git block, is sent back once per party with the reason, so the woken agent starts on the work. The same call sent again is stored.

## [0.7.0-dev.12] — 2026-10-13

### Added

- The Files block of a forward handoff outlines each file the party made or edited, read as it stands at handoff time: `C /…/levels.ts — 84 lines: LEVELS, isEffort, rank, clamp, stepUp`. Names come from top-level declarations (TypeScript and JavaScript, Go with `Type.Method`, Python, Rust, shell), test names, Markdown headings to depth 3, and the top-level keys of JSON, YAML and TOML; any other file gives its line count. One line holds at most 400 characters and all outlines at most 2k tokens; a file over 1 MiB, or one gone or unreadable, is named in Unresolved.

## [0.7.0-dev.11] — 2026-10-13

### Changed
- A forward handoff reads as one line for the person, once its install is checked: `forward handoff 6 of general-purpose: 245k -> 6k tokens, all 9 blocks landed, files in …` (or `blocks missing: …`). The separate stored and installed lines are gone; the decision log still records each step.
- No line the plugin shows names the plugin again: Claude Code already puts `sub-agent-compact:` in front of it.

## [0.7.0-dev.10] — 2026-10-13

### Added
- A forward handoff taken after Claude Code's own compaction carries what that summary knew, as an `Earlier summary` block: its Key Technical Concepts, Files and Code Sections, Errors and fixes and Problem Solving sections, dedented, at most 1.5k tokens. Its request, prompts, pending tasks, current work and next step are left out: the User block and the model's own fields carry them newer. A chained handoff carries the block on from its record (`summary`). A summary without those sections is named under `Unresolved`.

### Fixed
- The refusal of an early second handoff states the context size rounded down, so 39.6k reads `39k, below 40k`, not `40k, below 40k`.

## [0.7.0-dev.9] — 2026-10-13

### Fixed
- The forward handoff's `Files` block survives every compaction, as the prompts do: after Claude Code's own compaction it adds the files touched before it, read from the transcript; a chained handoff adds the files the earlier one listed, from its record (`trail`). Newer touches first, a file created earlier stays `C`. Haiku handoffs taken after Claude Code's own compaction listed none of the files read before it.

## [0.7.0-dev.8] — 2026-10-13

### Fixed
- A party that woke from a forward handoff is refused a second one while its context is below its first nudge point (`Not stored: … continue its work from its Next block`). Woken Haiku probes called `forward_handoff` again in 6 of 8 runs; the in-reply tag alone did not stop them. A first handoff is never refused for size.

## [0.7.0-dev.7] — 2026-10-13

### Fixed
- When the forward handoff is the model's reply to the latest prompt (it did nothing after that prompt but reach for the tool), the prompt's tag reads `[n, latest, handed off in reply]`, and the record keeps it across chained handoffs. A probe woken from a handoff ordered by its last prompt read the order as still open and called `forward_handoff` again.
- The prompts from before Claude Code's own compaction are read again: the summary is found past the reminders Claude Code puts before it (CLAUDE.md, session context, date). In 0.7.0-dev.6 only a summary in the first text block was seen, so a context compacted once carried only its last prompt.

## [0.7.0-dev.6] — 2026-10-13

### Fixed
- The `User` block of a forward handoff carries the prompts from before Claude Code's own compaction: when the context opens with its summary, they are read from the session transcript (its user entries before the last compaction, without expansions or tool results). Haiku probes cut after one real compaction woke with only the last message; the worker's brief was gone.
- A message that wraps a slash command in more text (a workflow relaying the person's request) is carried whole, with the command as `/name args`, and the message after it is no longer taken for the command's expansion: a Haiku worker's task, sent right after such a relay, was dropped.

## [0.7.0-dev.5] — 2026-10-13

### Added
- A Haiku party with `forwardHandoffTool` on gets the steps to hand off before Claude Code's own summary replaces its context: Claude Code's automatic ask is held up to 3 times while no forward handoff is stored, and the model is told once to call `forward_handoff` as its very next step. The ask passes once the handoff is stored (and installs it) or after the third hold. A live probe showed Claude Code compacting a Haiku main chat at 77k between the model loading the tool and calling it.

## [0.7.0-dev.4] — 2026-10-13

### Fixed
- A `forward_handoff` list field is capped by its total budget (items × characters) and its item count, never an item by itself: a model that passes a list as one long line keeps it whole while the field fits. Probes on 10 foremen: 6 passed `done`/`remaining`/`findings` as single strings, which the per-item 200-character cap cut to a third of their text.
- The text of a field the tool does not define (a model passing `context`) is carried into `findings` as `name: text` instead of being dropped.

## [0.7.0-dev.3] — 2026-10-13

### Changed
- With `forwardHandoffTool` on, the `compact` tool is not offered and `<compact-now>` markers do not count: the forward handoff replaces it, so the model sees one way to hand off. Probes on 10 foremen showed a model passing `compact`'s `focus` to `forward_handoff` while both were offered.
- Haiku parties are served by the forward handoff: with `forwardHandoffTool` on they are nudged, may call `forward_handoff`, and its text installs when Claude Code compacts them (a Haiku main chat between turns, as any main chat). Without it Haiku stays on Claude Code's own compaction, as before.

## [0.7.0-dev.2] — 2026-10-13

### Fixed
- A slash command or a skill the Skill tool loaded is in the `User` block only as `/name args`: its expanded body is in the transcript as a second user text, and was carried a second time next to the `Skill <name>` block. No content is in the text twice.
- The `User` block holds only what a person or a parent wrote: `Tool loaded.` (the sibling text of a tool search), the image note lines, a plugin's message to the model, the note after an output cut (`Output token limit hit…`), what a sub-agent of the session sent back (`<agent-message from="a…">`) and a chat's reply footer (` — sid … · to reply: …`) are left out; a message a person wrote that opens like a forward handoff (a pasted `wake.txt`) is carried as theirs; an image is one marker, `[image <absolute path>]`; the `latest` mark sits on the last real message.
- Every path in the text is absolute: the file trail, `load_files`, subdirectory `CLAUDE.md` files, the plan file, the git paths (under the repository top), the transcript and the saved directory.
- Running work: with the engine's own list of background tasks and crons (taken at the end of the last turn) it lists exactly what is in flight, so a one-shot wakeup or cron whose fire time has passed, a deleted cron and an ended shell, monitor or agent are no longer listed; calls made since that list come from the transcript until they end. Before any turn has ended the transcript's endings decide, with `CronDelete` now one of them.
- The transcript is found by its session id (`find -H`, so a `projects` directory that is a link is searched through), not by rebuilding Claude Code's directory name, so a project path over 200 characters (which Claude Code hashes) no longer shows as `transcript: not found`; the line appears only when no file exists for the session.
- A carried line that reads as a block label, an item marker or the header is escaped with a backslash, in every block (in a list item, also a line that opens like `- `, `N. ` or a task mark), so user messages, skill bodies, loaded files and the model's arguments cannot forge the text's structure; a skill or file name with a line break stays one label line.

### Changed
- Chained handoffs carry the last 25 prompts: the next handoff reads the previous one's prompts from its `record.json` (`users`, `usersDropped`, `textHash`), never from the text, and adds those written since. The held handoff is the newest text a record of the party holds, else the one leading the context. The item numbers go on counting, with `[N older dropped]` for what went older.
- `forward_handoff` also serves sub-agents: their prompts (the parent's task and messages) are carried the same way, and their files are saved under `<session>/agent-<id>/<n>/`. A sub-agent no policy governs is refused, as with `handoff`: nothing would install it. A sub-agent's running work is read from its transcript, as the engine's list is the session's.

## [0.7.0-dev.1] — 2026-10-13

### Added
- `forward_handoff`, behind the new option `forwardHandoffTool` (default `false`): the main chat compacts itself at a moment it picks, and the installed text is carried by code. One header line, then only non-empty blocks: the user's messages verbatim (about 8k tokens), the skills and commands invoked reloaded from disk (about 3k tokens each, 12k total), the file trail as `E|R|C path`, `load_files` read at handoff time (a `lines` range exactly), plan and task state, running work, one git line, the transcript path with the line of the cut and the previous handoff's path, and what could not be read. The model writes only the objective, done, remaining, blocked, findings and next, with `next` last. A field over its limit is trimmed and marked, never refused; only a missing required field returns an error.
- Per call, `args.json`, `wake.txt` and `record.json` (the size of every block, the context before and after, and an install check that each block landed) are saved under the Claude config directory.
- The `handoff` tool and `handoffTool` are unchanged.

## [0.5.1] — 2026-10-13

### Fixed
- Registering the tools no longer holds a turn without limit: past 5 seconds the turn goes on, a warning says so once, no hook waits on that registration again until it settles, a registration that finishes late still names the tools, and one that fails late leaves its tries left to a later turn. Once every tool is registered or out of tries, a turn sets no timer for it. (`session.start` or its first call hanging before registration is not bounded.)
- After a plugin reload, a main-chat step with at most three messages is read as the session's first request only when the session has sent exactly one prompt (`$.session.turns()`), so the step after a CLI compaction (a summary and the prompt) no longer yields a false "cutting each later request to about …" claim. The prompt count unreadable leaves the claim out, with a warning.
- A handoff stored in the transcript is no longer dropped because a task notification, a system reminder or a local command's output (text the harness wrote) came after it; a person's message, an interrupt written as its own message included, still cancels it.
- `load_on_wake` reads a file only after `$.fs.stat` shows a regular file of at most 256 KiB; a directory, a pipe, a device, a larger file or a stat that fails is refused at the call and named `NOT LOADED` at install, where the read used to run up to its 4 MiB limit.
- The install text no longer says Claude Code re-attaches an invoked skill. That is read from Claude Code's own compaction in the 2.1.296 bundle and not shown for a compaction a plugin installs; the text now says the skill was invoked earlier and is to be invoked again if its text is not in context.

## [0.5.0] — 2026-10-13

### Added
- The handoff has typed fields instead of one free-text string: `goal` and `next_step` are required; `done_verified`, `in_flight`, `files` (`path:line` anchors, never contents), `decisions`, `dead_ends`, `standing_rules` and `notes` are optional and an empty one is omitted from the installed text. A missing required field or a key that is not a field comes back as a tool error the model reads. The rendering is short markdown sections, not a fixed essay.
- `load_on_wake`: skill and command names the plugin resolves at the call and inlines at install. A skill the transcript shows was invoked is left to Claude Code, which re-attaches invoked skills itself (read from the 2.1.296 bundle, not yet proven live).
- A handoff the plugin's memory lost is read back from the transcript's own `handoff` call before the compaction is judged.
- Notices the model reads after its next tool result (the main chat: at its next prompt): a refused marker, a compaction that was skipped, a manual `/compact` that dropped a stored handoff, or that was skipped and left it stored.
- One visible log line per install, naming the party and the size cut, and a warning, once, for each of: both tools off, the tool failing to register, an unknown compaction trigger, an unrecognised transcript shape.

### Changed
- The nudge, the tool description and the install text name the typed fields; the nudge no longer promises a size the cut did not have.
- A handoff is capped at 12000 characters (about 3k tokens); a `<handoff>` marker is held to the same checks as a tool call.
- The fallback to the summarizer no longer drops the handoff: its text is the summarizer's instructions, and it stays stored if the summarizer is skipped.
- A Haiku-class party passes through `decide` and is compacted at Claude Code's own point, never held (its ask comes near 51k; non-Haiku asks, measured on 255, sit at 67k as the plugin assumed).
- The tool registers again, up to three tries, if it failed at session start, and lazily if `session.start` never fires.

### Fixed
- After a plugin reload mid-session, the plugin's first reading became the "fresh base", and the nudge told a 208k main chat that a handoff would cut it to "about 208k plus your handoff"; the real result was 25k. The cut is now stated only when the base reading came from the session's first request; otherwise the claim is left out.
- A handoff stored while the main chat's compaction was skipped was reported as installed; the model and the user are now told it is still pending.

## [0.4.1] — 2026-10-13

### Changed
- The defaults are back to the compact-only behaviour of 0.3.1 and earlier: `compactTool` is `true` and `handoffTool` is `false`, so models get the `compact` tool and the `<compact-now>` marker, and the nudges say how to compact. 0.4.0 shipped them the other way round. To keep the 0.4.0 behaviour, set `handoffTool` to `true` (and `compactTool` to `false` to drop the `compact` tool beside it).

## [0.4.0] — 2026-10-13

### Added
- The `handoff` tool (`mcp__sub-agent-compact__handoff`), on by default through the new option `handoffTool`. A model passes its own handoff (the task and its fixed values verbatim, what is done with evidence, the facts the rest uses with their `file:line`, decisions, what is left, the next step), and at the next compaction point the plugin answers Claude Code's compaction ask itself: the handoff, framed as the party's whole memory, then every message after the call, kept as they were. No summarizer request runs. A sub-agent without the tool writes `<handoff>…</handoff>` in a response that also calls a tool. A handoff below the first nudge point or shorter than 200 characters is refused; one whose call cannot be found falls back to the summarizer with the handoff as its instructions.
- The nudges name the handoff: the context size, that every request re-sends all of it, what a handoff would cut it to, what goes in it, and that the handoff is the model's next call once a result closes a step, never deferred past a step that may be its last.

### Changed
- The `compact` tool and the `<compact-now>` marker are off by default, behind the new option `compactTool`. With it on they work as before, and the nudges still name the handoff while `handoffTool` is on. To keep the old behaviour, set `compactTool` to `true` and `handoffTool` to `false`.

## [0.3.1] — 2026-10-12

### Fixed
- A sub-agent resumed from its transcript is no longer compacted unmeasured. Its first automatic compaction request comes before it has made a response of its own, so there is no usage reading; the plugin let that compaction through whatever the transcript held, and a resumed agent was compacted at about 100k tokens under a 600k limit. With no usage reading the plugin now measures the transcript it is asked to compact: below the limit the compaction is held, at or above it the compaction goes through. The measure leaves out the system prompt and tool definitions, so it runs below the true context, and it is trusted for the first request only: asked again before the agent has answered, the request after the hold got no response, as a prompt too long gets none, and the compaction goes through. A request with neither a reading nor an estimate (an empty transcript) still passes as `no-reading`.
- A teammate was labelled by its name instead of its agent type, and so missed its type's compaction policy: a teammate's `SubagentStart` and `SubagentStop` carry its name as `agent_type`, and that announcement was preferred over `$.agent.list()`. The list's type now comes first; the announcement stays the source only for an agent the list does not name, such as a Workflow run's.

## [0.3.0] — 2026-10-10

### Added
- A sub-agent keeps its brief across compactions. Claude Code replaces its first message, the prompt its parent passed, with the summary; the plugin now seats that prompt again, verbatim, right after the summary at every compaction, exactly one copy however often it compacts, up to 64k tokens (characters / 4) with one line marking a cut. The option `subagentKeepBrief` (default `true`) turns it off.

### Fixed
- A sub-agent on a model that is not Claude, such as a GPT model behind a gateway, is measured against Claude Code's 200k default window, the one Claude Code enforces on it, instead of the main chat's window. Under a 1M main chat, a GPT sub-agent's forced point sat at 600k, every compaction Claude Code asked for from 55k on was skipped, and the agent died at 165k with "Prompt is too long".
- A self-compaction the model asks for below its first nudge point (`mainAutoCompactNudgeStart`, `subagentAutoCompactNudgeStart`) is refused, and the model is told to keep working. A main chat on a 1M window compacted itself at 123k (12%), before any nudge, because the `compact` tool invited a call "after finishing a unit of work while your context is large".

## [0.2.6] — 2026-10-08

### Fixed
- A Workflow run's agents get the sub-agent policy: nudged, armed and held like any sub-agent. `$.agent.list()` never names them, so they were taken for engine loops and left ungoverned (0.2.5), or logged a lookup failure on every tool call and compaction (0.2.4 and earlier). Their type now comes from Claude Code's `SubagentStart` and `SubagentStop` hooks.

## [0.2.5] — 2026-09-28

### Fixed
- A self-compaction the model armed can be called off. The person's message cancels a compaction the main chat armed, and its model is told not to ask again until the ask is done; before this, the message itself set off the compaction it tried to stop.
- An interrupt (Esc or Ctrl+C) during an armed compaction, or a compaction that is skipped or fails, drops the armed request instead of leaving it to fire on the next request.
- An engine loop missing from `$.agent.list()` (a fork Claude Code runs itself) is left to Claude Code's own compaction point, instead of logging a lookup failure on every compaction.

### Changed
- The main chat's nudges say that a person waiting on an answer comes first: finish their ask, and never compact while they wait.

## [0.2.4] — 2026-09-27

### Changed
- A sub-agent is first nudged at 20% of its window, up from 10% (`subagentAutoCompactNudgeStart`).
- Every nudge tells a party on its last job (one task or its final answer left) to finish it first and not compact.
- The plugin names Professor as its maker: the manifest's author and keywords, and the READMEs.
- The marketplace installs the plugin from `main` (a `git-subdir` source), so an install only ever gets a released version while work lands on `develop`.

## [0.2.3] — 2026-09-26

### Changed
- The plugin ships from `plugins/sub-agent-compact/`, the layout Anthropic's marketplace uses.
- The installed plugin holds only what runs: the manifest, an icon, the hooks module and its sources, a README and the LICENSE.

## [0.2.2] — 2026-09-26

### Changed
- A held compaction shows one short notice, such as `main 311k/600k`, since Claude Code draws a notice for every held compaction.

## [0.2.1] — 2026-09-26

### Changed
- Per-agent keys nest under `autoCompact` in frontmatter: `forceAt`, `nudgeFrom`, `nudgeEvery`, `enabled`. A bare `autoCompact: 200k` is shorthand for `forceAt`.
- Sub-agents are forced at 60% of their window by default.

## [0.2.0] — 2026-09-26

### Added
- Self-compaction: the model is nudged as its context grows (main from 20%, sub-agents from 10%, every 10%) and compacts itself at a milestone it chooses, naming what the summary must keep.
- A `compact` tool, and a `<compact-now>` marker for sub-agents that cannot see it.
- Per-party policy: a forced point, the nudge start and step, and an on/off switch, in `settings.json` or agent frontmatter.
- Haiku agents are never touched.

## [0.1.1] — 2026-09-25

### Fixed
- One decision log per session.
- The options key is the full plugin id.

## [0.1.0] — 2026-09-25

### Added
- Separate auto-compact points for the main chat and each sub-agent type, through Claude Code function hooks.

[0.8.0]: https://github.com/rezzminator/sub-agent-compact/compare/sub-agent-compact--v0.4.1...sub-agent-compact--v0.8.0
[0.4.0]: https://github.com/rezzminator/sub-agent-compact/compare/sub-agent-compact--v0.3.1...sub-agent-compact--v0.4.0
[0.3.1]: https://github.com/rezzminator/sub-agent-compact/compare/sub-agent-compact--v0.3.0...sub-agent-compact--v0.3.1
[0.3.0]: https://github.com/rezzminator/sub-agent-compact/compare/sub-agent-compact--v0.2.6...sub-agent-compact--v0.3.0
[0.2.6]: https://github.com/rezzminator/sub-agent-compact/compare/sub-agent-compact--v0.2.5...sub-agent-compact--v0.2.6
[0.2.5]: https://github.com/rezzminator/sub-agent-compact/compare/sub-agent-compact--v0.2.4...sub-agent-compact--v0.2.5
[0.2.4]: https://github.com/rezzminator/sub-agent-compact/compare/sub-agent-compact--v0.2.3...sub-agent-compact--v0.2.4
[0.2.3]: https://github.com/rezzminator/sub-agent-compact/compare/sub-agent-compact--v0.2.2...sub-agent-compact--v0.2.3
[0.2.2]: https://github.com/rezzminator/sub-agent-compact/compare/sub-agent-compact--v0.2.1...sub-agent-compact--v0.2.2
[0.2.1]: https://github.com/rezzminator/sub-agent-compact/compare/sub-agent-compact--v0.2.0...sub-agent-compact--v0.2.1
[0.2.0]: https://github.com/rezzminator/sub-agent-compact/compare/sub-agent-compact--v0.1.1...sub-agent-compact--v0.2.0
[0.1.1]: https://github.com/rezzminator/sub-agent-compact/compare/sub-agent-compact--v0.1.0...sub-agent-compact--v0.1.1
[0.1.0]: https://github.com/rezzminator/sub-agent-compact/releases/tag/sub-agent-compact--v0.1.0
