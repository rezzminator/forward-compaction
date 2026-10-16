import { describe, expect, it } from 'vitest';
import { register } from '../plugins/sub-agent-compact/hooks/sub-agent-compact.ts';
import { earlyArm } from '../plugins/sub-agent-compact/src/nudge.ts';

// A main chat on a 1M window, first nudged at 20% (200k): its model asks to
// compact itself at 123k, before any nudge. Observed live: the plugin armed
// it and the chat compacted at 12% of its window.

type AnyHook = (...args: any[]) => any;
const TOOL = 'mcp__sub-agent-compact__compact';

function engine() {
  const hooks = new Map<string, AnyHook>();
  const on = (event: string, hook: AnyHook) => void hooks.set(event, hook);
  const $ = {
    session: { id: async () => 'session-1', cwd: async () => '/nowhere', usage: async () => ({ context: { tokens: 0, window: 1_000_000 } }) },
    env: { get: async (name: string) => (name === 'CLAUDE_CODE_AUTO_COMPACT_WINDOW' ? '100000' : undefined) },
    settings: { read: async () => ({}) },
    fs: { exists: async () => false, read: async () => '', write: async () => {}, list: async () => [] },
    ui: { log: () => {} },
    agent: { list: async () => [] },
    tool: { register: async (spec: { name: string }) => ({ tool: `mcp__sub-agent-compact__${spec.name}` }) },
  };
  register(on as never, {} as never);
  const dispatch = (event: string, e: unknown, impl: (e: any) => any) => {
    const next = Object.assign((input: unknown) => impl(input), { signal: new AbortController().signal });
    const hook = hooks.get(event);
    return hook ? hook($, e, next) : impl(e);
  };
  const step = async (tokens: number) => {
    const gen = dispatch('turn.step', { model: 'claude-opus-4-5[1m]' }, async function* () {
      return { usage: { input_tokens: tokens }, answer: 'working', toolUses: [{}] };
    });
    for (;;) if ((await gen.next()).done) break;
  };
  const arm = () => dispatch('tool.call', { tool: TOOL, focus: 'plan: PLAN.md; next: phase 3' }, async () => ({ result: 'unreached' }));
  const autoAsk = () => dispatch('session.compact', { trigger: 'auto', messages: [] }, async () => ({ messages: [], tokensAfter: 20_000 }));
  return { step, arm, autoAsk, start: () => dispatch('session.start', {}, async () => ({})) };
}

describe('a self-compaction asked for below the first nudge point', () => {
  it('is refused, and the next automatic ask is held', async () => {
    const cc = engine();
    await cc.start();
    await cc.step(123_000);
    expect(await cc.arm()).toEqual({ result: expect.stringMatching(/^Not armed: .*123k.*200k/) });
    expect(await cc.autoAsk()).toEqual({ skip: expect.any(String) });
  });

  it('control: past the first nudge point, it arms and the next automatic ask compacts', async () => {
    const cc = engine();
    await cc.start();
    await cc.step(250_000);
    expect(await cc.arm()).toEqual({ result: expect.stringMatching(/armed/) });
    expect(await cc.autoAsk()).toEqual({ messages: [], tokensAfter: 20_000 });
  });
});

describe('earlyArm', () => {
  it('refuses below the nudge point, naming both sizes', () => {
    expect(earlyArm({ tokens: 123_000, nudgeStart: 200_000 })).toMatch(/123k.*200k/);
  });
  it('allows at or past the nudge point, and without a reading', () => {
    expect(earlyArm({ tokens: 200_000, nudgeStart: 200_000 })).toBeUndefined();
    expect(earlyArm({ tokens: undefined, nudgeStart: 200_000 })).toBeUndefined();
  });
});
