import { describe, expect, it } from 'vitest';
import { bashWrites, collapseWhitespace, fileTrail, gitLine, invocationPaths, invocations, parseLineRange, parsePorcelain, planAndTasks, relPath, runningWork, sliceLines, stripNoise, transcriptPath, userMessages, type ApiMsg } from '../plugins/sub-agent-compact/src/forward-carry.ts';
import { renderForward } from '../plugins/sub-agent-compact/src/forward-text.ts';
import { HANDOFF_OPENING } from '../plugins/sub-agent-compact/src/handoff.ts';

const t = (text: string) => ({ type: 'text', text });
const user = (...c: (string | Record<string, unknown>)[]): ApiMsg => ({ role: 'user', content: c.map((x) => (typeof x === 'string' ? t(x) : x)) as never });
const asst = (...c: Record<string, unknown>[]): ApiMsg => ({ role: 'assistant', content: c as never });
const use = (name: string, input: Record<string, unknown>, id = `t_${Math.random().toString(36).slice(2, 8)}`) => ({ type: 'tool_use', id, name, input });
const res = (id: string, text: string) => ({ type: 'tool_result', tool_use_id: id, content: text });
const cmd = (name: string, args = '') => `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`;

describe('user messages', () => {
  it('strips harness noise and collapses blank lines', () => {
    expect(stripNoise('hi <system-reminder>secret</system-reminder> there')).toBe('hi  there');
    expect(stripNoise('<local-command-stdout>x</local-command-stdout>go')).toBe('go');
    expect(stripNoise('a\n<task-notification>\n<task-id>1</task-id>\n</task-notification>\nb')).toBe('a\n\nb');
    expect(collapseWhitespace('a  \n\n\n\n b\n\n\n')).toBe('a\n\n b');
  });

  it('keeps real prompts verbatim in order, not tool results, reminders, or interrupts', () => {
    const m = [
      user('first ask\n\n\n\nwith gap'),
      asst(use('Bash', { command: 'ls' }, 'a1')),
      user(res('a1', 'file list')),
      user('<system-reminder>only noise</system-reminder>'),
      user('[Request interrupted by user]'),
      user('second ask <system-reminder>x</system-reminder>'),
    ];
    expect(userMessages(m)).toEqual(['first ask\n\nwith gap', 'second ask']);
  });

  it('renders a slash command with its arguments and drops the skill body message after it', () => {
    const m = [user(cmd('design', 'a new login page')), user('Base directory for this skill: /plug/skills/design\n\n# Design\nbody'), user(cmd('commit')), user(cmd('x', ''))];
    expect(userMessages(m)).toEqual(['/design a new login page', '/commit', '/x']);
  });

  it('drops the body a command expands to, which follows it, but not the next real message', () => {
    const m = [
      user(cmd('ultimate', 'the work')),
      user('# Ultimate\n\nThe work: the work'),
      asst(t('ok') as never),
      user('a real follow-up'),
      user(cmd('effort', 'high')),
      user('<local-command-stdout>set</local-command-stdout>'),
      user('after a builtin'),
      user(cmd('pcm')),
      user(cmd('x'), '# X body'),
    ];
    expect(userMessages(m)).toEqual(['/ultimate the work', 'a real follow-up', '/effort high', 'after a builtin', '/pcm', '/x']);
  });

  it('turns images into [image N] numbered across the session', () => {
    const m = [user('look', { type: 'image', source: {} }), user({ type: 'image', source: {} }, 'and', { type: 'image', source: {} })];
    expect(userMessages(m)).toEqual(['look [image 1]', '[image 2] and [image 3]']);
  });

  it('takes a plain string content', () => {
    expect(userMessages([{ role: 'user', content: 'plain' }])).toEqual(['plain']);
  });

  it('carries the users of an earlier forward handoff first, not its text', () => {
    const wake = renderForward({ seq: 1, users: ['old one', 'old two'], skills: [], trail: [], loaded: [], tasks: [], running: [], paths: [], problems: [], args: { objective: 'o', done: [], remaining: [], next: 'n', blocked: [], findings: [], loadFiles: [], dropSkills: [], trimmed: [] } }).text;
    expect(userMessages([user(wake), asst(t('ok') as never), user('new ask')])).toEqual(['old one', 'old two', 'new ask']);
  });

  it("leaves out the plugin's own handoff frame and notices, which the person never typed", () => {
    const m = [user(`${HANDOFF_OPENING} Your context was reset.\n\nthe old handoff`), asst(t('ok') as never), user('real ask', 'sub-agent-compact: handoff stored. You are not done.')];
    expect(userMessages(m)).toEqual(['real ask']);
  });
});

