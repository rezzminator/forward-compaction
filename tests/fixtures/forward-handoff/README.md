# Forward handoff donor replays

`forward_handoff -> record.json + wake.txt -> session.compact -> install check -> second forward_handoff -> record carry`

Run `npm test -- tests/forward-replay.test.ts tests/forward-policy.test.ts` from the repository root. The ordinary `npm test` gate collects both files. The replay process boots the shipped TypeScript hook through the installed TypeScript compiler, using the same host double as the adapter tests, extracted into `tests/fakes/forward-engine.ts`.

Each replay owns a temporary home, transcript and log directory. Transcript searches run real grep/shell commands against the temporary file, and production log scripts write real logs there. Session, settings, Git and record filesystem operations use the existing host double. Assertions read the stored records, literal installed text, install verification, tool reply and production error log; no model or installed plugin runs. This covers the plugin's hook lifecycle and carry protocol; it does not certify Claude Code's delivery of host events or a live model's adherence to instructions.

## Donor provenance

| Fixture | Transcript session | Source | Behaviour |
| --- | --- | --- | --- |
| `queued-prompt.json` | `3c68b8b8-aa25-4a8b-979f-5640e605a581` | enqueue at 513, handoff at 519, removal at 521, wake at 525; record 1 | Recover the exact prompt even when removed as `absorbed_mid_turn`. |
| `queued-skill-instruction.json` | `05ee6a85-45ee-4b10-8a86-6df28033ad44` | queued attachment at 9532; record 31 | Recover the user's exact god-speed instruction rather than its paraphrase. |
| `native-compaction.json` | `17483962-a39f-4ad2-a243-df614a83dde4` | boundary at 9610, summary at 9614; wakes 36–44, records 44–45 | Recover skills from the latest record; exclude resurfaced wakes from prompt history. |
| `pinned-skill-drop.json` | `05ee6a85-45ee-4b10-8a86-6df28033ad44` | sub-agent `a48ef9bffb1e2753f`, record 1 and arguments 2 | Preserve pinned god-speed despite the model's recorded `drop_skills`. |

These are real excerpts, as requested by the owner. Queue text, event shapes, skill names and the model's drop list are preserved. Unrelated metadata, private history and most bodies are omitted; host paths are scrubbed. Shortened wake texts have independently recomputed FNV hashes so the retained records still identify their wakes. Skill bodies retain their actual opening instruction. Tests provision policy settings and the existing harness's frontier fields; the donors supply the lost data and recorded model drop.

## Assertions and failure proofs

The original ten replay tests were observed failing against the original production code before the fixes, then passing through storage, installation and a second carry. The replay assertions cover both queue formats, native record recovery and its warning, nonleading wake exclusion, central and agent pins, overlapping policy lists, central exclusions, malformed settings and live instruction framing. Six additional replays exercise delayed attachment delivery (disk and API), an archived wake after an enqueue, a newer typed correction, and cancelled handoffs before ordinary or native compaction. Expected prompts and skill bodies come from these fixtures; policy and framing expectations come from the owner's specification.

The agent replay sets opposing central and agent lists: inheriting the central policy now fails it. The landing regressions were watched red with the corresponding pre-patch behavior restored, then green after restoration, including comment-only YAML lines, native recovery without an installed wake, chronological queue order and cross-cursor attachment matching. The archived-wake and delayed-API regressions failed on the reviewed code before their fixes.

The unit tests cover policy defaults and malformed lists, nested YAML lists, drop precedence, skill cap boundaries, prompt priority, repeated queue messages, enqueue/attachment reconciliation, persisted transcript cursors, recovery after a recorded wake and malformed transcript diagnostics. The 47,999- and 48,000-character controls were also observed failing under a temporary mutation of the cap comparison, then passing after restoration; the 48,001-character regression failed before the fix. No source mutation remains.

## Gates and limits

Required gates are `npm test`, `npm run typecheck` and `npm run validate:plugin`. Settings changes also run the tests with every option environment variable perturbed. Test subprocesses receive only their declared PATH; plugin environment and settings values come from their owned host double.

No paid calls, network acquisition, host settings changes, installed-plugin probes or Git writes belong to these replays. Real transcripts are used only to prepare the checked-in fixtures, never read by a test. The separate-process test boots the plugin entry point against a simulated host; a real Claude Code release rehearsal remains the host-level check.
