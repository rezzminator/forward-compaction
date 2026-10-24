import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeEngine, usage, type Script } from './fakes/engine.ts';

const FORWARD = 'mcp__forward-compaction__forward_compaction';
const SECTIONS = { objective: 'Ship U5.', done: 'The fake.', remaining: 'The adapter.', next: 'Wire session.compact.' };
/** The handoff the plugin assembles from SECTIONS. */
const HANDOFF = '## Objective\nShip U5.\n\n## Done\nThe fake.\n\n## Remaining\nThe adapter.\n\n## Next\nWire session.compact.';
const A1 = 'a1b2c3d4e5';

type Fake = ReturnType<typeof fakeEngine>;
const fakes: Fake[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) {
    expect(f.unscripted, 'every $ call the plugin made was scripted').toEqual([]);
    f.cleanup();
  }
});

/** A session on a 1M main window and a 1M sub-agent max context, every party's sizes held where 60%, 15% and 5% of 200k fall; Claude Code asks at 63k. */
async function begin(script: Script = {}, reason = 'startup'): Promise<Fake> {
  const sizes = (party: string) => ({ [`FORWARD_COMPACTION_${party}_CEILING`]: '120000', [`FORWARD_COMPACTION_${party}_NUDGE_START`]: '30000', [`FORWARD_COMPACTION_${party}_NUDGE_EVERY`]: '10000' });
  const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT: '1m', ...sizes('MAIN'), ...sizes('SUBAGENT') };
  const f = fakeEngine({ window: 1_000_000, ...script, env: { ...env, ...script.env } });
  fakes.push(f);
  await f.dispatch('session.start', { reason }, async () => ({}));
  return f;
}

const step = (f: Fake, tokens: number, agentId?: string, output?: number, model = 'claude-sonnet-4-5') =>
  f.dispatch('turn.step', { turnId: 't1', index: 0, model, messageCount: 4, ...(agentId ? { agentId } : {}) }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(tokens, output) }));

const spawn = (f: Fake, agentId = A1, prompt = 'Brief for agent one') =>
  f.dispatch('agent.spawn', { tool_use_id: 'tu-spawn', prompt, description: 'one', subagentType: 'general-purpose', provider: { kind: 'local' } }, async () => ({ model: 'sonnet', agentId }));

const store = (f: Fake, agentId?: string, id = 'tu-h') =>
  f.dispatch('tool.call', { tool: FORWARD, tool_use_id: id, ...(agentId ? { agentId } : {}), ...SECTIONS }, async () => ({ result: 'not ours' }));

/** Characters a test transcript carries before its call, of a real transcript's order. */
const PAD = 'p'.repeat(200_000);

