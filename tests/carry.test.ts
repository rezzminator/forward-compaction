import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { descriptionOf, pinned, pinnedBy, FRONTMATTER_KEEP } from '../plugins/forward-compaction/src/carry.ts';
import { fakeEngine, usage, type Script } from './fakes/engine.ts';

// What a wake carries whole and what it lists: a skill's text only when pinned; every other skill by name.

const FORWARD = 'mcp__forward-compaction__forward_compaction';
const SECTIONS = { objective: 'Ship U5.', done: { add: ['The fake.'] }, remaining: { add: ['The adapter.'] }, next: 'Wire session.compact.' };
const A1 = 'a1b2c3d4e5';
const PIN = { [FRONTMATTER_KEEP]: true };
const SKILLS_NOTE = 'Their text is not in your context: load one again with the Skill tool before doing work it governs.';

describe('pinnedBy and pinned', () => {
  it('reads the frontmatter key set to true, as YAML or as a quoted string, and nothing else', () => {
    expect([PIN, { [FRONTMATTER_KEEP]: 'true' }, { [FRONTMATTER_KEEP]: ' True ' }].map(pinnedBy)).toEqual([true, true, true]);
    expect([{}, { [FRONTMATTER_KEEP]: false }, { [FRONTMATTER_KEEP]: 'yes please' }, { [FRONTMATTER_KEEP]: 1 }, null, undefined, 'x'].map(pinnedBy)).toEqual([false, false, false, false, false, false, false]);
  });

  it.each([
    [{ skill: 'notes', keep: true as const }, [], true],
    [{ skill: 'notes' }, ['notes'], true],
    [{ skill: 'notes' }, ['*'], true],
    [{ skill: 'notes' }, ['god-speed'], false],
    [{ skill: 'notes' }, [], false],
  ])('loaded %j, FORWARD_COMPACTION_KEEP_SKILLS %j -> pinned %s', (skill, keep, want) => {
    expect(pinned(skill, keep)).toBe(want);
  });
});

