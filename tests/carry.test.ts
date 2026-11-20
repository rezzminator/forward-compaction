import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  descriptionOf, keepNote, keepOutcome, keptLater, laterApply, laterChecked, laterNote, laterProblem, pinned, pinnedBy, FRONTMATTER_KEEP,
} from '../plugins/forward-compaction/src/frontier.ts';
import type { FileCheck } from '../plugins/forward-compaction/src/frontier.ts';
import { fakeEngine, usage, type Script } from './fakes/engine.ts';

// What a wake carries whole and what it lists: a skill's text only when pinned or named in keep_skills, a load file
// marked later never, listed by path and why in every wake until a frontier names it again, drops it, or it is gone.

const FORWARD = 'mcp__forward-compaction__forward_compaction';
const SECTIONS = { objective: 'Ship U5.', decisions: 'none', done: 'The fake.', remaining: 'The adapter.', next: 'Wire session.compact.' };
const A1 = 'a1b2c3d4e5';
const PIN = { [FRONTMATTER_KEEP]: true };
const SKILLS_NOTE = 'Their text is not in your context: load one again with the Skill tool before doing work it governs.';
const LATER_HEAD = '## Files for later, not loaded\nTheir content is not in your context: read each with the Read tool (or the shell) at the step that needs it.';
const PLAN = '/work/plan.md';

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

describe('keepOutcome and keepNote', () => {
  it('sorts the names asked by what becomes of them, the latest load of each deciding, and says each kind', () => {
    const outcome = keepOutcome([{ skill: 'notes' }, { skill: 'god-speed', keep: true }], ['notes', 'notes', 'god-speed', 'nosuch'], []);
    expect(outcome).toEqual({ kept: ['notes'], pinned: ['god-speed'], unknown: ['nosuch'] });
    expect(keepNote(outcome)).toBe(`Carried whole in your next wake: notes. Name it in keep_skills again to keep it in the wake after. Carried whole in every wake already: god-speed. It is pinned: its file's frontmatter sets ${FRONTMATTER_KEEP}, or FORWARD_COMPACTION_KEEP_SKILLS names it. Not in your context, nothing to keep: nosuch. Use the name the skill or command was loaded under.`);
    expect(keepOutcome([{ skill: 'notes' }, { skill: 'plain' }], ['notes', 'plain'], ['plain'])).toEqual({ kept: ['notes'], pinned: ['plain'], unknown: [] });
    expect(keepNote(keepOutcome([{ skill: 'notes' }], [], []))).toBe('');
  });
});

describe('laterApply', () => {
  const a = { path: '/a', why: 'old', later: true as const };
  const b = { path: '/b', later: true as const };
  it.each([
    ['a later entry joins the list, a whole one does not', [], [{ path: '/a', why: 'w', later: true as const }, { path: '/b' }], [], { listed: [{ path: '/a', why: 'w', later: true }], dropped: [], unknown: [] }],
    ['an entry no call names stays', [a], [], [], { listed: [a], dropped: [], unknown: [] }],
    ['the same path without later leaves the list', [a, b], [{ path: '/a' }], [], { listed: [b], dropped: [], unknown: [] }],
    ['the same path with later replaces the entry', [a, b], [{ path: '/a', why: 'new', later: true as const }], [], { listed: [b, { path: '/a', why: 'new', later: true }], dropped: [], unknown: [] }],
    ['drop_files takes a listed path out and answers one it does not hold', [a, b], [], ['/a', '/c'], { listed: [b], dropped: ['/a'], unknown: ['/c'] }],
    ['drop_files wins over a later entry of the same call', [a], [{ path: '/a', why: 'again', later: true as const }, { path: '/b', later: true as const }], ['/a', '/b'], { listed: [], dropped: ['/a'], unknown: ['/b'] }],
    ['a path named twice is listed once, at its last entry', [], [{ path: '/a', why: '1', later: true as const }, { path: '/a', why: '2', later: true as const }], [], { listed: [{ path: '/a', why: '2', later: true }], dropped: [], unknown: [] }],
  ])('%s', (_name, list, loadFiles, dropFiles, want) => {
    expect(laterApply(list, loadFiles, dropFiles)).toEqual(want);
  });

  it('says the list after the call and each drop_files path, and nothing when there is neither', () => {
    expect(laterNote({ listed: [], dropped: [], unknown: [] })).toBe('');
    expect(laterNote({ listed: [{ path: '/a' }, { path: '/b' }], dropped: ['/c'], unknown: ['/d'] })).toBe(
      'Listed for later in every wake, not loaded: /a, /b. Read one at the step that needs it; name it in drop_files once no step does. Dropped from the files for later: /c. Not listed for later, nothing to drop: /d.');
  });
});

