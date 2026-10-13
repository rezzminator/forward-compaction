# Changelog

Every release of sub-agent-compact. Versions follow [semantic versioning](https://semver.org); each release is the `main` commit tagged `sub-agent-compact--v<version>`, with a GitHub release carrying the section below.

## [Unreleased]

## [0.5.1] — 2026-10-13

### Fixed
- Registering the tools no longer holds a turn without limit: past 5 seconds the turn goes on, a warning says so once, the plugin stops waiting on registration, and a registration that finishes late still names the tools. (`session.start` or its first call hanging before registration is not bounded.)
- After a plugin reload, a main-chat step with at most three messages is read as the session's first request only when the session has sent exactly one prompt (`$.session.turns()`), so the step after a CLI compaction (a summary and the prompt) no longer yields a false "cutting each later request to about …" claim. The prompt count unreadable leaves the claim out, with a warning.
- A handoff stored in the transcript is no longer dropped because a task notification, a system reminder or a local command's output (text the harness wrote) came after it; a person's message, an interrupt included, still cancels it.
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
