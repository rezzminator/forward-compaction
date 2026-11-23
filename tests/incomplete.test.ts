// A frontier without its objective or next, and a call a broken field may have ended early, are stored, never refused: the install waits one request for the rest, then the frontier installs as it is, its wake naming what it lacks.
import { afterEach, describe, expect, it } from 'vitest';
import { begin, cleanup, rows, step, store, transcript, FORWARD, type Fake } from './fakes/session.ts';

afterEach(cleanup);

describe('an unfinished call is stored, and its install waits one request for the rest', () => {
  const HELD = "forward-compaction: holding Claude Code's compaction for main for one request: its forward_compaction call arrived broken or without its objective or next, and its next request can send the rest";
  const INSIDE = 'inside this turn: what you have read is gone then, and the rest of the turn, your reply to the user included, is written from the frontier. The newest messages after this call that fit are kept verbatim behind it, the rest named as not carried.';
  const cutOff = (f: Fake, id = 'tu-h') => f.dispatch('tool.call', { tool: FORWARD, tool_use_id: id, objective: 'Ship U5, cut off mid-wo' }, async () => ({ result: 'not ours' }));
  const answer = (f: Fake, turnId: string) => f.dispatch('turn.complete', { reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId }, async () => ({ text: 'done' }));
  const ask = (f: Fake, id = 'tu-h') => f.dispatch('session.compact', { trigger: 'auto', messages: transcript(id) }, async () => ({ skip: 'native ran' }));
  const asks = async (f: Fake) => (await rows(f)).filter((row) => row.event === 'compact').map((row) => [row.decision, row.why, row.incomplete ?? null]);

  it('answers with what is missing, holds one ask, then installs with a wake naming it, and warns', async () => {
    const f = await begin();
    await step(f, 64_000);
    const r = await cutOff(f);
    expect(r.result.split('\n').slice(0, 4)).toEqual([
      'objective set',
      'Frontier: 23 characters in 0 items',
      'Storage: none',
      `Frontier stored, without next: send it before it installs, or the wake names it missing. It installs after your next request, ${INSIDE}`,
    ]);
    expect(await ask(f)).toEqual({ skip: HELD });
    await step(f, 64_500);
    const wake = await ask(f);
    expect(wake.messages[1].text.split('\n\n').slice(1, 3)).toEqual(['=== frontier ===\n## Objective\nShip U5, cut off mid-wo\n=== end of frontier ===', "Your frontier has no next: re-establish it from the user's messages and the messages below, and send it in your next forward_compaction call."]);
    const r2 = await rows(f);
    expect(r2.filter((row) => row.event === 'stored').map((row) => [row.waits ?? null, row.incomplete ?? null])).toEqual([[true, ['next']]]);
    expect(await asks(f)).toEqual([['skip', 'unfinished', null], ['install', 'stored', ['next']]]);
    expect(r2.filter((row) => row.event === 'said').map((row) => row.line)).toContain("main's frontier installed without next: its wake asks the model to re-establish it.");
  });

  it('holds one ask for a call whose list arrived broken, and the call that sends the rest installs at the next ask, complete', async () => {
    const f = await begin();
    await step(f, 64_000);
    const cut = await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-h', objective: 'Ship U5.', orders: '\n<parameter name="add">["No git writes."]' }, async () => ({ result: 'not ours' }));
    expect(cut.result.split('\n').slice(0, 6)).toEqual([
      'objective set',
      'Added to orders: [1]',
      "orders arrived as text whose JSON was broken: repaired and read, this result's lines show what it changed.",
      'Frontier: 22 characters in 1 items (orders 1)',
      'Storage: none',
      `Frontier stored, without next: send it before it installs, or the wake names it missing. A broken field can end a call early: if the lines above lack something you meant to send, send it before it installs. It installs after your next request, ${INSIDE}`,
    ]);
    expect(await ask(f)).toEqual({ skip: HELD });
    await step(f, 64_500);
    const rest = await store(f, undefined, 'tu-h2');
    expect(rest.result.split('\n').slice(0, 4)).toEqual(['objective unchanged', 'Added to done: [1]', 'Added to remaining: [1]', 'next set']);
    expect(rest.result.split('\n')[6]).toBe(`Frontier stored. It installs before your next request, ${INSIDE} This call applied on top of your earlier one since the last wake.`);
    const wake = await ask(f, 'tu-h2');
    expect(wake.messages[1].text).toContain('## Next\nWire session.compact.');
    expect(wake.messages[1].text).not.toContain('Your frontier has no');
    const r2 = await rows(f);
    expect(r2.filter((row) => row.event === 'stored').map((row) => [row.waits ?? null, row.incomplete ?? null])).toEqual([[true, ['next']], [null, null]]);
    expect(await asks(f)).toEqual([['skip', 'unfinished', null], ['install', 'stored', null]]);
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