describe('laterProblem and keptLater', () => {
  it.each([
    [{ kind: 'file' as const, size: 3 }, undefined],
    [{ absent: true as const }, 'no such file'],
    [{ kind: 'dir' as const, size: 4096 }, 'not a regular file'],
    [{ error: 'EACCES: permission denied' }, 'could not be checked: EACCES: permission denied'],
  ])('stat %j -> %j', (check, want) => {
    expect(laterProblem(check)).toBe(want);
  });

  it('keeps each file for later that is a regular file, names each other one with why, and persists the list only when one left', async () => {
    const checks: Record<string, FileCheck> = { '/a': { kind: 'file', size: 1 }, '/b': { absent: true }, '/c': { error: 'EACCES' }, '/d': { kind: 'file', size: 2 } };
    const files = ['/a', '/b', '/c', '/d'].map((path) => ({ path, later: true as const }));
    let kept = 0;
    const party = { later: files };
    expect(await laterChecked(party, async (path) => checks[path]!, async () => void kept++)).toEqual({ listed: [files[0], files[3]], gone: [{ path: '/b', problem: 'no such file' }, { path: '/c', problem: 'could not be checked: EACCES' }] });
    expect([party.later, kept]).toEqual([[files[0], files[3]], 1]);
    expect(await laterChecked(party, async (path) => checks[path]!, async () => void kept++)).toEqual({ listed: [files[0], files[3]], gone: [] });
    expect(kept).toBe(1);
    expect(await laterChecked({}, async () => ({ absent: true }), async () => void kept++)).toEqual({ listed: [], gone: [] });
  });

  it('reads back each kept entry with a path, and nothing from a value that is no list', () => {
    expect(keptLater([{ path: '/a', lines: '1-2', why: 'w' }, { path: ' ' }, null, { path: 3 }, { path: '/b', why: 4 }])).toEqual([{ path: '/a', lines: '1-2', why: 'w', later: true }, { path: '/b', later: true }]);
    expect(keptLater(undefined)).toBeUndefined();
    expect(keptLater({ path: '/a' })).toBeUndefined();
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
describe('a sub-agent\'s skills and files for later through the hooks', { timeout: 30_000 }, () => {
  async function begin(env: Record<string, string> = {}, script: Script = {}): Promise<Fake> {
    const f = fakeEngine({ window: 1_000_000, ...script, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', ...env } });
    fakes.push(f);
    await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
    await f.dispatch('agent.spawn', { tool_use_id: 'tu-spawn', prompt: 'Brief for agent one', description: 'one', subagentType: 'general-purpose', provider: { kind: 'local' } }, async () => ({ model: 'sonnet', agentId: A1 }));
    await load(f, 'notes', 'NOTES SKILL BODY', { description: 'Notes on the work.' });
    await load(f, 'god-speed', 'GOD SPEED BODY', PIN);
    return f;
  }
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
    await f.dispatch('turn.step', { turnId: 't1', index: 0, model: 'claude-sonnet-4-5', messageCount: 4, agentId: A1 }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(90_000) }));
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
  /** `$.state` whose writes of the files for later are refused while `fail` is set. */
  class RefusingState extends Map<string, { value: unknown; version: number }> {
    fail = false;
    override set(key: string, value: { value: unknown; version: number }): this {
      if (this.fail && key.includes('"key":"later"')) throw new Error('state write refused');
      return super.set(key, value);
    }
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
    expect((await installs(f)).map((r) => [r.skills, r.later])).toEqual([[{ carried: 1, listed: 2 }, 0]]);
  });

  it('carries a skill keep_skills names whole in that one wake, and lists it again in the next', async () => {
    const f = await begin();
    const kept = await cycle(f, { keep_skills: ['notes', 'god-speed', 'nosuch'] });
    expect(kept.receipt).toContain(`Carried whole in your next wake: notes. Name it in keep_skills again to keep it in the wake after. Carried whole in every wake already: god-speed. It is pinned: its file's frontmatter sets ${FRONTMATTER_KEEP}, or FORWARD_COMPACTION_KEEP_SKILLS names it. Not in your context, nothing to keep: nosuch. Use the name the skill or command was loaded under.`);
    expect(kept.wake).toContain('### notes (user, /s/notes/SKILL.md, named in your keep_skills)\nNOTES SKILL BODY');
    expect(kept.wake).not.toContain('## Skills not carried');
    const next = await cycle(f);
    expect(next.wake).toContain(`## Skills not carried\n${SKILLS_NOTE}\n- notes (user, /s/notes/SKILL.md): Notes on the work.`);
    expect(next.wake).not.toContain('NOTES SKILL BODY');
    expect((await installs(f)).map((r) => r.skills)).toEqual([{ carried: 2, listed: 0 }, { carried: 1, listed: 1 }]);
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

  it('stores a call that still passes drop_skills, carrying it under findings', async () => {
    const f = await begin();
    const { receipt, wake } = await cycle(f, { drop_skills: ['notes'] });
    expect(receipt).toMatch(/^Frontier stored \(/);
    expect(receipt).toContain('Stored with 1 change:\n- unknown field "drop_skills" carried under findings. The fields are objective, decisions, done, remaining, next, blocked, findings, load_files, drop_files, keep_skills, standing_orders and lifted.');
    expect(wake).toContain('## Findings\n[drop_skills, an argument forward_compaction does not take]\n["notes"]');
  });

  it('lists a file for later by path, lines and why, with none of its content, in every wake until one ends it', async () => {
    const f = await begin({}, { files: { [PLAN]: { content: 'PLAN BODY\nSTEP FOUR' } } });
    const first = await cycle(f, { load_files: [{ path: PLAN, lines: '1-2', why: 'the plan for step 4', later: true }] });
    expect(first.receipt).toMatch(/^Frontier stored \([\d,]+ characters, 0 files\)/);
    expect(first.receipt).toContain(`Listed for later in every wake, not loaded: ${PLAN}. Read one at the step that needs it; name it in drop_files once no step does.`);
    const line = `${LATER_HEAD}\n- ${PLAN} lines 1-2 — the plan for step 4`;
    for (const { wake } of [first, await cycle(f), await cycle(f)]) {
      expect(wake).toContain(line);
      expect(wake).not.toContain('PLAN BODY');
    }
    expect((await installs(f)).map((r) => r.later)).toEqual([1, 1, 1]);
  });

  it('carries a file for later whole once a frontier names its path without later, and lists it no more', async () => {
    const f = await begin({}, { files: { [PLAN]: { content: 'PLAN BODY' } } });
    expect((await cycle(f, { load_files: [{ path: PLAN, why: 'later', later: true }] })).wake).toContain(`${LATER_HEAD}\n- ${PLAN} — later`);
    const whole = await cycle(f, { load_files: [{ path: PLAN }] });
    expect(whole.wake).toContain(`## Files you asked to carry\n### ${PLAN}\nPLAN BODY`);
    expect(whole.wake).not.toContain(LATER_HEAD);
    expect(whole.receipt).not.toContain('Listed for later');
    const after = await cycle(f);
    expect(after.wake).not.toContain(PLAN);
  });

  it('ends a listing that drop_files names, answering a path it never listed', async () => {
    const f = await begin({}, { files: { [PLAN]: { content: 'PLAN BODY' } } });
    expect((await cycle(f, { load_files: [{ path: PLAN, later: true }] })).wake).toContain(`${LATER_HEAD}\n- ${PLAN}\n`);
    const dropped = await cycle(f, { drop_files: [PLAN, '/work/none.md'] });
    expect(dropped.receipt).toContain(`Dropped from the files for later: ${PLAN}. Not listed for later, nothing to drop: /work/none.md.`);
    expect(dropped.wake).not.toContain(LATER_HEAD);
    expect(dropped.wake).toContain('## Skills not carried');
  });

  it('names a file for later that is gone at a wake once as not carried, then lists it no more', async () => {
    const files: Script['files'] = { [PLAN]: { content: 'PLAN BODY' } };
    const f = await begin({}, { files });
    expect((await cycle(f, { load_files: [{ path: PLAN, why: 'the plan', later: true }] })).wake).toContain(`${LATER_HEAD}\n- ${PLAN} — the plan`);
    delete files[PLAN];
    const gone = await cycle(f);
    expect(gone.wake).toContain(`## Files not carried\n- ${PLAN}: no such file`);
    expect(gone.wake).not.toContain(LATER_HEAD);
    const after = await cycle(f);
    expect(after.wake).not.toContain(PLAN);
    expect(after.wake).toContain('## Skills not carried');
  });

  it('leaves the files for later as they were when the call cannot keep them', async () => {
    const state = new RefusingState();
    const f = await begin({}, { state, files: { [PLAN]: { content: 'PLAN BODY' } } });
    state.fail = true;
    expect(await store(f, { load_files: [{ path: PLAN, why: 'the plan', later: true }] })).toMatch(/^forward_compaction failed, nothing stored: state write refused\s/);
    state.fail = false;
    const { wake } = await cycle(f);
    expect(wake).toContain('## Skills not carried');
    expect(wake).not.toContain(PLAN);
  });

  it('names a file for later that is gone at a wake even when the shorter list cannot be kept', async () => {
    const state = new RefusingState();
    const files: Script['files'] = { [PLAN]: { content: 'PLAN BODY' } };
    const f = await begin({}, { state, files });
    await cycle(f, { load_files: [{ path: PLAN, why: 'the plan', later: true }] });
    delete files[PLAN];
    await store(f);
    state.fail = true;
    expect(await compact(f)).toContain(`## Files not carried\n- ${PLAN}: no such file`);
    state.fail = false;
    expect((await installs(f)).map((r) => r.later)).toEqual([1, 0]);
  });

  it('keeps the files for later across a plugin reload', async () => {
    const state = new Map<string, { value: unknown; version: number }>();
    const files = { [PLAN]: { content: 'PLAN BODY' } };
    const before = await begin({}, { state, files });
    await cycle(before, { load_files: [{ path: PLAN, why: 'the plan', later: true }] });
    const after = await begin({}, { state, files });
    expect((await cycle(after)).wake).toContain(`${LATER_HEAD}\n- ${PLAN} — the plan`);
  });
});