describe('descriptionOf', () => {
  it.each([
    [{ description: ' Notes on the work. ' }, 'Notes on the work.'],
    [{ description: '   ' }, undefined],
    [{ description: 3 }, undefined],
    [{}, undefined],
    [null, undefined],
  ])('frontmatter %j -> %j', (frontmatter, want) => {
    expect(descriptionOf(frontmatter)).toBe(want);
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

// Each case drives several frontier cycles over a 200k-character transcript through the hooks:
// CPU-bound seconds that a loaded host stretches past vitest's 5 s default.
describe('a sub-agent\'s skills through the hooks', { timeout: 30_000 }, () => {
  async function begin(env: Record<string, string> = {}, script: Script = {}): Promise<Fake> {
    const f = fakeEngine({ window: 1_000_000, ...script, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', ...env } });
    fakes.push(f);
    await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
    await f.dispatch('agent.spawn', { tool_use_id: 'tu-spawn', prompt: 'Brief for agent one', description: 'one', subagentType: 'general-purpose', provider: { kind: 'local' } }, async () => ({ model: 'sonnet', agentId: A1 }));
    await reading(f, 30_000); // its floor: the call at 90k is past its install point, so it compacts
    await load(f, 'notes', 'NOTES SKILL BODY', { description: 'Notes on the work.' });
    await load(f, 'god-speed', 'GOD SPEED BODY', PIN);
    return f;
  }
  const reading = (f: Fake, tokens: number) => f.dispatch('turn.step', { turnId: 't1', index: 0, model: 'claude-sonnet-4-5', messageCount: 4, agentId: A1 }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(tokens) }));
  const load = (f: Fake, skill: string, text: string, frontmatter: Record<string, unknown> = {}) =>
    f.dispatch('tool.call', { tool: 'Skill', tool_use_id: `tu-${skill}`, agentId: A1, skill }, async () => {
      await f.dispatch('skill.prompt', { skill, text, frontmatter, source: 'user', path: `/s/${skill}/SKILL.md` }, async () => ({ text }));
      return { result: 'loaded' };
    });
  const transcript = () => [
    { role: 'user', text: 'Brief for agent one', toolUses: [], handle: 'h0' },
    { role: 'assistant', text: `storing ${'p'.repeat(200_000)}`, toolUses: [{ tool_use_id: 'tu-h', tool: FORWARD, input: SECTIONS }], handle: 'h1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'tu-h', text: 'Frontier stored' }], handle: 'h2' },
  ];
  /** A reading, then the call with `args` besides its sections; its receipt. */
  async function store(f: Fake, args: Record<string, unknown> = {}): Promise<string> {
    await reading(f, 90_000);
    return ((await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-h', agentId: A1, ...SECTIONS, ...args }, async () => ({ result: 'not ours' }))) as { result: string }).result;
  }
  /** The install at Claude Code's ask; the wake's text. */
  async function compact(f: Fake): Promise<string> {
    const w = (await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: transcript() }, async () => ({ skip: 'native ran' }))) as { messages: { text: string }[] };
    return w.messages.map((m) => m.text).join('\n');
  }
  /** One frontier cycle: `store`, then `compact`; the receipt and the wake's text. */
  async function cycle(f: Fake, args: Record<string, unknown> = {}): Promise<{ receipt: string; wake: string }> {
    const receipt = await store(f, args);
    return { receipt, wake: await compact(f) };
  }
  /** The decision log's installing `compact` rows, once session.end has flushed them. */
  async function installs(f: Fake): Promise<Record<string, unknown>[]> {
    await f.dispatch('session.end', { reason: 'other' }, async () => ({}));
    const dir = join(f.home, '.local/state/forward-compaction/logs/decisions');
    return readdirSync(dir).flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)).filter((r) => r.event === 'compact' && r.decision === 'install');
  }

  it('lists a loaded skill by name, source and description, with none of its text, and carries a pinned one whole', async () => {
    const f = await begin();
    await load(f, 'plain', 'PLAIN SKILL BODY');
    const { wake } = await cycle(f);
    expect(wake).toContain(`## Skills not carried\n${SKILLS_NOTE}\n- plain (user, /s/plain/SKILL.md)\n- notes (user, /s/notes/SKILL.md): Notes on the work.\n\n`);
    expect(wake).toContain('## Skills in force, as loaded\n### god-speed (user, /s/god-speed/SKILL.md, pinned)\nGOD SPEED BODY\n\n');
    expect(wake).not.toContain('NOTES SKILL BODY');
    expect(wake).not.toContain('PLAIN SKILL BODY');
    expect((await installs(f)).map((r) => [r.skills, r.storage])).toEqual([[{ carried: 1, listed: 2 }, 0]]);
  });

  it.each([
    ['notes', '### notes (user, /s/notes/SKILL.md, pinned)\nNOTES SKILL BODY'],
    ['*', '### notes (user, /s/notes/SKILL.md, pinned)\nNOTES SKILL BODY'],
  ])('carries every skill FORWARD_COMPACTION_KEEP_SKILLS=%s pins whole, though its file sets nothing', async (keep, block) => {
    const f = await begin({ FORWARD_COMPACTION_KEEP_SKILLS: keep });
    const { wake } = await cycle(f);
    expect(wake).toContain(block);
    expect(wake).toContain('GOD SPEED BODY');
    expect(wake).not.toContain('## Skills not carried');
  });

  it.each([
    ['keep_skills', ['notes'], 'keep_skills is no field: ignored.'],
    ['drop_skills', ['notes'], 'drop_skills is no field: ignored.'],
  ])('stores a call that still passes %s, ignoring it with a note, and lists the skill as before', async (field, value, note) => {
    const f = await begin();
    const { receipt, wake } = await cycle(f, { [field]: value });
    expect(receipt.split('\n').slice(0, 5)).toEqual(['objective set', 'Added to done: [1]', 'Added to remaining: [1]', 'next set', note]);
    expect(wake).toContain(`## Skills not carried\n${SKILLS_NOTE}\n- notes (user, /s/notes/SKILL.md): Notes on the work.\n\n`);
    expect(wake).not.toContain('NOTES SKILL BODY');
  });
});
