import { describe, expect, it } from 'vitest';
import { FORWARD_INPUT_SCHEMA, FORWARD_LIMITS, FORWARD_TOOL, FORWARD_TOOL_DESCRIPTION, askedToCompact, forwardCallShape, forwardNudgeText, forwardRefusal, forwardStoredText, parseForwardArgs, rereadNudge, TRIMMED } from '../plugins/sub-agent-compact/src/forward-args.ts';

const ok = { objective: 'Ship the thing', done: ['a: tests green'], remaining: ['b', 'c'], next: 'run the tests' };
const parse = (input: Record<string, unknown>) => {
  const r = parseForwardArgs(input);
  if ('nudge' in r) throw new Error(`nudged: ${r.nudge}`);
  return r.args;
};

describe('parseForwardArgs', () => {
  it('names the tool forward_handoff', () => expect(FORWARD_TOOL).toBe('forward_handoff'));

  it('takes the required fields as they are', () => {
    const a = parse(ok);
    expect(a).toMatchObject({ objective: 'Ship the thing', done: ['a: tests green'], remaining: ['b', 'c'], next: 'run the tests', blocked: [], findings: [], loadFiles: [], dropSkills: [], trimmed: [] });
  });

  it('returns one nudge naming every missing required field and never refuses for anything else', () => {
    const r = parseForwardArgs({ done: [], remaining: [] });
    expect('nudge' in r && r.nudge).toContain('objective');
    expect('nudge' in r && r.nudge).toContain('next');
    expect('nudge' in r && r.nudge).toMatch(/^Not stored: required fields missing: objective, next\./);
    expect('nudge' in parseForwardArgs({ ...ok, objective: '   ' })).toBe(true);
    expect('nudge' in parseForwardArgs({ ...ok, done: undefined })).toBe(true);
    expect('nudge' in parseForwardArgs({ ...ok, next: 42 })).toBe(true);
  });

  it('accepts empty lists and unknown keys', () => {
    expect('args' in parseForwardArgs({ ...ok, done: [], remaining: [], mystery: 1 })).toBe(true);
  });

  it('trims an over-limit string to its cap and marks it', () => {
    const a = parse({ ...ok, objective: 'o'.repeat(900), next: 'n'.repeat(900) });
    expect(a.objective.length).toBeLessThanOrEqual(FORWARD_LIMITS.objective);
    expect(a.objective.endsWith(TRIMMED)).toBe(true);
    expect(a.next.length).toBeLessThanOrEqual(FORWARD_LIMITS.next);
    expect(a.next.endsWith(TRIMMED)).toBe(true);
    expect(a.trimmed).toEqual(['objective', 'next']);
  });

  it('holds the caps the requirements fix', () => {
    expect(FORWARD_LIMITS).toMatchObject({ objective: 600, doneItems: 15, doneChars: 200, remainingItems: 15, next: 400, blockedItems: 10, findingsItems: 15, findingsChars: 300, loadFiles: 8 });
  });

  it('caps a list field by its total budget, never an item by itself: a long item stays whole while the field fits', () => {
    const one = 'x'.repeat(621);
    const a = parse({ ...ok, done: one, findings: ['f'.repeat(800)] });
    expect(a.done).toEqual([one]);
    expect(a.findings).toEqual(['f'.repeat(800)]);
    expect(a.trimmed).toEqual([]);
  });

  it('cuts a list once, where it crosses its budget (items x chars) or its item count, and marks it', () => {
    const a = parse({
      ...ok,
      done: Array.from({ length: 20 }, (_, i) => `item ${i} ${'x'.repeat(300)}`),
      findings: Array.from({ length: 18 }, (_, i) => `f${i}`),
      blocked: Array.from({ length: 12 }, (_, i) => `b${i}`),
    });
    const budget = FORWARD_LIMITS.doneItems * FORWARD_LIMITS.doneChars;
    expect(a.done.join('').length).toBeLessThanOrEqual(budget);
    expect(a.done.join('').length).toBeGreaterThan(budget - 400);
    expect(a.done.at(-1)!.endsWith(TRIMMED)).toBe(true);
    expect(a.done.slice(0, -1).every((d) => !d.endsWith(TRIMMED))).toBe(true);
    expect(a.findings).toHaveLength(15);
    expect(a.findings[14]).toBe(`f14 ${TRIMMED}`);
    expect(a.blocked).toHaveLength(10);
    expect(a.blocked[9]).toBe(`b9 ${TRIMMED}`);
    expect(a.trimmed).toEqual(['done', 'blocked', 'findings']);
  });

  it('carries the text of an unknown field into findings under its name, never dropping it', () => {
    const a = parse({ ...ok, findings: ['known'], context: 'Key facts: X at a.go:3', mystery: 1 });
    expect(a.findings).toEqual(['known', 'context: Key facts: X at a.go:3']);
  });

  it('reads a newline-separated string as a list and drops blank items', () => {
    const a = parse({ ...ok, done: '- one\n\n- two', remaining: ['x', '', 5] });
    expect(a.done).toEqual(['one', 'two']);
    expect(a.remaining).toEqual(['x', '5']);
  });

  it('reports a load_files that is not a list and an item without a path, never dropping them silently', () => {
    expect(parse({ ...ok, load_files: 'src/z.ts' }).problems).toEqual(['load_files: not a list of {path, lines?, why}']);
    const a = parse({ ...ok, load_files: [{ why: 'x' }, 'a.ts', { path: 'b.ts', why: 'y' }] });
    expect(a.problems).toEqual(['load_files item 1: no path', 'load_files item 2: no path']);
    expect(a.loadFiles).toEqual([{ path: 'b.ts', why: 'y' }]);
    expect(parse(ok).problems).toBeUndefined();
  });

  it('normalizes load_files: at most 8, a path and why each, lines as text', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, lines: i === 0 ? '10-20' : i === 1 ? 7 : undefined, why: 'because' }));
    const a = parse({ ...ok, load_files: [...files, { why: 'no path' }, 'junk'] });
    expect(a.loadFiles).toHaveLength(8);
    expect(a.loadFiles[0]).toEqual({ path: 'f0.ts', lines: '10-20', why: 'because' });
    expect(a.loadFiles[1]).toEqual({ path: 'f1.ts', lines: '7', why: 'because' });
    expect(a.loadFiles[2]).toEqual({ path: 'f2.ts', why: 'because' });
    expect(a.trimmed).toContain('load_files');
  });

  it('keeps drop_skills as bare names, deduped', () => {
    expect(parse({ ...ok, drop_skills: ['/design', 'design', 'x:y', ' '] }).dropSkills).toEqual(['design', 'x:y']);
  });
});

