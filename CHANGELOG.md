# Changelog

Every release of sub-agent-compact. Versions follow [semantic versioning](https://semver.org); each release is the `main` commit tagged `sub-agent-compact--v<version>`, with a GitHub release carrying the section below.

## [Unreleased]

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

[Unreleased]: https://github.com/rezzminator/sub-agent-compact/compare/sub-agent-compact--v0.3.0...develop
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
