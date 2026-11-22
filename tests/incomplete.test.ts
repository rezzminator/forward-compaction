// A frontier without its objective or next is stored, never refused, and installs as it is: its wake names what it lacks.
import { afterEach, describe, expect, it } from 'vitest';
import { begin, cleanup, rows, step, store, transcript, FORWARD, type Fake } from './fakes/session.ts';

afterEach(cleanup);

describe('a frontier without its next is stored and installs without it', () => {
  const cutOff = (f: Fake, id = 'tu-h') => f.dispatch('tool.call', { tool: FORWARD, tool_use_id: id, objective: 'Ship U5, cut off mid-wo' }, async () => ({ result: 'not ours' }));
  const answer = (f: Fake, turnId: string) => f.dispatch('turn.complete', { reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId }, async () => ({ text: 'done' }));

  it('answers with what is missing, installs at the next ask with a wake naming it, and warns', async () => {
    const f = await begin();
    await step(f, 64_000);
    const r = await cutOff(f);
    expect(r.result.split('\n').slice(0, 3)).toEqual([
      'objective set',
      'Frontier: 23 characters in 0 items',
      "Frontier stored, without next: send it before it installs, or the wake names it missing. It installs before your next request, inside this turn: what you have read is gone then, and the rest of the turn, your reply to the user included, is written from the frontier. The newest messages after this call that fit are kept verbatim behind it, the rest named as not carried.",
    ]);
    const wake = await f.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' }));
    expect(wake.messages[1].text.split('\n\n').slice(1, 3)).toEqual(['=== frontier ===\n## Objective\nShip U5, cut off mid-wo\n=== end of frontier ===', "Your frontier has no next: re-establish it from the user's messages and the messages below, and send it in your next forward_compaction call."]);
    const r2 = await rows(f);
    expect(r2.filter((row) => row.event === 'stored').map((row) => row.incomplete ?? null)).toEqual([['next']]);
    expect(r2.filter((row) => row.event === 'compact').map((row) => [row.decision, row.incomplete ?? null])).toEqual([['install', ['next']]]);
    expect(r2.filter((row) => row.event === 'said').map((row) => row.line)).toContain("main's frontier installed without next: its wake asks the model to re-establish it.");
  });

  it("installs at main's turn end like a complete one, and a later call that sends next completes it", async () => {
    const f = await begin();
    await step(f, 64_000);
    await cutOff(f);
    expect((await store(f, undefined, 'tu-h2')).result.split('\n').slice(0, 4)).toEqual(['objective replaced', 'Added to done: [1]', 'Added to remaining: [1]', 'next set']);
    await answer(f, 't1');
    expect(f.compactCalls).toEqual([[]]);
    const f2 = await begin();
    await step(f2, 64_000);
    await cutOff(f2);
    await answer(f2, 't1');
    expect(f2.compactCalls).toEqual([[]]);
  });
});
