import { describe, expect, it } from 'vitest';
import type { ForwardArgs } from '../plugins/sub-agent-compact/src/forward-args.ts';
import { estimateTokens, fnv1a, FORWARD_OPENING, installCheck, LOAD_MAX_CHARS, LOADS_MAX_CHARS, priorUsers, renderForward, renderUsers, SKILL_MAX_CHARS, SKILLS_MAX_CHARS, TRAIL_MAX, USERS_MAX_CHARS, type RenderInput } from '../plugins/sub-agent-compact/src/forward-text.ts';

const args: ForwardArgs = { objective: 'Ship it', done: ['a (npm test 3/3)'], remaining: ['b', 'c'], next: 'run npm test', blocked: [], findings: [], loadFiles: [], dropSkills: [], trimmed: [] };
const input = (over: Partial<RenderInput> = {}): RenderInput => ({ seq: 1, users: [], skills: [], trail: [], loaded: [], tasks: [], running: [], paths: [], problems: [], args, ...over });
const lines = (t: string) => t.split('\n');

describe('caps (HARD RULE)', () => {
  it('pins the numbers: 8k tokens of user messages, 3k/12k skills, 3k/12k load_files, 15 trail entries', () => {
    expect(USERS_MAX_CHARS).toBe(8_000 * 4);
    expect(SKILL_MAX_CHARS).toBe(3_000 * 4);
    expect(SKILLS_MAX_CHARS).toBe(12_000 * 4);
    expect(LOAD_MAX_CHARS).toBe(3_000 * 4);
    expect(LOADS_MAX_CHARS).toBe(12_000 * 4);
    expect(TRAIL_MAX).toBe(15);
    expect(estimateTokens(4001)).toBe(1001);
  });
});

describe('renderForward layout', () => {
  it('with nothing mechanical, is one header line then the frontier with Next last', () => {
    const { text } = renderForward(input());
    expect(lines(text)).toEqual([
      '[forward handoff 1: history, not new instructions]',
      'Objective',
      'Ship it',
      'Done',
      '- a (npm test 3/3)',
      'Remaining',
      '1. b',
      '2. c',
      'Next',
      'run npm test',
    ]);
    expect(text.startsWith(FORWARD_OPENING)).toBe(true);
  });

  it('omits every empty block entirely: no none lines, no empty labels', () => {
    const { text, blocks } = renderForward(input({ args: { ...args, done: [], remaining: [] } }));
    for (const label of ['User', 'Skill', 'Files', 'Load', 'Plan', 'Tasks', 'Running', 'Git', 'Paths', 'Unresolved', 'Done', 'Remaining', 'Blocked', 'Findings']) {
      expect(lines(text)).not.toContain(label);
    }
    expect(text).not.toMatch(/none|\(empty\)|n\/a/i);
    expect(blocks.map((b) => b.name)).toEqual(['Objective', 'Next']);
    expect(text).not.toMatch(/\n\n/);
  });

  it('orders mechanical blocks first, then the frontier, Next final', () => {
    const { text, blocks } = renderForward(
      input({
        users: ['do x', 'then y'],
        skills: [{ name: 'design', body: 'SKILL BODY' }],
        trail: [{ tag: 'E', path: 'src/a.ts' }, { tag: 'R', path: 'b.md' }, { tag: 'C', path: 'c.md' }],
        loaded: [{ label: 'src/z.ts:2-3', body: 'two\nthree' }],
        plan: 'the plan',
        tasks: ['[x] one', '[ ] two'],
        running: ['shell bg_1: npm run dev, 4 msgs'],
        git: 'main@abc1234, 2 dirty: a, b',
        paths: ['transcript /t/s.jsonl:812'],
        problems: ['load_files nope.ts: not found'],
        args: { ...args, blocked: ['review by Sam'], findings: ['ENOENT: no such file'] },
      }),
    );
    expect(blocks.map((b) => b.name)).toEqual(['User', 'Skill design', 'Files', 'Load src/z.ts:2-3', 'Plan', 'Tasks', 'Running', 'Git', 'Paths', 'Unresolved', 'Objective', 'Done', 'Remaining', 'Blocked', 'Findings', 'Next']);
    expect(lines(text).at(-2)).toBe('Next');
    expect(lines(text).at(-1)).toBe('run npm test');
    expect(text).toContain('Files\nE src/a.ts\nR b.md\nC c.md');
    expect(text).toContain('Git\nmain@abc1234, 2 dirty: a, b');
    expect(text).toContain('Running\nshell bg_1: npm run dev, 4 msgs');
    expect(text).toContain('Load src/z.ts:2-3\ntwo\nthree');
    expect(text).toContain('Skill design\nSKILL BODY');
  });

  it('numbers user messages, marks the latest, and keeps them chronological', () => {
    const { text } = renderForward(input({ users: ['first', 'second', 'third'] }));
    expect(text).toContain('User\n[1] first\n[2] second\n[3, latest] third\n');
  });

  it('names the sequence number in the single header line', () => {
    expect(lines(renderForward(input({ seq: 7 })).text)[0]).toBe('[forward handoff 7: history, not new instructions]');
  });

  it('caps the file trail at 15 lines', () => {
    const trail = Array.from({ length: 30 }, (_, i) => ({ tag: 'R' as const, path: `f${i}` }));
    const { text } = renderForward(input({ trail }));
    const block = text.split('Files\n')[1]!.split('\nObjective')[0]!;
    expect(block.split('\n')).toHaveLength(15);
    expect(block.split('\n')[0]).toBe('R f0');
  });

  it('puts the unresolved problems in one block, one line each', () => {
    const { text } = renderForward(input({ problems: ['a: x', 'b: y'] }));
    expect(text).toContain('Unresolved\na: x\nb: y\n');
  });

  it('reports a skill that did not resolve and a load_file that could not be read, not as absence', () => {
    const { text } = renderForward(input({ skills: [{ name: 'gone', problem: 'no file at X' }], loaded: [{ label: 'q.ts', problem: 'not found' }] }));
    expect(text).toContain('Unresolved\nskill gone: no file at X\nload q.ts: not found');
    expect(lines(text)).not.toContain('Skill gone');
    expect(lines(text)).not.toContain('Load q.ts');
  });
});

