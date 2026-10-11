import { describe, expect, it } from 'vitest';
import { register } from '../plugins/sub-agent-compact/hooks/sub-agent-compact.ts';

// A Workflow run's agents carry ids `$.agent.list()` never names, so their
// type reaches the plugin only through Claude Code's SubagentStart and
// SubagentStop hooks. Each agent here runs on a 200k window at 70k: past the
// sub-agent nudge point (20%), below its forced point (60%, 120k). A resumed
// agent, announced the same way here, is asked to compact before its first step.

type AnyHook = (...args: any[]) => any;
const ID = 'ae94f8193d6856148';

function engine() {
  const hooks = new Map<string, AnyHook>();
  const on = (event: string, hook: AnyHook) => void hooks.set(event, hook);
  const logs: string[] = [];
  const $ = {
    session: {
      id: async () => 'session-1',
      cwd: async () => '/nowhere',
      usage: async () => ({ context: { tokens: 50_000, window: 200_000 } }),
    },
    env: { get: async () => undefined },
    fs: { exists: async () => false, read: async () => '', write: async () => {}, list: async () => [] },
    ui: { log: (line: string) => void logs.push(line) },
    agent: { list: async () => [] },
    tool: { register: async () => ({ tool: 'mcp__sub-agent-compact__compact' }) },
  };
  register(on as never, {} as never);

  const dispatch = (event: string, e: unknown, impl: (e: any) => any) => {
    const next = Object.assign((input: unknown) => impl(input), { signal: new AbortController().signal });
    const hook = hooks.get(event);
    return hook ? hook($, e, next) : impl(e);
  };

  /** One model response of the agent at `tokens`, as turn.step streams it. */
  const step = async (tokens: number) => {
    const result = { usage: { input_tokens: tokens }, answer: 'working', toolUses: [{}] };
    const gen = dispatch('turn.step', { agentId: ID, model: 'claude-sonnet-4-5' }, async function* () {
      return result;
    });
    for (;;) if ((await gen.next()).done) break;
  };
  const toolCall = () => dispatch('tool.call', { agentId: ID, tool: 'Read' }, async () => ({ result: 'file text' }));
  const autoAsk = (messages: unknown[] = []) => dispatch('session.compact', { agentId: ID, trigger: 'auto', messages }, async () => ({ messages: [], tokensAfter: 10_000 }));
  const subagentStart = () => dispatch('classic.SubagentStart', { agent_id: ID, agent_type: 'general-purpose' }, async () => ({}));

  return { logs, step, toolCall, autoAsk, subagentStart };
}

describe('a Workflow agent missing from $.agent.list()', () => {
  it('announced by SubagentStart, is held below its forced point', async () => {
    const cc = engine();
    await cc.subagentStart();
    await cc.step(70_000);
    expect(await cc.autoAsk()).toEqual({ skip: expect.stringContaining('general-purpose') });
  });

  it('announced by SubagentStart, is nudged past its nudge point', async () => {
    const cc = engine();
    await cc.subagentStart();
    await cc.step(70_000);
    const result = await cc.toolCall();
    expect(result.context).toEqual([expect.stringContaining('compact')]);
    expect(cc.logs.filter((line) => line.includes('failed'))).toEqual([]);
  });

  it('never announced, is left to Claude Code: no nudge, the compaction passes, nothing logged as failed', async () => {
    const cc = engine();
    await cc.step(70_000);
    expect((await cc.toolCall()).context).toBeUndefined();
    expect(await cc.autoAsk()).toEqual({ messages: [], tokensAfter: 10_000 });
    expect(cc.logs.filter((line) => line.includes('failed'))).toEqual([]);
  });
});

describe('a resumed agent asked to compact before any response of its own', () => {
  const transcript = [{ role: 'user', text: 'x'.repeat(350_000), toolUses: [] }]; // 100k tokens by the estimate

  it('is held below its forced point by its transcript, and let through when asked again without having answered', async () => {
    const cc = engine();
    await cc.subagentStart();
    expect(await cc.autoAsk(transcript)).toEqual({ skip: 'general-purpose 100k/120k' });
    // no response came between the two asks: the request failed, as a prompt too long does, and the recovery compaction must run
    expect(await cc.autoAsk(transcript)).toMatchObject({ tokensAfter: 10_000 });
  });
});