describe('tool text', () => {
  it('describes the tool in its own terms: the latest explicit request, verified done, verbatim errors', () => {
    expect(FORWARD_TOOL_DESCRIPTION).toMatch(/latest explicit request/);
    expect(FORWARD_TOOL_DESCRIPTION).toMatch(/verified/);
    expect(FORWARD_TOOL_DESCRIPTION).toMatch(/verbatim/);
    expect(FORWARD_TOOL_DESCRIPTION).toMatch(/unconfirmed/);
    expect(FORWARD_TOOL_DESCRIPTION).toMatch(/mid-edit/);
    expect(FORWARD_TOOL_DESCRIPTION.length).toBeLessThanOrEqual(600);
  });

  it('schema requires objective, done, remaining and next', () => {
    const s = FORWARD_INPUT_SCHEMA as { required: string[]; properties: Record<string, unknown> };
    expect(s.required).toEqual(['objective', 'done', 'remaining', 'next']);
    expect(Object.keys(s.properties)).toEqual(['objective', 'done', 'remaining', 'next', 'blocked', 'findings', 'load_files', 'drop_skills']);
  });

  it('nudge names the tool and the size', () => {
    const t = forwardNudgeText({ tokens: 120_000, level: 0, autoCompact: 360_000, toolName: 'mcp__sub-agent-compact__forward_handoff' });
    expect(t).toContain('mcp__sub-agent-compact__forward_handoff');
    expect(t).toContain('120k');
  });

  it('stored reply says the size, the saved directory, and to end the turn', () => {
    const t = forwardStoredText({ tokens: 9000, dir: '/c/x/1', blocks: [{ name: 'User', tokens: 4000 }, { name: 'Files', tokens: 100 }] });
    expect(t).toContain('9k');
    expect(t).toContain('/c/x/1');
    expect(t).toContain('User 4k');
    expect(t).toMatch(/end your turn/i);
  });
});

