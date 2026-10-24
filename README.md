<div align="center">

# forward-compaction

**Compaction for Claude Code where the model writes its own handoff: the main chat and every sub-agent hand off through one tool, and everything after the call stays verbatim.**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Version](https://img.shields.io/badge/version-1.0.0--dev.3-blue)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-526%20passing-brightgreen)](#development)
[![Built with Professor](https://img.shields.io/badge/built%20with-Professor-8A2BE2)](https://github.com/rezzminator/professor)

</div>

```text
forward_compaction({
  "objective": "…", "done": "…", "remaining": "…", "next": "…",
  "load_files": [{ "path": "/abs/plan.md", "why": "the plan I am executing" }]
})
```

<sup>One call, one argument per section. At Claude Code's next compaction the plugin replaces everything before the call with recorded facts plus this handoff, and keeps every message after it word for word.</sup>

---

Claude Code compacts by asking a summarizer to paraphrase the whole
conversation. The paraphrase loses what matters most to the party being
compacted: the person's exact words, a sub-agent's brief, the skills in
force, and the frontier — what is done, what is left, what comes next.

**forward-compaction** lets the model write that frontier itself, while it
still holds the context, and builds the rest from facts the plugin recorded
as they happened.

- ✍️ **The model writes the frontier.** `forward_compaction` takes one
  argument per section — `objective`, `done`, `remaining` and `next` — and
  assembles them into one markdown handoff. It is stored, never summarized,
  and installed verbatim.
- 🧾 **Facts are recorded, never reconstructed.** The person's messages (main
  chat) or the brief (sub-agent), messages from the coordinator, the skills
  loaded, the agents and the background shells come from typed hook events as
  they happened. Nothing is grepped out of a transcript or re-read from disk.
  The person's newest ten messages are also held in Claude Code's session
  state, so a plugin reload (`/reload-plugins`) does not lose them.
- ⏩ **Everything after the call is kept.** The model need not stop after it
  hands off: every message from the call on stays in the new context as it
  was, so no work done after the handoff is lost.
- 👥 **Every party.** The main chat and every sub-agent use the same tool;
  each has its own stored handoff, nudges, readings and ceiling. A model on
  the ignore list (Haiku by default) takes no handoff and is held to its
  ceiling, then compacted mechanically ([Ignored models](#ignored-models)).
- 🛟 **A ceiling as the safety net.** A party that never hands off is
  compacted mechanically at its ceiling: the same recorded facts and its
  newest messages, kept verbatim.
- 📜 **Every decision logged** to a JSONL file per session, and every step
  to a debug log, with the numbers as Claude Code's API gave them.

## 📊 Benchmark

No benchmark of forward-compaction has been measured yet. The figures the
earlier plugin of this repository published measured a different mechanism
(a summarizer run at a milestone) and are not claimed for this one.

## 🚀 Quick start

```sh
# 1. Turn on function hooks, and let Claude Code ask to compact from about 63k
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000

# 2. Install
claude plugin marketplace add https://github.com/rezzminator/sub-agent-compact.git
claude plugin install forward-compaction@forward-compaction
```

Both variables also work in the `env` block of `settings.json`. With the
defaults the main chat is told its context size from 15% of its window,
again every 5%, and asked to hand off at its next clean milestone; it is
compacted mechanically at 60% of its window if it never does. A sub-agent is
measured against a 200k max context: nudged from 80k every 20k, compacted
mechanically at 160k.

> **Early access.** This plugin is built on Claude Code's function hooks,
> an early-access surface that may change between releases. It is tested on
> Claude Code 2.1.309.

Moving from the earlier plugin of this repository? The
[CHANGELOG](./CHANGELOG.md) entry for 1.0.0-dev.1 maps every old setting.

## 🧠 How it works

```mermaid
flowchart LR
    A[Tool call] --> B{Past a<br/>nudge point?}
    B -- no --> A
    B -- yes --> C[Nudge after the result:<br/>hand off at a clean point]
    C --> D[Model calls forward_compaction:<br/>handoff stored]
    D --> E[Next compaction door:<br/>facts + handoff + every later message]
    E --> A
    B -- at the ceiling,<br/>nothing stored --> F[Mechanical wake:<br/>facts + newest messages]
    F --> A
```

A party's context is its last measured reading: the input, cache-read,
cache-write and output tokens of its last completed request, as `turn.step`
reports them. The nudge, the ceiling and the mechanical decision use it, so a
nudge may come one step late. No number is ever estimated from characters: a
party with no reading at all, none yet or none since an install, gets no nudge
and no ceiling, and an automatic ask from it with nothing stored is held as
`no-reading` until its next reading decides.

1. **Nudges.** After a tool result, once a party's context passes its nudge
   start (`FORWARD_COMPACTION_MAIN_NUDGE_START` or
   `FORWARD_COMPACTION_SUBAGENT_NUDGE_START`, a share of its max context), the
   model reads one line saying how large its context is, as tokens and as a
   share of its max context, and that every call re-sends all of it. One more
   follows every `FORWARD_COMPACTION_{MAIN|SUBAGENT}_NUDGE_EVERY`. The line asks
   for a handoff at the next clean milestone, once the step in hand is
   finished and its results are written down, and before the next step
   starts: the model picks the milestone, not
   whether, and skips it only when nothing is left but writing its result
   and its final answer. A held
   compaction ask adds no nudge of its own. After an install, the first
   reading's level is absorbed silently (a sub-agent's floor of system
   prompt, tools and skills is already 55-60k), so the next nudge goes only
   when the context crosses the level above it. A model on the ignore list
   gets no nudge.
2. **Handing off.** The model calls `forward_compaction` (the model sees
   `mcp__forward-compaction__forward_compaction`). The plugin checks the
   section arguments and files and stores the handoff in memory for that party, or
   refuses the call and stores nothing, naming what to fix. A later call
   replaces the stored one.
3. **Installing.** The stored handoff installs at the next door Claude Code
   opens: for the main chat at the end of the turn (the plugin asks Claude
   Code to compact) or at an automatic ask if one comes first; for a
   sub-agent at Claude Code's next automatic ask. No summarizer request runs.
4. **The ceiling.** An automatic ask with nothing stored is held. Once the
   party reaches its ceiling with still
   nothing stored, or Claude Code asks again with no response in between
   (its "prompt is too long" recovery), the plugin installs a mechanical wake.

### The tool

`forward_compaction({objective, done, remaining, next, blocked, findings, load_files})`,
with its schema in the prompt's tool list (not deferred), so a nudged model
needs no ToolSearch.

- `objective`, `done`, `remaining`, `next` (required): non-blank strings —
  what the work is for and what done means; the finished pieces, each with
  how it was verified; every step left, in order; the first concrete action
  after the wake.
- `blocked`, `findings` (optional): strings — what waits on whom; decisions
  with why, errors verbatim. Absent or blank, the section is left out.
- The plugin assembles the handoff as `## Objective`, `## Done`,
  `## Remaining`, `## Next`, then `## Blocked` and `## Findings` when given,
  each heading followed by its argument verbatim and a blank line between
  sections. The assembled handoff is at most 20,000 characters. Nothing is
  ever trimmed.
- `load_files` (optional): at most 8 `{path, lines?, why}` entries, each an
  absolute path to a regular file of at most 1,048,576 bytes, `why` 1–200
  characters, `lines` a range like `10-40` or `1-60,160-185`. Each file is
  read when the handoff installs and carried whole. Carried files get a room
  of 5% of the party's max context, turned into characters at the party's
  measured characters per token (see the wake's budget below). A call
  whose files, one or together, exceed it is refused, never trimmed, and a
  `lines` range counts only its lines. With no ratio measured yet the files
  are accepted without a size check, and a warning row says so. A file that has grown past the room by install is named as not
  carried, never cut.

The result is a receipt saying when the handoff installs — for the main chat
at the end of this turn, for a sub-agent at Claude Code's next ask (with
where that ask comes) — and, when it replaced one, that it did. It prints no
context size: the plugin measures none for that moment. A refusal starts
`forward_compaction refused, nothing stored:` and names what to fix: every
unknown field and every bad section argument, one line each, in one refusal;
then an assembled handoff over the cap, with its total; then a bad
`load_files` entry, or a file that is absent, not a regular file, too large
or could not be checked; then load files over the room, each named with its
size, with the room, and asking for `lines` ranges or fewer files. A refusal is a tool answer, not an error, so the
model reads it and calls again.

Every answer, receipt and refusal alike, ends with one line saying the
plugin is experimental and asking the model to append a short note of any
trouble to `issues.md` in the level-log directory (the reply itself when no
directory resolves).

### The wake

The installed context is, oldest first: one facts message, one handoff
message, then the messages after the call, returned as Claude Code holds
them. The handoff message carries the call's own receipt, since the install
replaces the message that held it, and, like a mechanical wake's message,
ends with the experimental line and where to note any trouble.

The facts message holds, each section only when it has content:

- the brief (sub-agent), verbatim, or the person's newest ten messages
  (main chat), oldest first;
- messages from the coordinator (sub-agent) or notifications delivered
  (main chat);
- the results of the tool calls made in the same response as the handoff;
- the skills in force, as they were loaded. A skill Claude Code loaded
  without saying which party loaded it is named, not carried, in every
  party's wake, with the call that loads it again;
- the agents, listed at install (at most 50 rows): for main every agent, for a
  sub-agent only the agents it spawned (`parentId` its own id);
- the background shells and crons, from the newest Stop event, with its age.
  The list is session-wide, not per agent; before any Stop event it says the
  running shells are unknown;
- the files the handoff asked to carry, and the ones not carried with why.

Its size is held to a budget of half Claude Code's ask point (the
`autoCompactThreshold` that `$.session.usage` reports, held at or below the
party's max context: 31,500 tokens at `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`),
turned into characters at the party's measured characters per token: the
characters over the tokens it has grown since its base, its live window's
characters (from `$.session.messages({ as: 'api' })`, the messages its next
request is built from) and reading at its first reading since it started or
was last compacted, so the system prompt, tools and skills every reading
counts cancel. It is unmeasured until the reading has grown 5,000
tokens past the base, or outside 1 to 8 characters a token, and unmeasured
nothing is fitted: a handoff's wake carries the facts, the files and every
message after the call, and a mechanical wake keeps no earlier message. Each section has a share — brief or person's messages 25%,
coordinator messages or notifications 5%, sibling results 10%, skills 25%,
and the files their own room above — and is carried whole or named as
not carried, never cut; the person's messages and skills are carried newest
first while they fit. The room left goes to the messages after the call: the
oldest are dropped whole until the rest fits, and the handoff message says
how many were dropped.

The handoff message carries the handoff verbatim, tells the model it is its
frontier and to continue from `## Next`, and says how many later messages
follow. A mechanical wake replaces it with a message saying no frontier was
written, how many of the newest messages were kept and how many are gone,
and to re-establish the objective from the person's messages or the brief.

Each install writes one line, measured: it waits for the party's first
reading after the install. A handoff the model chose is routine, so its line
is an info row in the logs, never on screen:
`main handoff landed — 164k → 46k context, measured; frontier 4,812 characters, 3 facts, 5 messages kept verbatim.`
A mechanical wake lost the model's frontier, so its line is also printed:
`Explore 3f2a9c had no handoff at 125k (ceiling 120k) — mechanical wake installed, 125k → 38k context, measured.`
Before is the party's last reading before the install, after its first one
since. A party that ends before a request measures it gets its line at its
end, with after said as unknown, never guessed.

### What else happens at a compaction

- A person's `/compact` runs Claude Code's own summary untouched; a stored
  handoff is dropped, and the screen says so.
- A message the person sends after the call does not cancel a stored handoff:
  it is among the messages kept after the call.
- A stored handoff whose call is no longer in the party's transcript
  (something else compacted it) is dropped and said on screen; the ask is
  then judged as if nothing were stored.
- An engine loop that is not one of the session's sub-agents (a fork Claude
  Code runs itself) is left to Claude Code.
- A `precompute` ask is skipped: it is never used.
- An error inside the compaction hook never reaches Claude Code: the plugin
  installs a mechanical wake instead, built without any read, and if that
  fails too, Claude Code's own summary runs. Either way the error is on the
  screen.
- When the main chat's turn-end install is skipped or rejected, the handoff
  stays stored for the next turn end or ask, and a skip is said on screen.
- A party's context that falls to half or less with no compaction this
  plugin handled (another plugin or Claude Code compacted it) is said on
  screen.

### Look back

`look_back` (`mcp__forward-compaction__look_back`) searches only the caller's
own transcript before its latest compaction, for an exact detail the wake no
longer holds. Supply `query` (case-insensitive words; double quotes keep a
phrase whole) or `entry: N` to fetch one entry whole. Results rank by how
many terms an entry holds, then newest first. Every call is logged as a
compaction miss, and the person is told what was looked up.

## ⚙️ Configuration

### Options

Every option is an environment variable, set in the shell that starts Claude
Code or in the `env` block of `settings.json`. The plugin declares no
`userConfig` and has no `/config` screen; an options object handed to it is
named in one warning and not applied. An unset, empty or blank variable is
absent and the default applies; a bad value is named by its variable on the
screen and in the log, and the default applies.

A **size** is a token count (`100000`), a number with a k/m suffix
(`100k`, `0.6m`), or a percentage of the party's max context above 0 and at
most 100 (`60%`). A **max context** is a token count, never a percentage. A
**flag** is `1`, `0`, `true` or `false` in any case. A **model list** is
comma-separated, case-insensitive substrings of the model id a step reports;
set empty, it ignores no model (the one option whose empty value is a value).

| Variable | Type | Default | Meaning |
| --- | --- | --- | --- |
| `FORWARD_COMPACTION_MAIN_MAX_CONTEXT` | max context | `window` | The main chat's max context, which its sizes are a percentage of: by default the window `$.session.usage()` reports, read at start and again after `/model`. |
| `FORWARD_COMPACTION_MAIN_CEILING` | size | `60%` | With no handoff stored, the main chat's context at which the plugin installs a mechanical wake (1M window → 600k). |
| `FORWARD_COMPACTION_MAIN_NUDGE_START` | size | `15%` | The main chat's context at which it is first told its size and that it may hand off. |
| `FORWARD_COMPACTION_MAIN_NUDGE_EVERY` | size | `5%` | How much the main chat's context grows between nudges. |
| `FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT` | max context | `200k` | Every sub-agent's max context, Haiku included: Claude Code's API reports no sub-agent's window ([Max contexts](#max-contexts)). |
| `FORWARD_COMPACTION_SUBAGENT_CEILING` | size | `80%` | With no handoff stored, a sub-agent's context at which the plugin installs a mechanical wake (160k on 200k). |
| `FORWARD_COMPACTION_SUBAGENT_NUDGE_START` | size | `40%` | A sub-agent's first nudge (80k on 200k), above the 55-60k a sub-agent lands at after an install, so a handoff never loops. |
| `FORWARD_COMPACTION_SUBAGENT_NUDGE_EVERY` | size | `10%` | How much a sub-agent's context grows between nudges (20k on 200k). |
| `FORWARD_COMPACTION_CEILING_NATIVE` | flag | `0` | `1`: at any party's ceiling with no handoff, Claude Code's own summary runs instead of the mechanical wake. |
| `FORWARD_COMPACTION_IGNORE_MODELS` | model list | `haiku` | Models that take no handoff: no nudge, the tool refused, every ask held to the ceiling and then compacted mechanically ([Ignored models](#ignored-models)). |
| `FORWARD_COMPACTION_DEBUG` | flag | `1` | `0`: no `debug.jsonl`, the row the plugin writes at every step. |
| `FORWARD_COMPACTION_LOG_FILE` | path | `~/.local/state/forward-compaction/logs/decisions/.jsonl` | Where decision rows go; each session writes `{session}.jsonl` beside it. With `PLUGIN_LOG_DIR` set the default is `$PLUGIN_LOG_DIR/forward-compaction/decisions/.jsonl`. A relative path is refused and the default applies. |

A nudge start at or past its party's ceiling in the same unit is kept and
named once: no nudge goes out before the ceiling. A ceiling below Claude
Code's ask point is named once at start, for the main chat and for
sub-agents: a party with no handoff is then compacted mechanically at its
first ask.

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "100000",
    "FORWARD_COMPACTION_MAIN_CEILING": "60%",
    "FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT": "200k",
    "FORWARD_COMPACTION_IGNORE_MODELS": "haiku"
  }
}
```

The plugin also reads, and does not own, `PLUGIN_LOG_DIR`, `HOME` and
`CLAUDE_CONFIG_DIR` (for `look_back`). It reads no
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`: Claude Code's own compaction window and
ask point come from `$.session.usage`.

### The window rule

A plugin can hold a compaction back, but it can't make Claude Code ask
sooner. The plugin reads where Claude Code asks from `$.session.usage`: the
breakdown's `autoCompactThreshold` (about 63k with
`CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`), against its compaction window
`rawMaxTokens`. When auto-compaction is off, or no breakdown is reported, a
warning row says which, and the ask point is taken as `rawMaxTokens`, else the
window. A sub-agent's handoff installs only at such an ask, so **set
`CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`**: when the compaction window Claude
Code reports is above 100000 the plugin says so once at start, with that
window, its source and the ask point. Past that point Claude Code asks
before every request, so a stored handoff installs at the party's next
request. The low window is there so the plugin can install a handoff
whenever the model writes one, never to force one: a held ask changes no
nudge, and the model keeps picking its milestone until the ceiling. The main chat does not wait for an ask: its handoff installs at the
end of its turn.

Letting a plugin start a compaction for any sub-agent from code would remove
this rule. It is requested upstream in
[anthropics/claude-code#91870](https://github.com/anthropics/claude-code/issues/91870#issuecomment-5848066352).

### Max contexts

Sizes are percentages of each party's max context. The main chat's is the
window Claude Code reports through `$.session.usage()`, read at session
start, at the main chat's first request when not read yet, and again when its
model changes (`/model`); `FORWARD_COMPACTION_MAIN_MAX_CONTEXT` sets it
instead. Until it is known (set, or reported) the main chat gets no nudge and
no ceiling. A sub-agent's is `FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT`, 200k by
default, for every model: Claude Code's API reports only the main chat's
window, so the plugin never guesses a sub-agent's from its model id. A
sub-agent on a model with a different window gets a matching
`FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT`, or goes on the ignore list.
Claude Code's ask point for a party is held at or below its max context.

### Ignored models

A party whose model id holds an entry of `FORWARD_COMPACTION_IGNORE_MODELS`
(`haiku` by default, case-insensitive) takes no handoff: it gets no nudge, its
`forward_compaction` call is refused with nothing stored, naming the entry and
the ceiling, and every automatic compaction ask is held, as for any party with
nothing stored, until its ceiling. There it gets the mechanical wake (Claude
Code's own summary with `FORWARD_COMPACTION_CEILING_NATIVE=1`); Claude Code's
"prompt is too long" recovery gets it at once. It is never compacted at
Claude Code's early ask. A manual `/compact` runs Claude Code's summary as for
any party. A party is judged each time a request names its model, and again
after `/model`; a sub-agent no request has named a model for yet is judged
`unknown`, never `managed`; the decision log's `ignore` row records each judgement with
the entry matched, and a held ask's row carries `why: ignored-model`.

With the defaults, on the 200k sub-agent max context:

| Sub-agent | Nudges | Held | Mechanical wake |
| --- | --- | --- | --- |
| Sonnet or Opus | at 80k, 100k, 120k and 140k | every ask below 160k with nothing stored | at 160k |
| Haiku (ignored) | none | every ask below 160k, Claude Code's 63k ask included | at 160k |

### State on disk

| Path | What | Retention |
| --- | --- | --- |
| `~/.local/state/forward-compaction/logs/decisions/{session}.jsonl` (`$PLUGIN_LOG_DIR/forward-compaction/decisions/` when set) | decision rows: every handoff stored or refused, every nudge, every compaction decision, every `landed` row (`{party, kind, before, after, line}`, `kind` being `handoff` or `mechanical`, `before` and `after` the measured readings or `null`, written with the landed line), every `ignore` row (`{party, label, model, judged, matched}`, `judged` being `managed`, `ignored` or `unknown`, `matched` the ignore-list entry or `null`, written when a party's judgement is first made or changes); a held-ask streak is one folded `skips` row, written when the streak closes and stamped with its last ask's time, so it can follow later rows | a file over 8 MiB moves to `.1`; other sessions' files older than 14 days, then all but the newest 200, are deleted |
| `~/.local/state/forward-compaction/logs/{errors,warnings,info}.jsonl` (`$PLUGIN_LOG_DIR/forward-compaction/` when set) | the plugin's errors, warnings and info: every decision event lands at its level — errors and warnings in their files, every other operational event (nudge, stored, refused, each compaction decision, party, skill, tool-registered, look-back, the lines said) in `info.jsonl`, a held-ask streak folded into its first row and one `skips` row | a level file over 20 MiB moves to `.1` |
| `debug.jsonl` in the same directory (with `FORWARD_COMPACTION_DEBUG` on) | a row at every step: each hook entry (hook, party, trigger, model), each `$` answer the plugin decides on (`session.usage` figures, the `agent.list` count, each `turn.step` reading with its four counts and model, `fs.stat` results), the options and variables resolved, each ratio base and each ratio, measured or not and why, with the base's characters and tokens and the characters and reading now, each wake's section sizes and files, each nudge sent or withheld and why, and every decision row whole; numbers as the API gave them | a level file over 20 MiB moves to `.1` |
| `issues.md` in the same directory | notes a model appends when the plugin gave it trouble, as each tool answer asks | not managed by the plugin |
| anything else | none: the recorded facts and the stored handoffs live in memory only | — |

Errors always reach the screen and the log. Warnings and info stay in the
logs while a log works, and reach the screen when no log is available or
logging fails. Rows never hold handoff or transcript bodies.

## ❓ FAQ

<details>
<summary><b>How is this different from Claude Code's own compaction?</b></summary>

Claude Code asks a summarizer to rewrite the whole conversation. Here the
model writes the frontier itself through `forward_compaction`, the plugin
supplies the facts it recorded, and every message after the call stays
verbatim. No summarizer request runs.
</details>

<details>
<summary><b>What if the model never calls the tool?</b></summary>

It is told its context size from its nudge start (15% of the main chat's
window, 80k of a sub-agent's 200k), again at each step after, and asked to
hand off at its next clean milestone. At its ceiling (60% of the main chat's
window, 160k for a sub-agent, by default) the plugin installs a mechanical wake: the recorded facts
and the newest messages that fit, with a line telling the model no frontier
was written. Set `FORWARD_COMPACTION_CEILING_NATIVE=1` to let Claude Code's
own summary run there instead.
</details>

<details>
<summary><b>Does a sub-agent with a <code>tools:</code> allowlist get the tool?</b></summary>

A sub-agent's tool list is not visible to the plugin, so it is nudged anyway;
the nudge tells it to carry on if the tool is not in its list. Such a
sub-agent is compacted mechanically at its ceiling, keeping its brief, its
skills and its newest messages.
</details>

<details>
<summary><b>Why doesn't the PreCompact hook work for this?</b></summary>

The classic `PreCompact` hook fires for a sub-agent's compaction without the
agent's id, so it can't tell which party is compacting
([#91910](https://github.com/anthropics/claude-code/issues/91910)). Function
hooks carry `agentId` on `session.compact`, which is what this plugin
decides on.
</details>

<details>
<summary><b>Does a handoff survive a restart or <code>claude --resume</code>?</b></summary>

No. Stored handoffs and recorded facts live in the plugin's memory: the main
chat installs at the same turn's end, and a sub-agent ends with its process.
The handoff text stays in the transcript as the tool call's input, where
`look_back` finds it. After a resume the facts message says when recording
started.
</details>

## 🛠️ Development

```sh
npm install
npm test              # unit, adapter, replay and layout tests
npm run typecheck
npm run validate:plugin
npm run replay:record # records a live replay fixture (a paid Claude Code session)
```

The replay test (`tests/replay.test.ts`) drives a recorded live session through the current plugin and pins what carries format risk, never the plugin's own call sequence. Hook events and their payloads replay exactly as recorded. A read of engine state (`agent.list`, `env.get`, `fs.read`, `fs.stat`, `session.usage`, `session.messages`, `session.compact`) takes its recorded answer: the same call's when the arguments match, else the latest answer recorded for that path (for `env.get`, `fs.read` and `fs.stat`, for the same variable or file) at that point of the timeline; one the recording never holds fails as `unrecorded $ call {path}`, and the fixture is re-recorded. Utility and effect calls are the harness's: `session.id` and `clock.now` give the recorded id and time, `ui.log` is captured, `tool.register` gives the recorded registration, `clock.after` never fires, and `process.run` really runs the plugin's argv in a temporary sandbox standing in for the recorded home, refusing any path outside it. The table is `ANSWERS` in `tests/fakes/replay-engine.ts`.

The live replay fixture exercises every replay invariant but two, which the replay test names: I2, a precompute ask (Claude Code 2.1.309 sent none; `tests/decide.test.ts` covers C2), and I11, tail handles shared by two chained installs (a chained handoff's call comes after everything the install before it kept, so the two tails share no message).

Work lands on `develop`; `main` holds only releases. Merging the `develop → main` pull request is the release: [`release.yml`](./.github/workflows/release.yml) tags the merge commit `forward-compaction--vX.Y.Z` and publishes its notes from [CHANGELOG.md](./CHANGELOG.md). `make release-check` runs that pull request's checks locally first. Pull requests go to `develop`.

`plugins/forward-compaction/hooks/forward-compaction.ts` is a thin adapter over `plugins/forward-compaction/src/`:

| Module | Role |
| --- | --- |
| `options.ts` | Sizes, flags and the `FORWARD_COMPACTION_*` variables, resolved with their defaults |
| `window.ts` | Claude Code's ask point from `$.session.usage`, the ignore list, each party's marks against its max context, the measured characters per token, the load-file room |
| `ledger.ts` | The facts recorded from typed hook events, per party |
| `handoff.ts` | The tool's description and schema, its validation and refusals, and the receipt |
| `wake.ts` | The split at the call, the budget, the facts and handoff messages, the tail that fits, the screen lines |
| `decide.ts` | The decision for one compaction ask, and a party's reading |
| `nudge.ts` | Nudge levels and text |
| `parties.ts` | Per-party state: readings, the stored handoff, nudges sent |
| `unseen.ts` | A context fall no compaction of this plugin explains |
| `look-back.ts` | The `look_back` tool |
| `log.ts` | The decision log and the level logs |
| `bounded.ts` | Bounds a promise with a timer passed in: tool registration holds a turn at most 5s |
| `register.ts` | Which tools still need a registration try, up to three each |

## 🎓 Built with Professor

forward-compaction is built and maintained with [Professor](https://github.com/rezzminator/professor), a fleet controller and discipline layer for Claude Code, Codex and OpenCode: chats that message each other, agents held to the project's rules, and gated releases. Professor runs long orchestrations of sub-agents, and keeping their work intact across compactions is why this plugin exists.

## License

MIT

<sub>Keywords: Claude Code compaction · model-written handoff · forward compaction · sub-agent compaction · self-compaction · context window management · CLAUDE_CODE_AUTO_COMPACT_WINDOW · Claude Code plugin · function hooks · Claude Mods · multi-agent orchestration</sub>