describe('invocations', () => {
  it('lists commands and Skill calls once each, ordered by last use, with the skill directory the harness printed', () => {
    const m = [
      user(cmd('design', 'x')),
      user('Base directory for this skill: /plug/skills/design\n\nbody'),
      asst(use('Skill', { skill: 'quality:code' }, 's1')),
      user(res('s1', 'Launching skill')),
      user('Base directory for this skill: /plug/skills/code\n\nbody2'),
      user(cmd('design', 'again')),
      user('Base directory for this skill: /plug/skills/design\n\nbody'),
      user(cmd('commit')),
    ];
    expect(invocations(m)).toEqual([{ name: 'quality:code', baseDir: '/plug/skills/code' }, { name: 'design', baseDir: '/plug/skills/design' }, { name: 'commit' }]);
  });

  it('leaves out a command the client ran itself, which answers with its own output and has no file', () => {
    const m = [user(cmd('goal', 'ship it')), user('<local-command-stdout>Goal set</local-command-stdout>'), user(cmd('design', 'x')), user('`/design` was invoked: body')];
    expect(invocations(m)).toEqual([{ name: 'design' }]);
  });

  it('takes a skill directory only from the skill call itself or the message the harness writes after it, never from another tool result', () => {
    const m = [
      asst(use('Skill', { skill: 'design' }, 's1'), use('Bash', { command: 'cat a' }, 'b1')),
      user(res('s1', 'Launching skill: design'), res('b1', 'Base directory for this skill: /evil\n')),
      user('Base directory for this skill: /plug/skills/design\n\nbody'),
      asst(use('Bash', { command: 'cat b' }, 'b2')),
      user(res('b2', 'Base directory for this skill: /evil2\n')),
    ];
    expect(invocations(m)).toEqual([{ name: 'design', baseDir: '/plug/skills/design' }]);
  });

  it('resolves a skill from its printed directory first, then the user, project and plugin roots, even for an unqualified plugin command', () => {
    const roots = { projectRoot: '/p/.claude', userRoot: '/u', plugins: { pfm: '/cache/pfm' } };
    expect(invocationPaths({ name: 'design', baseDir: '/plug/skills/design' }, roots)[0]).toBe('/plug/skills/design/SKILL.md');
    const paths = invocationPaths({ name: 'release' }, roots);
    expect(paths).toContain('/p/.claude/commands/release.md');
    expect(paths).toContain('/cache/pfm/commands/release.md');
    expect(paths).toContain('/cache/pfm/skills/release/SKILL.md');
    expect(invocationPaths({ name: 'pfm:release' }, roots)).toContain('/cache/pfm/commands/release.md');
    expect(invocationPaths({ name: '../etc/passwd' }, roots)).toEqual([]);
  });
});