describe('forwardRefusal', () => {
  it('refuses only a party that woke from a forward handoff and is still below its first nudge point', () => {
    expect(forwardRefusal({ woke: true, tokens: 30_000, nudgeStart: 40_000 })).toMatch(/^Not stored: you woke from a forward handoff.*30k.*40k.*Next/);
    expect(forwardRefusal({ woke: true, tokens: 39_600, nudgeStart: 40_000 })).toContain('your context is 39k, below 40k');
    expect(forwardRefusal({ woke: true, tokens: 40_000, nudgeStart: 40_000 })).toBeUndefined();
    expect(forwardRefusal({ woke: false, tokens: 1_000, nudgeStart: 40_000 })).toBeUndefined();
    expect(forwardRefusal({ woke: true, tokens: undefined, nudgeStart: 40_000 })).toBeUndefined();
  });
});

describe('rereadNudge', () => {
  const loads = [{ path: '/f/tracer-loom/plan.md', why: 'design' }, { path: '/r/src/levels.ts', lines: '1-20', why: 'x' }];
  it('sends back a next that opens by reading a file the wake already loads, naming it', () => {
    expect(rereadNudge('Read plan.md, run git status, then write the tests', loads)).toBe(
      'Not stored: `next` opens by reading /f/tracer-loom/plan.md, which load_files already puts in the wake. Make `next` the first action after that read, and call forward_handoff again with the same fields.',
    );
    expect(rereadNudge('Re-read /r/src/levels.ts and gate.ts; then fix clamp', loads)).toContain('/r/src/levels.ts, which load_files');
  });
  it('sends back a next that opens by checking git, which the wake carries in its Git block', () => {
    expect(rereadNudge('Run `git -C /w status`, then grep the doors', [])).toBe(
      'Not stored: `next` opens by checking git status, which the wake already carries in its Git block. Make `next` the first action after that check, and call forward_handoff again with the same fields.',
    );
    expect(rereadNudge('Check the git state and write run.md', [])).toContain('checking git status');
  });
  it('lets through a next whose first action is the work, or a read of a file not loaded', () => {
    expect(rereadNudge('Grep the doors, then read plan.md', loads)).toBeUndefined();
    expect(rereadNudge('Read design.md and tests/adapter.test.ts, then write the adapter', loads)).toBeUndefined();
    expect(rereadNudge('Write GOAL/DECIDE to run.md; commit after git status is clean', loads)).toBeUndefined();
  });
});

const TOOL = 'mcp__sub-agent-compact__forward_handoff';

describe('what a trim reports', () => {
  it('records a string field cut, with its characters before and after', () => {
    const a = parse({ ...ok, objective: 'o'.repeat(804) });
    expect(a.cuts).toEqual([{ field: 'objective', unit: 'characters', before: 804, after: a.objective.length }]);
    expect(a.objective.length).toBeLessThanOrEqual(600);
  });

  it("records a list cut with its items and characters before and after, in the tool's field order", () => {
    const items = Array.from({ length: 20 }, (_, i) => `item ${i} ${'x'.repeat(300)}`);
    const a = parse({ ...ok, findings: Array.from({ length: 18 }, (_, i) => `f${i}`), done: items });
    const total = items.join('').length;
    expect(a.cuts?.map((c) => c.field)).toEqual(['done', 'findings']);
    expect(a.cuts![0]).toEqual({ field: 'done', unit: 'characters', before: total, after: a.done.join('').length, itemsBefore: 20, itemsAfter: a.done.length });
    // Characters after are what the field kept, never the marks: 15 full items fill the 3000 limit the reply asks to stay within.
    const full = parse({ ...ok, done: Array.from({ length: 20 }, () => 'x'.repeat(200)) });
    expect(full.cuts![0]).toEqual({ field: 'done', unit: 'characters', before: 4000, after: 3000, itemsBefore: 20, itemsAfter: 15 });
    expect(a.cuts![1]).toMatchObject({ field: 'findings', itemsBefore: 18, itemsAfter: 15 });
    expect(a.trimmed).toEqual(['done', 'findings']);
  });

  it('records a load_files list cut in items, and a why cut in characters', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, why: i === 0 ? 'w'.repeat(250) : 'ok' }));
    const a = parse({ ...ok, load_files: files });
    expect(a.cuts).toEqual([{ field: 'load_files why (f0.ts)', unit: 'characters', before: 250, after: a.loadFiles[0]!.why.length }, { field: 'load_files', unit: 'items', before: 10, after: 8 }]);
  });

  it('reports no cut for a field that fits', () => {
    expect(parse(ok).cuts).toBeUndefined();
  });
});

