import { describe, expect, it } from 'vitest';
import {
  promptsKept, restorePrompts, PROMPTS_KEPT, skillsKept, restoreSkills,
  PERSON_ORIGINS, addEntry, attributeSkill, factsFor, isPersonOrigin, markStart, newLedger, resolveSpawn, shellsOf,
  type EntryInput, type Ledger, type PartyKey,
} from '../plugins/forward-compaction/src/ledger.ts';

const person = (text: string, at = 1): EntryInput => ({ kind: 'person', party: 'main', text, at });
const skill = (party: PartyKey, name: string, text: string, at = 1): EntryInput => ({
  kind: 'skill', party, skill: name, text, how: 'skill-tool', at,
});
const build = (...entries: EntryInput[]): Ledger => entries.reduce(addEntry, newLedger());
const skillParty = (l: Ledger, name: string): string | undefined =>
  l.entries.flatMap((e) => (e.kind === 'skill' && e.skill === name ? [e.party] : []))[0];
const none = { keptTexts: [] as string[] };

describe('attributeSkill (D5)', () => {
  const base = { pendingCommand: undefined, pendingSpawns: new Set<string>(), skill: 'replay-rules' };

  it('names the party of the one in-flight Skill call', () => {
    expect(attributeSkill({ ...base, inFlightSkills: [{ party: 'agent:a1', tool_use_id: 't1' }] }))
      .toEqual({ party: 'agent:a1', how: 'skill-tool' });
  });

  it('prefers the in-flight call over a typed command and a pending spawn', () => {
    expect(attributeSkill({
      inFlightSkills: [{ party: 'main', tool_use_id: 't1' }], pendingCommand: 'replay-rules',
      pendingSpawns: new Set(['toolu_9']), skill: 'replay-rules',
    })).toEqual({ party: 'main', how: 'skill-tool' });
  });

  it('is main for a typed command naming the skill, plain or plugin-qualified', () => {
    const typed = { ...base, inFlightSkills: [] };
    expect(attributeSkill({ ...typed, pendingCommand: 'forward-compaction:replay-rules' }))
      .toEqual({ party: 'main', how: 'typed-command' });
    expect(attributeSkill({ ...typed, pendingCommand: 'replay-rules' })).toEqual({ party: 'main', how: 'typed-command' });
    expect(attributeSkill({ ...typed, pendingCommand: '/replay-rules' })).toEqual({ party: 'main', how: 'typed-command' });
  });

  it('does not take a command that merely ends in the skill name', () => {
    expect(attributeSkill({ ...base, inFlightSkills: [], pendingCommand: 'other-replay-rules' }))
      .toEqual({ party: 'unknown', how: 'ambiguous' });
  });

  it('is the spawn awaiting its result when it is the only one (preload)', () => {
    expect(attributeSkill({ ...base, inFlightSkills: [], pendingSpawns: new Set(['toolu_9']) }))
      .toEqual({ party: 'spawn:toolu_9', how: 'preload' });
  });

  it('is unknown when two Skill calls are in flight', () => {
    expect(attributeSkill({
      ...base, inFlightSkills: [{ party: 'main', tool_use_id: 't1' }, { party: 'agent:a1', tool_use_id: 't2' }],
    })).toEqual({ party: 'unknown', how: 'ambiguous' });
  });

  it('does not take a typed command or a pending spawn while two Skill calls are in flight', () => {
    expect(attributeSkill({
      pendingCommand: '/replay-rules', pendingSpawns: new Set(['s1']), skill: 'replay-rules',
      inFlightSkills: [{ party: 'agent:a1', tool_use_id: 't1' }, { party: 'agent:a2', tool_use_id: 't2' }],
    })).toEqual({ party: 'unknown', how: 'ambiguous' });
  });

  it('is unknown when nothing matches, or two spawns are pending', () => {
    expect(attributeSkill({ ...base, inFlightSkills: [] })).toEqual({ party: 'unknown', how: 'ambiguous' });
    expect(attributeSkill({ ...base, inFlightSkills: [], pendingSpawns: new Set(['a', 'b']) }))
      .toEqual({ party: 'unknown', how: 'ambiguous' });
  });
});

describe('PERSON_ORIGINS', () => {
  it('holds composer, bridge and sdk, and nothing that is a notification or a peer', () => {
    expect([...PERSON_ORIGINS].sort()).toEqual(['bridge', 'composer', 'sdk']);
    expect(isPersonOrigin('composer')).toBe(true);
    expect(isPersonOrigin('task-notification')).toBe(false);
    expect(isPersonOrigin('peer')).toBe(false);
    expect(isPersonOrigin(undefined)).toBe(false);
  });
});

