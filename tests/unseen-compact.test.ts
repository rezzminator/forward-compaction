import { describe, expect, it } from 'vitest';
import { register } from '../plugins/sub-agent-compact/hooks/sub-agent-compact.ts';
import { optionVars } from './option-env.ts';
import { unseenCompaction } from '../plugins/sub-agent-compact/src/unseen.ts';

// Claude Code 2.1.299 on a machine with managed settings passes every user plugin's session.compact over
// (debug: "sub-agent-compact+cache-live-control: session.compact bypassed by cc-plugin-sec-default (tier user)"):
// the main chat compacts and the plugin hears nothing. Its next reading is the only trace, so a sharp drop
// with no session.compact handled since becomes a compact-unseen row.

type AnyHook = (...args: any[]) => any;

function engine() {
  const hooks = new Map<string, AnyHook>();
  const written: Record<string, string> = {};
  // main's last reading: a compaction ask is judged against it, as Claude Code reports it.
  let current = 0;
  const $ = {
    session: {
      id: async () => 'session-1',
      turns: async () => 1,
      cwd: async () => '/nowhere',
      usage: async () => ({ context: { tokens: current, window: 1_000_000 } }),
      messages: async () => [],
      compact: async () => ({}),
    },
    env: { get: async (name: string) => optionVars({ logFile: '/logs/decisions.jsonl' })[name] },
    settings: { read: async () => ({}) },
    fs: {
      exists: async (path: string) => path in written,
      read: async (path: string) => written[path] ?? '',
      write: async (path: string, content: string) => void (written[path] = content),
      list: async () => [],
    },
    process: {
      run: async (argv: string[], init?: { stdin?: string }) => {
        if (argv[3] === 'decision-log') written[argv[4]!] = (written[argv[4]!] ?? '') + (init?.stdin ?? '');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    clock: { after: (ms: number, fn: () => void) => ({ cancel: () => clearTimeout(setTimeout(fn, ms)) }) },
    ui: { log: () => {} },
    agent: { list: async () => [] },
    tool: { register: async (spec: { name: string }) => ({ tool: `mcp__sub-agent-compact__${spec.name}` }) },
  };
  register(((event: string, hook: AnyHook) => void hooks.set(event, hook)) as never, {} as never);
  const dispatch = (event: string, e: unknown, impl: (e: any) => any): any => {
    const next = Object.assign((input: unknown) => impl(input), { signal: new AbortController().signal });
    const hook = hooks.get(event);
    return hook ? hook($, e, next) : impl(e);
  };
  return {
    start: () => dispatch('session.start', {}, async () => ({})),
    step: async (tokens: number, agentId?: string) => {
      if (agentId === undefined) current = tokens;
      const gen = dispatch('turn.step', { model: 'claude-opus-4-5[1m]', index: 3, messageCount: 40, ...(agentId ? { agentId } : {}) }, async function* () {
        return { usage: { input_tokens: tokens }, answer: 'working', toolUses: [{}] };
      });
      for (;;) if ((await gen.next()).done) break;
    },
    ask: (trigger: string) =>
      dispatch('session.compact', { trigger, messages: [{ role: 'user', text: 'go', toolUses: [], handle: 'm0' }] }, async () => ({
        messages: [{ role: 'user', text: 'summary', toolUses: [] }],
        tokensAfter: 9_000,
      })),
    unseen: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return Object.values(written)
        .flatMap((body) => body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)))
        .filter((row) => row.event === 'compact-unseen');
    },
  };
}

describe('unseenCompaction', () => {
  it('is a drop to half or less with no session.compact handled since', () => {
    expect(unseenCompaction(69_422, 12_753, false)).toBe(true);
    expect(unseenCompaction(100_000, 50_000, false)).toBe(true);
  });

  it('is not a drop it saw, a smaller fall, or a reading with nothing before it', () => {
    expect(unseenCompaction(69_422, 12_753, true)).toBe(false);
    expect(unseenCompaction(100_000, 50_001, false)).toBe(false);
    expect(unseenCompaction(undefined, 12_753, false)).toBe(false);
    expect(unseenCompaction(69_422, undefined, false)).toBe(false);
  });
});

describe('a main compaction the plugin never saw, through the adapter', () => {
  it('records compact-unseen with the readings before and after', async () => {
    // live: aa5857fc compacted main from 69,422 to 12,753 tokens and the log held no session.compact row
    const cc = engine();
    await cc.start();
    await cc.step(68_239);
    await cc.step(12_753);
    expect(await cc.unseen()).toEqual([expect.objectContaining({ event: 'compact-unseen', party: 'main', before: 68_239, after: 12_753 })]);
  });

  it('records nothing when a compaction session.compact let through ran in between', async () => {
    const cc = engine();
    await cc.start();
    await cc.step(700_000);
    expect(await cc.ask('auto')).toHaveProperty('messages');
    await cc.step(12_753);
    expect(await cc.unseen()).toEqual([]);
  });

  it('records the drop after an ask the plugin skipped: that compaction never ran', async () => {
    const cc = engine();
    await cc.start();
    await cc.step(100_000);
    expect(await cc.ask('auto')).toHaveProperty('skip');
    await cc.step(12_753);
    expect(await cc.unseen()).toEqual([expect.objectContaining({ before: 100_000, after: 12_753 })]);
  });

  it('records nothing for a steady main chat or for a sub-agent', async () => {
    const cc = engine();
    await cc.start();
    await cc.step(60_000);
    await cc.step(62_000);
    await cc.step(90_000, 'agent-1');
    await cc.step(10_000, 'agent-1');
    expect(await cc.unseen()).toEqual([]);
  });
});
