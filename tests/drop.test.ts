import { afterEach, describe, expect, it } from 'vitest';
import { applyDrops, dropNote, pinnedBy, FRONTMATTER_KEEP } from '../plugins/forward-compaction/src/drop.ts';
import { parseFrontier } from '../plugins/forward-compaction/src/frontier.ts';
import { addEntry, newLedger, type Ledger } from '../plugins/forward-compaction/src/ledger.ts';
import { fakeEngine, usage } from './fakes/engine.ts';

// drop_skills: a skill or command named on two frontiers in a row leaves the second wake; one its frontmatter pins never does.

const FORWARD = 'mcp__forward-compaction__forward_compaction';
const SECTIONS = { objective: 'Ship U5.', done: 'The fake.', remaining: 'The adapter.', next: 'Wire session.compact.' };
const A1 = 'a1b2c3d4e5';
const PIN = { [FRONTMATTER_KEEP]: true };

describe('pinnedBy', () => {
  it('reads the frontmatter key set to true, as YAML or as a quoted string, and nothing else', () => {
    expect([PIN, { [FRONTMATTER_KEEP]: 'true' }, { [FRONTMATTER_KEEP]: ' True ' }].map(pinnedBy)).toEqual([true, true, true]);
    expect([{}, { [FRONTMATTER_KEEP]: false }, { [FRONTMATTER_KEEP]: 'yes please' }, { [FRONTMATTER_KEEP]: 1 }, null, undefined, 'x'].map(pinnedBy)).toEqual([false, false, false, false, false, false, false]);
  });
});

describe('applyDrops', () => {
  const ledger = (): Ledger => {
    let l = newLedger();
    l = addEntry(l, { kind: 'skill', party: 'agent:a1', at: 1, skill: 'notes', text: 'NOTES v1', how: 'skill-tool' });
    l = addEntry(l, { kind: 'skill', party: 'agent:a1', at: 2, skill: 'god-speed', text: 'GOD', how: 'skill-tool', keep: true });
    l = addEntry(l, { kind: 'skill', party: 'agent:a2', at: 3, skill: 'notes', text: 'NOTES of a2', how: 'skill-tool' });
    return addEntry(l, { kind: 'skill', party: 'agent:a1', at: 4, skill: 'notes', text: 'NOTES v2', how: 'skill-tool' });
  };
  const texts = (l: Ledger) => l.entries.map((e) => ('text' in e ? e.text : ''));

  it('drops a loaded, unpinned name the previous frontier named too: every entry of it for that party, no other party touched', () => {
    const { ledger: after, outcome } = applyDrops(ledger(), 'agent:a1', ['notes', 'notes'], ['notes']);
    expect(outcome).toEqual({ dropped: ['notes'], pending: [], pinned: [], unknown: [] });
    expect(texts(after)).toEqual(['GOD', 'NOTES of a2']);
  });

  it('holds a name asked once as pending, answers a pinned or unknown one, and leaves the ledger as it was', () => {
    const before = ledger();
    const { ledger: after, outcome } = applyDrops(before, 'agent:a1', ['notes', 'god-speed', 'nosuch'], ['god-speed', 'nosuch']);
    expect(outcome).toEqual({ dropped: [], pending: ['notes'], pinned: ['god-speed'], unknown: ['nosuch'] });
    expect(after).toBe(before);
  });

  it("says each kind of outcome in the receipt, and nothing when no name was asked", () => {
    expect(dropNote({ dropped: [], pending: [], pinned: [], unknown: [] })).toBe('');
    const note = dropNote({ dropped: ['a'], pending: ['b'], pinned: ['c'], unknown: ['d'] });
    expect(note).toContain('Dropped from your wake: a.');
    expect(note).toContain('Not dropped yet: b. Name it in drop_skills on your next frontier too');
    expect(note).toContain(`Never dropped: c. It is pinned: its file's frontmatter sets ${FRONTMATTER_KEEP}, or FORWARD_COMPACTION_KEEP_SKILLS names it.`);
    expect(note).toContain('Not in your context, nothing to drop: d.');
  });
});

describe('parseFrontier drop_skills', () => {
  it('takes a list of names, and skips anything else, naming the argument', () => {
    expect(parseFrontier({ ...SECTIONS, drop_skills: ['notes'] })).toMatchObject({ dropSkills: ['notes'] });
    expect(parseFrontier(SECTIONS)).toMatchObject({ dropSkills: [] });
    for (const bad of ['notes', [''], [3], Array.from({ length: 33 }, (_, i) => `s${i}`)]) expect(parseFrontier({ ...SECTIONS, drop_skills: bad }).notes.join('\n')).toContain('drop_skills');
  });
});

