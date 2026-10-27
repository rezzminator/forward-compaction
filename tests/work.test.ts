import { describe, expect, it } from 'vitest';
import { workOf, workSummary, type WorkFact } from '../plugins/forward-compaction/src/work.ts';

const ok = { text: 'done' };

describe('workOf: what a finished call records', () => {
  it('records the file a Read, Edit, MultiEdit, Write or NotebookEdit touched', () => {
    expect(workOf('Read', { file_path: '/w/a.ts' }, ok)).toEqual([{ kind: 'file', path: '/w/a.ts', tag: 'R' }]);
    expect(workOf('Edit', { file_path: '/w/a.ts' }, ok)).toEqual([{ kind: 'file', path: '/w/a.ts', tag: 'E' }]);
    expect(workOf('MultiEdit', { file_path: '/w/a.ts' }, ok)).toEqual([{ kind: 'file', path: '/w/a.ts', tag: 'E' }]);
    expect(workOf('Write', { file_path: '/w/b.ts' }, ok)).toEqual([{ kind: 'file', path: '/w/b.ts', tag: 'W' }]);
    expect(workOf('NotebookEdit', { notebook_path: '/w/n.ipynb' }, ok)).toEqual([{ kind: 'file', path: '/w/n.ipynb', tag: 'E' }]);
  });

  it('records nothing for a denied or errored call, a call with no path, or another tool', () => {
    expect(workOf('Edit', { file_path: '/w/a.ts' }, { deny: 'no' })).toEqual([]);
    expect(workOf('Write', { file_path: '/w/a.ts' }, { isError: true, text: 'EACCES' })).toEqual([]);
    expect(workOf('Read', {}, ok)).toEqual([]);
    expect(workOf('Grep', { pattern: 'x' }, ok)).toEqual([]);
  });

  it('M2 + M4: records a Bash call\'s command verbatim with its description, an errored one too (the command to rerun), never a denied one or its output', () => {
    expect(workOf('Bash', { command: 'npm test -- a.test.ts', description: 'Run the a tests' }, { text: 'output never kept' })).toEqual([{ kind: 'command', command: 'npm test -- a.test.ts', description: 'Run the a tests' }]);
    expect(workOf('Bash', { command: 'false' }, { isError: true, text: 'exit 1' })).toEqual([{ kind: 'command', command: 'false' }]);
    expect(workOf('Bash', { command: 'rm x' }, { deny: 'no' })).toEqual([]);
    expect(workOf('Bash', {}, ok)).toEqual([]);
  });

  it('records the todo list as set, and task creates and updates with the id from the answer', () => {
    expect(workOf('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] }, ok))
      .toEqual([{ kind: 'todos', lines: ['[x] a', '[~] b', '[ ] c'] }]);
    expect(workOf('TaskCreate', { subject: 'ship it' }, { text: 'Task #4 created successfully' })).toEqual([{ kind: 'task-create', id: '4', subject: 'ship it' }]);
    expect(workOf('TaskUpdate', { taskId: '4', status: 'completed' }, ok)).toEqual([{ kind: 'task-update', id: '4', status: 'completed' }]);
    expect(workOf('TaskUpdate', { status: 'completed' }, ok)).toEqual([]);
  });
});

describe("workSummary: a party's files and tasks", () => {
  const file = (path: string, tag: 'R' | 'E' | 'W'): WorkFact => ({ kind: 'file', path, tag });

  it('lists every file once, newest touch first, keeping its strongest touch', () => {
    const s = workSummary([file('/a', 'W'), file('/b', 'R'), file('/a', 'R'), file('/c', 'E'), file('/b', 'E')]);
    expect(s.files).toEqual([{ path: '/b', tag: 'E' }, { path: '/c', tag: 'E' }, { path: '/a', tag: 'W' }]);
  });

  it('gives the task list that moved last: the TaskCreate/TaskUpdate list, a deleted task gone, or the todo list', () => {
    const tasks: WorkFact[] = [
      { kind: 'todos', lines: ['[ ] old todo'] },
      { kind: 'task-create', id: '1', subject: 'one' },
      { kind: 'task-create', id: '2', subject: 'two' },
      { kind: 'task-update', id: '1', status: 'in_progress', subject: 'one, renamed' },
      { kind: 'task-update', id: '2', status: 'deleted' },
    ];
    expect(workSummary(tasks).tasks).toEqual(['[~] one, renamed']);
    expect(workSummary([...tasks, { kind: 'todos', lines: ['[x] new todo'] }]).tasks).toEqual(['[x] new todo']);
    expect(workSummary([]).tasks).toEqual([]);
  });

  it('lists the commands newest first, each once at its newest run', () => {
    const run = (command: string, description?: string): WorkFact => ({ kind: 'command', command, ...(description !== undefined ? { description } : {}) });
    expect(workSummary([run('make', 'Build'), run('ls'), run('make', 'Build again')]).commands).toEqual([{ command: 'make', description: 'Build again' }, { command: 'ls' }]);
    expect(workSummary([]).commands).toEqual([]);
  });
});