/** A transcript holding the forward_compaction call `id`, its result, and two messages after it. */
function transcript(id = 'tu-h') {
  return [
    { role: 'user', text: 'Brief for agent one', toolUses: [], handle: 'h0' },
    { role: 'assistant', text: `storing ${PAD}`, toolUses: [{ tool_use_id: id, tool: FORWARD, input: SECTIONS }], handle: 'h1' },
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
    expect(r.result).toContain('from about 63k context. Everything after this call');
    expect((await rows(f)).some((row) => row.event === 'stored' && row.party === `agent:${A1}`)).toBe(true);
  });

  it('gives main the main receipt', async () => {
    const f = await begin();
    await step(f, 30_000);
    const r = await store(f);
    expect(r.result).toContain('It installs at the end of this turn');
  });

  it('ends every answer, receipt and refusal alike, with the experimental line naming the issues file', async () => {
    const f = await begin();
    const line = `forward-compaction is experimental. If it gave you any trouble, append a short note of what happened to ${f.home}/.local/state/forward-compaction/logs/issues.md; it will be taken care of later.`;
    const stored = await store(f);
    expect(stored.result.split('\n').at(-1)).toBe(line);
    const refused = await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-x', objective: 'x' }, async () => ({ result: 'not ours' }));
    expect(refused.result.split('\n').at(-1)).toBe(line);
    expect(refused.result.split('\n').filter((l: string) => l === line)).toHaveLength(1);
  });

  it('refuses a handoff missing a section and stores nothing', async () => {
    const f = await begin();
    const r = await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-x', objective: 'x' }, async () => ({ result: 'not ours' }));
    expect(r.result).toMatch(/^forward_compaction refused, nothing stored: done must be a non-blank string/);
  });

  it('refuses a load file that does not exist (stat ENOENT)', async () => {
    const f = await begin();
    const r = await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-x', ...SECTIONS, load_files: [{ path: '/work/gone.ts', why: 'needed' }] }, async () => ({ result: 'not ours' }));
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
  it("warns at session start when Claude Code's own compaction window is past 100k, by the numbers its breakdown reports", async () => {
    const f = fakeEngine({ window: 1_000_000, breakdown: { rawMaxTokens: 1_000_000, autocompactSource: 'model-default', autoCompactThreshold: 967_000, isAutoCompactEnabled: true, model: 'claude-opus-5-5' } });
    fakes.push(f);
    await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
    expect(f.texts()).toContain('Claude Code compacts against a 1M window (model-default) and asks to compact from about 967k, so a handoff installs no earlier. Set CLAUDE_CODE_AUTO_COMPACT_WINDOW to 100000 in your settings env.');
  });

  it("names a breakdown or threshold Claude Code did not report, and the ask point taken instead", async () => {
    const none = fakeEngine({ window: 1_000_000, breakdown: null });
    const off = fakeEngine({ window: 1_000_000, breakdown: { rawMaxTokens: 400_000, autocompactSource: 'settings', isAutoCompactEnabled: false, model: 'claude-opus-5-5' } });
    fakes.push(none, off);
    for (const f of [none, off]) await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
    const warned = async (f: Fake) => (await rows(f)).filter((r) => r.event === 'warning').map((r) => r.line);
    expect(await warned(none)).toContain("forward-compaction: $.session.usage reported no context breakdown; Claude Code's ask point is taken as its window 1M");
    expect(await warned(off)).toContain("forward-compaction: $.session.usage reported no autoCompactThreshold (auto-compaction is off); Claude Code's ask point is taken as its rawMaxTokens 400k");
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
    expect(r.tokensBefore).toBe(64_000); // the last reading, never an estimate beside it
    expect(r.tokensAfter).toBeUndefined(); // no character count stands in for it: the next reading measures it (M2)
    await step(f, 12_000, A1);
    expect(f.texts().filter((t) => t.includes('handoff landed'))).toEqual([]); // a chosen handoff is routine: logged, never on screen
    const landed = (await rows(f)).filter((r) => r.event === 'landed');
    expect(landed).toHaveLength(1);
    expect(landed[0]!.line).toContain('general-purpose a1b2c3 handoff landed — 64k → 12k context, measured;'); // both figures are readings: before the install and the first after
  });

  it('holds an auto ask with nothing stored below the ceiling (C9) and passes a manual one untouched (C1)', async () => {
    const f = await begin();
    await step(f, 64_000);
    const held = await f.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' }));
    expect(held).toEqual({ skip: "forward-compaction: holding Claude Code's compaction for main until its handoff is stored or the ceiling is reached" });
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
    expect(r).toEqual({ skip: "forward-compaction: holding Claude Code's compaction for main until its handoff is stored or the ceiling is reached" });
    expect(f.texts()).toContain("main's stored handoff is no longer in its transcript (compacted by something else); it was dropped.");
  });

  it('installs a mechanical wake at the ceiling with no handoff (C10)', async () => {
    const f = await begin();
    await step(f, 125_000);
    const r = await f.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' }));
    expect(r).toHaveProperty('messages');
    expect(r.messages[1].text).toMatch(/^\[forward-compaction: no frontier written by the model\]/);
    await step(f, 30_000);
    expect(f.texts().some((t) => t.startsWith('main had no handoff at 125k (ceiling 120k) — mechanical wake installed'))).toBe(true);
  });

  it("re-reads main's window after /model: the ceiling follows the new model's window", async () => {
    let window = 1_000_000;
    const f = await begin({ window: () => window, env: { FORWARD_COMPACTION_MAIN_CEILING: '' } });
    const mainStep = (tokens: number, model: string) =>
      f.dispatch('turn.step', { turnId: 't1', index: 0, model, messageCount: 4 }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(tokens) }));
    await mainStep(40_000, 'claude-opus-5[1m]');
    window = 400_000;
    await mainStep(245_000, 'claude-opus-5');
    const r = await f.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' }));
    expect(r).toHaveProperty('messages');
    await mainStep(30_000, 'claude-opus-5');
    expect(f.texts().some((t) => /^main had no handoff at 245k \(ceiling 240k\)/.test(t))).toBe(true);
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
    expect(r.tokensBefore).toBe(64_000); // the same reading C1-C10 decides on
  });

  it("returns next(e)'s result when the mechanical wake throws too (R35)", async () => {
    const f = await begin();
    await step(f, 125_000); // past the ceiling: the mechanical wake reads the poisoned messages
    const poisoned = [{ role: 'user', get text(): string { throw new Error('unreadable message'); }, toolUses: [] }];
    const r = await f.dispatch('session.compact', { trigger: 'auto', messages: poisoned }, async () => ({ skip: 'native ran' }));
    expect(r).toEqual({ skip: 'native ran' });
    expect(f.texts()).toContain("error in session.compact for main: unreadable message; Claude Code's own summary ran.");
  });
});