describe('addEntry', () => {
  it('numbers entries in ledger order and keeps the clock value it was given', () => {
    const ledger = build(person('a', 100), person('b', 250));
    expect(ledger.entries.map((e) => [e.seq, e.at])).toEqual([[1, 100], [2, 250]]);
  });

  it('returns a new ledger and leaves the old one as it was', () => {
    const before = newLedger();
    const after = addEntry(before, person('a'));
    expect(before.entries).toHaveLength(0);
    expect(after.entries).toHaveLength(1);
  });

  it('replaces the previous shells entry (R10) and facts carry the latest at', () => {
    const ledger = build(
      { kind: 'shells', tasks: [{ id: 's1', type: 'shell', status: 'running', description: 'd', command: 'sleep 1' }], crons: [], at: 10 },
      person('x', 20),
      { kind: 'shells', tasks: [], crons: [{ id: 'c1', schedule: '* * * * *', recurring: true, prompt: 'p' }], at: 30 },
    );
    expect(ledger.entries.filter((e) => e.kind === 'shells')).toHaveLength(1);
    const shells = factsFor(ledger, 'main', none).shells;
    expect(shells?.at).toBe(30);
    expect(shells?.tasks).toEqual([]);
    expect(shells?.crons[0]?.id).toBe('c1');
  });

  it('gives a replaced shells entry a seq after the entries before it', () => {
    const ledger = build(
      { kind: 'shells', tasks: [], crons: [], at: 1 }, person('x'), { kind: 'shells', tasks: [], crons: [], at: 2 },
    );
    expect(ledger.entries.map((e) => e.seq)).toEqual([2, 3]);
  });
});

describe('markStart', () => {
  it('records when and why the ledger started, and keeps the entries', () => {
    const ledger = markStart(build(person('a')), 5000, 'resume');
    expect(ledger.startedAt).toBe(5000);
    expect(ledger.startReason).toBe('resume');
    expect(factsFor(ledger, 'main', none)).toMatchObject({ startedAt: 5000, startReason: 'resume' });
    expect(ledger.entries).toHaveLength(1);
  });

  it('has no start before session.start fires', () => {
    expect(factsFor(newLedger(), 'main', none)).toMatchObject({ startedAt: undefined, startReason: undefined });
  });
});