type Fake = ReturnType<typeof fakeEngine>;
const fakes: Fake[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) {
    expect(f.unscripted, 'every $ call the plugin made was scripted').toEqual([]);
    f.cleanup();
  }
});

describe('drop_skills through the hooks', () => {
  async function begin(env: Record<string, string> = {}): Promise<Fake> {
    const f = fakeEngine({ window: 1_000_000, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', ...env } });
    fakes.push(f);
    await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
    await f.dispatch('agent.spawn', { tool_use_id: 'tu-spawn', prompt: 'Brief for agent one', description: 'one', subagentType: 'general-purpose', provider: { kind: 'local' } }, async () => ({ model: 'sonnet', agentId: A1 }));
    await load(f, 'notes', 'NOTES SKILL BODY');
    await load(f, 'god-speed', 'GOD SPEED BODY', PIN);
    return f;
  }
  const load = (f: Fake, skill: string, text: string, frontmatter: Record<string, unknown> = {}) =>
    f.dispatch('tool.call', { tool: 'Skill', tool_use_id: `tu-${skill}`, agentId: A1, skill }, async () => {
      await f.dispatch('skill.prompt', { skill, text, frontmatter }, async () => ({ text }));
      return { result: 'loaded' };
    });
  const transcript = () => [
    { role: 'user', text: 'Brief for agent one', toolUses: [], handle: 'h0' },
    { role: 'assistant', text: `storing ${'p'.repeat(200_000)}`, toolUses: [{ tool_use_id: 'tu-h', tool: FORWARD, input: SECTIONS }], handle: 'h1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'tu-h', text: 'Frontier stored' }], handle: 'h2' },
  ];
  /** One frontier cycle: a reading, the call naming `drop`, and the install at Claude Code's ask; the receipt and the wake's text. */
  async function cycle(f: Fake, drop?: string[]): Promise<{ receipt: string; wake: string }> {
    await f.dispatch('turn.step', { turnId: 't1', index: 0, model: 'claude-sonnet-4-5', messageCount: 4, agentId: A1 }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(90_000) }));
    const r = (await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-h', agentId: A1, ...SECTIONS, ...(drop ? { drop_skills: drop } : {}) }, async () => ({ result: 'not ours' }))) as { result: string };
    const w = (await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: transcript() }, async () => ({ skip: 'native ran' }))) as { messages: { text: string }[] };
    return { receipt: r.result, wake: w.messages.map((m) => m.text).join('\n') };
  }

  it('leaves a skill out of the wake only at the second frontier in a row naming it, and never a pinned one', async () => {
    const f = await begin();
    const first = await cycle(f, ['notes', 'god-speed', 'nosuch']);
    expect(first.receipt).toContain('Frontier stored');
    expect(first.receipt).toContain('Not dropped yet: notes.');
    expect(first.receipt).toContain('Never dropped: god-speed.');
    expect(first.receipt).toContain('Not in your context, nothing to drop: nosuch.');
    expect(first.wake).toContain('NOTES SKILL BODY');
    expect(first.wake).toMatch(/### god-speed \([^)]*pinned: never dropped\)\nGOD SPEED BODY/);
    const second = await cycle(f, ['notes', 'god-speed']);
    expect(second.receipt).toContain('Dropped from your wake: notes.');
    expect(second.wake).not.toContain('NOTES SKILL BODY');
    expect(second.wake).toContain('GOD SPEED BODY');
    expect((await cycle(f)).wake).not.toContain('NOTES SKILL BODY');
  });

  it('starts the count again when a frontier in between does not name it', async () => {
    const f = await begin();
    await cycle(f, ['notes']);
    await cycle(f);
    const third = await cycle(f, ['notes']);
    expect(third.receipt).toContain('Not dropped yet: notes.');
    expect(third.wake).toContain('NOTES SKILL BODY');
  });

  it('never drops a skill FORWARD_COMPACTION_KEEP_SKILLS names, though its file sets nothing', async () => {
    const f = await begin({ FORWARD_COMPACTION_KEEP_SKILLS: 'notes' });
    await cycle(f, ['notes']);
    const second = await cycle(f, ['notes']);
    expect(second.receipt).toContain('Never dropped: notes.');
    expect(second.wake).toMatch(/### notes \([^)]*pinned: never dropped\)\nNOTES SKILL BODY/);
  });

  it('carries a dropped skill again once the agent loads it again', async () => {
    const f = await begin();
    await cycle(f, ['notes']);
    await cycle(f, ['notes']);
    await load(f, 'notes', 'NOTES SKILL BODY, LOADED AGAIN');
    expect((await cycle(f)).wake).toContain('NOTES SKILL BODY, LOADED AGAIN');
  });
});