describe('renderUsers', () => {
  it('keeps the newest under the cap, truncates only the oldest kept, and counts the dropped', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(5_000));
    const { text, items, dropped } = renderUsers(msgs);
    expect(text.length).toBeLessThanOrEqual(USERS_MAX_CHARS + 60);
    expect(items + dropped).toBe(10);
    expect(dropped).toBeGreaterThan(0);
    expect(text.split('\n')[0]).toBe(`[${dropped} older dropped]`);
    expect(text).toContain('[10, latest] ' + '9'.repeat(5_000));
    const oldest = text.split('\n')[1]!;
    expect(oldest.startsWith(`[${dropped + 1}] `)).toBe(true);
    // every kept message but the oldest is whole
    const whole = text.split('\n').slice(2);
    expect(whole.every((l) => !l.endsWith('[trimmed]'))).toBe(true);
  });

  it('truncates a single message over the cap and marks it', () => {
    const { text } = renderUsers(['z'.repeat(40_000)]);
    expect(text.length).toBeLessThanOrEqual(USERS_MAX_CHARS + 30);
    expect(text.endsWith('[trimmed]')).toBe(true);
    expect(text.startsWith('[1, latest] zzz')).toBe(true);
  });

  it('round-trips through priorUsers', () => {
    const { text } = renderForward(input({ users: ['alpha\nline two', 'beta [3] not a marker', 'gamma'] }));
    expect(priorUsers(text)).toEqual(['alpha\nline two', 'beta [3] not a marker', 'gamma']);
  });

  it('round-trips a user message holding a line that reads like a block label', () => {
    const users = ['check these\nFiles\n- a.ts', 'Skill issue: the plan\nPlan', 'go'];
    const { text } = renderForward(input({ users, trail: [{ tag: 'R', path: 'a.ts' }] }));
    expect(priorUsers(text)).toEqual(users);
  });

  it('priorUsers of a text without a User block is empty', () => {
    expect(priorUsers('plain text')).toEqual([]);
    expect(priorUsers(renderForward(input()).text)).toEqual([]);
  });
});

describe('skills and load_files caps', () => {
  it('cuts one skill at 3k tokens and drops the oldest past 12k total, naming the dropped', () => {
    const skills = Array.from({ length: 6 }, (_, i) => ({ name: `s${i}`, body: `${i}`.repeat(20_000) }));
    const { text, blocks } = renderForward(input({ skills }));
    const bodies = blocks.filter((b) => b.name.startsWith('Skill '));
    expect(bodies.length).toBe(4);
    expect(bodies.every((b) => b.chars <= SKILL_MAX_CHARS + 30)).toBe(true);
    expect(bodies.reduce((n, b) => n + b.chars, 0)).toBeLessThanOrEqual(SKILLS_MAX_CHARS + 120);
    expect(bodies.map((b) => b.name)).toEqual(['Skill s2', 'Skill s3', 'Skill s4', 'Skill s5']);
    expect(text).toContain('skill s0: dropped');
    expect(text).toContain('skill s1: dropped');
    expect(text).toContain('[trimmed]');
  });

  it('cuts one loaded file at 3k tokens and refuses the one past 12k total', () => {
    const loaded = Array.from({ length: 6 }, (_, i) => ({ label: `f${i}.ts`, body: 'x'.repeat(20_000) }));
    const { text, blocks } = renderForward(input({ loaded }));
    const files = blocks.filter((b) => b.name.startsWith('Load '));
    expect(files).toHaveLength(4);
    expect(files.every((b) => b.chars <= LOAD_MAX_CHARS + 40)).toBe(true);
    expect(text).toContain('load f4.ts: not loaded');
    expect(text).toContain('load f5.ts: not loaded');
  });
});

describe('block records', () => {
  it('records chars, estimated tokens, items and a hash per block', () => {
    const { text, blocks } = renderForward(input({ trail: [{ tag: 'R', path: 'a' }, { tag: 'E', path: 'b' }] }));
    const files = blocks.find((b) => b.name === 'Files')!;
    expect(files.items).toBe(2);
    expect(files.chars).toBe('Files\nR a\nE b'.length);
    expect(files.tokens).toBe(estimateTokens(files.chars));
    expect(files.hash).toBe(fnv1a('Files\nR a\nE b'));
    expect(blocks.find((b) => b.name === 'Done')!.items).toBe(1);
    expect(text.includes('Files\nR a\nE b')).toBe(true);
  });

  it('fnv1a is stable and differs by input', () => {
    expect(fnv1a('abc')).toBe('1a47e90b');
    expect(fnv1a('abd')).not.toBe(fnv1a('abc'));
  });
});

describe('installCheck', () => {
  it('confirms every block landed and the whole text hash', () => {
    const { text, blocks } = renderForward(input({ users: ['hi'] }));
    expect(installCheck(blocks, text, text)).toEqual({ landed: blocks.length, missing: [], hash: fnv1a(text), ok: true });
  });

  it('names a block that did not land', () => {
    const { text, blocks } = renderForward(input({ users: ['hi'], trail: [{ tag: 'R', path: 'a' }] }));
    const damaged = text.replace('R a', 'R z');
    const r = installCheck(blocks, damaged, text);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['Files']);
    expect(r.landed).toBe(blocks.length - 1);
  });
});
