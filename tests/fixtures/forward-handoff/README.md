# Synthetic forward handoff replays

`forward_handoff -> record.json + wake.txt -> session.compact -> install check -> second forward_handoff -> record carry`

The focused test command is `npm test -- tests/forward-replay.test.ts tests/forward-policy.test.ts` from the repository root, within the project's test fence. The ordinary `npm test` gate collects both files. The replay process boots the shipped TypeScript hook through the installed TypeScript compiler, using the same host double as the adapter tests, extracted into `tests/fakes/forward-engine.ts`.

Each replay owns a temporary home, transcript and log directory. Transcript searches run real grep/shell commands against the temporary file, and production log scripts write real logs there. Session, settings, Git and record filesystem operations use the existing host double. Assertions read the stored records, literal installed text, install verification, tool reply and production error log; no model or installed plugin runs. This covers the plugin's hook lifecycle and carry protocol; it does not certify Claude Code's delivery of host events or a live model's adherence to instructions.

## Synthetic content contract

All fixture content is entirely synthetic, modelled on real handoff record shapes. Prompts, assistant messages, summaries, wake text and skill bodies are fully invented; they are not transcript excerpts or actual/private skill bodies. Session, agent and source IDs are obvious synthetic labels, not real identities. Record sequences, source line numbers and event ordering retain their replay roles; those numbers are fixture metadata, not attribution to a real transcript.

The synthetic skill names are `review-checklist`, `package-checklist`, `testing-manual` and `god-speed`. The invented `god-speed` body preserves the autonomy/completion intent: proceed independently and finish the work rather than stop for routine confirmation. It does not reproduce a private skill's wording.

Harness protocol wrapper literals are necessarily preserved so the production parser sees the expected queue, skill, summary and wake framing. They are protocol syntax, not retained conversation content. Wake hashes are recomputed from the invented wake text using the production `fnv1a` algorithm: 32-bit FNV-1a over JavaScript UTF-16 code units, rendered as eight hexadecimal digits, not a hash of UTF-8 bytes. Changes to wake text require recomputing its hash.

## Behaviour matrix

| Fixture | Record mechanics | Behaviour |
| --- | --- | --- |
| `queued-prompt.json` | Queue enqueue, removal and wake; record 1 | Recover the exact synthetic prompt even when removed as `absorbed_mid_turn`. |
| `queued-skill-instruction.json` | Queued attachment; record 31 | Recover the exact invented god-speed instruction rather than its paraphrase. |
| `native-compaction.json` | Compaction boundary and summary; wakes 36–44, records 44–45 | Recover skills from the latest record; exclude resurfaced wakes from prompt history. |
| `pinned-skill-drop.json` | Synthetic sub-agent; record 1 and arguments 2 | Preserve pinned god-speed despite the synthetic `drop_skills` request. |

## Assertion scope

The replay assertions cover both queue formats, native record recovery and its warning, nonleading wake exclusion, central and agent pins, overlapping policy lists, central exclusions, malformed settings and live instruction framing. Other replay cases cover delayed attachment delivery through disk and API, an archived wake after an enqueue, a newer typed correction, and cancelled handoffs before ordinary or native compaction. Expected prompts and skill bodies come from these synthetic fixtures; tests provision policy settings and the harness's frontier fields.

The agent replay sets opposing central and agent lists to distinguish their policies. Regression cases cover comment-only YAML lines, native recovery without an installed wake, chronological queue order and cross-cursor attachment matching.

The unit-test scope includes policy defaults and malformed lists, nested YAML lists, drop precedence, skill cap boundaries, prompt priority, repeated queue messages, enqueue/attachment reconciliation, persisted transcript cursors, recovery after a recorded wake and malformed transcript diagnostics. Cap-boundary cases use 47,999, 48,000 and 48,001 characters. Assertion scope does not establish a passing run or a watched-failing regression; those require separate execution evidence.

## Gates and limits

Required gates are `npm test`, `npm run typecheck` and `npm run validate:plugin`. Settings changes also run the tests with every option environment variable perturbed. Test subprocesses receive only their declared PATH; plugin environment and settings values come from their owned host double. Fixture changes require fenced validation; this README is not a test-results ledger.

No paid calls, network acquisition, host settings changes, installed-plugin probes or Git writes belong to these replays. Tests read only synthetic fixture data, never real transcripts. The separate-process test boots the plugin entry point against a simulated host; a real Claude Code release rehearsal remains the host-level check.
