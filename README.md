<div align="center">

# forward-compaction

**Compaction for Claude Code where the model writes its own frontier: the main chat and every sub-agent compact through one tool, and the newest messages after the call stay verbatim.**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Version](https://img.shields.io/badge/version-1.0.0-blue)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-616%20passing-brightgreen)](#development)
[![Built with Professor](https://img.shields.io/badge/built%20with-Professor-8A2BE2)](https://github.com/rezzminator/professor)

</div>

```text
forward_compaction({
  "objective": "…", "done": "…", "remaining": "…", "next": "…",
  "load_files": [{ "path": "/abs/plan.md", "why": "the plan I am executing" }]
})
```

<sup>One call, one argument per section. At Claude Code's next compaction the plugin replaces everything before the call with recorded facts plus this frontier, and keeps every message after it word for word.</sup>

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
  assembles them into one markdown frontier. It is stored, never summarized,
  and installed verbatim.
- 🧾 **Facts are recorded, never reconstructed.** The person's messages (main
  chat) or the brief (sub-agent), the messages delivered to it, the skills
  loaded, the agents and the background shells come from typed hook events as
  they happened. Nothing is grepped out of a transcript or re-read from disk.
  Each party's newest prompts (the person's ten newest messages, or a
  sub-agent's brief and the ten newest delivered to it) and the skills it loaded
  (the latest text of each), and the standing orders of its last stored
  frontier, are also held in Claude Code's session state, so a
  plugin reload (`/reload-plugins`) does not lose them. The files touched and the task list come from each finished tool call.
- ⏩ **The messages after the call are kept.** The model need not stop after it
  compacts: the newest messages from the call on stay in the new context as
  they were, as many as fit, and any left out are named as not carried. Anything delivered between
  the call and the install that those messages lack (a notification of an
  agent or command finishing, the person's message, a coordinator's message)
  is carried in the wake under its own heading, as the model has not read it.
- 👥 **Every party.** The main chat and every sub-agent use the same tool;
  each has its own stored frontier, nudges, readings and ceiling. A model on
  the ignore list (Haiku by default) takes no frontier and is held to its
  ceiling, then compacted mechanically ([Ignored models](#ignored-models)).
- 🛟 **A ceiling as the safety net.** A party that never compacts is
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
again every 5%, and asked to compact at its next clean milestone; it is
compacted mechanically at 60% of its window if it never does. A sub-agent is
measured against a 200k max context: nudged from 80k every 20k, compacted
mechanically at 160k.

> **Early access.** This plugin is built on Claude Code's function hooks,
> an early-access surface that may change between releases. It is tested on
> Claude Code 2.1.309.

Moving from the earlier plugin of this repository? The
[CHANGELOG](./CHANGELOG.md) entry for 1.0.0, "Migrating from 0.8.0", maps every old setting.

## 🧠 How it works

```mermaid
flowchart LR
    A[Tool call] --> B{Past a<br/>nudge point?}
    B -- no --> A
    B -- yes --> C[Nudge after the result:<br/>compact at a clean point]
    C --> D[Model calls forward_compaction:<br/>frontier stored]
    D --> E[Next compaction door:<br/>facts + frontier + every later message]
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
   share of its max context. One more follows every
   `FORWARD_COMPACTION_{MAIN|SUBAGENT}_NUDGE_EVERY`. The line asks it to call
   `forward_compaction` once its current step is done, never in the middle of
   one, and to skip it only when nothing is left but its final answer; it
   names the ceiling and, for a sub-agent before its gate, the point from
   which its other calls wait. A held
   compaction ask adds no nudge of its own. After an install, the first
   reading's level is absorbed silently (a sub-agent's floor of system
   prompt, tools and skills is already 55-60k), so the next nudge goes only
   when the context crosses the level above it and has grown by at least
   one `NUDGE_EVERY` past that first reading: a first reading just under a
   level brings no nudge a few thousand tokens later. A model on the ignore list
   gets no nudge.
   A sub-agent gets one step to pick its milestone: one nudge level past its
   first nudge since its last install (100k with the defaults), its calls
   wait for its frontier. Every call but `forward_compaction`, `look_back` and
   `ToolSearch` is refused, unrun, with a line saying to compact first, then
   repeat the call. Once the frontier is stored every call runs again. The
   refusal also says that a party with only its result and final answer left,
   or without the tool, repeats the call: the repeat runs, and so does every
   later call, nudged, to its ceiling. The
   main chat is never held this way: its person steers it.
2. **Compacting.** The model calls `forward_compaction` (the model sees
   `mcp__forward-compaction__forward_compaction`). The plugin checks the
   section arguments and files and stores the frontier in memory for that party, or
   refuses the call and stores nothing, naming what to fix. A later call
   replaces the stored one.
3. **Installing.** The stored frontier installs at the next door Claude Code
   opens: for the main chat at the end of the turn (the plugin asks Claude
   Code to compact) or at an automatic ask if one comes first; for a
   sub-agent at Claude Code's next automatic ask. No summarizer request runs.
4. **The ceiling.** An automatic ask with nothing stored is held. Once the
   party reaches its ceiling with still
   nothing stored, or Claude Code asks again with no response in between
   (its "prompt is too long" recovery), the plugin installs a mechanical wake.

### The tool

`forward_compaction({objective, done, remaining, next, blocked, findings, load_files, drop_skills, standing_orders, lifted})`,
with its schema in the prompt's tool list (not deferred), so a nudged model
needs no ToolSearch.

- `objective`, `done`, `remaining`, `next` (required): non-blank strings —
  what the work is for and what done means; the finished pieces, each with
  how it was verified, every figure with the command that produced it; every
  step left, in order; the first concrete action after the wake.
- `blocked`, `findings` (optional): strings — what waits on whom; decisions
  with why, errors verbatim, the commands and recipes the party will need
  again. Absent or blank, the section is left out.
- The plugin assembles the frontier as `## Objective`, `## Done`,
  `## Remaining`, `## Next`, then `## Blocked` and `## Findings` when given,
  each heading followed by its argument verbatim and a blank line between
  sections. The frontier has no length cap: it is stored and installed
  whole, never trimmed.
- `load_files` (optional): at most 8 `{path, lines?, why}` entries, each an
  absolute path to a regular file, `why` 1–200 characters, `lines` a range
  like `10-40` or `1-60,160-185`. Their size never refuses the frontier: it is
  always stored. Each file is read when the frontier installs and carried
  whole while its room lasts: 5% of the party's max context, turned into
  characters at the party's measured characters per token (see the wake's
  budget below), a `lines` range counting only its lines. Each file left out
  is named under `## Files not carried` with its size, the room left and the
  room, never cut; with no ratio measured yet every file is carried.
- `drop_skills` (optional): at most 32 names of skills or commands the party
  loaded and no longer needs. A name is dropped only when two frontiers in a
  row name it: the second one's wake leaves it out, and so does every later
  wake until the party loads it again. A frontier that does not name it starts
  the count again. A skill or command whose file's frontmatter sets
  `forward-compaction-keep: true`, or that `FORWARD_COMPACTION_KEEP_SKILLS`
  names, is never dropped, whoever asks; the wake
  marks it `pinned: never dropped`. The receipt says, per name, whether it
  was dropped, waits for the next frontier, is pinned, or was never loaded.
- `standing_orders` (optional): the person's orders that bind the rest of the
  work (a prohibition, a limit, a rule), each `{order, at}`: `order` the
  person's words verbatim, `at` the ISO time of the message that gave it. The
  model names them; the plugin never guesses one from the person's wording.
  The plugin remembers the standing orders of each party's last stored
  frontier, across installs, the mechanical wake, the person's own `/compact`
  and a plugin reload, and the party's next frontier must carry each one again,
  with the same `order` text, or lift it.
- `lifted` (optional): the orders the person has lifted, each `{order, by}`:
  `order` exactly the text the last frontier carried, `by` the person's words
  that lifted it, verbatim. A lift counts only when `by` is found in a message
  the plugin recorded for the party and sent after the order's `at`: the
  person's messages for the main chat, its brief or a message delivered to it
  for a sub-agent. Words said before the order was given lift nothing. Only a
  lift clears a remembered order.

The result is a receipt saying when the frontier installs — for the main chat
at the end of this turn, for a sub-agent at Claude Code's next ask (with
where that ask comes) — and, when it replaced one, that it did. It prints no
context size: the plugin measures none for that moment. A refusal starts
`forward_compaction refused, nothing stored:` and names what to fix: every
unknown field and every bad section or order argument, one line each, in one
refusal; then a bad `drop_skills`; then every standing order the last frontier
carried that this one neither carries nor lifts, named with its time, every
`lifted` entry whose `by` text no recorded message sent after the order holds
(named with the order's time), that names no
remembered order, or whose order is also carried, one line each, in one
refusal; then a bad
`load_files` entry, or a file that is absent, not a regular file or could
not be checked. A refusal is a tool answer, not an error, so the
model reads it and calls again.

Every answer, receipt and refusal alike, ends with one line saying the
plugin is experimental and asking the model to append a short note of any
trouble to `issues.md` in the level-log directory (the reply itself when no
directory resolves).

### The wake

The installed context is, oldest first: one facts message, one frontier
message, then the messages after the call, returned as Claude Code holds
them. The frontier message carries the call's own receipt, since the install
replaces the message that held it, and, like a mechanical wake's message,
ends with the experimental line and where to note any trouble.

The facts message opens with the plugin version that built the wake
(`compacted by forward-compaction 1.0.0`), so a chat on an old build shows
it. It holds, each section only when it has content:

- the standing orders, first, under `## Standing orders — binding until the
  person lifts them`: each order the frontier carried with its time, carried
  whole, outside the budget; then each order lifted since the last install,
  once, with the person's lifting words, and never again. A mechanical wake
  carries the party's remembered orders the same way, and the frontier
  message and the mechanical wake's message both say to continue within
  them;
- what arrived after the frontier and the kept messages lack: every
  notification, message from the person or the coordinator, and message that
  resumed a sub-agent, verbatim, first;
- the brief (sub-agent), verbatim, or the person's newest ten messages
  (main chat), oldest first, always carried whole, whatever their size. A
  wake carries text only: each `[Image #N]` in them reads
  `[Image #N] (image not carried: the wake cannot hold images)`. A resumed
  sub-agent's resuming message is a delivered message, never part of its
  brief;
- the newest ten messages delivered to the sub-agent (its coordinator's, and
  the notifications that resumed it) or the notifications delivered (main
  chat);
- the results of the tool calls made in the same response as the frontier;
- every skill and command in force, whole, as it was loaded, whatever its
  size. A skill Claude Code loaded
  without saying which party loaded it is named, not carried, in every
  party's wake, with the call that loads it again;
- the agents, listed at install (at most 50 rows): for main every agent, for a
  sub-agent only the agents it spawned (`parentId` its own id);
- the background shells and crons, from the newest Stop event, with its age.
  The list is session-wide, not per agent; before any Stop event it says the
  running shells are unknown;
- the commands the party ran, newest first, under `## Commands you ran,
  newest first`: each finished `Bash` call's command verbatim under its
  `description`, a failed one too (it is the command to rerun), a denied one
  never, never their output; at most 20, a command run again kept at its
  newest run, the older ones named as not carried;
- the files the party touched, newest first, at most 15 paths, each tagged R
  read, E edited or W written (its strongest touch), from its finished `Read`,
  `Edit`, `MultiEdit`, `Write` and `NotebookEdit` calls; a denied or failed
  call touched nothing;
- the task list as last set, from `TodoWrite` or `TaskCreate`/`TaskUpdate`,
  whichever moved last, carried whole within 5% of the budget or named as not
  carried;
- the files the frontier asked to carry, and the ones not carried with why.

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
nothing is fitted: a frontier's wake carries the facts, the files and every
message after the call, and a mechanical wake keeps no earlier message. The standing orders, the brief or the person's newest ten messages
and every skill and command the party invoked are carried whole, outside the
budget. Every other section has a share — what arrived after the frontier 25%,
delivered messages or notifications 5%, sibling results 10%, the task list
5%, the commands 5%, and the files their own room above — and is carried whole or named as
not carried, never cut. The room left goes to the messages after the call: the
oldest are dropped whole until the rest fits, and the frontier message says
how many were dropped.

The frontier message carries the frontier verbatim, tells the model to
continue from its `## Next`, and says how many later messages
follow. A mechanical wake replaces it with a message saying no frontier was
written, how many of the newest messages were kept and how many are gone,
and to re-establish the objective from the person's messages or the brief.

Each install writes one line, measured: it waits for the party's first
reading after the install, and is an info row in the logs, never on screen.
A frontier the model chose:
`main frontier landed — 164k → 46k context, measured; 4,812 characters, 3 facts, 5 messages kept verbatim.`
A mechanical wake:
`Explore 3f2a9c had no frontier at 125k (ceiling 120k) — mechanical wake installed, 125k → 38k context, measured.`
Before is the party's last reading before the install, after its first one
since. A party that ends before a request measures it gets its line at its
end, with after said as unknown, never guessed.

### What else happens at a compaction

- A person's `/compact` runs Claude Code's own summary untouched; a stored
  frontier is dropped, and the screen says so.
- A message the person sends after the call does not cancel a stored frontier:
  it is among the messages kept after the call.
- A stored frontier whose call is no longer in the party's transcript
  (something else compacted it) is dropped and said on screen; the ask is
  then judged as if nothing were stored.
- An engine loop that is not one of the session's sub-agents (a fork Claude
  Code runs itself) is left to Claude Code.
- A `precompute` ask is skipped: it is never used.
- An error inside the compaction hook never reaches Claude Code: the plugin
  installs a mechanical wake instead, built without any read, and if that
  fails too, Claude Code's own summary runs. Either way the error is on the
  screen.
- When the main chat's turn-end install is skipped or rejected, the frontier
  stays stored for the next turn end or ask; a skip is a warning row
  (`turn-end-skipped`), a rejection an error row (`turn-end-rejected`) said on
  screen.
- A party's context that falls to half or less with no compaction this
  plugin handled (another plugin or Claude Code compacted it) is a warning
  row (`unseen-compaction`).

### Look back

`look_back` (`mcp__forward-compaction__look_back`), its schema in the prompt's
tool list like `forward_compaction`'s (not deferred), searches only the caller's
own transcript before its latest compaction, for an exact detail the wake no
longer holds. Supply `query` (case-insensitive words; double quotes keep a
phrase whole) or `entry: N` to fetch one entry whole. Results rank by how
many terms an entry holds, then newest first. Every call is logged as a
compaction miss, with what was looked up.

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
| `FORWARD_COMPACTION_MAIN_CEILING` | size | `60%` | With no frontier stored, the main chat's context at which the plugin installs a mechanical wake (1M window → 600k). |
| `FORWARD_COMPACTION_MAIN_NUDGE_START` | size | `15%` | The main chat's context at which it is first told its size and that it may compact. |
| `FORWARD_COMPACTION_MAIN_NUDGE_EVERY` | size | `5%` | How much the main chat's context grows between nudges. |
| `FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT` | max context | `model` | Every sub-agent's max context, Haiku included, when set; unset, each sub-agent's own: 1m for a model id carrying `[1m]`, 200k for every other ([Max contexts](#max-contexts)). |
| `FORWARD_COMPACTION_SUBAGENT_CEILING` | size | `80%` | With no frontier stored, a sub-agent's context at which the plugin installs a mechanical wake (160k on 200k). |
| `FORWARD_COMPACTION_SUBAGENT_NUDGE_START` | size | `40%` | A sub-agent's first nudge (80k on 200k), above the 55-60k a sub-agent lands at after an install, so a frontier never loops. |
| `FORWARD_COMPACTION_SUBAGENT_NUDGE_EVERY` | size | `10%` | How much a sub-agent's context grows between nudges (20k on 200k). |
| `FORWARD_COMPACTION_CEILING_NATIVE` | flag | `0` | `1`: at any party's ceiling with no frontier, Claude Code's own summary runs instead of the mechanical wake. |
| `FORWARD_COMPACTION_IGNORE_MODELS` | model list | `haiku` | Models that take no frontier: no nudge, the tool refused, every ask held to the ceiling and then compacted mechanically ([Ignored models](#ignored-models)). |
| `FORWARD_COMPACTION_KEEP_SKILLS` | name list | `none` | Skills and commands never dropped from a wake, comma-separated, as a file's `forward-compaction-keep: true` pins it ([The tool](#the-tool)). |
| `FORWARD_COMPACTION_DEBUG` | flag | `1` | `0`: no `debug.jsonl`, the row the plugin writes at every step. |
| `FORWARD_COMPACTION_LOG_FILE` | path | `~/.local/state/forward-compaction/logs/decisions/.jsonl` | Where decision rows go; each session writes `{session}.jsonl` beside it. With `PLUGIN_LOG_DIR` set the default is `$PLUGIN_LOG_DIR/forward-compaction/decisions/.jsonl`. A relative path is refused and the default applies. |

A nudge start at or past its party's ceiling in the same unit is kept and
named once: no nudge goes out before the ceiling. A ceiling below Claude
Code's ask point is named once at start, for the main chat and for
sub-agents: a party with no frontier is then compacted mechanically at its
first ask.

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "100000",
    "FORWARD_COMPACTION_MAIN_CEILING": "60%",
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
window. A sub-agent's frontier installs only at such an ask, so **set
`CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`**: when the compaction window Claude
Code reports is above 100000 the plugin says so once at start, with that
window, its source and the ask point. Past that point Claude Code asks
before every request, so a stored frontier installs at the party's next
request. The low window is there so the plugin can install a frontier
whenever the model writes one, never to force one: a held ask changes no
nudge, and the model keeps picking its milestone until the ceiling. The main chat does not wait for an ask: its frontier installs at the
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
no ceiling. Claude Code's API reports only the main chat's window, so a
sub-agent's comes from the model id its steps report: one carrying the API's
own `[1m]` context marker is measured against 1,000,000, every other (and one
no step has named yet) against 200,000. The marker is the id's literal, never
a table of model names. `FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT`, when set,
is every sub-agent's max context instead. An ignored (Haiku) sub-agent's
ceiling comes from the same per-model max context.
Claude Code's ask point for a party is held at or below its max context.

### Ignored models

A party whose model id holds an entry of `FORWARD_COMPACTION_IGNORE_MODELS`
(`haiku` by default, case-insensitive) takes no frontier: it gets no nudge, its
`forward_compaction` call is refused with nothing stored, naming the entry and
the ceiling, and every automatic compaction ask is held, as for any party with
nothing stored, until its ceiling. There it gets the mechanical wake (Claude
Code's own summary with `FORWARD_COMPACTION_CEILING_NATIVE=1`); Claude Code's
"prompt is too long" recovery gets it at once. It is never compacted at
Claude Code's early ask. A manual `/compact` runs Claude Code's summary as for
any party. A party is judged each time a request names its model, and again
after `/model`; a party, the main chat included, that no request has named a
model for yet is judged `unknown`, never `managed`, and a request that names no
model keeps the judgement it has. The decision log's `ignore` row records each
judgement with the entry matched, only when it is first made or changes; the
judgement is kept in `$.state`, so a plugin reload writes no row for one that
holds. A held ask's row carries `why: ignored-model`.

With the defaults, on the 200k sub-agent max context:

| Sub-agent | Nudges | Held | Mechanical wake |
| --- | --- | --- | --- |
| Sonnet or Opus | at 80k, 100k, 120k and 140k | every ask below 160k with nothing stored | at 160k |
| Haiku (ignored) | none | every ask below 160k, Claude Code's 63k ask included | at 160k |

### State on disk

| Path | What | Retention |
| --- | --- | --- |
| `~/.local/state/forward-compaction/logs/decisions/{session}.jsonl` (`$PLUGIN_LOG_DIR/forward-compaction/decisions/` when set) | decision rows: every frontier stored (with `orders` and `lifted`, its counts of standing orders carried and lifted) or refused (one refused for a dropped standing order has `reason: standing-orders` and its count of `faults`, never the order's words), every nudge, every compaction decision, every `landed` row (`{party, kind, before, after, line}`, `kind` being `frontier` or `mechanical`, `before` and `after` the measured readings or `null`, written with the landed line), every `ignore` row (`{party, label, model, judged, matched}`, `judged` being `managed`, `ignored` or `unknown`, `matched` the ignore-list entry or `null`, written when a party's judgement is first made or changes); a held-ask streak is one folded `skips` row, written when the streak closes and stamped with its last ask's time, so it can follow later rows | a file over 8 MiB moves to `.1`; other sessions' files older than 14 days, then all but the newest 200, are deleted |
| `~/.local/state/forward-compaction/logs/{errors,warnings,info}.jsonl` (`$PLUGIN_LOG_DIR/forward-compaction/` when set) | the plugin's errors, warnings and info: every decision event lands at its level — errors and warnings in their files, every other operational event (nudge, stored, refused, each compaction decision, party, skill, tool-registered, look-back, the lines said) in `info.jsonl`, a held-ask streak folded into its first row and one `skips` row. Each row's `event` names what happened (never a bare `error` or `warning`), and an error or warning row's `where` names the function that raised it. One failure is one row: a tool that fails to register writes one error row and one screen line. Rows a write could not append (the lock held past its 10-second wait, the writer killed at its 15-second bound, any failure) stay queued, order kept, and are retried with the next write: a row may be written twice, never lost or torn. Only past 2,000 held rows are the oldest dropped, and their count goes to `errors.jsonl` (`plugin-log-rows-dropped`) once a write succeeds. A lock stage or broken lock whose writer died is cleared | a level file over 20 MiB moves to `.1`, the older ones to `.2` … `.5`, the oldest of five deleted |
| `debug.jsonl` in the same directory (with `FORWARD_COMPACTION_DEBUG` on) | a row at every step: each hook entry (hook, party, trigger, model), each `$` answer the plugin decides on (`session.usage` figures, the `agent.list` count, each `turn.step` reading with its four counts and model, `fs.stat` results), the options and variables resolved, each ratio base and each ratio, measured or not and why, with the base's characters and tokens and the characters and reading now, each wake's section sizes and files, each nudge sent or withheld and why, and every decision row whole; numbers as the API gave them | as the level files: `.1` … `.5` |
| `issues.md` in the same directory | notes a model appends when the plugin gave it trouble, as each tool answer asks | not managed by the plugin |
| anything else | none: the recorded facts and the stored frontiers live in memory only | — |

Only errors reach the screen, and the log too. Warning, info and debug rows
go to their files, or nowhere when no log can hold them; while the log fails,
one line per failing streak says so, and the next successful write re-arms it.
Rows never hold frontier or transcript bodies.

## ❓ FAQ

<details>
<summary><b>How is this different from Claude Code's own compaction?</b></summary>

Claude Code asks a summarizer to rewrite the whole conversation. Here the
model writes the frontier itself through `forward_compaction`, the plugin
supplies the facts it recorded, and the newest messages after the call that
fit stay verbatim. No summarizer request runs.
</details>

<details>
<summary><b>What if the model never calls the tool?</b></summary>

It is told its context size from its nudge start (15% of the main chat's
window, 80k of a sub-agent's 200k), again at each step after, and asked to
compact at its next clean milestone. At its ceiling (60% of the main chat's
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
<summary><b>Does a frontier survive a restart or <code>claude --resume</code>?</b></summary>

No. Stored frontiers and recorded facts live in the plugin's memory: the main
chat installs at the same turn's end, and a sub-agent ends with its process.
The frontier text stays in the transcript as the tool call's input, where
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

The live replay fixture exercises every replay invariant but two, which the replay test names: I2, a precompute ask (Claude Code 2.1.309 sent none; `tests/decide.test.ts` covers C2), and I11, tail handles shared by two chained installs (a chained frontier's call comes after everything the install before it kept, so the two tails share no message).

Work lands on `develop`; `main` holds only releases. Merging the `develop → main` pull request is the release: [`release.yml`](./.github/workflows/release.yml) tags the merge commit `forward-compaction--vX.Y.Z` and publishes its notes from [CHANGELOG.md](./CHANGELOG.md). `make release-check` runs that pull request's checks locally first. Pull requests go to `develop`.

`plugins/forward-compaction/hooks/forward-compaction.ts` is a thin adapter over `plugins/forward-compaction/src/`:

| Module | Role |
| --- | --- |
| `options.ts` | Sizes, flags and the `FORWARD_COMPACTION_*` variables, resolved with their defaults |
| `window.ts` | Claude Code's ask point from `$.session.usage`, the ignore list, each party's marks against its max context, the measured characters per token, the load-file room |
| `ledger.ts` | The facts recorded from typed hook events, per party |
| `frontier.ts` | The tool's description and schema, its validation and refusals, and the receipt |
| `wake.ts` | The split at the call, the budget, the facts and frontier messages, the tail that fits, the landed lines |
| `decide.ts` | The decision for one compaction ask, and a party's reading |
| `nudge.ts` | Nudge levels and text |
| `parties.ts` | Per-party state: readings, the stored frontier, nudges sent |
| `unseen.ts` | A context fall no compaction of this plugin explains |
| `look-back.ts` | The `look_back` tool |
| `log.ts` | The decision log and the level logs |
| `bounded.ts` | Bounds a promise with a timer passed in: tool registration holds a turn at most 5s |
| `register.ts` | Which tools still need a registration try, up to three each |

## 🎓 Built with Professor

forward-compaction is built and maintained with [Professor](https://github.com/rezzminator/professor), a fleet controller and discipline layer for Claude Code, Codex and OpenCode: chats that message each other, agents held to the project's rules, and gated releases. Professor runs long orchestrations of sub-agents, and keeping their work intact across compactions is why this plugin exists.

## License

MIT

<sub>Keywords: Claude Code compaction · model-written frontier · forward compaction · sub-agent compaction · self-compaction · context window management · CLAUDE_CODE_AUTO_COMPACT_WINDOW · Claude Code plugin · function hooks · Claude Mods · multi-agent orchestration</sub>
