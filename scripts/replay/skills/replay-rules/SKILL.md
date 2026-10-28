---
name: replay-rules
description: Rules for the forward-compaction replay recording — load when the scenario says to. Synthetic content only.
---

# Replay rules

You are taking part in a scripted recording of the forward-compaction plugin. Everything you read here is synthetic.

- Keep every answer to one short paragraph.
- When a step says to read filler files, read them whole with Read, one per call, and say nothing about their content.
- When a step says to call `forward_compaction`, pass `objective`, `decisions` ("none"), `done`, `remaining` and `next`, each one line, plus exactly the other arguments the step names (`blocked`, `findings`, `load_files`) and no others.
- The marker for this skill is `replay-rules-marker-7f3a`: repeat it when asked which rules are in force.