describe('factsFor', () => {
  it('leaves out a person message already in the kept tail, exactly or contained (R9)', () => {
    const ledger = build(person('fix the parser'), person('also add tests'));
    expect(factsFor(ledger, 'main', { keptTexts: ['also add tests'] }).person.map((e) => e.text)).toEqual(['fix the parser']);
    expect(factsFor(ledger, 'main', { keptTexts: ['ok: fix the parser, thanks'] }).person.map((e) => e.text))
      .toEqual(['also add tests']);
  });

  it('counts the person messages left out because the tail holds them, so the wake never calls them unrecorded', () => {
    const ledger = build(person('fix the parser'), person('also add tests'));
    expect(factsFor(ledger, 'main', { keptTexts: ['fix the parser', 'also add tests'] })).toMatchObject({ person: [], personInTail: 2 });
    expect(factsFor(ledger, 'main', { keptTexts: ['also add tests'] }).personInTail).toBe(1);
    expect(factsFor(ledger, 'main', none).personInTail).toBe(0);
  });

  it('keeps everything when nothing is kept, and never drops on an empty text', () => {
    const ledger = build(person(''), person('hello'));
    expect(factsFor(ledger, 'main', { keptTexts: ['anything'] }).person.map((e) => e.text)).toEqual(['', 'hello']);
  });

  it('lists the person messages oldest first, and notices and received apart from them', () => {
    const ledger = build(
      person('one'),
      { kind: 'notice', party: 'main', origin: 'task-notification', text: 'bg done', at: 2 },
      person('two'),
      { kind: 'received', party: 'agent:a1', origin: 'coordinator', text: 'to a1', at: 3 },
      { kind: 'received', party: 'agent:a2', origin: 'coordinator', text: 'to a2', at: 4 },
    );
    const main = factsFor(ledger, 'main', none);
    expect(main.person.map((e) => e.text)).toEqual(['one', 'two']);
    expect(main.notices.map((e) => e.text)).toEqual(['bg done']);
    expect(main.received).toEqual([]);
    const a1 = factsFor(ledger, 'agent:a1', none);
    expect(a1.received.map((e) => e.text)).toEqual(['to a1']);
    expect(a1.person).toEqual([]);
    expect(a1.notices).toEqual([]);
  });

  it('gives a sub-agent its own brief and no other', () => {
    const brief = (id: string, text: string): EntryInput => ({
      kind: 'brief', party: `agent:${id}`, text, subagentType: 'general-purpose', description: 'd', spawnedBy: 'main', at: 1,
    });
    const ledger = build(brief('a1', 'brief one'), brief('a2', 'brief two'));
    expect(factsFor(ledger, 'agent:a2', none).brief?.text).toBe('brief two');
    expect(factsFor(ledger, 'agent:a2', none).brief?.subagentType).toBe('general-purpose');
    expect(factsFor(ledger, 'agent:a3', none).brief).toBeUndefined();
    expect(factsFor(ledger, 'main', none).brief).toBeUndefined();
    expect(factsFor(ledger, 'agent:a2', { keptTexts: ['the brief two is first'] }).brief).toBeUndefined();
  });

  it('carries the latest brief of a party that was briefed twice', () => {
    const brief = (text: string): EntryInput => ({ kind: 'brief', party: 'agent:a1', text, spawnedBy: 'main', at: 1 });
    expect(factsFor(build(brief('first brief'), brief('second brief')), 'agent:a1', none).brief?.text).toBe('second brief');
  });

  it('leaves out a notice, a received message and a skill whose text the kept tail holds', () => {
    const ledger = build(
      { kind: 'notice', party: 'main', origin: 'task-notification', text: 'bg done', at: 1 },
      { kind: 'received', party: 'main', origin: 'coordinator', text: 'peer says hi', at: 2 },
      skill('main', 'alpha', 'alpha body'),
    );
    const kept = factsFor(ledger, 'main', { keptTexts: ['x bg done x', 'peer says hi', '<skill>alpha body</skill>'] });
    expect([kept.notices, kept.received, kept.skills]).toEqual([[], [], []]);
    const fresh = factsFor(ledger, 'main', { keptTexts: ['unrelated'] });
    expect([fresh.notices.length, fresh.received.length, fresh.skills.length]).toEqual([1, 1, 1]);
  });

  it('keeps the latest text per skill name for the party, newest first', () => {
    const ledger = build(
      skill('main', 'alpha', 'alpha v1'), skill('main', 'beta', 'beta v1'), skill('main', 'alpha', 'alpha v2'),
      skill('agent:a1', 'gamma', 'gamma for a1'),
    );
    expect(factsFor(ledger, 'main', none).skills.map((s) => s.text)).toEqual(['alpha v2', 'beta v1']);
    expect(factsFor(ledger, 'agent:a1', none).skills.map((s) => s.skill)).toEqual(['gamma']);
  });

  it('names unattributed skills for every party, without a skill the party carries itself', () => {
    const ledger = build(
      skill('unknown', 'mystery', 'mystery text'), skill('unknown', 'mystery', 'mystery again'),
      skill('unknown', 'alpha', 'alpha unknown'), skill('main', 'alpha', 'alpha main'),
    );
    for (const party of ['main', 'agent:a1'] as const) {
      const names = factsFor(ledger, party, none).unattributedSkills.map((s) => s.skill);
      expect(names).toContain('mystery');
      expect(names.filter((n) => n === 'mystery')).toHaveLength(1);
    }
    expect(factsFor(ledger, 'main', none).unattributedSkills.map((s) => s.skill)).not.toContain('alpha');
    expect(factsFor(ledger, 'agent:a1', none).unattributedSkills.map((s) => s.skill)).toContain('alpha');
    expect(factsFor(ledger, 'main', none).skills.map((s) => s.skill)).not.toContain('mystery');
  });

  it('has no shells before any Stop event', () => {
    expect(factsFor(build(person('a')), 'main', none).shells).toBeUndefined();
  });
});

describe('resolveSpawn', () => {
  it('moves a preloaded skill from its spawn to the child agent once the spawn returns', () => {
    const ledger = build(
      skill('spawn:toolu_9', 'replay-rules', 'rules'), skill('spawn:toolu_8', 'other', 'o'), skill('main', 'm', 'm'),
    );
    const resolved = resolveSpawn(ledger, 'toolu_9', 'a1');
    expect(factsFor(resolved, 'agent:a1', none).skills.map((s) => s.skill)).toEqual(['replay-rules']);
    expect(skillParty(resolved, 'other')).toBe('spawn:toolu_8');
    expect(factsFor(resolved, 'main', none).skills.map((s) => s.skill)).toEqual(['m']);
    expect(skillParty(ledger, 'replay-rules')).toBe('spawn:toolu_9');
  });
});

describe('shellsOf', () => {
  it("reads a Stop event's tasks and crons, and a field that is no list as none", () => {
    expect(shellsOf({ background_tasks: [{ id: 1, type: 'local_bash', status: 'running', command: 'sleep 1' }], session_crons: [{ id: 'c1', schedule: '* * * * *', recurring: true }] })).toEqual({
      tasks: [{ id: '1', type: 'local_bash', status: 'running', description: '', command: 'sleep 1' }],
      crons: [{ id: 'c1', schedule: '* * * * *', recurring: true, prompt: '' }],
    });
    expect(shellsOf({ background_tasks: 'x' })).toEqual({ tasks: [], crons: [] });
  });
});

