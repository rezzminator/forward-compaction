# Replay scenario

The live recording `npm run replay:record` drives (spec § Tests, replay gate 3). `drive.sh` reads the step table
below: each row's prompt is typed into the session, then the step waits for its `wait` condition in the recorder's
rows, at most 15 minutes. All content is synthetic: the files under `filler/` come from `filler.mjs`.

Wait conditions: `main-turn` — a new main `turn.complete`; `manual-compact` — a `session.compact` row with trigger
`manual`; `notification` — a row naming `replay-done` (the background shell's notification), then a new main
`turn.complete`.

What each step exercises: S1 a typed skill (D5 b); S2 main's handoff installed at its turn end (C3, P1, install #1);
S3 two concurrent sub-agents, each loading the skill through the Skill tool (D5 a; D5 c if Claude Code preloads),
A storing a handoff below its ask point (receipt "from about") and installed at its first ask (C7), B never storing,
nudged, and compacted mechanically at its ceiling (C10); S4 a coordinator message to A (`session.receive`, I7);
S5 a background shell and its task notification (Stop `background_tasks`, I8, I12); S6 main's second handoff
(install #2, chained: I11); S7 `/compact` (C1, I1); S8 main past its ask point with no handoff (C9 skip, the "now"
nudge), then its handoff installed at the next ask (C7).

| step | wait | prompt |
|---|---|---|
| S1 | main-turn | /forward-compaction:replay-rules |
| S2 | main-turn | Read filler/filler-1.txt, filler/filler-2.txt and filler/filler-3.txt whole, one Read call each. Then call the forward_compaction tool with a handoff whose Objective is "replay step S2", and end your turn. |
| S3 | main-turn | In one message, spawn two background general-purpose agents. Agent A's prompt: "Call the Skill tool for forward-compaction:replay-rules. Read filler/filler-1.txt and filler/filler-2.txt whole, one Read call each, then call forward_compaction with Objective 'agent A handoff'. Then read filler/filler-3.txt to filler/filler-7.txt whole, one Read call each, and answer 'A done' with the coordinator note you received, if any." Agent B's prompt: "Call the Skill tool for forward-compaction:replay-rules. Read filler/filler-1.txt to filler/filler-10.txt whole, one Read call each, then answer 'B done'. Never call forward_compaction." Then end your turn. |
| S4 | main-turn | Use SendMessage to send agent A exactly: coordinator note 5c1e. Then end your turn. |
| S5 | notification | Run the Bash command "sleep 20; echo replay-done" with run_in_background set, then end your turn. |
| S6 | main-turn | Read filler/filler-4.txt and filler/filler-5.txt whole, one Read call each. Then call forward_compaction with Objective "replay step S6", and end your turn. |
| S7 | manual-compact | /compact |
| S8 | main-turn | Read filler/filler-1.txt to filler/filler-8.txt whole, one Read call each. Call forward_compaction only when a tool result tells you Claude Code is asking to compact you; then call it with Objective "replay step S8" and read on. |
