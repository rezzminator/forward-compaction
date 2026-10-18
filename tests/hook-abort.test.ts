import { describe, expect, it } from 'vitest';
import { register } from '../plugins/sub-agent-compact/hooks/sub-agent-compact.ts';

// A hook that waits on past its dispatch's abort is a "runaway plugin in the hooks worker" to Claude Code: after a few
// in a row, every other plugin's tool.call fails open ("ignored its signal 2 times in a row"). These drive the hooks
// with a `$` call that never settles and an abort, and require the hook to be back at once.

type AnyHook = (...args: any[]) => any;
const NEVER = new Promise<never>(() => {});
const HUNG = Symbol('hung');
const tick = (ms: number) => new Promise<typeof HUNG>((resolve) => setTimeout(() => resolve(HUNG), ms));

function engine(hang: { env?: boolean; turns?: boolean; register?: boolean }) {
  const hooks = new Map<string, AnyHook>();
  const on = (event: string, hook: AnyHook) => void hooks.set(event, hook);
  const $ = {
    session: {
      id: async () => 'session-1',
      turns: () => (hang.turns ? NEVER : Promise.resolve(1)),
      cwd: async () => '/nowhere',
      usage: async () => ({ context: { tokens: 1_000, window: 1_000_000 } }),
    },
    env: { get: (key: string) => (hang.env ? NEVER : Promise.resolve(key === 'HOME' ? '/h/u' : undefined)) },
    settings: { read: async () => ({}) },
    fs: { exists: async () => false, read: async () => '', write: async () => {}, list: async () => [], stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0, isLink: false }) },
    process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    // The timer of an aborted dispatch never fires.
    clock: { now: async () => 1791991231123, after: () => ({ cancel: () => {} }) },
    ui: { log: () => {} },
    agent: { list: async () => [] },
    tool: { register: (spec: { name: string }) => (hang.register ? NEVER : Promise.resolve({ tool: `mcp__sub-agent-compact__${spec.name}` })) },
  };
  register(on as never, {} as never);
  const dispatch = (event: string, e: unknown, impl: (e: any) => any, controller: AbortController): any => {
    const next = Object.assign((input: unknown) => impl(input), { signal: controller.signal });
    return hooks.get(event)!($, e, next);
  };
  return { dispatch };
}

/** The hook's promise, with the dispatch aborted a moment in; HUNG when it is still waiting well after. */
async function afterAbort(run: (controller: AbortController) => Promise<unknown>): Promise<unknown> {
  const controller = new AbortController();
  const hook = run(controller);
  await tick(10);
  controller.abort();
  return Promise.race([hook, tick(300)]);
}

describe('hooks return once their dispatch is aborted', () => {
  it('tool.call: a stalled start does not hold the call past its abort', async () => {
    const cc = engine({ env: true });
    const out = await afterAbort((c) => cc.dispatch('tool.call', { tool: 'Edit', file_path: 'x' }, async () => ({ result: 'edited' }), c));
    expect(out).toEqual({ result: 'edited' });
  });

  it('session.start: a registration that never settles does not hold the hook past its abort', async () => {
    const cc = engine({ register: true });
    const out = await afterAbort((c) => cc.dispatch('session.start', {}, async () => ({ started: true }), c));
    expect(out).toEqual({ started: true });
  });

  it('turn.step: a reading that never settles does not hold the step past its abort', async () => {
    const cc = engine({ turns: true });
    const out = await afterAbort(async (c) => {
      const gen = cc.dispatch('turn.step', { model: 'claude-opus-4-5[1m]', index: 0, messageCount: 1 }, async function* () {
        return { usage: { input_tokens: 1_000 }, answer: 'working', toolUses: [{}] };
      }, c);
      for (;;) if ((await gen.next()).done) return 'done';
    });
    expect(out).toBe('done');
  });
});
