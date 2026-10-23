import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeEngine, usage, type Script } from './fakes/engine.ts';

const FORWARD = 'mcp__forward-compaction__forward_compaction';
const HANDOFF = '## Objective\nShip U5.\n## Done\nThe fake.\n## Remaining\nThe adapter.\n## Next\nWire session.compact.';
const A1 = 'a1b2c3d4e5';

type Fake = ReturnType<typeof fakeEngine>;
const fakes: Fake[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) {
    expect(f.unscripted, 'every $ call the plugin made was scripted').toEqual([]);
    f.cleanup();
  }
});

async function begin(script: Script = {}, reason = 'startup'): Promise<Fake> {
  const f = fakeEngine({ ...script, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', ...script.env } });
  fakes.push(f);
  await f.dispatch('session.start', { reason }, async () => ({}));
  return f;
}

const step = (f: Fake, tokens: number, agentId?: string) =>
  f.dispatch('turn.step', { turnId: 't1', index: 0, model: 'claude-sonnet-4-5', messageCount: 4, ...(agentId ? { agentId } : {}) }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(tokens) }));

const spawn = (f: Fake, agentId = A1, prompt = 'Brief for agent one') =>
  f.dispatch('agent.spawn', { tool_use_id: 'tu-spawn', prompt, description: 'one', subagentType: 'general-purpose', provider: { kind: 'local' } }, async () => ({ model: 'sonnet', agentId }));

const store = (f: Fake, agentId?: string, id = 'tu-h') =>
  f.dispatch('tool.call', { tool: FORWARD, tool_use_id: id, ...(agentId ? { agentId } : {}), handoff: HANDOFF }, async () => ({ result: 'not ours' }));