describe('a list that arrives as a string', () => {
  it('reads a JSON array text, newline items and bullets, and says how many items each became', () => {
    expect(parse({ ...ok, done: '["a","b"]' })).toMatchObject({ done: ['a', 'b'], converted: [{ field: 'done', items: 2 }] });
    const a = parse({ ...ok, done: '- one\n- two\n- three', remaining: 'only one' });
    expect(a.done).toEqual(['one', 'two', 'three']);
    expect(a.converted).toEqual([{ field: 'done', items: 3 }, { field: 'remaining', items: 1 }]);
  });

  it('splits a single line with inline numbering into its items', () => {
    const a = parse({ ...ok, remaining: '1) edit a.ts 2) run npm test 3) commit' });
    expect(a.remaining).toEqual(['edit a.ts', 'run npm test', 'commit']);
    expect(a.converted).toEqual([{ field: 'remaining', items: 3 }]);
    expect(parse({ ...ok, remaining: '1. first. 2. second' }).remaining).toEqual(['first.', 'second']);
    expect(parse({ ...ok, done: '1) a: green\n2) b: green' }).done).toEqual(['a: green', 'b: green']);
  });

  it('keeps a single item whose text only mentions a number, or numbers out of order, and a real array as it is', () => {
    expect(parse({ ...ok, remaining: 'bump to 2) not a list' }).remaining).toEqual(['bump to 2) not a list']);
    expect(parse({ ...ok, remaining: 'see 2) and 1) here' }).remaining).toEqual(['see 2) and 1) here']);
    expect(parse(ok).converted).toBeUndefined();
  });

  it('counts a findings or drop_skills string once', () => {
    const a = parse({ ...ok, findings: 'x\ny', drop_skills: '/design' });
    expect(a.findings).toEqual(['x', 'y']);
    expect(a.dropSkills).toEqual(['design']);
    expect(a.converted).toEqual([{ field: 'findings', items: 2 }, { field: 'drop_skills', items: 1 }]);
  });
});

describe('the call shape', () => {
  it('states every field with its type, lists as arrays of strings, and the limits', () => {
    const shape = forwardCallShape(TOOL);
    expect(shape).toBe(
      `Call ${TOOL} with an object: objective (string, at most 600 characters), done (array of strings, at most 15 items, 3000 characters in all), remaining (array of strings, at most 15 items, 3000 characters in all), next (string, at most 400 characters); ` +
        'optional: blocked (array of strings, at most 10 items, 2000 characters in all), findings (array of strings, at most 15 items, 4500 characters in all), load_files (array of {path, lines?, why} objects, at most 8, why at most 200 characters), drop_skills (array of strings). ' +
        'A field over its limit is trimmed, never refused.',
    );
  });

  it('is in the nudge toward the tool and in the reply to a missing field, which names each field of the wrong type', () => {
    expect(forwardNudgeText({ tokens: 120_000, level: 0, autoCompact: 360_000, toolName: TOOL }).endsWith(forwardCallShape(TOOL))).toBe(true);
    const r = parseForwardArgs({ ...ok, done: 7, next: undefined, objective: '  ' }, TOOL);
    expect('nudge' in r && r.nudge).toBe(`Not stored: required fields missing: objective, done, next. objective: got a blank string, expects a string. done: got a number, expects an array of strings. ${forwardCallShape(TOOL)}`);
    const one = parseForwardArgs({ ...ok, remaining: { a: 1 } }, TOOL);
    expect('nudge' in one && one.nudge).toMatch(/^Not stored: required field missing: remaining\. remaining: got an object, expects an array of strings\. Call mcp__/);
  });
});