describe('nudges (R37)', () => {
  it('appends the informative nudge to main\'s tool result at 51,000, and none again at 52,000', async () => {
    const f = await begin();
    await step(f, 51_000);
    const first = await f.dispatch('tool.call', { tool: 'Read', tool_use_id: 'tu-1', file_path: '/x' }, async () => ({ result: 'file', context: ['other'] }));
    expect(first.context.at(-1)).toMatch(/^forward-compaction: your context is 51k tokens \(5% of your 1M max context\), and every call re-sends all of it\. Hand off at your next clean milestone: once the step in hand is finished/);
    expect(first.context[0]).toBe('other');
    await step(f, 52_000);
    const second = await f.dispatch('tool.call', { tool: 'Read', tool_use_id: 'tu-2', file_path: '/x' }, async () => ({ result: 'file' }));
    expect(second.context ?? []).toEqual([]);
  });

  it('starts at 15% of the window and steps every 5%: 60k, then 80k on a 400k window', async () => {
    const f = await begin({ window: 400_000, env: { FORWARD_COMPACTION_MAIN_NUDGE_START: '', FORWARD_COMPACTION_MAIN_NUDGE_EVERY: '' } });
    const read = (id: string) => f.dispatch('tool.call', { tool: 'Read', tool_use_id: id, file_path: '/x' }, async () => ({ result: 'file' }));
    await step(f, 59_000);
    expect((await read('tu-1')).context ?? []).toEqual([]);
    await step(f, 60_000);
    expect((await read('tu-2')).context?.at(-1)).toContain('your context is 60k tokens (15% of your 400k max context)');
    await step(f, 79_000);
    expect((await read('tu-3')).context ?? []).toEqual([]);
    await step(f, 80_000);
    expect((await read('tu-4')).context?.at(-1)).toContain('your context is 80k tokens (20% of your 400k max context)');
  });

  it('a held ask adds no nudge of its own: the level already delivered is not repeated', async () => {
    const f = await begin();
    const read = (id: string) => f.dispatch('tool.call', { tool: 'Read', tool_use_id: id, file_path: '/x' }, async () => ({ result: 'file' }));
    await step(f, 64_000);
    expect((await read('tu-1')).context?.at(-1)).toContain('your context is 64k tokens');
    await f.dispatch('session.compact', { trigger: 'auto', messages: transcript('tu-none') }, async () => ({ skip: 'native ran' }));
    await step(f, 65_000);
    expect((await read('tu-2')).context ?? []).toEqual([]);
  });

  it('absorbs the first reading after an install: an agent installed, read at 61k, is nudged next at 70k', async () => {
    const f = await begin();
    const read = (id: string) => f.dispatch('tool.call', { tool: 'Read', tool_use_id: id, agentId: A1, file_path: '/x' }, async () => ({ result: 'file' }));
    await spawn(f);
    await step(f, 89_000, A1);
    await store(f, A1);
    const r = await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: transcript() }, async () => ({ skip: 'native ran' }));
    expect(r).toHaveProperty('messages');
    await step(f, 61_000, A1);
    expect((await read('tu-1')).context ?? []).toEqual([]);
    await step(f, 66_000, A1);
    expect((await read('tu-2')).context ?? []).toEqual([]);
    await step(f, 70_000, A1);
    expect((await read('tu-3')).context?.at(-1)).toContain('your context is 70k tokens');
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

describe('the log rows the hook writes reach their folds and levels', () => {
  /** The level file `name` (errors, warnings) of this session, once session.end has flushed it. */
  async function level(f: Fake, name: string): Promise<Record<string, unknown>[]> {
    await rows(f);
    const path = join(f.home, `.local/state/forward-compaction/logs/${name}.jsonl`);
    for (let i = 0; i < 50 && !existsSync(path); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  }

  it("folds main's held asks (C9) into the first skip row and one skips row", async () => {
    const f = await begin();
    for (let i = 0; i < 3; i++) {
      await step(f, 64_000 + i);
      await f.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' }));
    }
    const asks = (await rows(f)).filter((r) => r.event === 'compact' || r.event === 'skips');
    expect(asks.map((r) => [r.event, r.party, r.decision ?? null, r.count ?? null])).toEqual([['compact', 'main', 'skip', null], ['skips', 'main', null, 2]]);
  });

  it('files the operational events at info, held asks folded, each said line once', async () => {
    const f = await begin();
    await step(f, 51_000);
    await f.dispatch('tool.call', { tool: 'Read', tool_use_id: 'tu-1', file_path: '/x' }, async () => ({ result: 'file' }));
    for (let i = 0; i < 3; i++) {
      await step(f, 64_000 + i);
      await f.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' }));
    }
    await store(f);
    const info = await level(f, 'info');
    expect(info.every((r) => r.level === 'info')).toBe(true);
    const events = info.map((r) => r.event);
    expect(events).toEqual(expect.arrayContaining(['tool-registered', 'nudge', 'stored', 'compact', 'skips']));
    expect(events.filter((e) => e === 'compact')).toHaveLength(1);
    expect(info.find((r) => r.event === 'skips')?.msg).toBe('2 more held compaction asks folded');
    expect(info.filter((r) => r.event === 'said')).toEqual([]);
  });

  it('files an unseen compaction as a warning and a failed compaction as an error', async () => {
    const f = await begin();
    await spawn(f);
    await step(f, 120_000, A1);
    await step(f, 30_000, A1);
    await step(f, 125_000); // past the ceiling: the mechanical wake reads the poisoned messages
    const poisoned = [{ role: 'user', get text(): string { throw new Error('unreadable message'); }, toolUses: [] }];
    await f.dispatch('session.compact', { trigger: 'auto', messages: poisoned }, async () => ({ skip: 'native ran' }));
    expect((await level(f, 'warnings')).map((r) => r.event)).toContain('unseen-compaction');
    expect((await level(f, 'errors')).map((r) => r.event)).toContain('compact-error');
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

  it('does not call a compaction it passed to Claude Code unseen: the fall after a /compact draws no warning', async () => {
    const f = await begin();
    await step(f, 120_000);
    await f.dispatch('session.compact', { trigger: 'manual', messages: transcript() }, async () => ({ skip: 'native ran' }));
    await step(f, 30_000);
    expect(f.texts().filter((t) => t.includes('context fell from'))).toEqual([]);
  });
});

describe('ignored models: FORWARD_COMPACTION_IGNORE_MODELS, Haiku by default', () => {
  const read = (f: Fake, id: string, agentId?: string) => f.dispatch('tool.call', { tool: 'Read', tool_use_id: id, file_path: '/x', ...(agentId ? { agentId } : {}) }, async () => ({ result: 'file' }));
  const haikuStep = (f: Fake, tokens: number, agentId = A1) =>
    f.dispatch('turn.step', { turnId: 't1', index: 0, model: 'claude-haiku-4-5-20251001', messageCount: 4, ...(agentId ? { agentId } : {}) }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(tokens) }));
  /** The shipped sub-agent sizes: a 200k max context, the ceiling at 80%, nudges from 40% every 10%. */
  const defaults = { FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT: '', FORWARD_COMPACTION_SUBAGENT_CEILING: '', FORWARD_COMPACTION_SUBAGENT_NUDGE_START: '', FORWARD_COMPACTION_SUBAGENT_NUDGE_EVERY: '' };

  it('holds a Haiku sub-agent Claude Code asks at 64k, never compacting it there, and gives it the mechanical wake at the 160k sub-agent ceiling', async () => {
    const f = await begin({ env: defaults });
    await spawn(f);
    await haikuStep(f, 64_000);
    expect(await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: transcript() }, async () => ({ skip: 'native ran' }))).toEqual({ skip: "forward-compaction: holding Claude Code's compaction for general-purpose a1b2c3: its model is on the ignore list, so it is compacted mechanically at its ceiling" });
    await haikuStep(f, 120_000);
    expect((await read(f, 'tu-1', A1)).context ?? []).toEqual([]); // past 80k, 100k and 120k: no nudge for an ignored model
    await haikuStep(f, 160_000);
    const r = await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: transcript() }, async () => ({ skip: 'native ran' }));
    expect(r.messages[1].text).toMatch(/^\[forward-compaction: no frontier written by the model\] Your context reached 160k tokens, past the 160k ceiling/);
    const compacts = (await rows(f)).filter((row) => row.event === 'compact').map((row) => [row.decision, row.why, row.tokens, row.ceiling, row.matched]);
    expect(compacts).toEqual([['skip', 'ignored-model', 64_000, 160_000, 'haiku'], ['mechanical', 'ceiling', 160_000, 160_000, 'haiku']]);
  });

  it("nudges a managed sub-agent at 80k, 100k, 120k and 140k of its 200k max context, and gives it the mechanical wake at 160k", async () => {
    const f = await begin({ env: defaults });
    await spawn(f);
    const levels: number[] = [];
    for (const tokens of [79_000, 80_000, 99_000, 100_000, 120_000, 140_000, 150_000]) {
      await step(f, tokens, A1);
      if (((await read(f, `tu-${tokens}`, A1)).context ?? []).length > 0) levels.push(tokens);
    }
    expect(levels).toEqual([80_000, 100_000, 120_000, 140_000]);
    await step(f, 160_000, A1);
    expect((await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: transcript() }, async () => ({ skip: 'native ran' }))).messages[1].text).toMatch(/past the 160k ceiling/);
  });

  it("refuses an ignored party's forward_compaction call with nothing stored, naming the list entry and its ceiling, and an empty list ignores none", async () => {
    const f = await begin({ env: defaults });
    await spawn(f);
    await haikuStep(f, 30_000);
    const r = await store(f, A1);
    expect(r.result).toMatch(/^forward_compaction refused, nothing stored: your model is on forward-compaction's ignore list \("haiku"\), so it takes no handoff from you; carry on with your work, and at 160k the plugin compacts you mechanically\.\nforward-compaction is experimental\./);
    const all = await rows(f);
    expect(all.filter((row) => row.event === 'stored')).toEqual([]);
    expect(all.find((row) => row.event === 'refused')).toMatchObject({ party: `agent:${A1}`, matched: 'haiku' });
    const none = await begin({ env: { ...defaults, FORWARD_COMPACTION_IGNORE_MODELS: '' } });
    await spawn(none);
    await haikuStep(none, 30_000);
    expect((await store(none, A1)).result).toContain('Handoff stored');
  });

  it("gives main no nudge and no ceiling until its window is read, and manages it against FORWARD_COMPACTION_MAIN_MAX_CONTEXT when that is set", async () => {
    const unread = await begin({ window: () => { throw new Error('usage unavailable'); } });
    await step(unread, 51_000);
    expect((await read(unread, 'tu-1')).context ?? []).toEqual([]);
    await step(unread, 900_000);
    expect(await unread.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' }))).toMatchObject({ skip: expect.stringContaining('holding') });
    const set = await begin({ window: () => { throw new Error('usage unavailable'); }, env: { FORWARD_COMPACTION_MAIN_MAX_CONTEXT: '400k' } });
    await step(set, 51_000);
    expect((await read(set, 'tu-1')).context?.at(-1)).toContain('your context is 51k tokens (13% of your 400k max context)');
  });
});