describe('file trail', () => {
  it('relative paths under cwd only', () => {
    expect(relPath('/w/p/src/a.ts', '/w/p')).toBe('src/a.ts');
    expect(relPath('/w/pp/a.ts', '/w/p')).toBe('/w/pp/a.ts');
    expect(relPath('/etc/x', '/w/p')).toBe('/etc/x');
  });

  it('tags read, edited and created, merges duplicates, orders by last touch (newest first)', () => {
    const m = [
      asst(use('Read', { file_path: '/w/p/a.ts' }), use('Read', { file_path: '/w/p/b.ts' })),
      asst(use('Edit', { file_path: '/w/p/a.ts', old_string: 'x', new_string: 'y' })),
      asst(use('Write', { file_path: '/w/p/new.md', content: 'x' })),
      asst(use('Read', { file_path: '/w/p/b.ts' })),
      asst(use('NotebookEdit', { notebook_path: '/w/p/n.ipynb' })),
      asst(use('MultiEdit', { file_path: '/w/p/c.ts', edits: [] })),
    ];
    expect(fileTrail(m, { cwd: '/w/p' })).toEqual([
      { tag: 'E', path: 'c.ts' },
      { tag: 'E', path: 'n.ipynb' },
      { tag: 'R', path: 'b.ts' },
      { tag: 'C', path: 'new.md' },
      { tag: 'E', path: 'a.ts' },
    ]);
  });

  it('a Write over a file already seen is an edit, a created file stays created after edits', () => {
    const m = [asst(use('Read', { file_path: '/w/p/a.ts' })), asst(use('Write', { file_path: '/w/p/a.ts' })), asst(use('Write', { file_path: '/w/p/n.ts' })), asst(use('Edit', { file_path: '/w/p/n.ts' }))];
    expect(fileTrail(m, { cwd: '/w/p' })).toEqual([{ tag: 'C', path: 'n.ts' }, { tag: 'E', path: 'a.ts' }]);
  });

  it('caps at 15, keeping the most recent', () => {
    const m = Array.from({ length: 25 }, (_, i) => asst(use('Read', { file_path: `/w/p/f${i}` })));
    const trail = fileTrail(m, { cwd: '/w/p' });
    expect(trail).toHaveLength(15);
    expect(trail[0]).toEqual({ tag: 'R', path: 'f24' });
    expect(trail[14]).toEqual({ tag: 'R', path: 'f10' });
  });

  it('reads clear Bash writes only', () => {
    expect(bashWrites('echo hi > out.txt')).toEqual([{ path: 'out.txt', tag: 'C', create: true }]);
    expect(bashWrites('cat a >> log.md')).toEqual([{ path: 'log.md', tag: 'E', create: false }]);
    expect(bashWrites('npm test 2>&1 | tee run.log')).toEqual([{ path: 'run.log', tag: 'C', create: true }]);
    expect(bashWrites("sed -i '' 's/a/b/' src/x.ts")).toEqual([{ path: 'src/x.ts', tag: 'E', create: false }]);
    expect(bashWrites('cp a.txt b.txt')).toEqual([{ path: 'b.txt', tag: 'C', create: true }]);
    expect(bashWrites('touch "a b.txt"')).toEqual([{ path: 'a b.txt', tag: 'C', create: true }]);
    expect(bashWrites('ls > /dev/null; echo x 2>&1')).toEqual([]);
    expect(bashWrites('git status')).toEqual([]);
  });

  it('ignores redirects and flags inside heredocs, quotes and scripts, and anything that is not a plain path', () => {
    expect(bashWrites("cat > notes.md <<'EOF'\nfoo > bar.txt\nEOF")).toEqual([{ path: 'notes.md', tag: 'C', create: true }]);
    expect(bashWrites('echo "a > b.txt"')).toEqual([]);
    expect(bashWrites('grep ">" file.txt')).toEqual([]);
    expect(bashWrites("awk '{ if (x > 5) print }' data")).toEqual([]);
    expect(bashWrites('python3 -c "print(1>0)"')).toEqual([]);
    expect(bashWrites('echo x > non-blocking')).toEqual([]);
    expect(bashWrites('echo x > "${n}s"')).toEqual([]);
    expect(bashWrites('echo x > ~/notes/today.md')).toEqual([{ path: '~/notes/today.md', tag: 'C', create: true }]);
    // The redirect may follow the heredoc opener on its line: the file is still written, the body still ignored.
    expect(bashWrites("cat <<'EOF' > notes.md\nfoo > bar.txt\nEOF")).toEqual([{ path: 'notes.md', tag: 'C', create: true }]);
    expect(bashWrites('cat <<EOF >> log.md\nx\nEOF')).toEqual([{ path: 'log.md', tag: 'E', create: false }]);
  });

  it('counts a Bash write in the trail', () => {
    const m = [asst(use('Bash', { command: 'echo hi > /w/p/out.txt' }))];
    expect(fileTrail(m, { cwd: '/w/p' })).toEqual([{ tag: 'C', path: 'out.txt' }]);
  });
});

