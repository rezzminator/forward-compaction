import { describe, expect, it } from 'vitest';
import { register } from '../plugins/sub-agent-compact/hooks/sub-agent-compact.ts';
import { HANDOFF_OPENING } from '../plugins/sub-agent-compact/src/handoff.ts';

// The handoff path end to end through the adapter: the tool stores the text,
// the next automatic ask installs it without calling the summarizer beneath,
// and each tool is registered only while its flag is on: by default the
// compact tool alone.

type AnyHook = (...args: any[]) => any;
const HANDOFF_ONLY = { handoffTool: true, compactTool: false };
const HANDOFF = 'Task (verbatim): "rename qty to quantity in every report". Done: a.sql, b.sql, npm test 41/41. Facts: reports/c.sql:12 reads `SELECT qty, price FROM ledger`. Next step: edit reports/c.sql:12, then npm test.';

function engine(options: Record<string, unknown> = {}) {
  const hooks = new Map<string, AnyHook>();
  const registered: string[] = [];
  const compacts: unknown[] = [];
  let current = 0;
  const on = (event: string, hook: AnyHook) => void hooks.set(event, hook);
  const $ = {
    session: {
      id: async () => 'session-1',
      cwd: async () => '/nowhere',
      usage: async () => ({ context: { tokens: current, window: 1_000_000 } }),
      compact: async (args: unknown) => {
        compacts.push(args);
        return dispatch('session.compact', { trigger: 'plugin', messages: transcript(), ...(args as object) }, async () => ({ messages: [], tokensAfter: 1 }));
      },
    },
    env: { get: async () => undefined },
    fs: { exists: async () => false, read: async () => '', write: async () => {}, list: async () => [] },
    ui: { log: () => {} },
    agent: { list: async () => [] },
    tool: {
      register: async (spec: { name: string }) => {
        registered.push(spec.name);
        return { tool: `mcp__sub-agent-compact__${spec.name}` };
      },
    },
  };
  register(on as never, options as never);
  const dispatch = (event: string, e: unknown, impl: (e: any) => any): any => {
    const next = Object.assign((input: unknown) => impl(input), { signal: new AbortController().signal });
    const hook = hooks.get(event);
    return hook ? hook($, e, next) : impl(e);
  };
  const transcript = () => [
    { role: 'user', text: 'rename qty to quantity in every report', toolUses: [], handle: 'm0' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'h1', tool: 'mcp__sub-agent-compact__handoff', input: { handoff: HANDOFF } }], handle: 'm1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'h1', text: 'stored', isError: false }], handle: 'm2' },
  ];
  const step = async (tokens: number) => {
    current = tokens;
    const gen = dispatch('turn.step', { model: 'claude-opus-4-5[1m]' }, async function* () {
      return { usage: { input_tokens: tokens }, answer: 'working', toolUses: [{}] };
    });
    for (;;) if ((await gen.next()).done) break;
  };
  let summarized = 0;
  const summarizer = async () => {
    summarized++;
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensAfter: 20_000 };
  };
  return {
    registered,
    compacts,
    summarized: () => summarized,
    start: () => dispatch('session.start', {}, async () => ({})),
    step,
    handoff: (text: string = HANDOFF) => dispatch('tool.call', { tool: 'mcp__sub-agent-compact__handoff', handoff: text, tool_use_id: 'h1' }, async () => ({ result: 'unreached' })),
    read: () => dispatch('tool.call', { tool: 'Read', file_path: 'x' }, async () => ({ result: 'file text' })),
    ask: (trigger: string) => dispatch('session.compact', { trigger, messages: transcript() }, summarizer),
    turnComplete: () => dispatch('turn.complete', {}, async () => ({})),
  };
}

describe('the handoff tool through the adapter', () => {
  it('registers the compact tool and not the handoff tool by default', async () => {
    const cc = engine();
    await cc.start();
    expect(cc.registered).toEqual(['compact']);
  });

  it('registers the handoff tool alone when it is on and the compact tool off', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    expect(cc.registered).toEqual(['handoff']);
  });

  it('registers both when the compact tool is turned on, and neither nudges about compact while handoff is on', async () => {
    const cc = engine({ compactTool: true, handoffTool: true });
    await cc.start();
    expect(cc.registered.sort()).toEqual(['compact', 'handoff']);
    await cc.step(250_000);
    const nudged = await cc.read();
    expect(nudged.context?.[0]).toMatch(/mcp__sub-agent-compact__handoff/);
    expect(nudged.context?.[0]).not.toMatch(/__compact\b/);
  });

  it('stores the handoff, then installs it at the next automatic ask without the summarizer', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    expect(await cc.handoff()).toEqual({ result: expect.stringMatching(/^Handoff stored/) });
    const out = await cc.ask('auto');
    expect(cc.summarized()).toBe(0);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].text.startsWith(HANDOFF_OPENING)).toBe(true);
    expect(out.messages[0].text).toContain(HANDOFF);
    expect(out.tokensBefore).toBe(250_000);
    // Installed once: the next ask is held again at the party's limit.
    expect(await cc.ask('auto')).toEqual({ skip: expect.any(String) });
  });

  it('refuses a handoff below the first nudge point, and a thin one, storing nothing', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(120_000);
    expect(await cc.handoff()).toEqual({ result: expect.stringMatching(/^Not stored: .*120k.*200k/) });
    await cc.step(250_000);
    expect(await cc.handoff('next: c.sql')).toEqual({ result: expect.stringMatching(/^Not stored/) });
    expect(await cc.ask('auto')).toEqual({ skip: expect.any(String) });
  });

  it('waits out a precompute, and leaves a person /compact to the summarizer', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    await cc.handoff();
    expect(await cc.ask('precompute')).toEqual({ skip: expect.any(String) });
    expect((await cc.ask('manual')).messages[0].text).toBe('summary');
    expect(cc.summarized()).toBe(1);
  });

  it('installs a main handoff between turns when no automatic ask came', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    await cc.handoff();
    await cc.turnComplete();
    expect(cc.compacts).toEqual([{}]);
    expect(cc.summarized()).toBe(0);
  });

  it('nudges nobody when both tools are off', async () => {
    const cc = engine({ handoffTool: false, compactTool: false });
    await cc.start();
    expect(cc.registered).toEqual([]);
    await cc.step(250_000);
    expect((await cc.read()).context).toBeUndefined();
  });
});
