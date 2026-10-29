// The work a party's tool calls record as each one finishes: the files touched, the commands run and the task list. Read from the call's
// own arguments and answer, never from rendered text, so the wake restores what Claude Code's own compaction restores
// (the recent files, the todo list).

/** R read, E edited, W written whole (Write). A file keeps the strongest touch it had: W over E over R. */
export type FileTag = 'R' | 'E' | 'W';
export type WorkFact =
  | { kind: 'file'; path: string; tag: FileTag }
  | { kind: 'command'; command: string; description?: string; background?: true }
  | { kind: 'todos'; lines: string[] }
  | { kind: 'task-create'; id?: string; subject: string }
  | { kind: 'task-update'; id: string; status?: string; subject?: string };

/** The answer of a finished call, as `next(e)` resolved it: a deny or an error touched nothing. */
export type CallAnswer = { deny?: string; isError?: boolean; text?: string; result?: unknown };

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const MARK: Record<string, string> = { completed: '[x]', in_progress: '[~]' };
const mark = (status: unknown): string => MARK[String(status)] ?? '[ ]';

/** The facts a finished call records, none for a call that was denied, errored (a command excepted: the one to rerun) or touches no file, command or task. */
export function workOf(tool: string, input: Record<string, unknown>, answer: CallAnswer): WorkFact[] {
  if (answer.deny !== undefined) return [];
  if (tool === 'Bash') return str(input.command) === undefined ? [] : [{ kind: 'command', command: str(input.command)!, ...(str(input.description) !== undefined ? { description: str(input.description) } : {}), ...(input.run_in_background === true ? { background: true as const } : {}) }]; // never its output
  if (answer.isError === true) return [];
  const file = (path: string | undefined, tag: FileTag): WorkFact[] => (path === undefined ? [] : [{ kind: 'file', path, tag }]);
  switch (tool) {
    case 'Read':
      return file(str(input.file_path), 'R');
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return file(str(input.file_path), tool === 'Write' ? 'W' : 'E');
    case 'NotebookEdit':
      return file(str(input.notebook_path), 'E');
    case 'TodoWrite':
      return Array.isArray(input.todos) ? [{ kind: 'todos', lines: (input.todos as Record<string, unknown>[]).map((t) => `${mark(t?.status)} ${String(t?.content ?? '')}`) }] : [];
    case 'TaskCreate': {
      const id = /#(\d+)/.exec(answer.text ?? '')?.[1];
      return [{ kind: 'task-create', ...(id !== undefined ? { id } : {}), subject: String(input.subject ?? '') }];
    }
    case 'TaskUpdate': {
      const id = str(input.taskId);
      return id === undefined ? [] : [{ kind: 'task-update', id, ...(str(input.status) !== undefined ? { status: str(input.status) } : {}), ...(str(input.subject) !== undefined ? { subject: str(input.subject) } : {}) }];
    }
    default:
      return [];
  }
}

const RANK: Record<FileTag, number> = { R: 0, E: 1, W: 2 };

export type WorkCommand = { command: string; description?: string };
export type WorkSummary = { files: { path: string; tag: FileTag }[]; commands: WorkCommand[]; tasks: string[] };

/**
 * The person's answer to an AskUserQuestion call, which reaches the model as the call's result, never as a prompt: `text`
 * each question with its answer and notes, `said` the person's own words alone (a lift may quote only those, never the
 * question the model wrote). A call turned back or holding no answers record is carried as the text the model read.
 */
export function answersOf(tool: string, input: Record<string, unknown>, answer: CallAnswer): { text: string; said: string } | undefined {
  if (tool !== 'AskUserQuestion' || answer.deny !== undefined) return undefined;
  const record = (answer.result ?? {}) as { answers?: unknown; annotations?: unknown };
  const answers = typeof record.answers === 'object' && record.answers !== null && answer.isError !== true ? Object.entries(record.answers as Record<string, unknown>) : [];
  if (answers.length === 0) return str(answer.text) === undefined ? undefined : { text: answer.text!, said: '' };
  const notes = (record.annotations ?? {}) as Record<string, { notes?: unknown } | undefined>;
  const lines = answers.map(([question, value]) => ({ question, said: [String(value), ...(str(notes[question]?.notes) !== undefined ? [String(notes[question]!.notes)] : [])] }));
  return {
    text: lines.map((l) => [l.question, `Answer: ${l.said[0]}`, ...l.said.slice(1).map((n) => `Notes: ${n}`)].join('\n')).join('\n'),
    said: lines.flatMap((l) => l.said).join('\n'),
  };
}

/** A party's work, from its facts in the order recorded: every file newest touch first, every command once at its newest run, newest first, and the task list as last set (TodoWrite's, or the TaskCreate/TaskUpdate list, whichever moved last). */
export function workSummary(facts: readonly WorkFact[]): WorkSummary {
  const files = new Map<string, FileTag>();
  const commands = new Map<string, WorkCommand>();
  const tasks = new Map<string, { subject: string; status: string }>();
  let todos: string[] = [];
  let todosLast = false;
  for (const f of facts) {
    if (f.kind === 'file') {
      const before = files.get(f.path);
      files.delete(f.path); // re-inserted last: the map's order is the touch order
      files.set(f.path, before !== undefined && RANK[before] > RANK[f.tag] ? before : f.tag);
    } else if (f.kind === 'command') (commands.delete(f.command), commands.set(f.command, { command: f.command, ...(f.description !== undefined ? { description: f.description } : {}) }));
    else if (f.kind === 'todos') (todos = f.lines), (todosLast = true);
    else if (f.kind === 'task-create') (tasks.set(f.id ?? String(tasks.size + 1), { subject: f.subject, status: 'pending' }), (todosLast = false));
    else {
      const task = tasks.get(f.id);
      if (task !== undefined && f.status === 'deleted') tasks.delete(f.id);
      else if (task !== undefined) Object.assign(task, f.status !== undefined ? { status: f.status } : {}, f.subject !== undefined ? { subject: f.subject } : {});
      todosLast = false;
    }
  }
  return {
    files: [...files].reverse().map(([path, tag]) => ({ path, tag })),
    commands: [...commands.values()].reverse(),
    tasks: todosLast ? todos : [...tasks.values()].map((t) => `${mark(t.status)} ${t.subject}`),
  };
}
