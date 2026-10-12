import { describe, expect, it } from 'vitest';
import { register } from '../plugins/sub-agent-compact/hooks/sub-agent-compact.ts';

// Drives the adapter as Claude Code does: a main chat on a 1M window at 310k,
// forced at 600k, CLAUDE_CODE_AUTO_COMPACT_WINDOW 100000 so every request
// asks to compact. Its model arms a compaction, the person interrupts it.

type AnyHook = (...args: any[]) => any;
const TOOL = 'mcp__sub-agent-compact__compact';

function engine() {
  const hooks = new Map<string, AnyHook>();
  const on = (event: string, hook: AnyHook) => void hooks.set(event, hook);
  const $ = {
    session: {
      id: async () => 'session-1',
      cwd: async () => '/nowhere',
      usage: async () => ({ context: { tokens: 310_000, window: 1_000_000 } }),
      compact: async () => ({ skip: 'not in this test' }),
    },
    env: { get: async (name: string) => (name === 'CLAUDE_CODE_AUTO_COMPACT_WINDOW' ? '100000' : undefined) },
    fs: { exists: async () => false, read: async () => '', write: async () => {}, list: async () => [] },
    ui: { log: () => {} },
    agent: { list: async () => [] },
    tool: { register: async (spec: { name: string }) => ({ tool: `mcp__sub-agent-compact__${spec.name}` }) },
  };
  register(on as never, { compactTool: true } as never);

  /** One dispatch of `event`; with no hook for it, the engine's own `impl` answers, as core would. */
  const dispatch = (event: string, e: unknown, impl: (e: any) => Promise<unknown>, signal = new AbortController().signal) => {
    const next = Object.assign((input: unknown) => impl(input), { signal });
    const hook = hooks.get(event);
    return hook ? hook($, e, next) : impl(e);
  };

  const ran: unknown[] = [];
  /** The compaction core runs when every hook lets it through. */
  const compactor = async (e: unknown) => (ran.push(e), { messages: [], tokensAfter: 20_000 });
  const autoAsk = (impl: (e: any) => Promise<unknown> = compactor, signal?: AbortSignal) => dispatch('session.compact', { trigger: 'auto', messages: [] }, impl, signal);
  const arm = () => dispatch('tool.call', { tool: TOOL, focus: 'plan: checkpoint-9.md; next: re-arm the window' }, async () => ({ result: 'unreached' }));
  const prompt = (kind: string) => dispatch('prompt.submit', { text: "don't compact now", origin: { kind }, wait: false }, async (e) => e);

  return { ran, dispatch, autoAsk, arm, prompt, start: () => dispatch('session.start', {}, async () => ({})) };
}

describe('an armed self-compaction the person interrupts (Ctrl+C)', () => {
  it('control: armed and left alone, the next automatic ask compacts', async () => {
    const cc = engine();
    await cc.start();
    expect(await cc.arm()).toEqual({ result: expect.stringMatching(/armed/) });
    await cc.autoAsk();
    expect(cc.ran).toHaveLength(1);
  });

  it('is cancelled: the interrupted compaction does not run again on the next request', async () => {
    const cc = engine();
    await cc.start();
    await cc.arm();

    // Ctrl+C lands while the compaction is in flight: the signal aborts and core answers with a skip.
    const ctrlC = new AbortController();
    const interrupted = cc.autoAsk(async () => {
      ctrlC.abort();
      return { skip: 'interrupted' };
    }, ctrlC.signal);
    expect(await interrupted).toEqual({ skip: 'interrupted' });

    // The person's next request: Claude Code asks again at 310k, below the 600k forced point.
    expect(await cc.autoAsk()).toEqual({ skip: expect.stringMatching(/310k\/600k/) });
    expect(cc.ran).toHaveLength(0);
  });

  it('is cancelled by the abort alone when the interrupted compaction never settles', async () => {
    const cc = engine();
    await cc.start();
    await cc.arm();

    // Ctrl+C mid-compaction; the engine abandons the dispatch, so the hook's next() never answers.
    const ctrlC = new AbortController();
    let inFlight!: () => void;
    const reached = new Promise<void>((resolve) => (inFlight = resolve));
    void cc.autoAsk(() => (inFlight(), ctrlC.abort(), new Promise(() => {})), ctrlC.signal);
    await reached;

    expect(await cc.autoAsk()).toEqual({ skip: expect.stringMatching(/310k\/600k/) });
    expect(cc.ran).toHaveLength(0);
  });

  it('is cancelled when Ctrl+C lands before the hook reaches the compaction', async () => {
    const cc = engine();
    await cc.start();
    await cc.arm();

    const ctrlC = new AbortController();
    ctrlC.abort();
    void cc.autoAsk(() => new Promise(() => {}), ctrlC.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await cc.autoAsk()).toEqual({ skip: expect.stringMatching(/310k\/600k/) });
    expect(cc.ran).toHaveLength(0);
  });

  it("is cancelled by the person's prompt, which tells the model not to ask again", async () => {
    const cc = engine();
    await cc.start();
    await cc.arm();

    const entered = (await cc.prompt('composer')) as { context?: string[] };
    expect(entered.context?.join('\n')).toMatch(/cancelled the compaction you armed/);
    expect(await cc.autoAsk()).toEqual({ skip: expect.stringMatching(/310k\/600k/) });
    expect(cc.ran).toHaveLength(0);
  });

  it("is not cancelled by another chat's message, which is not the person", async () => {
    const cc = engine();
    await cc.start();
    await cc.arm();

    await cc.prompt('peer');
    await cc.autoAsk();
    expect(cc.ran).toHaveLength(1);
  });
});
