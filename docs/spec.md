# forward-compaction — behaviour reference

This is the full behaviour of the plugin: every rule, limit and edge case the code holds. Start with the [README](../README.md) to install it and pick your settings; option defaults live only in the README's [Options](../README.md#options) table.

## What a compaction keeps

- ✍️ **The model writes the frontier, change by change.** `forward_compaction`
  takes `objective` and `next` as texts and `orders`, `decisions`, `done`,
  `remaining`, `blocked` and `findings` as numbered lists the model changes
  by item number; whatever a call leaves out stays. The plugin holds the
  frontier in files on disk, never summarized, and renders the wake from it;
  one with no objective or next installs as it is, its wake naming what it
  lacks.
- 🧾 **Facts are recorded, never reconstructed.** The user's messages (main
  chat) or the brief (sub-agent), the messages delivered to it, the skills
  loaded, the agents and the background shells come from typed hook events as
  they happened. Nothing is grepped out of a transcript or re-read from disk.
  Each party's newest prompts (the user's ten newest typed messages and every
  answer they gave to an AskUserQuestion, or a sub-agent's brief and the ten
  newest delivered to it) and the skills it loaded
  (the latest text of each) are also held in Claude Code's session state, so a
  plugin reload (`/reload-plugins`) does not lose them. Its frontier and its
  storage live in its files ([State on disk](#state-on-disk)), so a restarted
  or resumed chat keeps them with every number. The files touched and the task list come from each finished tool call.
- ⏩ **The messages after the call are kept.** The model need not stop after it
  compacts: the newest messages from the call on stay in the new context as
  they were, as many as fit, and any left out are named as not carried. Anything delivered between
  the call and the install that those messages lack (a notification of an
  agent or command finishing, the user's message, a coordinator's message)
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

## How it works

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

1. **Nudges.** Each party has a floor: its first context reading, its first
   reading after an install, or any lower reading (a compaction this plugin
   did not make, after which the nudges start over as after an install); the
   plugin keeps it in the party's folder (`floor.json`).
   After a tool result, once the party's context has reached its nudge start
   (`FORWARD_COMPACTION_MAIN_NUDGE_START`, default `15%` of the max context;
   `FORWARD_COMPACTION_SUBAGENT_NUDGE_START`, default `165k` tokens, the same
   on every max context), the model reads one line saying how large its
   context is, in tokens. One more follows every
   `FORWARD_COMPACTION_{MAIN|SUBAGENT}_NUDGE_EVERY` of growth (default `5%`
   and `65k`). After an install the next nudge waits until the context has
   grown as much as the nudge start past the party's first reading (held to
   two `NUDGE_EVERY` below the ceiling, never under one `NUDGE_EVERY`).
   `FORWARD_COMPACTION_MAIN_NUDGE_ROOM` and
   `FORWARD_COMPACTION_SUBAGENT_NUDGE_ROOM` have no default: set, the party's
   first nudge goes out once its context has grown that room above its floor
   instead of at its nudge start, and after each install again that room
   above the new floor; the room is held to two `NUDGE_EVERY` below the
   ceiling so a nudge still comes before the mechanical wake, and is never
   under one `NUDGE_EVERY`. A set room wins over the nudge start, which then
   decides nothing and raises no start-below-the-ceiling warning. An invalid
   room is named in the options errors and the party has no room. The floor
   decides where nudges start only when a room is set. Each line is worded by
   its count since the party's last install, so no two read alike and each is
   firmer than the one before. The first three time the call between two
   steps, because a compaction drops what the model has read: the first asks
   for a frontier once the step in hand has its result saved and checked, and
   before it reads for the next step, the second the same as soon as that
   step is done, the third to start no new step and read nothing new; the
   fourth says to compact now, the fifth to stop, and from the sixth on the
   line names how many notices went unanswered. The last nudge before the
   ceiling, the one that one more `NUDGE_EVERY` of growth would carry to it,
   says instead that the plugin compacts next, with no frontier from the
   model. A nudge prints no list. A party holding a frontier is asked for
   only what changed since its last one, by item number: remove what is
   finished, lifted or wrong, edit what changed, add what is new; a party
   holding none is asked for a first frontier (objective, next, and what the
   rest of the work needs in orders, decisions, done, remaining and
   findings). Every line also routes material: what only a later step reads
   goes in `storage`, and `load_files` carries only what the next step reads.
   The first three close on the party's exception: a sub-agent's on when it
   may skip, as its work ends within a few calls, the main chat's on the
   finish rule below. No line names a max context or the ceiling. A held
   compaction ask adds no nudge of its own. After an install the party's
   first reading is its new floor and its level is absorbed silently (a
   sub-agent's floor of system prompt, tools and skills is already 55-60k), so
   the next nudge goes only when the context has grown by the nudge start (or
   the room, when set) above it. A wake lands near or above the old nudge
   level, and a nudge a few thousand tokens later makes the party compact in
   a loop. No nudge goes
   within one `NUDGE_EVERY` of the last one. A model on the ignore list gets
   no nudge. No call is ever refused or held back: a party that does not
   compact is compacted mechanically at its ceiling.

   The finish rule: the main chat also compacts when its whole work is
   finished, before its final report, with `remaining` "none" and `next`
   "write the final report". A finished chat otherwise holds a large context
   until the user replies, and a reply after the prompt cache expired
   re-sends all of it. The main chat reads the rule in its first three
   nudges, and before any nudge in one line of its own, the finish notice:
   once since its last install, when its context reaches
   `FORWARD_COMPACTION_MAIN_FINISH_START` with nothing stored, and after an
   install only once it has grown one `NUDGE_EVERY` past its first reading.
   A sub-agent is never asked: its context ends with its report. The plugin
   detects no finish and holds no turn end: the model decides.
2. **Compacting.** The model calls `forward_compaction` (the model sees
   `mcp__forward-compaction__forward_compaction`). The plugin applies the
   call's changes to that party's frontier, writes them to its files, and
   never refuses the call: an argument it cannot use is skipped, and the
   result names it. A second call before the install applies on top of the
   first. A frontier with no objective or next installs like a complete one,
   its wake naming what it lacks.
3. **Installing.** The stored frontier installs at the next door Claude Code
   opens: for the main chat at the end of the turn (the plugin asks Claude
   Code to compact) or at an automatic ask if one comes first; for a
   sub-agent at Claude Code's next automatic ask. No summarizer request runs.
4. **The ceiling.** An automatic ask with nothing stored is held. Once the
   party reaches its ceiling with still
   nothing stored, or Claude Code asks again with no response in between
   (its "prompt is too long" recovery), the plugin installs a mechanical wake.

### The tool

`forward_compaction({objective, next, orders, decisions, done, remaining, blocked, findings, storage, load_files})`,
with its schema in the prompt's tool list (not deferred), so a nudged model
needs no ToolSearch. The plugin holds each party's frontier as two texts and
six numbered lists, and a call sends only changes: whatever it leaves out
stays.

- `objective`, `next`: texts — what the work is for and what done means; the
  first concrete action after the wake. A text sent replaces the stored one,
  which goes to its history; one left out keeps it. The result says
  `objective set`, `objective replaced` or `objective unchanged` (the same for
  `next`), and `next kept: {text}` when the call left `next` out over a
  stored one. A blank text or one that is no string is skipped with a note.
- `orders`, `decisions`, `done`, `remaining`, `blocked`, `findings`: lists —
  the user's orders that bind the rest of the work, in the user's words; every
  ruling the user gave on how something gets done; the finished pieces, each
  with how it was verified; every step left, in order; what waits on whom;
  the party's own choices, errors verbatim, the commands it will need again.
  Each takes one object `{add, remove, edit}`, every key optional: `add` an
  array of texts, `remove` an array of item numbers, `edit` an array of
  `{id, text}`. In `remaining` alone an `add` entry may be `{before, text}`:
  the new step is shown before the live step with that number, or last, with
  a note, when that number is not live.
- An item's number is per list, starts at 1, never shifts and is never
  reused, across restarts too. In one call a list's removes and edits apply to
  the numbers the model saw, then its adds; a number both removed and edited
  is removed, with a note. An edit replaces the item's whole text and keeps
  its number and its place; an edit to the text it already holds is a note.
  An added text equal to a live item of the same list, compared with its
  spacing collapsed and in lower case, is skipped as `already [n]`.
- An order is removed by its number in `orders.remove`, with no proof asked.
  The live orders open every wake ([The wake](#the-wake)).
- The call is never refused. A plain text sent to a list is one added item,
  and an array sent straight to a list its adds; a single number or `{id,
  text}` where an array was due is read as one; a number that is not live, a
  blank text or a malformed entry is skipped. Each is answered by one note
  naming its place (`done.remove[1]: [9] is not a live item: skipped.`).
  `standing_orders` entries are taken as `orders.add`; `lifted` is answered
  with a note naming `orders.remove`; `keep_skills`, `drop_files`,
  `drop_skills` and a load file's `later` are ignored with a note. A field
  the tool does not take joins `findings` as one item,
  `[{name}, an argument forward_compaction does not take]` then its value,
  and the note lists the fields; one that holds nothing (null, a blank text,
  an empty array or object) is ignored, with a note.
- A list, `storage` or `load_files` value that arrives as the text of its own
  JSON is read as that JSON, with one note. A value whose JSON does not parse
  is repaired (`repairJson`): its brackets balanced (a closer missing, a
  closer misplaced, a string left open), bare `add:`/`remove:`/`edit:`
  operations braced, and a value closed early read together with the
  arguments written after it inside the same text; each repaired field gets
  one note. An item's text loses a number the model typed before it
  (`[9] Parser merged`); an edit's text only its own number. A list's text
  that is an empty array or object changes nothing. A text that is no
  JSON stays one added item. A field taken back out of a text that holds
  its own closing tag then `<parameter name="…">` (the model's call markup
  closed it early; a list, `storage` or `load_files` field is read as JSON, a
  list one that is no JSON as text) is one note; one that cannot be (no
  field, one the call also sent, or a `storage` or `load_files` one that is
  not JSON) stays in the text it arrived in, under
  `[{name}, as it arrived inside {field}]`.
- `storage` (optional): `{add, remove}`, markdown files the party keeps for a
  later step and reads or edits itself with Read and Edit, by the absolute
  path the wake gives. `add` takes `{name, description, value}` entries: a
  name is lower-case letters, digits and dashes ending `.md`; one sent
  without `.md` gets it, and another is rewritten to that form (`API Survey`
  → `api-survey.md`) and cut to 100 characters before `.md`, the result
  naming the name stored. The value is
  written whole, with no size cap, and the entry listed: `Stored {name} ({n}
  characters)`. An existing file is overwritten after its old content is
  copied to the history. An `add` without `value` changes a listed entry's
  description only (`Described {name}`), lists an unlisted file already in
  the folder (`Stored {name} ({n} characters, as it is in the folder)`),
  copies one the model wrote there under another spelling of the name to its
  storage name (`Stored {name} ({n} characters, copied from {file} in the
  folder)`), and is skipped with a note when there is no such file. `remove` takes names:
  each entry is unlisted (`Storage no longer lists {name}`) and its content
  copied to the history, a name already there numbered before `.md`
  (`survey.2.md`); a value the same call wrote is the one copied when that
  call overwrites or removes it. The plugin's file API (`$.fs`) has no move or delete, so
  the removed file stays in the storage folder, unlisted.
- `load_files` (optional): `{path, lines?, why?}` entries, as many as the
  party needs, each a path to a regular file, `lines` a range like `10-40` or
  `1-60,160-185`, `why` one line. A call that sends `load_files` replaces the
  earlier call's; one that leaves it out keeps them. A relative path is
  resolved against the session's directory (`$.session.cwd()`), or carried as
  given when that read fails; a `why` past 200 characters is cut to 200, and
  a missing one carries the file without it; `lines` that are no range carry
  the file from line 1. Only an entry with no path is skipped. Their size
  never refuses the call. Each file is read when the frontier installs and
  carries at most 250 lines: of its `lines` ranges when given, else from
  line 1. A file holding a NUL character is binary: it is named as `not a
  text file` and never carried. When lines are left past the 250th, the
  file's block ends with one line, `[N more lines not carried: Read {path}
  from line L]`, N the lines left in the ranges or the file and L the next
  one. There is no room for the files together. A file that is missing, or
  whose ranges hold no line, is named under `## Files not carried` with why.

Each call's changes are applied and written to the party's files when it
arrives ([State on disk](#state-on-disk)), so the result can give numbers; a
second call before the install applies on top of the first. The result is
one line per change, then the notes, then the sizes, then when the frontier
installs:

- `Added to {list}: [7], [8]`, `Removed from {list}: [2] {its text}`,
  `Edited in {list}: [4], was: {its old text}`, `Skipped in {list}: already
  [3]`, and the texts' and storage lines above; an item that left (removed,
  or the text an edit replaced) shows its first 80 characters, then `…`, its
  whole text staying in the list's history file;
- one note per skipped, malformed or unknown entry, naming the field and the
  place, and per `load_files` entry resolved from a relative path, with a cut
  or bad `why` or bad `lines`, absent, not a regular file or that could not
  be checked; a call with no `tool_use_id`, which the wake cannot place, is
  named too;
- per file the plugin could not write, `Not saved to disk yet: {list, text or
  storage entry} ({the error, the path of a list's, text's or history file
  replaced by …, a storage file's keeping its place in the folder}); it is held
  and saved again at your next call.` The change stays applied in memory,
  the error is logged and shown on screen, and the next call writes it again;
- `Frontier: {n} characters in {m} items ({list} {n}, …)`, counting every
  live item, the objective and next, listing the lists that hold items;
  past `FORWARD_COMPACTION_FRONTIER_WARN_CHARS`, a frontier with no list
  item also gets `Frontier is {n} characters, over {threshold}: in your next
  forward_compaction call send a shorter objective and next.`; one whose
  lists hold items is asked nothing. Nothing is cut and no call is refused;
- `Frontier stored`, with `with {n} files to load` when it carries any, and
  `, without {objective|next}: send it before it installs, or the wake names
  it missing` when the frontier holds no objective or next; then when it
  installs — for the main chat at the end of this turn, for a sub-agent at
  Claude Code's next ask (with where that ask comes) — and, when an earlier
  call since the last wake was stored, `This call applied on top of your
  earlier one since the last wake.` It prints no context size: the plugin
  measures none for that moment.

A frontier with no objective or next installs at the same doors as a complete
one: the frontier message names what it lacks and says to re-establish it
from the user's messages (main) or the brief (sub-agent) and send it in the
next call, and a warning row names it. The decision log's `stored` row and
the installing `compact` row name it as `incomplete`.

Every answer ends with one line saying the
plugin is experimental and asking the model to append a short note of any
trouble to `issues.md` in the level-log directory (the reply itself when no
directory resolves).

### The wake

The installed context is, oldest first: a sub-agent's start, one facts
message, one frontier message, then the messages after the call, returned as
Claude Code holds them. The start is the user messages the sub-agent's
transcript opens with (its brief, with what Claude Code attached to it),
handed back untouched by handle, then one fixed assistant line, `My context
was compacted here. What follows is the record of my work and my frontier as
forward-compaction holds them.` (`START_END`). A compaction that follows
another within the prompt cache's lifetime reads the start from the cache
instead of writing it again. A transcript that opens any other way (a wake
built without a start) has none, and its facts carry the brief. The main
chat's wake has no start: facts, frontier, tail. The frontier message carries the call's own result, since the install
replaces the message that held it, and, like a mechanical wake's message,
ends with the experimental line and where to note any trouble.

On screen the two built messages are user-role rows, which Claude Code's
fullscreen view draws whole. Outside the expanded view (the ctrl+o
transcript, `--verbose`, an export) the plugin draws nothing for the facts
message and one dim line for the message after it:
`forward-compaction installed the frontier: the transcript view (ctrl+o) shows it and the recorded facts in full`,
or for a mechanical wake
`forward-compaction compacted mechanically, no frontier was written: the transcript view (ctrl+o) shows its note and the recorded facts in full`.
The fold is a drawing only: the stored messages, the ones the model reads,
keep every character, and the expanded view draws them as Claude Code does.
A row folds only when Claude Code marks its message as built by a hook
(origin `unclassified` in the main view, `coordinator` in a sub-agent's view,
where it sits under "From main") and it opens as a wake message does, so the
same text typed or pasted by the user is drawn whole.

The facts message opens with the plugin version that built the wake
(`compacted by forward-compaction 2.2.5`), so a chat on an old build shows
it; a sub-agent's with a kept start adds `Your brief is the first message
above, kept verbatim.` It holds, each section only when it has content:

- the standing orders, first, under `## Standing orders — binding until the
  user lifts them`: each live order on its own line as `[n] text`, with the
  unchanged tag the frontier message describes, carried whole, outside the
  budget. A mechanical wake carries them the same way,
  and the frontier message and the mechanical wake's message both say to
  continue within them;
- what arrived after the frontier and the kept messages lack: every
  notification, message from the user or the coordinator, and message that
  resumed a sub-agent, verbatim, first;
- plan mode and the plan file, when the party's plan-mode attachments
  (Claude Code's `prompt.attachment` rows `plan_mode`, `plan_mode_reentry`,
  `plan_mode_exit`) named them, as Claude Code's own compaction carries them:
  `## Plan mode` while the party is in plan mode, naming its plan file, and
  `## Plan file` with the file's path and its content read whole at install,
  in plan mode or after it ended; a plan file not written yet is left out,
  one that could not be read is named. Both are carried whole, outside the
  budget;
- the brief (sub-agent), verbatim under `## Your brief`, only when the wake
  has no kept start (with one, the brief is the first message above and no
  section repeats it), or the user's newest ten typed messages
  and every answer they gave to an AskUserQuestion, however old (main chat),
  oldest first, always carried whole, whatever their size. An answer, which
  reaches the model as the tool's result, never as a prompt, is headed
  `(the user answering your question)` and holds each question, its
  `Answer:` and any `Notes:`. The heading counts what is carried of the messages
  the plugin recorded (`N of M recorded`; a restart begins the record again),
  the answers among it, and the oldest recorded typed messages left out, which
  look_back finds. A
  wake carries text only: each `[Image #N]` in them reads
  `[Image #N] (image not carried: the wake cannot hold images)`. A resumed
  sub-agent's resuming message is a delivered message, never part of its
  brief;
- the newest ten messages delivered to the sub-agent (its coordinator's, the
  returns of the agents it started, and the notifications that resumed it) or
  the notifications delivered (main chat); one delivered into a running
  sub-agent is recorded from the row Claude Code appends as it delivers it
  (`session.append`, door `delivery`), as the model reads it, and one that
  resumes it from the turn it starts;
- the results of the tool calls made in the same response as the frontier;
- the skills and commands the party loaded, the latest load of each, newest
  first. Only a pinned one (its file's frontmatter sets
  `forward-compaction-keep: true`, `FORWARD_COMPACTION_KEEP_SKILLS` names it,
  or that list holds `*`) is carried whole, under `## Skills in force, as
  loaded`, its heading saying `pinned`. Every other one is listed under
  `## Skills not carried`, after one sentence saying its text is gone and the
  `Skill` tool loads it again, as `- {name} ({source}, {path}): {description}`,
  the description its frontmatter's, left out when it has none. A sub-agent's
  skills follow the same rule as the main chat's. The skills carried whole
  stay within Claude Code's own limits after its compaction: newest loaded first, each cut past 20,000
  characters to its first characters and Claude Code's marker
  `[... skill content truncated for compaction; use Read on the skill path if
  you need the full text]`, and all of them together within 100,000
  characters (Claude Code's 5,000 tokens a skill and 25,000 in all, at its 4
  characters a token: design budgets in characters, never a measured token
  count). A skill that does not fit what is left is skipped, and a smaller one
  after it may still fit; each skipped one is named under `## Skills not
  carried` with the `Skill` call, and the path to `Read` when known, that
  loads it again. A skill Claude Code loaded
  without saying which party loaded it is named, not carried, in every
  party's wake, with the call that loads it again;
- the files the party touched, newest first, at most 15 paths, each tagged R
  read, E edited or W written (its strongest touch), from its finished `Read`,
  `Edit`, `MultiEdit`, `Write` and `NotebookEdit` calls; a denied or failed
  call touched nothing;
- the shell commands the party ran, newest first, under `## Shell commands
  you ran, newest first`: each finished `Bash` call's command verbatim under its
  `description`, a failed one too (it is the command to rerun), a denied one
  never, never their output; at most 20, a command run again kept at its
  newest run, the older ones named as not carried;
- the task list as last set, from `TodoWrite` or `TaskCreate`/`TaskUpdate`,
  whichever moved last, carried whole, never fitted;
- the agents, listed at install (at most 50 rows): for main every agent, for a
  sub-agent only the agents it spawned (`parentId` its own id); then each agent
  the party spawned that the list no longer holds, as `not in the list
  (finished, stopped or gone)`, so a frontier's "still running" is not
  trusted; past the cap the newest of those stay;
- the background shells and crons, from the newest Stop event, with its age.
  The list is session-wide, not per agent; before any Stop event it says the
  running shells are unknown;
- the files the frontier asked to carry, each at most 250 lines;
- the storage, when it lists an entry, under `## Storage — files in
  {absolute storage folder}/`: one line per entry, `{name} — {description}`;
- the load files not carried, with why;
- in a mechanical wake only, under `## Files you were working on, newest
  first, read at install`: the 5 newest files the party touched, read from
  disk at install, each at most 250 lines with the same `[N more lines not
  carried: …]` line and at most 40,000 characters, a longer one ending `[cut
  at 40000 characters: Read {path} for the rest]`, as Claude Code's own compaction restores its 5 most
  recent files because it fires uninvited. One that could not be read is
  named in place with why. A frontier's wake carries only the files the
  frontier asked for, and the wake an error falls back to, built without
  any read, carries neither these files nor the plan file.

Its size, a sub-agent's start counted whole, is held to a budget of half Claude Code's ask point (the
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
message after the call, and a mechanical wake keeps no earlier message. The standing orders, the brief or the user's newest ten typed messages and every answer,
and the task list are carried whole, outside the budget; the skills and
commands within their own limits above, the plan file whole, and the files
each within 250 lines, are outside it too. Every other section has a share — what arrived after the frontier 25%,
delivered messages or notifications 5%, sibling results 10%, the shell
commands 5% — and is carried whole or named as
not carried, never cut. The room left goes to the messages after the call: the
oldest are dropped whole until the rest fits, and the frontier message says
how many were dropped.

The frontier message opens `[forward-compaction: frontier] Below is your
frontier as forward-compaction holds it: continue from its ## Next`, with
`, within the standing orders above` while an order is live, then `In your
next forward_compaction call send only changes, by item number; whatever you
leave out stays.` The frontier follows, rendered from the lists, never from
text the model wrote whole: `## Objective`, `## Decisions`, `## Done`,
`## Remaining`, `## Next`, `## Blocked`, `## Findings`, each list's live
items one per line as `[n] text`, a list with no item left out. An item of
any list, an order included, ends with `[N rounds unchanged]` (` [1 round
unchanged]`) once N compactions were installed since it was added or last
edited, and with nothing before its first. The plugin counts the rounds, the model writes
none, and a tag sent back at the end of an add or edit text is stripped.
Where a tag shows, the opening line adds `An item tagged [N
rounds unchanged] has passed N compactions with no change: keep it only
while it is still true and still needed, and a standing order until the user
lifts it.` The objective, the next and the storage entries carry no tag. A
frontier with no objective or next names what it lacks; then the message says how
many later messages follow. No model-facing text names the path of a list's
file or of the history. A mechanical wake replaces it with a message saying
the party had not called `forward_compaction` (since its last wake, when it
holds a frontier), how many of the newest messages were kept and how many
are gone; with no frontier held it says to re-establish the objective and
next step from the user's messages or the brief, and with one held it shows
it as it stands, to continue from.

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

- A user's `/compact` runs Claude Code's own summary untouched; a stored
  frontier is dropped, and the screen says so.
- A message the user sends after the call does not cancel a stored frontier:
  it is among the messages kept after the call.
- A stored frontier whose call is no longer in the party's transcript
  (something else compacted it), or that came with no `tool_use_id`, still
  installs: it is carried with the newest messages that fit, as a mechanical
  wake keeps them (none when no ratio is measured), the frontier message says
  which messages followed the call is unknown, and a warning row names it.
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
own transcript before its latest compaction, however many compactions ago, back
to the start of the transcript, for an exact detail the wake no longer holds. Supply `query` (case-insensitive words; double quotes keep a
phrase whole) or `entry: N` to fetch one entry whole. Results rank by how
many terms an entry holds, then newest first. Every call is logged as a
compaction miss, with what was looked up.

## Windows, contexts and state

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

Sizes are percentages of each party's max context or token counts; a
sub-agent's nudge sizes default to token counts (165k, then every 65k), the
same on every max context, as does the main chat's finish start. The main chat's max context is the
window Claude Code reports through `$.session.usage()`, read at session
start, at the main chat's first request when not read yet, and again when its
model changes (`/model`); `FORWARD_COMPACTION_MAIN_MAX_CONTEXT` sets it
instead. Until it is known (set, or reported) the main chat gets no nudge and
no ceiling. Claude Code's API reports only the main chat's window, so a
sub-agent's comes from the model id its steps report: one carrying the API's
own `[1m]` context marker is measured against 1,000,000, one on the model id
the main chat's last request named against the main chat's reported window,
every other against the context window the Anthropic Models API states for
its id: `max_input_tokens` of `GET https://api.anthropic.com/v1/models/{id}`.
The marker is the id's literal and the window the API's answer, never a table
of model names. `FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT`, when set, is every
sub-agent's max context instead, and no model is looked up. An ignored (Haiku)
sub-agent's ceiling comes from the same per-model max context.
Claude Code's ask point for a party is held at or below its max context.

A model is looked up once in a session, with the session's own Anthropic
credential through Claude Code's plugin API (`$.session.authorize()`, then
`$.http.fetch`). The request starts beside the first step that names the
model, is read when that step ends, and counts as failed after 5 seconds.
While a model's window is not known, the sub-agent is measured against
200,000, the smallest window the API lists: a ceiling reached early costs a
mechanical wake, one set too high a request too long. That holds for a
sub-agent no step has named a model for yet, a session with no credential the
API takes (a third-party provider), a request Claude Code refuses
(`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`), a failed request, and a model
the API does not list. A failed lookup is tried again at a later step of a
sub-agent on that model: after 1 step, then 2, 4 … up to 64; a model the API
does not list is not asked again.

The decision log's `window` row records the max context a sub-agent is
measured against, once a step has named its model and each time it changes:
`{party, label, model, maxContext, source, ceiling}`, `source` being `option`,
`marker`, `main`, `models-api` or `fallback`. A `fallback` row carries
`unknown`, the reason the window is not known, and goes to `warnings.jsonl`
as `window-unknown`.

The Models API states a model's own window. With
`CLAUDE_CODE_DISABLE_1M_CONTEXT`, Claude Code takes 200k for a model the API
lists at 1M, and the plugin API reports that for the main chat's model alone:
set `FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT=200k` with it.

### Ignored models

A party whose model id holds an entry of `FORWARD_COMPACTION_IGNORE_MODELS`
(`haiku` by default, case-insensitive) gets no nudge. Its `forward_compaction`
call is stored like any party's, and installs at its next ask; with nothing
stored, every automatic compaction ask is held, as for any party, until its
ceiling. There it gets the mechanical wake (Claude
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

With the defaults, on a 200k sub-agent max context (on 1M the ceiling is
800k, and a managed sub-agent is nudged at 165k, then every 65k; on 200k its
165k start lies past the 160k ceiling):

| Sub-agent | Nudges | Held | Mechanical wake |
| --- | --- | --- | --- |
| Managed | none on 200k (the 165k start is past the ceiling); on 1M at 165k, then every 65k | every ask below 160k with nothing stored | at 160k |
| Ignored (Haiku) | none | every ask below 160k, Claude Code's 63k ask included | at 160k |

### State on disk

| Path | What | Retention |
| --- | --- | --- |
| `~/.local/state/forward-compaction/logs/decisions/{session}.jsonl` (`$PLUGIN_LOG_DIR/forward-compaction/decisions/` when set) | decision rows: every frontier stored (with `argChars`, the characters the call's arguments held; `lists`, per list it changed `{added, removed, edited, skipped}`; `frontier`, `{chars, items}` after it; `storage`, `{added, removed}`; `warned`, true when the size warning fired; `files`, the files to load; `notes`, the count of notes its result named; `writeFailed`, the files it could not write, when any; and `incomplete`, the texts it lacks, when any), every nudge (with `notice`, its count since the party's last install, and `last`, true for the last one before the ceiling), every `finish-notice` row (`{party, tokens, start}`), every compaction decision (an installing one with `skills`, `{carried, listed}`, the skills carried whole and the lines under `## Skills not carried`, `frontier`, `{chars, items}`, and `storage`, the entries listed), every `landed` row (`{party, kind, before, after, read, written, line}`, `kind` being `frontier` or `mechanical`, `before` and `after` the measured readings or `null`, `read` and `written` what the first request after the install read from and wrote to the prompt cache, written with the landed line), every `ignore` row (`{party, label, model, judged, matched}`, `judged` being `managed`, `ignored` or `unknown`, `matched` the ignore-list entry or `null`, written when a party's judgement is first made or changes), every `window` row (`{party, label, model, maxContext, source, ceiling}`, with `unknown` on the `fallback` source, written when a sub-agent's max context is first known or changes); a held-ask streak is one folded `skips` row, written when the streak closes and stamped with its last ask's time, so it can follow later rows; rows past the first 500 that come before the environment layer is read are counted in one `rows-lost` row | a file over 8 MiB moves to `.1`; other sessions' files older than 14 days, then all but the newest 200, are deleted |
| `~/.local/state/forward-compaction/logs/{errors,warnings,info}.jsonl` (`$PLUGIN_LOG_DIR/forward-compaction/` when set) | the plugin's errors, warnings and info: every decision event lands at its level — errors and warnings in their files, every other operational event (nudge, stored, each compaction decision, party, skill, tool-registered, look-back, the lines said) in `info.jsonl`, a held-ask streak folded into its first row and one `skips` row. Each row's `event` names what happened (never a bare `error` or `warning`), and an error or warning row's `where` names the function that raised it. One failure is one row: a tool that fails to register writes one error row and one screen line, and is tried again at each `turn.start`: at once for its first three tries, then after a wait of 30 seconds that doubles with each failure, up to 15 minutes, for the rest of the session. Rows a write could not append (the lock held past its 10-second wait, the writer killed at its 15-second bound, any failure) stay queued, order kept, and are retried with the next write: a row may be written twice, never lost or torn. Only past 2,000 held rows are the oldest dropped, and their count goes to `errors.jsonl` (`plugin-log-rows-dropped`) once a write succeeds. A lock stage or broken lock whose writer died is cleared | a level file over 20 MiB moves to `.1`, the older ones to `.2` … `.5`, the oldest of five deleted |
| `debug.jsonl` in the same directory (with `FORWARD_COMPACTION_DEBUG` on) | a row at every step: each hook entry (hook, party, trigger, model), each `$` answer the plugin decides on (`session.usage` figures, the `agent.list` count, each `turn.step` reading with its four counts and model, `fs.stat` results), the options and variables resolved, each ratio base and each ratio, measured or not and why, with the base's characters and tokens and the characters and reading now, each wake's section sizes and files, its `start` (how many messages stand before the facts: a sub-agent's kept start and its end line, 0 without one), `kept`, `dropped`, `skills` and `storage` counts, each nudge sent or withheld and why, and every decision row whole; numbers as the API gave them | as the level files: `.1` … `.5` |
| `issues.md` in the same directory | notes a model appends when the plugin gave it trouble, as each tool answer asks | not managed by the plugin |
| `~/.local/state/forward-compaction/{project}/{session}/`, each sub-agent's under `agents/{agent id}/` in it; `{project}` the name of the session's project directory without a leading dot | the party's frontier, written by the plugin alone when a call changes it: `orders.json` and `data/{decisions,done,remaining,blocked,findings}.json`, each `{next_id, items: [{id, text, round}]}` in shown order, `round` the party's count of installed compactions when the item was added or last edited, left out at 0; `data/{objective,next}.json`, `{text}`; `storage.json`, the listed `[{name, description}]`; `storage/{name}.md`, each value; `rounds.json`, `{rounds}`, that count, written right after each install of a party that holds a list item; `floor.json`, `{floor}`, the party's floor (its first reading ever, its first after an install, or any lower reading), which its nudges are timed from. What leaves goes to `history/`: `history/{list}.jsonl`, one line `{id, text, left}` (`removed` or `edited`) per value that left; `history/{objective,next}.jsonl`, one `{text}` per text replaced; `history/storage/{name}`, a storage value replaced or removed, numbered before `.md` when the name is taken; `history/unreadable/{file}`, the content of a live file that could not be parsed at start, copied there before the first write over it. No file holds a date or a time. At the start of a chat process or a sub-agent the party's frontier is loaded from them; every list's next number is past every number its history holds; an unreadable live file is logged and read as an empty list, its next number also past every number its own text names, and left as it is until a call changes that list. What left is appended to the history before the live file that no longer holds it is written. A party with no `orders.json` takes the standing orders the previous build kept in Claude Code's session state as its first numbered orders | nothing is ever deleted |
| anything else | none: the recorded facts live in memory only | — |

Only errors reach the screen, and the log too. Warning, info and debug rows
go to their files, or nowhere when no log can hold them; while the log fails,
one line per failing streak says so, and the next successful write re-arms it.
Rows never hold frontier or transcript bodies.