describe('the prompts kept across a plugin reload', () => {
  const said = (n: number) => Array.from({ length: n }, (_, i) => i).reduce((l, i) => addEntry(l, { kind: 'person', party: 'main', at: i, text: `m${i}`, ...(i === 0 ? { command: 'god-speed' } : {}) }), newLedger());
  const agent = (n: number) => Array.from({ length: n }, (_, i) => i).reduce(
    (l, i) => addEntry(l, { kind: 'received', party: 'agent:a1', at: 100 + i, origin: 'coordinator', text: `r${i}` }),
    addEntry(newLedger(), { kind: 'brief', party: 'agent:a1', at: 1, text: 'the brief', subagentType: 'general-purpose', spawnedBy: 'main' }),
  );

  it("keeps main's newest ten messages, oldest first, with their command", () => {
    expect(PROMPTS_KEPT).toBe(10);
    expect(promptsKept(said(12), 'main').map((p) => p.text)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11']);
    expect(promptsKept(said(1), 'main')).toEqual([{ kind: 'person', at: 0, text: 'm0', command: 'god-speed' }]);
  });

  it("keeps a sub-agent's brief and its coordinator's newest ten, and no other party's", () => {
    const kept = promptsKept(agent(12), 'agent:a1');
    expect(kept.map((p) => p.text)).toEqual(['the brief', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11']);
    expect(kept[0]).toEqual({ kind: 'brief', at: 1, text: 'the brief', subagentType: 'general-purpose', spawnedBy: 'main' });
    expect(promptsKept(agent(2), 'main')).toEqual([]);
  });

  it('puts them back ahead of what was recorded since, each once, leaving out anything else', () => {
    const since = addEntry(newLedger(), { kind: 'person', party: 'main', at: 50, text: 'after the reload' });
    const back = restorePrompts(since, 'main', [{ kind: 'person', at: 1, text: 'a', command: 'x' }, { kind: 'person', at: 'no', text: 'b' }, null, { kind: 'received', at: 2, text: 'not main' }, { kind: 'person', at: 50, text: 'after the reload' }]);
    expect(back.entries.map((e) => (e as { text: string }).text)).toEqual(['a', 'after the reload']);
    expect(factsFor(back, 'main', { keptTexts: [] }).person.map((p) => p.text)).toEqual(['a', 'after the reload']);
  });

  it("puts a sub-agent's brief back only when it has none, and its coordinator's messages under it", () => {
    const back = restorePrompts(newLedger(), 'agent:a1', promptsKept(agent(2), 'agent:a1'));
    const facts = factsFor(back, 'agent:a1', { keptTexts: [] });
    expect(facts.brief?.text).toBe('the brief');
    expect(facts.received.map((r) => [r.text, r.origin])).toEqual([['r0', 'coordinator'], ['r1', 'coordinator']]);
    const own = addEntry(newLedger(), { kind: 'brief', party: 'agent:a1', at: 5, text: 'its own brief', spawnedBy: 'main' });
    expect(restorePrompts(own, 'agent:a1', [{ kind: 'brief', at: 1, text: 'the brief' }])).toBe(own);
  });

  it('leaves the ledger as it is for a value that is not a list', () => {
    const own = said(2);
    expect(restorePrompts(own, 'main', undefined)).toBe(own);
    expect(restorePrompts(own, 'main', { at: 1 })).toBe(own);
  });
});

describe('the skills kept across a plugin reload', () => {
  const loaded = [['a', 'A1'], ['b', 'B1'], ['a', 'A2']].reduce((l, [skill, text], i) => addEntry(l, { kind: 'skill', party: 'main', at: i, skill: skill!, text: text!, how: 'skill-tool' }), newLedger());

  it('keeps the latest text of each skill a party loaded, oldest first, and no other party\'s', () => {
    expect(skillsKept(loaded, 'main').map((s) => [s.skill, s.text])).toEqual([['b', 'B1'], ['a', 'A2']]);
    expect(skillsKept(loaded, 'agent:a1')).toEqual([]);
  });

  it('puts back only the skills the party has not loaded since, leaving out anything else', () => {
    const since = addEntry(newLedger(), { kind: 'skill', party: 'main', at: 9, skill: 'a', text: 'A3', how: 'typed-command' });
    const back = restoreSkills(since, 'main', [...skillsKept(loaded, 'main'), { skill: 'x' }, null]);
    expect(factsFor(back, 'main', { keptTexts: [] }).skills.map((s) => [s.skill, s.text])).toEqual([['a', 'A3'], ['b', 'B1']]);
    expect(restoreSkills(since, 'main', undefined)).toBe(since);
  });
});
