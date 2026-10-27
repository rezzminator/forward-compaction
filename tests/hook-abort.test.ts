import { afterEach, describe, expect, it } from 'vitest';
import { fakeEngine, type Script } from './fakes/engine.ts';

// A hook that waits on past its dispatch's abort is a "runaway plugin in the hooks worker" to Claude Code: after a few
// in a row, every other plugin's tool.call fails open ("ignored its signal 2 times in a row"). These drive the hooks
// with a `$` call that never settles and an abort, and require the hook to be back at once.

type Fake = ReturnType<typeof fakeEngine>;
const fakes: Fake[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) {
    expect(f.unscripted, 'every $ call the plugin made was scripted').toEqual([]);
    f.cleanup();
  }
});

const HUNG = Symbol('hung');
const tick = (ms: number) => new Promise<typeof HUNG>((resolve) => setTimeout(() => resolve(HUNG), ms));

function engine(hang: Script['hang']): Fake {
  const f = fakeEngine({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000' }, hang });
  fakes.push(f);
  return f;
}

/** The hook's result, with the dispatch aborted a moment in; HUNG when it is still waiting well after. */
async function afterAbort(run: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
  const controller = new AbortController();
  const hook = run(controller.signal);
  await tick(10);
  controller.abort();
  return Promise.race([hook, tick(300)]);
}

describe('hooks return once their dispatch is aborted', () => {
  it('tool.call: a session id that never settles does not hold a Read past its abort', async () => {
    const cc = engine(['session.id']);
    const out = await afterAbort((signal) => cc.dispatch('tool.call', { tool: 'Read', tool_use_id: 'tu-r', file_path: '/x' }, async () => ({ result: 'read' }), signal));
    expect(out).toEqual({ result: 'read' });
  });

  it('session.start: a registration that never settles does not hold the hook past its abort', async () => {
    const cc = engine(['tool.register']);
    const out = await afterAbort((signal) => cc.dispatch('session.start', { reason: 'startup' }, async () => ({ started: true }), signal));
    expect(out).toEqual({ started: true });
  });
});
