import { describe, expect, it } from 'vitest';
import { FORWARD_INPUT_SCHEMA, FORWARD_LIMITS, FORWARD_TOOL, FORWARD_TOOL_DESCRIPTION, forwardNudgeText, forwardStoredText, parseForwardArgs, TRIMMED } from '../plugins/sub-agent-compact/src/forward-args.ts';

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
    expect('nudge' in r && r.nudge).not.toContain('done');
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

  it('trims an over-long item and an over-long list, marking each', () => {
    const a = parse({
      ...ok,
      done: Array.from({ length: 20 }, (_, i) => `item ${i} ${'x'.repeat(300)}`),
      findings: Array.from({ length: 18 }, (_, i) => `f${i}`),
      blocked: Array.from({ length: 12 }, (_, i) => `b${i}`),
    });
    expect(a.done).toHaveLength(15);
    expect(a.done.every((d) => d.length <= 200 && d.endsWith(TRIMMED))).toBe(true);
    expect(a.findings).toHaveLength(15);
    expect(a.findings[14]).toBe(`f14 ${TRIMMED}`);
    expect(a.blocked).toHaveLength(10);
    expect(a.blocked[9]).toBe(`b9 ${TRIMMED}`);
    expect(a.trimmed).toEqual(['done', 'blocked', 'findings']);
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
