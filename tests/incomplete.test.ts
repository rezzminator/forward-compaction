// A frontier missing a MANDATORY section is stored, never refused, and installs as it is: its wake names each section it lacks.
import { afterEach, describe, expect, it } from 'vitest';
import { begin, cleanup, rows, step, store, transcript, FORWARD, type Fake } from './fakes/session.ts';

afterEach(cleanup);

describe('a frontier missing a MANDATORY section is stored and installs without it', () => {
  const cutOff = (f: Fake, id = 'tu-h') => f.dispatch('tool.call', { tool: FORWARD, tool_use_id: id, objective: 'Ship U5, cut off mid-wo' }, async () => ({ result: 'not ours' }));
  const answer = (f: Fake, turnId: string) => f.dispatch('turn.complete', { reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId }, async () => ({ text: 'done' }));

  it('answers with what is missing, installs at the next ask with a wake naming each missing section, and warns', async () => {
    const f = await begin();
    await step(f, 64_000);
    const r = await cutOff(f);
    expect(r.result).toMatch(/^Frontier stored \(\d+ characters, 0 files\), missing a MANDATORY section: the wake will name each one it lacks\. It installs at the end of this turn/);
    expect(r.result).toContain('Stored with 4 changes:\n- decisions was missing: your frontier is stored without it.\n- done was missing');
    expect(r.result).toContain('- next was missing: your frontier is stored without it.\nCall forward_compaction again with every MANDATORY section to replace it before it installs.\nforward-compaction is experimental.');
    const wake = await f.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' }));
    expect(wake.messages[1].text).toContain('=== frontier ===\n## Objective\nShip U5, cut off mid-wo\n=== end of frontier ===');
    expect(wake.messages[1].text).toContain("Your frontier was missing decisions, done, remaining and next: re-establish them from the person's messages and the messages below.");
    const r2 = await rows(f);
    expect(r2.filter((row) => row.event === 'stored').map((row) => row.incomplete ?? null)).toEqual([['decisions', 'done', 'remaining', 'next']]);
    expect(r2.filter((row) => row.event === 'compact').map((row) => [row.decision, row.incomplete ?? null])).toEqual([['install', ['decisions', 'done', 'remaining', 'next']]]);
    expect(r2.filter((row) => row.event === 'said').map((row) => row.line)).toContain("main's frontier installed without decisions, done, remaining and next, the MANDATORY sections it lacked.");
  });

  it("installs at main's turn end like a complete one, and a complete call replaces it", async () => {
    const f = await begin();
    await step(f, 64_000);
    await cutOff(f);
    expect((await store(f, undefined, 'tu-h2')).result).not.toContain('MANDATORY');
    await answer(f, 't1');
    expect(f.compactCalls).toEqual([[]]);
    const f2 = await begin();
    await step(f2, 64_000);
    await cutOff(f2);
    await answer(f2, 't1');
    expect(f2.compactCalls).toEqual([[]]);
  });
});