describe('a resumed sub-agent with no reading yet', () => {
  it('is held as no-reading at its first ask, gets no nudge, then is managed against its max context once its step reads', async () => {
    const f = await begin({ agents: () => [{ id: A1, type: 'flights-foreman-sonnet', status: 'running', description: 'one' }], env: { FORWARD_COMPACTION_SUBAGENT_CEILING: '60%', FORWARD_COMPACTION_SUBAGENT_NUDGE_START: '15%', FORWARD_COMPACTION_SUBAGENT_NUDGE_EVERY: '5%' } });
    const read = (id: string) => f.dispatch('tool.call', { tool: 'Read', tool_use_id: id, agentId: A1, file_path: '/x' }, async () => ({ result: 'file' }));
    const big = [...transcript('tu-none'), { role: 'user', text: 'z'.repeat(660_000), toolUses: [], handle: 'h5' }];
    expect(await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: big }, async () => ({ skip: 'native ran' }))).toEqual({ skip: "forward-compaction: holding Claude Code's compaction for flights-foreman-sonnet a1b2c3: it has no reading yet, and its next reading decides" });
    expect((await read('tu-1')).context ?? []).toEqual([]);
    await f.dispatch('turn.step', { turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 4, agentId: A1 }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(189_000) }));
    expect((await read('tu-2')).context?.at(-1)).toContain('your context is 189k tokens (19% of your 1M max context)');
    expect((await read('tu-2')).context ?? []).toEqual([]);
    expect(await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: big }, async () => ({ skip: 'native ran' }))).toMatchObject({ skip: expect.stringContaining('until its handoff is stored') });
    const compacts = (await rows(f)).filter((row) => row.event === 'compact');
    expect(compacts.map((row) => [row.decision, row.why, row.tokens])).toEqual([['skip', 'no-reading', null]]); // the second held ask folds into the streak
    expect(f.texts().some((t) => /mechanical wake/.test(t))).toBe(false);
  });
});