describe('plan and tasks', () => {
  it('takes the latest TodoWrite as one line per todo', () => {
    const m = [
      asst(use('TodoWrite', { todos: [{ content: 'old', status: 'pending' }] })),
      asst(use('TodoWrite', { todos: [{ content: 'one', status: 'completed' }, { content: 'two', status: 'in_progress' }, { content: 'three', status: 'pending' }] })),
    ];
    expect(planAndTasks(m).tasks).toEqual(['[x] one', '[~] two', '[ ] three']);
  });

  it('builds task state from TaskCreate and TaskUpdate', () => {
    const m = [
      asst(use('TaskCreate', { subject: 'write tests' }, 'c1')),
      user(res('c1', 'Task #1 created successfully: write tests')),
      asst(use('TaskCreate', { subject: 'ship' }, 'c2')),
      user(res('c2', 'Task #2 created successfully: ship')),
      asst(use('TaskUpdate', { taskId: '1', status: 'completed' })),
    ];
    expect(planAndTasks(m).tasks).toEqual(['[x] write tests', '[ ] ship']);
  });

  it('takes the latest plan from ExitPlanMode, else the plan file written', () => {
    expect(planAndTasks([asst(use('ExitPlanMode', { plan: 'old' })), asst(use('ExitPlanMode', { plan: 'new plan' }))]).planText).toBe('new plan');
    expect(planAndTasks([asst(use('Write', { file_path: '/h/.claude/plans/swift-fox.md', content: 'p' }))]).planPath).toBe('/h/.claude/plans/swift-fox.md');
    expect(planAndTasks([])).toEqual({ tasks: [] });
  });
});

