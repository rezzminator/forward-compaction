import { describe, expect, it } from 'vitest';
import { invokedSkills, pluginPaths, renderWake, stripFrontmatter, wakeCandidates, wakeFileProblem, WAKE_ENTRY_MAX_CHARS, WAKE_FILE_MAX_BYTES, WAKE_TOTAL_MAX_CHARS } from '../plugins/sub-agent-compact/src/wake.ts';

const roots = { projectRoot: '/proj/.claude', userRoot: '/h/u/.claude', plugins: { quality: '/cache/quality/1.0' } };
const paths = (name: string): string[] => {
  const found = wakeCandidates(name, roots);
  if ('problem' in found) throw new Error(found.problem);
  return found.paths;
};

describe('wakeCandidates', () => {
  it('lists the files a skill or command name may come from: project, user, then the plugin the name prefixes', () => {
    expect(paths('quality:prompt')).toEqual([
      '/proj/.claude/skills/quality:prompt/SKILL.md',
      '/proj/.claude/commands/quality/prompt.md',
      '/h/u/.claude/skills/quality:prompt/SKILL.md',
      '/h/u/.claude/commands/quality/prompt.md',
      '/cache/quality/1.0/skills/prompt/SKILL.md',
      '/cache/quality/1.0/commands/prompt.md',
    ]);
  });

  it('takes a bare name and a leading slash alike, with no plugin files', () => {
    expect(paths('/pfm-testing-manual')).toEqual(paths('pfm-testing-manual'));
    expect(paths('pfm-testing-manual')).toEqual([
      '/proj/.claude/skills/pfm-testing-manual/SKILL.md',
      '/proj/.claude/commands/pfm-testing-manual.md',
      '/h/u/.claude/skills/pfm-testing-manual/SKILL.md',
      '/h/u/.claude/commands/pfm-testing-manual.md',
    ]);
  });

  it('refuses a name that could leave those directories, naming it', () => {
    for (const bad of ['../x', 'a/b', '', 'x y', '.hidden', 'a\\b', 'x:..:..:etc:notes', 'x::y', 'p:..', 'p:.hidden']) {
      const found = wakeCandidates(bad, roots);
      expect('problem' in found && found.problem.includes(JSON.stringify(bad))).toBe(true);
    }
  });
});

describe('stripFrontmatter', () => {
  it('drops a leading frontmatter block and nothing else', () => {
    expect(stripFrontmatter('---\nname: x\n---\nBody\n---\nrule\n')).toBe('Body\n---\nrule\n');
    expect(stripFrontmatter('---\r\nname: x\r\n---\r\nBody')).toBe('Body');
    expect(stripFrontmatter('Body only')).toBe('Body only');
    expect(stripFrontmatter('---\nunclosed')).toBe('---\nunclosed');
  });
});

describe('invokedSkills', () => {
  it('collects the names the transcript\'s Skill calls invoked, without a leading slash', () => {
    const messages = [
      { toolUses: [{ tool: 'Skill', input: { skill: 'quality:prompt' } }, { tool: 'Read', input: { skill: 'no' } }] },
      { toolUses: [{ tool: 'Skill', input: { skill: '/pfm-testing-manual', args: 'x' } }, { tool: 'Skill', input: {} }] },
    ];
    expect([...invokedSkills(messages)].sort()).toEqual(['pfm-testing-manual', 'quality:prompt']);
  });
});

describe('pluginPaths', () => {
  it('maps each installed plugin to its install path', () => {
    const json = JSON.stringify({ version: 2, plugins: { 'quality@market': [{ scope: 'project', installPath: '/p/q-project' }, { scope: 'user', installPath: '/p/q-user' }], 'other@market': [{ installPath: '/p/o' }] } });
    expect(pluginPaths(json)).toEqual({ paths: { quality: '/p/q-user', other: '/p/o' } });
  });

  it('names a file that is not that shape', () => {
    expect(pluginPaths('not json')).toEqual({ problem: expect.stringMatching(/installed_plugins\.json/) });
    expect(pluginPaths('{"version":2}')).toEqual({ problem: expect.stringMatching(/plugins/) });
  });
});

describe('renderWake', () => {
  it('inlines a resolved entry between marked lines, naming its file', () => {
    const { text, failed, cut } = renderWake([{ name: 'pfm-testing-manual', path: '/u/commands/pfm-testing-manual.md', content: 'RUN TESTS\nin the fence' }]);
    expect(text).toContain('=== loaded: pfm-testing-manual (/u/commands/pfm-testing-manual.md) ===\nRUN TESTS\nin the fence\n=== end loaded: pfm-testing-manual ===');
    expect(failed).toEqual([]);
    expect(cut).toEqual([]);
  });

  it('says in the text what it could not load, and names it', () => {
    const { text, failed } = renderWake([{ name: 'gone', problem: 'no file at any of: /a, /b' }]);
    expect(text).toContain('NOT LOADED: gone: no file at any of: /a, /b');
    expect(failed).toEqual(['gone']);
  });

  it('does not inline what the model invoked, and claims only that it invoked it: if its text is not in context after the wake, it invokes it again', () => {
    const { text, failed } = renderWake([{ name: 'quality:prompt', invoked: true, path: '/p', content: 'BODY' }]);
    expect(text).toMatch(/quality:prompt: not inlined because you invoked it earlier in this session; if its text is not in your context after this wake, invoke it again/);
    expect(text).not.toContain('BODY');
    expect(failed).toEqual([]);
  });

  it('cuts an entry past its cap with a line saying how much, and stops at the total cap naming what it left out', () => {
    const big = 'x'.repeat(WAKE_ENTRY_MAX_CHARS + 500);
    const one = renderWake([{ name: 'a', path: '/a', content: big }]);
    expect(one.cut).toEqual(['a']);
    expect(one.text).toContain(`[sub-agent-compact: cut at ${WAKE_ENTRY_MAX_CHARS} of ${big.length} characters]`);
    const many = renderWake(Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, path: `/s${i}`, content: 'y'.repeat(WAKE_ENTRY_MAX_CHARS) })));
    expect(many.text.length).toBeLessThanOrEqual(WAKE_TOTAL_MAX_CHARS + 2_000);
    expect(many.failed).toEqual(['s2', 's3', 's4']);
    expect(many.text).toContain('NOT LOADED: s2: the total of 40000 characters was reached');
  });

  it('is empty without entries', () => {
    expect(renderWake([])).toEqual({ text: '', failed: [], cut: [] });
  });
});

describe('wakeFileProblem', () => {
  it('passes a regular file within the byte cap, the cap itself included', () => {
    expect(wakeFileProblem({ kind: 'file', size: 0 })).toBeUndefined();
    expect(wakeFileProblem({ kind: 'file', size: WAKE_FILE_MAX_BYTES })).toBeUndefined();
  });

  it('refuses a directory and any other kind of path, naming the kind, so a pipe or a device is never read', () => {
    expect(wakeFileProblem({ kind: 'dir', size: 4096 })).toBe('is not a regular file (kind: dir)');
    expect(wakeFileProblem({ kind: 'other', size: 0 })).toBe('is not a regular file (kind: other)');
  });

  it('refuses a file past the cap, naming its size and the cap, before it is read', () => {
    expect(wakeFileProblem({ kind: 'file', size: WAKE_FILE_MAX_BYTES + 1 })).toBe(`is ${WAKE_FILE_MAX_BYTES + 1} bytes, past the ${WAKE_FILE_MAX_BYTES} bytes a skill or command may be`);
  });
});
