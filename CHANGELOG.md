# Changelog

Every release of sub-agent-compact. Versions follow [semantic versioning](https://semver.org); each release is the `main` commit tagged `sub-agent-compact--v<version>`, with a GitHub release carrying the section below.

## [Unreleased]

## [0.8.0-dev.2] — 2026-10-16

### Fixed

- A log or lock directory that cannot be created names its path on stderr, so the error is useful where `mkdir` omits the path (uutils coreutils prints only `Permission denied`).
- A decision-log append that fails, such as one an interrupt aborts, keeps its rows for the next write instead of dropping them; rows still unwritten at session end, and any the 2,000-row hold let go, are counted on screen and as a `decision-log-rows-lost` error row.
- Cleaning up old decision logs runs one `find` instead of one per file (past 15 s under load at 200 files), after the session's first rows are written; its failure is also a `decision-retention-failed` decision row.
- A tool registration past 5s says it goes on, and its late finish is a `tools-late` row naming the tools and the wait.
- `drop_skills` naming a skill not invoked since the last compaction says so and to leave it out, instead of "not invoked".
- An install's after-size is labelled as the messages only (`tokens in messages (system prompt and tools not counted)`, row and forward `record.json` `tokensAfterScope`).
- `look_back` reads `\"` in a query as a literal quote, in a phrase or a word, and finds a term holding a quote or a backslash in a message or a tool call's input (the transcript stores them escaped in a string, bare in a tool input's JSON); a bad query, an entry at or after the boundary, or one not found is logged as a warning, not an error.
- A forward handoff claims its call number with one `mkdir` that sees the real directory, so a call the listing missed is never written over; the record of the handoff the session holds is also read through the `saved` path its text names, when that call is this party's own; a record still missing names the handoff's number, every place looked and a saved path that is not this chat's.

## [0.8.0-dev.1] — 2026-10-15

### Removed

- The plugin's `userConfig` (and with it `pluginConfigs["sub-agent-compact@sub-agent-compact"].options`, `/config` and the option layer): every option is read from its `SUB_AGENT_COMPACT_*` environment variable alone, an unset, empty or blank variable giving the default. A non-empty options object handed to the plugin is not applied; the plugin finds a leftover entry in any settings source and names its keys in one warning, once.

### Changed

- `resolveOptions` resolves variable over default; a bad value is named by its variable and the default applies, and so does a variable that could not be read.
- Migration: move each value from `pluginConfigs["sub-agent-compact@sub-agent-compact"].options` to the variable in the README options table (`mainAutoCompact: "600k"` becomes `SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT=600k`; `forwardHandoffTool: true` becomes `SUB_AGENT_COMPACT_FORWARD_HANDOFF_TOOL=1`), in the `env` block of `settings.json` or the shell that starts Claude Code, then delete the `pluginConfigs` entry.

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

[Unreleased]: https://github.com/rezzminator/sub-agent-compact/compare/sub-agent-compact--v0.4.0...develop
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