/** A transcript holding the forward_compaction call `id`, its result, and two messages after it. */
function transcript(id = 'tu-h') {
  return [
    { role: 'user', text: 'Brief for agent one', toolUses: [], handle: 'h0' },
    { role: 'assistant', text: 'storing', toolUses: [{ tool_use_id: id, tool: FORWARD, input: { handoff: HANDOFF } }], handle: 'h1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'Handoff stored' }], handle: 'h2' },
    { role: 'assistant', text: 'reading on after the handoff', toolUses: [], handle: 'h3' },
    { role: 'user', text: 'a later note', toolUses: [], handle: 'h4' },
  ];
}

/** The decision rows written this session, read once session.end has flushed them. */
async function rows(f: Fake): Promise<Record<string, unknown>[]> {
  await f.dispatch('session.end', { reason: 'other' }, async () => ({}));
  const dir = join(f.home, '.local/state/forward-compaction/logs/decisions');
  return readdirSync(dir).filter((n) => n.endsWith('.jsonl')).flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

describe('forward_compaction tool answers (R31)', () => {
  it('stores a sub-agent handoff below its ask point with the sub-agent receipt and a stored row', async () => {
    const f = await begin();
    await spawn(f);
    await step(f, 41_200, A1);
    const r = await store(f, A1);
    expect(r.result).toContain('Handoff stored');
    expect(r.result).toContain('from about 63k context (you are at 41k)');
    expect((await rows(f)).some((row) => row.event === 'stored' && row.party === `agent:${A1}`)).toBe(true);
  });

  it('gives main the main receipt', async () => {
    const f = await begin();
    await step(f, 30_000);
    const r = await store(f);
    expect(r.result).toContain('It installs at the end of this turn');
  });

  it('refuses a handoff missing a heading and stores nothing', async () => {
    const f = await begin();
    const r = await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-x', handoff: '## Objective\nx' }, async () => ({ result: 'not ours' }));
    expect(r.result).toMatch(/^forward_compaction refused, nothing stored: .*## Done/);
  });

  it('refuses a load file that does not exist (stat ENOENT)', async () => {
    const f = await begin();
    const r = await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-x', handoff: HANDOFF, load_files: [{ path: '/work/gone.ts', why: 'needed' }] }, async () => ({ result: 'not ours' }));
    expect(r.result).toContain('load_files[0] /work/gone.ts: no such file.');
  });
});

describe('main turn-end door (R32, P1)', () => {
  it('compacts once with no argument when main answered with a handoff stored', async () => {
    const f = await begin();
    await store(f);
    await f.dispatch('turn.complete', { reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' }, async () => ({ text: 'done' }));
    expect(f.compactCalls).toEqual([[]]);
  });

  it('does not compact an aborted turn, and the handoff stays stored for the next answer', async () => {
    const f = await begin();
    await store(f);
    await f.dispatch('turn.complete', { reason: 'aborted', answer: '', durationMs: 1, isAborted: true, turnId: 't1' }, async () => ({ text: '' }));
    expect(f.compactCalls).toEqual([]);
    await f.dispatch('turn.complete', { reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't2' }, async () => ({ text: 'done' }));
    expect(f.compactCalls).toEqual([[]]);
  });

  it('says on screen when the turn-end compaction is skipped', async () => {
    const f = await begin({ compact: () => ({ skip: 'another plugin held it' }) });
    await store(f);
    await f.dispatch('turn.complete', { reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' }, async () => ({ text: 'done' }));
    expect(f.texts()).toContain("main's handoff did not install at turn end: another plugin held it. It stays stored for the next turn end or ask.");
  });
});

describe('the compaction window warning (R33)', () => {
  it('warns at session start when CLAUDE_CODE_AUTO_COMPACT_WINDOW is unset', async () => {
    const f = fakeEngine();
    fakes.push(f);
    await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
    expect(f.texts()).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW is unset; Claude Code asks to compact a sub-agent only from about 163k, so a sub-agent\'s handoff installs no earlier. Set it to 100000 in your settings env.');
  });

  it('says nothing at 100000', async () => {
    const f = await begin();
    expect(f.texts().filter((t) => t.includes('CLAUDE_CODE_AUTO_COMPACT_WINDOW'))).toEqual([]);
  });
});

describe('session.compact', () => {
  it('installs a sub-agent handoff at an auto ask: [F, H, ...tail] with the tail objects unchanged, and the landed line (R34, R36)', async () => {
    const f = await begin();
    await spawn(f);
    await step(f, 64_000, A1);
    await store(f, A1);
    const messages = transcript();
    const r = await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages }, async () => ({ skip: 'native ran' }));
    expect(r.messages).toHaveLength(4);
    expect(r.messages[0].text).toMatch(/^\[forward-compaction: facts\]/);
    expect(r.messages[0].text).toContain('Brief for agent one');
    expect(r.messages[1].text).toContain(`=== handoff ===\n${HANDOFF}\n=== end of handoff ===`);
    expect(r.messages.slice(2)).toEqual([messages[3], messages[4]]);
    expect(r.messages[2]).toBe(messages[3]);
    expect(r.tokensBefore).toBe(64_000);
    expect(typeof r.tokensAfter).toBe('number');
    const landed = f.screen.filter((c) => c.text.startsWith('general-purpose a1b2c3 handoff landed'));
    expect(landed).toHaveLength(1);
    expect(landed[0]!.opts).toBeUndefined();
  });

  it('holds an auto ask with nothing stored below the ceiling (C9) and passes a manual one untouched (C1)', async () => {
    const f = await begin();
    await step(f, 64_000);
    const held = await f.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' }));
    expect(held).toEqual({ skip: "forward-compaction: waiting for main's handoff" });
    await store(f);
    const manual = await f.dispatch('session.compact', { trigger: 'manual', messages: transcript() }, async () => ({ skip: 'native ran' }));
    expect(manual).toEqual({ skip: 'native ran' });
    expect(f.texts()).toContain("/compact ran Claude Code's own summary; main's stored handoff was dropped.");
  });

  it('drops a stored handoff whose call left the transcript (C8)', async () => {
    const f = await begin();
    await step(f, 64_000);
    await store(f, undefined, 'tu-old');
    const r = await f.dispatch('session.compact', { trigger: 'auto', messages: transcript('tu-other') }, async () => ({ skip: 'native ran' }));
    expect(r).toEqual({ skip: "forward-compaction: waiting for main's handoff" });
    expect(f.texts()).toContain("main's stored handoff is no longer in its transcript (compacted by something else); it was dropped.");
  });

  it('installs a mechanical wake at the ceiling with no handoff (C10)', async () => {
    const f = await begin();
    await step(f, 125_000);
    const r = await f.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' }));
    expect(r).toHaveProperty('messages');
    expect(r.messages[1].text).toMatch(/^\[forward-compaction: no frontier written by the model\]/);
    expect(f.texts().some((t) => t.startsWith('main had no handoff at 125k (ceiling 120k) — mechanical wake installed'))).toBe(true);
  });

  it('passes a foreign party to Claude Code (C6)', async () => {
    const f = await begin();
    const r = await f.dispatch('session.compact', { trigger: 'auto', agentId: 'fork-1', messages: transcript() }, async () => ({ skip: 'native ran' }));
    expect(r).toEqual({ skip: 'native ran' });
  });

  it('installs a mechanical wake with the C11 line when building the wake throws (R35)', async () => {
    const f = await begin({ agents: () => 'not an array' });
    await spawn(f);
    await step(f, 64_000, A1);
    await store(f, A1);
    const r = await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: transcript() }, async () => ({ skip: 'native ran' }));
    expect(r).toHaveProperty('messages');
    expect(r.messages[1].text).toMatch(/^\[forward-compaction: no frontier written by the model\]/);
    expect(f.texts().some((t) => /^error in session\.compact for general-purpose a1b2c3: .+; a mechanical wake was installed\.$/.test(t))).toBe(true);
  });

  it("returns next(e)'s result when the mechanical wake throws too (R35)", async () => {
    const f = await begin();
    await step(f, 64_000);
    const poisoned = [{ role: 'user', get text(): string { throw new Error('unreadable message'); }, toolUses: [] }];
    const r = await f.dispatch('session.compact', { trigger: 'auto', messages: poisoned }, async () => ({ skip: 'native ran' }));
    expect(r).toEqual({ skip: 'native ran' });
    expect(f.texts()).toContain("error in session.compact for main: unreadable message; Claude Code's own summary ran.");
  });
});

describe('nudges (R37)', () => {
  it('appends the soon nudge to main\'s tool result at 51,000, and none again at 52,000', async () => {
    const f = await begin();
    await step(f, 51_000);
    const first = await f.dispatch('tool.call', { tool: 'Read', tool_use_id: 'tu-1', file_path: '/x' }, async () => ({ result: 'file', context: ['other'] }));
    expect(first.context.at(-1)).toMatch(/^forward-compaction: your context is 51k tokens\. At your next milestone/);
    expect(first.context[0]).toBe('other');
    await step(f, 52_000);
    const second = await f.dispatch('tool.call', { tool: 'Read', tool_use_id: 'tu-2', file_path: '/x' }, async () => ({ result: 'file' }));
    expect(second.context ?? []).toEqual([]);
  });
});

describe('skill attribution (R38)', () => {
  it("attributes a skill.prompt during agent:a1's one Skill call to agent:a1, returns next(e) unchanged, and carries the text in its wake", async () => {
    const f = await begin();
    await spawn(f);
    const answer = { text: 'expanded skill', marker: 1 };
    let inner: unknown;
    await f.dispatch('tool.call', { tool: 'Skill', tool_use_id: 'tu-skill', agentId: A1, skill: 'rules' }, async () => {
      inner = await f.dispatch('skill.prompt', { skill: 'rules', text: 'RULES SKILL BODY', frontmatter: {} }, async () => answer);
      return { result: 'loaded' };
    });
    expect(inner).toBe(answer);
    await step(f, 125_000, A1);
    const r = await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: transcript('tu-none') }, async () => ({ skip: 'native ran' }));
    expect(r).toHaveProperty('messages');
    expect(r.messages[0].text).toContain('RULES SKILL BODY');
  });
});

describe('an unseen compaction (R39)', () => {
  it('warns on screen naming the party when its reading falls from 120,000 to 30,000 with no install', async () => {
    const f = await begin();
    await spawn(f);
    await step(f, 120_000, A1);
    await step(f, 30_000, A1);
    expect(f.texts().some((t) => t.startsWith("general-purpose a1b2c3's context fell from 120k to 30k"))).toBe(true);
  });
});