describe('running work', () => {
  it('lists a background shell until its notification, with id, what and age in messages', () => {
    const m = [
      asst(use('Bash', { command: 'npm run dev', run_in_background: true }, 'b1')),
      user(res('b1', 'Command running in background with ID: bg_abc. Output is being written to /tmp/x')),
      asst(use('Bash', { command: 'sleep 9', run_in_background: true }, 'b2')),
      user(res('b2', 'Command running in background with ID: bg_def. Output is being written to /tmp/y')),
      user('<task-notification>\n<task-id>bg_def</task-id>\n<status>completed</status>\n</task-notification>'),
      asst(t('working') as never),
    ];
    expect(runningWork(m)).toEqual(['shell bg_abc: npm run dev, 5 msgs ago']);
  });

  it('drops a shell a later result reports finished, and keeps the 10 newest', () => {
    const launch = (n: number) => [asst(use('Bash', { command: `job ${n}`, run_in_background: true }, `b${n}`)), user(res(`b${n}`, `Command running in background with ID: bg_${n}.`))];
    const m = [
      ...Array.from({ length: 12 }, (_, n) => launch(n)).flat(),
      asst(use('BashOutput', { bash_id: 'bg_3' }, 'o1')),
      user(res('o1', 'bg_3: process exited with exit code 0')),
    ];
    const lines = runningWork(m);
    expect(lines).toHaveLength(10);
    expect(lines.some((l) => l.includes('bg_3'))).toBe(false);
    expect(lines.at(-1)).toContain('bg_11');
    expect(lines[0]).toContain('bg_1');
  });

  it('ends a task by the notification Claude Code writes, matched by task id or tool-use id; a monitor event is not an end', () => {
    const note = (task: string, use: string, status?: string) => `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>${use}</tool-use-id>\n${status ? `<status>${status}</status>\n` : ''}<summary>x</summary>\n</task-notification>`;
    const m = [
      asst(use('Monitor', { description: 'watch a' }, 'toolu_mon_a')),
      user(res('toolu_mon_a', 'Monitor started (task mona1234, expires in 30m unless the source ends first)')),
      asst(use('Monitor', { description: 'watch b' }, 'toolu_mon_b')),
      user(res('toolu_mon_b', 'Monitor started (task monb5678, expires in 30m)')),
      asst(use('Bash', { command: 'long', run_in_background: true }, 'toolu_sh')),
      user(res('toolu_sh', 'Command running in background with ID: shell9.')),
      user(note('mona1234', 'toolu_mon_a', 'completed')),
      user(note('monb5678', 'toolu_mon_b')),
      user(note('x', 'toolu_sh', 'completed')),
    ];
    expect(runningWork(m)).toEqual(['monitor monb5678: watch b, 6 msgs ago']);
  });

  it('lists a sub-agent without a return: foreground with no result, or background not yet notified', () => {
    const m = [
      asst(use('Agent', { description: 'review the diff', subagent_type: 'reviewer' }, 'g1')),
      asst(use('Agent', { description: 'scan', run_in_background: true }, 'g2')),
      user(res('g2', 'Async agent launched successfully.\nagentId: a1b2c3 (internal ID)')),
      asst(use('Agent', { description: 'done one' }, 'g3')),
      user(res('g3', 'finished')),
    ];
    expect(runningWork(m)).toEqual(['agent g1: review the diff, 4 msgs ago', 'agent a1b2c3: scan, 3 msgs ago']);
  });

  it('lists monitors, wakeups and crons, and drops a killed shell', () => {
    const m = [
      asst(use('Monitor', { description: 'watch ci', command: 'tail -f ci.log' }, 'mon12345')),
      asst(use('ScheduleWakeup', { delaySeconds: 600, reason: 'check build' })),
      asst(use('CronCreate', { cron: '*/5 * * * *', prompt: 'poll' })),
      asst(use('Bash', { command: 'serve', run_in_background: true }, 'b1')),
      user(res('b1', 'Command running in background with ID: bg_s.')),
      asst(use('KillShell', { shell_id: 'bg_s' })),
    ];
    expect(runningWork(m)).toEqual(['monitor mon12345: watch ci, 5 msgs ago', 'wakeup: check build, 4 msgs ago', 'cron: */5 * * * * poll, 3 msgs ago']);
  });
});

describe('git, ranges, transcript', () => {
  it('reads dirty paths from porcelain, a rename as its target', () => {
    expect(parsePorcelain(' M src/a.ts\n?? new file.md\nR  old.ts -> new.ts\n')).toEqual(['src/a.ts', 'new file.md', 'new.ts']);
    expect(parsePorcelain('')).toEqual([]);
  });

  it('writes git as one line with up to 10 paths', () => {
    expect(gitLine({ branch: 'main', head: 'abc1234', dirty: ['a', 'b', 'c'] })).toBe('main@abc1234, 3 dirty: a, b, c');
    expect(gitLine({ branch: 'main', head: 'abc1234', dirty: [] })).toBe('main@abc1234, clean');
    const many = Array.from({ length: 14 }, (_, i) => `f${i}`);
    expect(gitLine({ branch: 'dev', head: 'x', dirty: many })).toBe(`dev@x, 14 dirty: ${many.slice(0, 10).join(', ')}…`);
  });

  it('honours a line range exactly', () => {
    expect(parseLineRange('10-20')).toEqual({ from: 10, to: 20 });
    expect(parseLineRange('10:20')).toEqual({ from: 10, to: 20 });
    expect(parseLineRange('7')).toEqual({ from: 7, to: 7 });
    expect(parseLineRange('20-10')).toBeUndefined();
    expect(parseLineRange('abc')).toBeUndefined();
    expect(sliceLines('a\nb\nc\nd\ne', { from: 2, to: 4 })).toBe('b\nc\nd');
    expect(sliceLines('a\nb', { from: 2, to: 9 })).toBe('b');
  });

  it('puts the transcript where Claude Code does', () => {
    expect(transcriptPath({ configDir: '/c', cwd: '/work/me/.proj', sessionId: 's-1' })).toBe('/c/projects/-work-me--proj/s-1.jsonl');
  });
});