describe("a reading includes the response's own output (H1)", () => {
  it('nudges, stores and asks on 147.0K input + 12,878 output: the 159.9K the next request carries', async () => {
    const f = await begin({ env: { FORWARD_COMPACTION_MAIN_NUDGE_START: '150000', FORWARD_COMPACTION_MAIN_NUDGE_EVERY: '50000', FORWARD_COMPACTION_MAIN_CEILING: '600000' } });
    await step(f, 147_000, undefined, 12_878);
    const nudged = await f.dispatch('tool.call', { tool: 'Read', tool_use_id: 'tu-1', file_path: '/x' }, async () => ({ result: 'ok' }));
    expect(nudged.context?.at(-1)).toContain('your context is 160k tokens');
    await store(f);
    await f.dispatch('session.compact', { trigger: 'auto', messages: transcript('tu-none') }, async () => ({ skip: 'native ran' }));
    const logged = await rows(f);
    expect(logged.filter((r) => r.event === 'nudge')).toEqual([expect.objectContaining({ level: 1, tokens: 159_878 })]);
    expect(logged.filter((r) => r.event === 'stored')).toEqual([expect.objectContaining({ tokens: 159_878 })]);
  });
});

describe('an ignore row records each judgement once (H3)', () => {
  const judged = async (f: Fake) => (await rows(f)).filter((r) => r.event === 'ignore').map((r) => [r.party, r.model ?? null, r.judged, r.matched]);

  it('records main managed at session start, a sub-agent unknown at its spawn and managed once its step names its model, and nothing again while that holds', async () => {
    const f = await begin();
    await spawn(f);
    await step(f, 20_000, A1, undefined, 'claude-sonnet-5-5');
    await step(f, 21_000, A1, undefined, 'claude-sonnet-5-5');
    await step(f, 22_000);
    expect(await judged(f)).toEqual([['main', null, 'managed', null], ['agent:a1b2c3d4e5', null, 'unknown', null], ['agent:a1b2c3d4e5', 'claude-sonnet-5-5', 'managed', null]]);
  });

  it('records an agent resumed with no spawn as unknown, then ignored with the entry its Haiku model matched, never managed between', async () => {
    const f = await begin();
    await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: transcript() }, async () => ({ skip: 'native ran' }));
    await step(f, 30_000, A1, undefined, 'claude-haiku-4-5');
    expect((await judged(f)).filter(([party]) => party === `agent:${A1}`)).toEqual([[`agent:${A1}`, null, 'unknown', null], [`agent:${A1}`, 'claude-haiku-4-5', 'ignored', 'haiku']]);
  });

  it('reaches the level log at info, and every decision row the debug log too', async () => {
    const f = await begin();
    await rows(f);
    const dir = join(f.home, '.local/state/forward-compaction/logs');
    for (let i = 0; i < 50 && !existsSync(join(dir, 'debug.jsonl')); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const level = (file: string) => readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(level('info.jsonl').filter((r) => r.event === 'ignore')).toEqual([expect.objectContaining({ level: 'info', detail: expect.objectContaining({ party: 'main', judged: 'managed', matched: null }) })]);
    const debug = level('debug.jsonl');
    expect(debug.find((r) => r.event === 'row:ignore')).toMatchObject({ level: 'debug', detail: { event: 'ignore', party: 'main', judged: 'managed' } });
    expect(debug.find((r) => r.event === 'session.usage')).toMatchObject({ detail: { window: 1_000_000, autoCompactThreshold: 63_000, rawMaxTokens: 100_000, autocompactSource: 'env' } });
    expect(debug.find((r) => r.event === 'options')?.detail).toMatchObject({ ignoreModels: ['haiku'], debug: true, subagent: { maxContext: 1_000_000 } });
    expect(debug.find((r) => r.event === 'hook')).toMatchObject({ detail: { hook: 'session.start', party: 'main' } });
  });

  it('writes no debug row with FORWARD_COMPACTION_DEBUG=0', async () => {
    const f = await begin({ env: { FORWARD_COMPACTION_DEBUG: '0' } });
    await step(f, 20_000);
    await rows(f);
    const dir = join(f.home, '.local/state/forward-compaction/logs');
    for (let i = 0; i < 50 && !existsSync(join(dir, 'info.jsonl')); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(join(dir, 'info.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'debug.jsonl'))).toBe(false);
  });
});

describe('a folded skips row is stamped once (H2)', () => {
  it('carries one timestamp in the decision log and the level log', async () => {
    const real = Date.prototype.toISOString;
    let ms = 0;
    Date.prototype.toISOString = function (this: Date) { return real.call(new Date(Date.UTC(2026, 9, 24, 0, 0, 0, ++ms % 1000))); }; // every call a new instant
    try {
      const f = await begin();
      for (let i = 0; i < 3; i++) {
        await step(f, 64_000 + i);
        await f.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' }));
      }
      const decisions = (await rows(f)).filter((r) => r.event === 'skips');
      const path = join(f.home, '.local/state/forward-compaction/logs/info.jsonl');
      for (let i = 0; i < 50 && !existsSync(path); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      const info = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.event === 'skips');
      expect(decisions).toHaveLength(1);
      expect(info).toHaveLength(1);
      expect(info[0].ts).toBe(decisions[0]!.ts);
    } finally {
      Date.prototype.toISOString = real;
    }
  });
});


describe('audit r4: readings only, measured landed lines, the milestone nudge, the load_files room, own agents', () => {
  const read = (f: Fake, id: string, chars = 4, agentId?: string) => f.dispatch('tool.call', { tool: 'Read', tool_use_id: id, file_path: '/x', ...(agentId ? { agentId } : {}) }, async () => ({ result: 'x'.repeat(chars) }));
  const ask = (f: Fake, messages: unknown[], agentId?: string) => f.dispatch('session.compact', { trigger: 'auto', messages, ...(agentId ? { agentId } : {}) }, async () => ({ skip: 'native ran' }));
  const landedLines = (f: Fake) => f.texts().filter((t) => t.includes('handoff landed') || t.includes('mechanical wake installed'));
  // A chosen handoff's landed line is a logged row only; the screen never shows it.
  const handoffLanded = async (f: Fake) => (expect(landedLines(f).filter((t) => t.includes('handoff landed'))).toEqual([]), (await rows(f)).filter((r) => r.event === 'landed').map((r) => r.line));
  const installAgent = async (f: Fake) => {
    await spawn(f);
    await step(f, 64_000, A1);
    await store(f, A1);
    return ask(f, transcript(), A1);
  };

  it('M1 nudges on the last reading alone: results delivered since it add nothing until the next reading', async () => {
    const f = await begin({ env: { FORWARD_COMPACTION_MAIN_NUDGE_START: '150000', FORWARD_COMPACTION_MAIN_NUDGE_EVERY: '50000' } });
    await step(f, 126_800);
    expect((await read(f, 'tu-1', 70_000)).context ?? []).toEqual([]);
    expect((await read(f, 'tu-2', 77_000)).context ?? []).toEqual([]);
    await step(f, 173_100);
    expect((await read(f, 'tu-3')).context?.at(-1)).toContain('your context is 173k tokens (17% of your 1M max context)');
    expect((await rows(f)).filter((r) => r.event === 'nudge')).toEqual([expect.objectContaining({ level: 1, tokens: 173_100 })]);
  });

  it('M1 stores the handoff at the last reading, and neither the receipt nor the wake prints a size for the call', async () => {
    const f = await begin();
    await spawn(f);
    await step(f, 41_200, A1);
    await read(f, 'tu-1', 70_000, A1);
    const r = await store(f, A1);
    expect(r.result).toContain("it installs at Claude Code's next ask, from about 63k context. Everything after this call");
    expect(r.result).not.toContain('you are at');
    const wake = await ask(f, transcript(), A1);
    expect(wake.messages[1].text.startsWith('[forward-compaction: handoff] Below is the handoff you wrote with forward_compaction. It is your frontier: continue from its ## Next.')).toBe(true);
    expect((await rows(f)).filter((row) => row.event === 'stored')).toEqual([expect.objectContaining({ tokens: 41_200 })]);
  });

  it('M1 decides the ceiling on the reading, and holds an ask with no reading as no-reading, never on a character count', async () => {
    const f = await begin();
    await step(f, 110_000);
    const jumped = [...transcript(), { role: 'assistant', text: 'reading', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: {} }], handle: 'h5' },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: 'z'.repeat(175_000) }], handle: 'h6' }];
    expect(await ask(f, jumped)).toEqual({ skip: "forward-compaction: holding Claude Code's compaction for main until its handoff is stored or the ceiling is reached" });
    await spawn(f);
    expect(await ask(f, jumped, A1)).toMatchObject({ skip: expect.stringContaining('it has no reading yet') });
    const compacts = (await rows(f)).filter((r) => r.event === 'compact');
    expect(compacts.map((r) => [r.party, r.tokens, r.why, 'estimated' in r])).toEqual([['main', 110_000, 'waiting', false], [`agent:${A1}`, null, 'no-reading', false]]);
  });

  it('M2 writes the landed line at the first reading after the install, measured, beside a landed row', async () => {
    const f = await begin();
    expect(await installAgent(f)).toHaveProperty('messages');
    await step(f, 41_000, A1);
    await step(f, 42_000, A1);
    // One line, at the first reading after the install (41k), never the second.
    expect(await handoffLanded(f)).toEqual([expect.stringMatching(new RegExp(`^general-purpose a1b2c3 handoff landed — 64k → 41k context, measured; frontier ${HANDOFF.length} characters, \\d+ facts, 2 messages kept verbatim\\.$`))]);
    const all = await rows(f);
    expect(all.filter((r) => r.event === 'compact' && r.decision === 'install')).toHaveLength(1);
    expect(all.filter((r) => r.event === 'landed')).toEqual([expect.objectContaining({ party: `agent:${A1}`, kind: 'handoff', before: 64_000, after: 41_000 })]);
  });

  it('M2 says at an agent end with no reading after its install that the size after was never measured', async () => {
    const f = await begin();
    await installAgent(f);
    await f.dispatch('turn.complete', { reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', agentId: A1 }, async () => ({ text: 'done' }));
    expect(await handoffLanded(f)).toEqual([expect.stringMatching(/^general-purpose a1b2c3 handoff landed — 64k → unknown context \(it ended before a request after the install measured it\); frontier /)]);
    expect((await rows(f)).filter((r) => r.event === 'landed')).toEqual([expect.objectContaining({ before: 64_000, after: null })]);
  });

  it('M2 holds the mechanical line for the measured reading too, and says so at session end when none came', async () => {
    const f = await begin();
    await step(f, 125_000);
    expect(await ask(f, transcript())).toHaveProperty('messages');
    expect(landedLines(f)).toEqual([]);
    await step(f, 30_000);
    expect(landedLines(f)).toEqual(['main had no handoff at 125k (ceiling 120k) — mechanical wake installed, 125k → 30k context, measured.']);
    await step(f, 125_000);
    await ask(f, transcript());
    await rows(f);
    expect(landedLines(f).at(-1)).toBe('main had no handoff at 125k (ceiling 120k) — mechanical wake installed, 125k → unknown context (it ended before a request after the install measured it).');
  });

  it('M3 nudges with the milestone wording, verbatim', async () => {
    const f = await begin();
    await step(f, 51_000);
    expect((await read(f, 'tu-1')).context?.at(-1)).toBe('forward-compaction: your context is 51k tokens (5% of your 1M max context), and every call re-sends all of it. Hand off at your next clean milestone: once the step in hand is finished and its results are written down, and before you start the next step, call mcp__forward-compaction__forward_compaction with objective, done, remaining and next. You pick the milestone, not whether: skip it only if nothing is left but writing your result and your final answer. At 120k the plugin compacts you mechanically, with no frontier from you. If this tool is not in your tool list, carry on.');
  });

  it("M4 refuses load files past 5% of the max context at the party's measured ratio, and carries one that fits", async () => {
    const [big, mid, rest] = ['/work/big.md', '/work/mid.md', '/work/rest.md'];
    // 100,000 characters grown over 40,000 tokens since the base: 2.5 characters a token, measured
    let chars = 60_000;
    const messages = () => [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(chars) }] }];
    const f = await begin({ messages, files: { [big]: { content: 'b'.repeat(125_001) }, [mid]: { content: 'm'.repeat(70_000) }, [rest]: { content: 'r'.repeat(60_000) } } });
    await spawn(f);
    await step(f, 24_000, A1);
    chars = 160_000;
    await step(f, 64_000, A1);
    const call = (paths: string[], id: string) => f.dispatch('tool.call', { tool: FORWARD, tool_use_id: id, agentId: A1, ...SECTIONS, load_files: paths.map((path) => ({ path, why: 'needed' })) }, async () => ({ result: 'not ours' }));
    expect((await call([big], 'tu-1')).result.split('\n').slice(0, 3)).toEqual([
      'forward_compaction refused, nothing stored: load_files come to 125,001 characters, over the 125,000-character room for carried files (5% of your 1M max context):',
      '- /work/big.md: 125,001 characters',
      'Pass lines ranges (like "10-40" or "1-60,160-185") to carry only what you need, or fewer files, and call again.',
    ]);
    const both = (await call([mid, rest], 'tu-2')).result;
    expect(both).toContain('load_files come to 130,000 characters, over the 125,000-character room');
    expect(both).toContain('- /work/mid.md: 70,000 characters\n- /work/rest.md: 60,000 characters');
    expect((await call([mid], 'tu-h')).result).toContain('Handoff stored (');
    const wake = await ask(f, transcript(), A1);
    expect(wake.messages[0].text).toContain('## Files you asked to carry\n### /work/mid.md — needed\nmmm');
    expect(wake.messages[0].text).not.toContain('## Files not carried');
  });

  it('M4 accepts load files with no size check, and says so, while the party has no reading to measure them by', async () => {
    const big = '/work/big.md';
    const f = await begin({ files: { [big]: { content: 'b'.repeat(900_000) } } });
    await spawn(f);
    const r = await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-1', agentId: A1, ...SECTIONS, load_files: [{ path: big, why: 'needed' }] }, async () => ({ result: 'not ours' }));
    expect(r.result).toContain('Handoff stored (');
    const all = await rows(f);
    expect(all.find((row) => row.event === 'warning' && row.key === 'load-files-unchecked')).toMatchObject({ party: `agent:${A1}`, files: 1 });
    expect(all.some((row) => row.event === 'said' && String(row.line).includes("agent:a1b2c3d4e5's load_files were accepted without a size check: its characters per token are not measured yet"))).toBe(true);
  });

  it("M5 lists only a sub-agent's own children in its wake, and every agent in main's", async () => {
    const [B, C] = ['b9c8d7e6f5', 'c1c2c3c4c5'];
    const f = await begin({ agents: () => [
      { id: A1, type: 'general-purpose', status: 'running', description: 'one' },
      { id: B, type: 'flights-foreman-sonnet', status: 'running', description: 'sibling' },
      { id: C, type: 'collector', status: 'running', description: 'child', parentId: A1 },
    ] });
    const sub = (await installAgent(f)).messages[0].text;
    expect(sub).toContain(`## Agents, listed at install\n- ${C} collector running: child`);
    expect(sub).not.toContain(B);
    await step(f, 125_000);
    expect((await ask(f, transcript())).messages[0].text).toContain(`## Agents, listed at install\n- ${A1} general-purpose running: one\n- ${B} flights-foreman-sonnet running: sibling\n- ${C} collector running: child`);
  });
});

