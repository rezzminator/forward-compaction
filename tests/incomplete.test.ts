// A frontier missing a MANDATORY section is stored, never refused, and never installs: every door treats it as nothing stored.
import { afterEach, describe, expect, it } from 'vitest';
import { begin, cleanup, rows, step, store, transcript, FORWARD, type Fake } from './fakes/session.ts';

afterEach(cleanup);

describe('a frontier missing a MANDATORY section is stored and never installs', () => {
  const cutOff = (f: Fake, id = 'tu-h') => f.dispatch('tool.call', { tool: FORWARD, tool_use_id: id, objective: 'Ship U5, cut off mid-wo' }, async () => ({ result: 'not ours' }));
  const answer = (f: Fake, turnId: string) => f.dispatch('turn.complete', { reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId }, async () => ({ text: 'done' }));

  it('answers with what is missing and that it will not install, holds every ask and the turn end, and a complete call then installs', async () => {
    const f = await begin();
    await step(f, 64_000);
    const r = await cutOff(f);
    expect(r.result).toMatch(/^Frontier stored \(\d+ characters, 0 files\), but a MANDATORY section is missing, so it does not install/);
    expect(r.result).toContain('Stored with 4 changes:\n- decisions was missing: your frontier is stored without it.\n- done was missing');
    expect(r.result).toContain('- next was missing: your frontier is stored without it.\nThis frontier will not install until you call forward_compaction again with every MANDATORY section.\nforward-compaction is experimental.');
    expect(await f.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' }))).toEqual({ skip: "forward-compaction: holding Claude Code's compaction for main until its frontier is stored or the ceiling is reached" });
    await answer(f, 't1');
    expect(f.compactCalls).toEqual([]);
    await step(f, 64_000);
    expect((await store(f, undefined, 'tu-h2')).result).not.toContain('MANDATORY');
    await answer(f, 't2');
    expect(f.compactCalls).toEqual([[]]);
    const stored = (await rows(f)).filter((row) => row.event === 'stored');
    expect(stored.map((row) => row.incomplete ?? null)).toEqual([['decisions', 'done', 'remaining', 'next'], null]);
  });

  it('gives the mechanical wake at the ceiling, saying the call never installed', async () => {
    const f = await begin();
    await step(f, 64_000);
    await cutOff(f);
    await step(f, 125_000);
    const r = await f.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' }));
    expect(r.messages[1].text).toContain('your last forward_compaction call was missing decisions, done, remaining and next, so it never installed');
  });
});
