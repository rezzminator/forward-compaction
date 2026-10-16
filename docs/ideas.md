# Ideas

Features the plugin API makes possible beyond holding a compaction back.
Nothing here is built yet. Each idea names the hook it rides on and what is
still unproven. The API facts come from the generated `types/claude-code.d.ts`
(Claude Code 2.1.282).

## What the API allows

- `session.compact` can rewrite `instructions` (what the summarizer is told)
  and `messages` (what it summarizes) on the way down, rewrite the messages on
  the way up, or answer `{ messages }` of its own in core's place. A message
  handed back with its engine `handle` stands as the engine has it.
- The `precompute` trigger computes a compaction ahead of time. Its result is
  kept for the compaction that comes, if the conversation still leads with it.
- `agent.spawn` sees each sub-agent's `prompt`, `subagentType`, `model`,
  `parentAgentId`, `background` and `fork`.
- `tool.call` can deny a call, or answer with a result plus `context` lines.
- `$.session.send({ to: { agentId } , text })` messages another agent.
- `$.model.complete` and `$.model.classify` let the plugin run a model itself.
- `turn.step` result usage gives the result's cost per model request.
- `ui.status` and `ui.toast` draw in the terminal.

## Tier 1: lose less in each compaction

1. **Brief pinning.** Capture each sub-agent's spawn `prompt` at
   `agent.spawn`, then re-attach it verbatim to the messages every compaction
   returns. An agent never loses its task, its acceptance check or its
   boundary to a summary. In one live run an executor compacted 7 times, so
   its brief went through the summarizer 7 times.
2. **Keep instructions per agent.** A frontmatter field such as
   `compactKeep: "files changed, the failing test, the task file path"`,
   passed down as `next({ ...e, instructions })`. The field's shape is fixed by
   the types; only the wording needs design.
3. **Verbatim keep-list.** A frontmatter field such as `compactPin: Edit, Write`
   takes those messages out of the set to summarize and re-appends them whole
   afterwards, handles kept.

## Tier 2: control the limit, not only hold it

4. **Return instead of compacting.** `onLimit: return`: at the limit, veto
   the compaction and send the agent a message to return what landed, what
   is left and the next step. The parent then starts a fresh agent. A token
   cap as the twin of a call cap. Unproven: whether a `session.send` to a
   running sub-agent arrives mid-loop.
5. **Overshoot guard.** The check runs once per model request, so one large
   read can carry an agent far past its limit (a live run with a 100k limit
   compacted at up to 177k). When an agent is one big read from its limit,
   attach a `context` line to its tool result ("96k of 100k: checkpoint before
   reading more") or narrow the read. Deny and context are in the types;
   rewriting a tool's input is unproven.
6. **Per-spawn limits.** The parent writes a tag such as `[autoCompact:80k]`
   in the Agent call's description and `agent.spawn` reads it, so a limit can
   follow the size of the task, not only the agent type.
7. **Relative limits.** `autoCompact: 50%` of the agent's model window, since
   `agent.spawn` carries the model.

## Tier 3: cheaper and faster

8. **No-pause compaction.** Let `precompute` run at about 85% of a party's
   limit so the summary is ready when the limit is reached. A compaction
   pauses the chat for over a minute today. Unproven: when core fires
   `precompute`, and whether it fires for sub-agents.
9. **Cheap summarizer.** Answer in core's place with `$.model.complete` on a
   smaller model (`compactModel: haiku`). Or, for mechanical agents, a
   model-free compaction: replace old tool results with one-line stubs
   ("read installer.go, 400 lines") and keep the call skeleton. Instant and
   free, lossy in a predictable way.

## Tier 4: see it

10. **Thrash detector.** N compactions within M steps raise an alarm to the
    parent, or annotate a re-read of a file the agent already read before its
    last compaction.
11. **Ledger and status.** Per agent type: compactions, tokens before and
    after, summarizer cost (`result.usage`). A `ui.status` line per live
    sub-agent ("exec-3 96k/100k").

## First picks

1, 2 and 5 answer what the first live runs showed: an overshoot past the
limit, and a brief re-summarized on every compaction. 4 and 8 each rest on
one engine behaviour the types leave open, so each starts with a probe.

## For the test suite

12. **Mutation audit.** A scheduled StrykerJS run over the diff only, never
    a gate, checks that each test still turns red when the code it guards
    breaks.
