# Replay scenario

The live recording `npm run replay:record` drives (spec § Tests, replay gate 3). `drive.sh` reads the step table
below: each row's prompt is typed into the session, then the step waits for its `wait` condition in the recorder's
rows, at most 15 minutes. All content is synthetic: the files under `filler/` come from `filler.mjs`.

Wait conditions: `main-turn` — a new main `turn.complete`; `manual-compact` — a `session.compact` row with trigger
`manual`; `notification` — a row naming `replay-done` (the background shell's notification), then a new main
`turn.complete`. The queue steps type over a running main turn, so Claude Code only queues the prompt: `busy` — the step's
`prompt.submit` row, its turn left running; `pull-back` — typed as one of the busy turn's Bash calls starts, then Up takes
the queued prompt back into the prompt box and Ctrl-U clears it, never sent; `edit` — the text before ` ++ ` typed and
pulled back the same way, the text after it appended in the box and sent; `queued` — typed as a Bash call starts, then the
busy turn's `turn.complete`; `essay` — the step's main `forward_compaction` call, then the request after it, its last;
`waiting` — typed while that request runs, then the prompt's own `session.append` row and its turn's `turn.complete`.

What each step exercises: S1 a typed skill (D5 b); S2 main's frontier installed at its turn end with every argument kind but blocked, one load file carried in the wake (C3, P1, install #1);
S3 two concurrent sub-agents, each loading the skill through the Skill tool (D5 a; D5 c if Claude Code preloads),
A storing a frontier below its ask point (receipt "from about") and installed at its first ask (C7), B never storing,
nudged, and compacted mechanically at its ceiling (C10: `settings.json` sets `FORWARD_COMPACTION_SUBAGENT_CEILING` to 100k, below
what its batched Reads reach; the 80% default of a sub-agent's max context, 160k at the least, would not fire here); S4 a coordinator message to A (a `session.append` `delivery` row while A runs, else A's later run);
S5 a background shell and its task notification (Stop `background_tasks`, I8, I12); S6 main's second frontier, with blocked
(install #2, chained: I11); S7 to S12 the user's prompts typed over a running main turn, each recorded only once it entered
the conversation (ledger.ts `enteredOf`): S8 one pulled back and never sent, S9 one pulled back, edited and sent, both while
S7's Bash calls run, each delivered into the turn at the next call's end, S10 one delivered so, S12 one typed during the last
request of S11's turn, whose frontier main's turn end installs (about 51k at the call, above main's finish notice 10k over
its floor and below Claude Code's ask, about 60k here) before Claude Code takes the queued prompt as the next turn's;
S13 `/compact` (C1, I1); S14 main past its ask point with no frontier (C9 skip; about 70k
after filler-2, below the 100k ceiling), then its frontier installed at the next ask (C7); S15 a background agent C past its
ask point spawning a background child, then storing its frontier in the message that waits on that child, so the child's
return reaches C as a `session.append` `delivery` row after the frontier and before its install (I7, I12; `settings.json`
sets `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` so C may spawn).

A forward_compaction call compacts only once its party's context has reached where its notice goes, judged by the
party's last completed request: the one before the request that makes the call. `settings.json` therefore holds
main's finish notice at 30k and 10k above its floor (`FORWARD_COMPACTION_MAIN_FINISH_START`,
`FORWARD_COMPACTION_MAIN_NUDGE_EVERY`) and a sub-agent's first nudge at 32k
(`FORWARD_COMPACTION_SUBAGENT_NUDGE_START`: above a sub-agent's first request, about 29k, and below its request
after the Skill call, about 35k), all under the 100k ceilings. S2, S6 and S14 read one file per message: a call made
right after files read together in one message is judged by the context before them and only updates the
frontier. C is told not to call before its scripted message: a call made earlier would install before the child's
return.

| step | wait | prompt |
|---|---|---|
| S1 | main-turn | /forward-compaction:replay-rules |
| S2 | main-turn | Read filler/filler-1.txt, filler/filler-2.txt and filler/filler-3.txt whole, one Read call per message, waiting for each result before the next. Then call the forward_compaction tool with objective "replay step S2", findings "replay finding S2", and load_files holding one entry: path the absolute path of filler/filler-1.txt, lines "1-100", why "replay load file". End your turn. |
| S3 | main-turn | In one message, spawn two background general-purpose agents. Agent A's prompt: "Call the Skill tool for forward-compaction:replay-rules. Read filler/filler-1.txt and filler/filler-2.txt whole, one Read call each, then call forward_compaction with Objective 'agent A frontier'. Then read filler/filler-3.txt to filler/filler-7.txt whole, one Read call each, and answer 'A done' with the coordinator note you received, if any." Agent B's prompt: "Call the Skill tool for forward-compaction:replay-rules. Read filler/filler-1.txt to filler/filler-10.txt whole, one Read call each, then answer 'B done'. Never call forward_compaction." Then end your turn. |
| S4 | main-turn | Use SendMessage to send agent A exactly: coordinator note 5c1e. Then end your turn. |
| S5 | notification | Run the Bash command "sleep 20; echo replay-done" with run_in_background set, then end your turn. |
| S6 | main-turn | Read filler/filler-4.txt and filler/filler-5.txt whole, one Read call per message, waiting for each result before the next. Then call forward_compaction with objective "replay step S6" and blocked "nothing blocks S6", and end your turn. |
| S7 | busy | Run the Bash command python3 -c 'import time; time.sleep(15)' four times, as four separate calls strictly one after another, each in the foreground: never in parallel and never with run_in_background. Answer any message I send meanwhile in one line, then answer 'busy done' and end your turn. |
| S8 | pull-back | queued DELTA pulled back and never sent |
| S9 | edit | queued BRAVO pulled back ++ , edited: reply with the word BRAVO |
| S10 | queued | queued ECHO delivered: reply with the word ECHO |
| S11 | essay | Read lines 1 to 300 of filler/filler-9.txt in one Read call, then lines 1 to 10 of filler/filler-10.txt in a second Read call, waiting for the first result before the second. Then call forward_compaction with objective "replay step S11". Then, with no further tool call, write a 600-word essay on tides and end your turn. |
| S12 | waiting | queued HOTEL waited across the install: reply with the word HOTEL |
| S13 | manual-compact | /compact |
| S14 | main-turn | Read filler/filler-1.txt to filler/filler-8.txt whole, one Read call per message, waiting for each result before the next. Right after the result of filler/filler-2.txt, call forward_compaction with Objective "replay step S14", then read on. |
| S15 | main-turn | Spawn one background general-purpose agent C, then end your turn. C's prompt: "Read filler/filler-1.txt, filler/filler-2.txt and filler/filler-3.txt whole, one Read call each. Then spawn one background general-purpose agent whose prompt tells it to run the Bash command python3 -c 'import time; time.sleep(20)' and then answer child-done-7f3a. Right after the spawn, in ONE message, call forward_compaction with Objective 'agent C frontier' and Remaining 'wait for the child' together with the Bash command python3 -c 'import time; time.sleep(45)'. Never call forward_compaction before that message. Then answer 'C done' with the child's reply." |