describe('the ratio is measured on the growth since the base, so the fixed overhead cancels', () => {
  const ask = (f: Fake, messages: unknown[], agentId?: string) => f.dispatch('session.compact', { trigger: 'auto', messages, ...(agentId ? { agentId } : {}) }, async () => ({ skip: 'native ran' }));
  const BRIEF = 'b'.repeat(12_000);
  /** A sub-agent transcript in row form (`e.messages`): its brief, `grown` characters of work before its forward_compaction call `id`, the result and two messages after. */
  const work = (grown: number, id = 'tu-h') => [
    { role: 'user', text: BRIEF, toolUses: [], handle: 'h0' },
    { role: 'assistant', text: 'w'.repeat(grown), toolUses: [{ tool_use_id: id, tool: FORWARD, input: SECTIONS }], handle: 'h1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'Handoff stored' }], handle: 'h2' },
    { role: 'assistant', text: 'reading on after the handoff', toolUses: [], handle: 'h3' },
    { role: 'user', text: 'a later note', toolUses: [], handle: 'h4' },
  ];
  /** A live window of `n` characters in Messages API form, as `$.session.messages({ as: 'api' })` answers. */
  const window = (n: number) => [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(n) }] }];
  /** The session's row history past the 4096 entries `$.session.messages()` answers: the same newest 4096 at every read. */
  const HISTORY = Array.from({ length: 4096 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'h'.repeat(100), toolUses: [] }));
  /** The debug rows of `event`, read once session.end has flushed them. */
  async function debugRows(f: Fake, event: string): Promise<Record<string, unknown>[]> {
    await rows(f);
    const file = join(f.home, '.local/state/forward-compaction/logs/debug.jsonl');
    for (let i = 0; i < 50 && !existsSync(file); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.event === event).map((r) => r.detail);
  }
  /**
   * A sub-agent spawned with the 12,000-character brief, its base taken at `baseTokens` over the brief alone. The api read
   * answers the live window `set` holds; the row read the 4096-entry history, never the window.
   */
  async function agent(baseTokens: number, script: Script = {}) {
    let live: unknown = window(12_000);
    const f = await begin({ ...script, messages: (args) => ((args as { as?: string } | undefined)?.as === 'api' ? live : HISTORY) });
    await spawn(f, A1, BRIEF);
    await step(f, baseTokens, A1);
    return { f, set: (next: unknown) => void (live = next) };
  }

  it('carries a 12,000-character brief whole for a sub-agent with 40k tokens of overhead growing 2.5 characters a token', async () => {
    const { f, set } = await agent(44_800); // 40k of system prompt and tools, plus the brief's 4,800
    set(window(60_000));
    await step(f, 64_000, A1); // 19,200 tokens grown: 48,000 characters at 2.5
    await store(f, A1);
    const wake = await ask(f, work(48_000), A1);
    expect(wake.messages[0].text).toContain(`## Your brief\n${BRIEF}`);
    expect(await debugRows(f, 'ratio')).toEqual([expect.objectContaining({ party: `agent:${A1}`, at: 'compact', baseChars: 12_000, baseTokens: 44_800, chars: 60_000, reading: 64_000, ratio: 2.5 })]);
  });

  it('measures the live window past 4096 row entries: the api read, never the newest 4096 rows, and never e.messages', async () => {
    const { f, set } = await agent(44_800);
    set(window(60_000));
    await step(f, 64_000, A1);
    await store(f, A1);
    await ask(f, work(400_000), A1); // e.messages counts 412k characters: not the read
    expect(await debugRows(f, 'ratio')).toEqual([expect.objectContaining({ baseChars: 12_000, chars: 60_000, ratio: 2.5 })]);
  });

  it('takes the first reading after an install as the new base', async () => {
    const { f, set } = await agent(44_800);
    set(window(60_000));
    await step(f, 64_000, A1);
    await store(f, A1);
    await ask(f, work(48_000), A1);
    set(window(30_000)); // the wake, the live window after the install
    await step(f, 41_000, A1); // the first reading after the install
    set(window(30_000 + 19_000 * 3));
    await step(f, 60_000, A1);
    await store(f, A1, 'tu-2');
    await ask(f, work(19_000 * 3, 'tu-2'), A1);
    const bases = await debugRows(f, 'ratio-base');
    expect(bases).toEqual([{ party: `agent:${A1}`, chars: 12_000, tokens: 44_800 }, { party: `agent:${A1}`, chars: 30_000, tokens: 41_000 }]);
    expect((await debugRows(f, 'ratio')).at(-1)).toMatchObject({ baseChars: 30_000, baseTokens: 41_000, chars: 87_000, reading: 60_000, ratio: 3 });
  });

  it('leaves the ratio unmeasured, and every section uncapped, while the growth is under the minimum', async () => {
    const { f, set } = await agent(60_000);
    set(window(13_000));
    await step(f, 63_000, A1); // 3,000 tokens grown, under RATIO_MIN_GROWTH
    await store(f, A1);
    const wake = await ask(f, work(1_000), A1);
    expect(wake.messages[0].text).toContain(`## Your brief\n${BRIEF}`);
    expect(await debugRows(f, 'ratio-unmeasured')).toEqual([expect.objectContaining({ party: `agent:${A1}`, why: 'below-min-growth', baseChars: 12_000, baseTokens: 60_000, chars: 13_000, reading: 63_000 })]);
  });

  it('leaves a ratio outside the sanity range unmeasured, its row naming the ratio and its four inputs', async () => {
    const { f, set } = await agent(44_800);
    set(window(212_000));
    await step(f, 64_000, A1);
    await store(f, A1);
    const wake = await ask(f, work(200_000), A1);
    expect(wake.messages[0].text).toContain(`## Your brief\n${BRIEF}`);
    const [row] = await debugRows(f, 'ratio-unmeasured');
    expect(row).toMatchObject({ party: `agent:${A1}`, at: 'compact', why: 'out-of-range', baseChars: 12_000, baseTokens: 44_800, chars: 212_000, reading: 64_000 });
    expect(row!.delta).toBeCloseTo(200_000 / 19_200, 6);
  });

  it("leaves the ratio unmeasured on an agent's deny, its row naming the deny", async () => {
    const f = await begin({ messages: () => ({ deny: 'agent a1b2c3d4e5 finished; no transcript saved' }) });
    await spawn(f, A1, BRIEF);
    await step(f, 44_800, A1);
    await step(f, 64_000, A1);
    await store(f, A1);
    const wake = await ask(f, work(48_000), A1);
    expect(wake.messages[0].text).toContain(`## Your brief\n${BRIEF}`);
    expect(await debugRows(f, 'session.messages-denied')).toContainEqual({ party: `agent:${A1}`, deny: 'agent a1b2c3d4e5 finished; no transcript saved' });
    expect(await debugRows(f, 'ratio-unmeasured')).toEqual([expect.objectContaining({ party: `agent:${A1}`, why: 'no-base', chars: null })]);
  });
});