describe('the stored reply', () => {
  const cuts = [
    { field: 'objective', unit: 'characters' as const, before: 804, after: 600 },
    { field: 'done', unit: 'characters' as const, before: 5000, after: 2900, itemsBefore: 20, itemsAfter: 15 },
    { field: 'remaining', unit: 'characters' as const, before: 3300, after: 2990, itemsBefore: 12, itemsAfter: 12 },
    { field: 'load_files', unit: 'items' as const, before: 10, after: 8 },
  ];
  const blocks = [{ name: 'User', tokens: 4000 }];

  it('names every trimmed field with its size before and after, where the uncut text is, how to keep it, and that a call again replaces this one', () => {
    expect(forwardStoredText({ tokens: 9000, dir: '/c/x/1', blocks, cuts, toolName: TOOL })).toBe(
      'Forward handoff stored (9k tokens: User 4k). Cut to fit: objective 804 -> 600 characters; done 20 -> 15 items, 5000 -> 2900 characters; remaining 3300 -> 2990 characters; load_files 10 -> 8 items. ' +
        `The wake holds what fit, each cut text ending in ${TRIMMED}; the uncut arguments are in /c/x/1/args.json. To keep what was cut, send those fields again within their limits, longer detail in a file named in load_files. ` +
        `Calling ${TOOL} again in this turn replaces this call. Saved to /c/x/1. It installs when this turn ends: end your turn now with one line to the person; do not call any other tool.`,
    );
    expect(forwardStoredText({ tokens: 9000, blocks, cuts })).not.toContain('args.json');
  });

  it('says what was converted and into how many items, and each entry that was not loaded and why', () => {
    const t = forwardStoredText({ tokens: 9000, dir: '/c/x/1', blocks, converted: [{ field: 'done', items: 3 }, { field: 'remaining', items: 1 }], unloaded: ['load /w/nope.ts: not found', 'skill gone: no file'], toolName: TOOL });
    expect(t).toContain(' done was a string, read as 3 items; remaining was a string, read as 1 item: send lists as arrays of strings. ');
    expect(t).toContain(` Not in the wake: load /w/nope.ts: not found; skill gone: no file. Calling ${TOOL} again in this turn replaces this call. Saved to /c/x/1. It installs`);
  });

  it('is the plain reply when nothing was cut, converted or left out', () => {
    expect(forwardStoredText({ tokens: 9000, dir: '/c/x/1', blocks })).toBe('Forward handoff stored (9k tokens: User 4k). Saved to /c/x/1. It installs when this turn ends: end your turn now with one line to the person; do not call more tools.');
    expect(forwardStoredText({ tokens: 9000, dir: '/c/x/1', blocks, converted: [{ field: 'done', items: 2 }] })).toMatch(/do not call more tools\.$/);
  });
});

describe('the early refusal and the person who asks', () => {
  it('says the person can still get a handoff or a compaction', () => {
    expect(forwardRefusal({ woke: true, tokens: 30_000, nudgeStart: 40_000 })).toContain('A handoff the person asks for is stored: a message of theirs after this wake that asks to compact or hand off lets the call through, and their /compact compacts at once.');
  });

  it.each([
    [['When it was back compact and standby'], true],
    [['please compact now'], true],
    [['run /compact'], true],
    [['hand off and continue'], true],
    [['do a handoff'], true],
    [['time for a hand-off'], true],
    [['call forward_handoff'], true],
    [['the tests pass, compaction is fine now'], true],
    [['first thing', 'then compact'], true],
    [["don't compact yet"], false],
    [['do not hand off, keep going'], false],
    [['fix the sub-agent-compact plugin'], false],
    [['auto-compact handles it'], false],
    [['continue'], false],
    [[], false],
  ])('reads %j as an ask: %s', (prompts, asked) => {
    expect(askedToCompact(prompts)).toBe(asked);
  });
});
