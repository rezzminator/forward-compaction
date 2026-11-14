// The forward_compaction tool contract: what the model may send, what is stored whole (never trimmed, never refused), and what the receipt says.

import { k } from './nudge';
import { DROP_MAX } from './drop';
import { carryOrders, type LiftedOrder, type OrderMemory, type StandingOrder } from './orders';
export { applyDrops, dropNote, pinnedBy } from './drop';

/** The tool's name as registered; the model sees `mcp__forward-compaction__forward_compaction`. */
export const FORWARD_TOOL = 'forward_compaction';

export const FORWARD_TOOL_DESCRIPTION =
  'Compacts your context at a clean milestone once it is large. Stores your frontier, one argument per section, any length, for yourself after a reset; at your next compaction it and recorded facts replace everything before this call, the newest later messages that fit stay verbatim, the rest named as not carried. The person\'s binding orders go in standing_orders, verbatim. Always stores; the receipt names any change. Example: forward_compaction({"objective": "…", "decisions": "…", "done": "…", "remaining": "…", "next": "…", "load_files": [{"path": "…"}]}). Exact old detail later → look_back.';

/**
 * The frontier's sections in the order they are assembled: the argument, its heading, whether it is required, and what it
 * holds. A frontier missing a required one is stored and installs as it is, its wake naming each one it lacks (`missing`).
 */
const SECTIONS = [
  { key: 'objective', heading: 'Objective', required: true, description: 'MANDATORY: what the work is for and what done means.' },
  { key: 'decisions', heading: 'Decisions', required: true, description: 'MANDATORY: every ruling the person gave on how something gets done, in the person\'s words, each with its undo when one exists; "none" when there are none. Rules binding the rest of the work go in standing_orders.' },
  { key: 'done', heading: 'Done', required: true, description: 'MANDATORY: finished pieces, each with how it was verified; every figure with the command that produced it.' },
  { key: 'remaining', heading: 'Remaining', required: true, description: 'MANDATORY: every step left, in order; "none" when nothing is left. A plan file you update at each milestone may stand in: name its path here and put it in load_files.' },
  { key: 'next', heading: 'Next', required: true, description: 'MANDATORY: the first concrete action after the wake.' },
  { key: 'blocked', heading: 'Blocked', required: false, description: 'Optional: what waits on whom.' },
  { key: 'findings', heading: 'Findings', required: false, description: 'Optional: your own choices with why, errors verbatim, the commands and recipes you will need again.' },
] as const;

export const FORWARD_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['objective', 'decisions', 'done', 'remaining', 'next'],
  properties: {
    objective: { type: 'string', description: SECTIONS[0].description },
    decisions: { type: 'string', description: SECTIONS[1].description },
    done: { type: 'string', description: SECTIONS[2].description },
    remaining: { type: 'string', description: SECTIONS[3].description },
    next: { type: 'string', description: SECTIONS[4].description },
    blocked: { type: 'string', description: SECTIONS[5].description },
    findings: { type: 'string', description: SECTIONS[6].description },
    load_files: {
      type: 'array',
      description: 'Files carried into the new context, read when it installs: each up to 250 lines; a longer file or range carries its first 250 and names where to Read the rest. Pass lines ranges to carry only what you need.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Absolute path.' },
          lines: { type: 'string', description: 'Line ranges, like "10-40" or "1-60,160-185".' },
          why: { type: 'string', description: 'What you need it for, one line; past 200 characters it is cut.' },
        },
      },
    },
    drop_skills: {
      type: 'array',
      maxItems: DROP_MAX,
      items: { type: 'string' },
      description: 'Optional: names of skills or commands in your context you no longer need. Name one on two frontiers in a row and the second wake leaves it out; one its file pins stays.',
    },
    standing_orders: {
      type: 'array',
      description: "Every order of the person's that binds the rest of the work (a prohibition, a limit, a rule), each in every frontier until the person lifts it.",
      // Open, so an entry still carrying a key an older schema had (`at`) is read for its order, never refused.
      items: {
        type: 'object',
        required: ['order'],
        properties: {
          order: { type: 'string', description: "The person's words, verbatim." },
        },
      },
    },
    lifted: {
      type: 'array',
      description: 'Orders your last frontier carried that the person has since lifted.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['order', 'by'],
        properties: {
          order: { type: 'string', description: 'The order, exactly as your last frontier carried it.' },
          by: { type: 'string', description: "The person's words that lifted it, verbatim." },
        },
      },
    },
  },
} as const;

// Format caps: design budgets on what the model may send, never a measured size.
/** Lines one load file carries: a plan, a spec or a module in hand reads whole, and a longer one names where to Read the rest. */
export const LOAD_FILE_MAX_LINES = 250;
/** The most characters one file the plugin picked carries at a mechanical install: 250 lines of 160. A file of few, enormous lines is cut here, where the line cap never bites. */
export const LOAD_FILE_MAX_CHARS = 40_000;
/** A load file's `why`: one line saying what it is for; a longer one is cut to it. */
export const WHY_MAX_CHARS = 200;

/** One file the model asked to carry into the wake: its path, absolute or resolved against the session's directory; `lines` and `why` the model's own text, `why` cut to WHY_MAX_CHARS. */
export type LoadFile = { path: string; lines?: string; why?: string };

export type ParsedFrontier = {
  frontier: string;
  loadFiles: LoadFile[];
  /** The place in the call's `load_files` of each entry of `loadFiles`, so a note on one names the entry the model sent. */
  loadAt: number[];
  dropSkills: string[];
  standingOrders: StandingOrder[];
  lifted: LiftedOrder[];
  /** The required sections absent, not a string or blank, in section order: the wake names each, and the receipt says so. */
  missing: string[];
  /** One line per argument left out, skipped or carried by the plugin instead: the receipt names each, the model fixes nothing. */
  notes: string[];
};

const FIELDS = [...SECTIONS.map((section) => section.key), 'load_files', 'drop_skills', 'standing_orders', 'lifted'];
const num = (n: number): string => n.toLocaleString('en-US');
const kind = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
/** Whether `p` is absolute, POSIX or Windows. */
export const isAbsolutePath = (p: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
/** `path` in `dir`: the session's directory, its trailing separators and the path's leading `./` dropped. */
const inDir = (dir: string, path: string): string => `${dir.replace(/[\\/]+$/, '')}/${path.replace(/^(\.[\\/])+/, '')}`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const ARRAYS = ['load_files', 'drop_skills', 'standing_orders', 'lifted'];
const FOLD = /<\/(\w+)>\s*<parameter name="(\w+)">/g;

/**
 * A section whose text holds its own closing tag and then `<parameter name="other">`: the model's call markup closed it
 * early and folded the parameters after it into its text. Each folded one is taken back out as its own field (an
 * array one parsed as JSON), one note each. One that cannot be (no field, one the call also sent, or an array one
 * that is not JSON) stays in the section it arrived in, under its name, so no text the model sent is lost.
 */
function unfold(input: Record<string, unknown>): { fields: Record<string, unknown>; notes: string[] } {
  const fields = { ...input };
  const notes: string[] = [];
  for (const key of FIELDS) {
    const value = fields[key];
    if (typeof value !== 'string') continue;
    const parts = value.split(FOLD);
    if (parts.length < 4 || parts[1] !== key) continue;
    const kept = [parts[0]];
    for (let i = 1; i + 2 < parts.length; i += 3) {
      const name = parts[i + 1] ?? '';
      const segment = parts[i + 2] ?? '';
      const text = i + 3 < parts.length ? segment : segment.replace(new RegExp(`</${name}>\\s*$`), '');
      const at = `${name} arrived inside ${key}, after "</${key}>"`;
      const keep = (why: string): void => void (kept.push(`[${name}, as it arrived inside ${key}]\n${text}`), notes.push(`${at}, but ${why}: kept in ${key} as it arrived.`));
      if (!FIELDS.includes(name)) keep(`${name} is no field`);
      else if (input[name] !== undefined) keep(`the call also sent ${name}`);
      else if (!ARRAYS.includes(name)) (fields[name] = text, notes.push(`${at}: your call's markup closed ${key} early; taken back out as its own field.`));
      else {
        try {
          fields[name] = JSON.parse(text);
          notes.push(`${at}: your call's markup closed ${key} early; taken back out as its own field.`);
        } catch (err) {
          keep(`it is not JSON (${(err as Error).message})`);
        }
      }
    }
    fields[key] = kept.join('\n\n');
  }
  return { fields, notes };
}

/** One line per section left out: a required one missing or blank, any one given but not a string; one per unknown field, carried under findings (`carryUnknown`). */
function argumentNotes(fields: Record<string, unknown>): string[] {
  const unknown = Object.keys(fields).filter((key) => !FIELDS.includes(key)).map((key) => `unknown field "${key}" carried under findings. The fields are ${FIELDS.slice(0, -1).join(', ')} and ${FIELDS.at(-1)}.`);
  const sections = SECTIONS.flatMap(({ key, required }) => {
    const value = fields[key];
    if (typeof value === 'string' && value.trim() !== '') return [];
    if (value === undefined || value === '' || (typeof value === 'string' && value.trim() === '')) return required ? [`${key} was ${value === undefined ? 'missing' : 'blank'}: your frontier is stored without it.`] : [];
    return [`${key} must be a string; got ${kind(value)}: your frontier is stored without it.`];
  });
  return [...unknown, ...sections];
}

/** The fields with every unknown one's content appended to `findings` under its name: the model sent it, so the wake carries it. A `findings` that is no string is left out, as its note says. */
function carryUnknown(fields: Record<string, unknown>): Record<string, unknown> {
  const unknown = Object.keys(fields).filter((key) => !FIELDS.includes(key));
  if (unknown.length === 0) return fields;
  const own = typeof fields.findings === 'string' && fields.findings.trim() !== '' ? [fields.findings] : [];
  const carried = unknown.map((key) => `[${key}, an argument forward_compaction does not take]\n${typeof fields[key] === 'string' ? fields[key] : JSON.stringify(fields[key])}`);
  return { ...fields, findings: [...own, ...carried].join('\n\n') };
}

/**
 * Reads the model's tool input into a frontier that is always stored: nothing is refused. Each bad argument is left
 * out (a section) or skipped (one `drop_skills`, `standing_orders` or `lifted` entry, or a `load_files` entry with no
 * path) and named in `notes` for the receipt, the sections' text and the files coming back as sent; an unknown argument
 * rides under findings. A load file's relative path is resolved against `cwd`, the session's directory, when known.
 * With `memory`, the party's remembered standing orders, the plugin carries every one the frontier left out and keeps
 * every one a lift did not prove (orders.ts `carryOrders`).
 * `$.fs.stat` checks (V12-V15) are the adapter's, through `loadFileNote`.
 */
export function parseFrontier(input: unknown, memory?: OrderMemory, cwd?: string): ParsedFrontier {
  const unfolded = unfold(isObject(input) ? input : {});
  const notes = [...unfolded.notes, ...argumentNotes(unfolded.fields)];
  const fields = carryUnknown(unfolded.fields);
  const given = (key: string): boolean => typeof fields[key] === 'string' && (fields[key] as string).trim() !== '';
  const frontier = SECTIONS.flatMap(({ key, heading }) => (given(key) ? [`## ${heading}\n${fields[key] as string}`] : [])).join('\n\n');
  const missing = SECTIONS.flatMap(({ key, required }) => (required && !given(key) ? [key] : []));
  const drops = fields.drop_skills;
  let dropSkills: string[] = [];
  if (drops !== undefined && !Array.isArray(drops)) notes.push('drop_skills must be an array of skill or command names: none dropped.');
  else if (drops !== undefined) {
    dropSkills = drops.filter((d, i): d is string => (typeof d === 'string' && d.trim() !== '') || (notes.push(`drop_skills[${i}] must be a non-blank string: skipped.`), false));
    if (dropSkills.length > DROP_MAX) (notes.push(`drop_skills has ${dropSkills.length} names, over the ${DROP_MAX} cap: the first ${DROP_MAX} are used.`), (dropSkills = dropSkills.slice(0, DROP_MAX)));
  }
  const orders = carryOrders(memory ?? { remembered: [], said: [], party: 'main' }, fields.standing_orders, fields.lifted);
  notes.push(...orders.notes);
  const files = fields.load_files;
  const loadFiles: LoadFile[] = [];
  const loadAt: number[] = [];
  if (files !== undefined && !Array.isArray(files)) notes.push('load_files must be an array of {path, lines?, why}: none carried.');
  else {
    for (const [i, entry] of (files ?? []).entries()) {
      const { path: sent, why, lines: ranges } = isObject(entry) ? entry : ({} as Record<string, unknown>);
      if (typeof sent !== 'string' || sent.trim() === '') {
        notes.push(`load_files[${i}].path must be a non-blank string; got ${kind(sent)}: skipped.`);
        continue;
      }
      let path = sent;
      if (!isAbsolutePath(sent) && cwd === undefined) notes.push(`load_files[${i}].path "${sent}" is relative and the session's directory is unknown: carried as given.`);
      else if (!isAbsolutePath(sent)) (path = inDir(cwd!, sent)), notes.push(`load_files[${i}].path "${sent}" is relative: carried as ${path}, in the session's directory.`);
      const file: LoadFile = { path };
      if (ranges !== undefined && (typeof ranges !== 'string' || parseLineRanges(ranges) === undefined)) notes.push(`load_files[${i}].lines "${String(ranges)}" is not a range like "10-40" or "1-60,160-185": ${path} carried from line 1.`);
      else if (ranges !== undefined) file.lines = ranges as string;
      if (why !== undefined && typeof why !== 'string') notes.push(`load_files[${i}].why must be a string; got ${kind(why)}: ${path} carried without it.`);
      else if (why !== undefined && why.length > WHY_MAX_CHARS) (file.why = why.slice(0, WHY_MAX_CHARS)), notes.push(`load_files[${i}].why is ${why.length} characters, over ${WHY_MAX_CHARS}: cut to its first ${WHY_MAX_CHARS}.`);
      else if (why !== undefined && why.trim() !== '') file.why = why;
      loadFiles.push(file), loadAt.push(i);
    }
  }
  return { frontier, dropSkills, standingOrders: orders.standing, lifted: orders.lifted, loadFiles, loadAt, missing, notes };
}

/** What the adapter learned from `$.fs.stat(path)` on one load file: its stat, or `absent` (ENOENT), or the error text of any other throw. */
export type FileCheck = { kind: 'file' | 'dir' | 'other'; size: number } | { absent: true } | { error: string };

/** V12-V15: the note for one load file that is skipped (`index` is its place in `load_files`, from 0), or undefined when it can be carried. */
export function loadFileNote(index: number, path: string, check: FileCheck): string | undefined {
  const at = `load_files[${index}] ${path}`;
  if ('error' in check) return `${at} could not be checked: ${check.error}: skipped.`;
  if ('absent' in check) return `${at}: no such file: skipped.`;
  if (check.kind !== 'file') return `${at} is not a regular file: skipped.`;
  return undefined;
}

/** The receipt's list of what the plugin left out, skipped or carried on for the model: empty when it changed nothing; with a required section `missing`, it ends with INCOMPLETE_NOTE. */
export function changesNote(notes: readonly string[], missing: readonly string[] = []): string {
  const list = notes.length === 0 ? '' : `Stored with ${notes.length} ${notes.length === 1 ? 'change' : 'changes'}:\n${notes.map((n) => `- ${n}`).join('\n')}`;
  return missing.length === 0 ? list : `${list}\n${INCOMPLETE_NOTE}`;
}

/** The last line of the changes list of a frontier missing a required section. */
export const INCOMPLETE_NOTE = 'Call forward_compaction again with every MANDATORY section to replace it before it installs.';

/** `tokens`: the party's last reading, absent when it has none; it picks the sentence and is never printed, being a step behind the call. `incomplete`: a required section is missing, which its wake names. */
export type ReceiptInput =
  | { party: 'main'; chars: number; files: number; tokens?: number; askPoint?: number; replaced?: boolean; incomplete?: boolean }
  | { party: 'subagent'; chars: number; files: number; tokens?: number; askPoint: number; replaced?: boolean; incomplete?: boolean };

/** The tool result of a stored frontier: when it installs, true to the party's door (a sub-agent's only door is Claude Code's ask), and what it lacks. */
export function receipt(input: ReceiptInput): string {
  const replaced = input.replaced ? ' It replaces the frontier you stored before.' : '';
  const stored = `Frontier stored (${num(input.chars)} characters, ${input.files} files)${input.incomplete ? ', missing a MANDATORY section: the wake will name each one it lacks' : ''}.`;
  const behind = 'The newest messages after this call that fit are kept verbatim behind it, the rest named as not carried';
  if (input.party === 'main') return `${stored} It installs at the end of this turn, or at Claude Code's next compaction ask if one comes first. ${behind}, so finish the step in hand; you need not stop.${replaced}`;
  if (input.tokens !== undefined && input.tokens >= input.askPoint) return `${stored} It installs at Claude Code's next compaction ask, before your next request. ${behind}.${replaced}`;
  return `${stored} Claude Code has not asked to compact you yet: it installs at Claude Code's next ask, from about ${k(input.askPoint)} context. ${behind}. Carry on with your work.${replaced}`;
}

/** Keys the tool.call event carries beside the tool's arguments (`requestMeta` a hook may add, `consent` a press may carry). */
const EVENT_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent']);

/** The arguments of a tool call: every key of the event but its own (a key that is not a field included, so the check names it) or, when none is there, the event's `input`. */
export function toolInput(e: Record<string, unknown>): Record<string, unknown> {
  const top: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(e)) if (!EVENT_KEYS.has(key) && key !== 'input' && value !== undefined) top[key] = value;
  if (Object.keys(top).length > 0) return top;
  const nested = e.input;
  return nested !== null && typeof nested === 'object' && !Array.isArray(nested) ? (nested as Record<string, unknown>) : {};
}

/** Every forward_compaction answer, receipt or failure, ends with this line; `logDir` is the level-log directory, where the issues file lives. */
export const EXPERIMENTAL_OPENING = 'forward-compaction is experimental.';
export function experimental(text: string, logDir: string | undefined): string {
  const where = logDir === undefined ? 'your reply.' : `${logDir.replace(/\/+$/, '')}/issues.md; it will be taken care of later.`;
  return `${text}\n${EXPERIMENTAL_OPENING} If it gave you any trouble, append a short note of what happened to ${where}`;
}

export function parseLineRanges(text: string): { from: number; to: number }[] | undefined {
  const out: { from: number; to: number }[] = [];
  for (const part of text.split(',')) {
    const m = /^\s*(\d+)\s*(?:[-:]\s*(\d+))?\s*$/.exec(part);
    if (!m) return undefined;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < 1 || to < from) return undefined;
    out.push({ from, to });
  }
  return out;
}

const span = (r: { from: number; to: number }): string => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`);

/**
 * A file's text as `load_files` asked for it, at most LOAD_FILE_MAX_LINES lines: from line 1 without ranges, else its ranges
 * in file order, overlapping or touching ones merged, the lines between two of them named by one `[lines a-b not loaded]`
 * line. Lines asked for past the cap are counted, and the body ends with one line naming where to Read them. `shown` is
 * the ranges that loaded, clipped to the file and the cap ('' for a whole file). A range past the file's end, or clipped
 * by it, is a `problem`, and an empty load is one too: a slice of nothing never reaches the wake as a Load block that says nothing.
 * A file holding a NUL character is binary and is a `problem`, never a body; with `maxChars`, a body past it is cut there and says so.
 */
export function sliceFile(path: string, text: string, ranges: readonly { from: number; to: number }[] | undefined, maxChars?: number): { body: string; shown: string; problem?: string } | { problem: string } {
  if (text.includes('\u0000')) return { problem: 'not a text file' };
  const capped = (body: string): string => (maxChars === undefined || body.length <= maxChars ? body : `${body.slice(0, maxChars)}\n[cut at ${maxChars} characters: Read ${path} for the rest]`);
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const count = lines.length;
  const more = (left: number, from: number): string => `[${left} more lines not carried: Read ${path} from line ${from}]`;
  if (ranges === undefined) {
    if (text.trim() === '') return { problem: 'the file is empty' };
    if (count <= LOAD_FILE_MAX_LINES) return { body: capped(text), shown: '' };
    return { body: capped([...lines.slice(0, LOAD_FILE_MAX_LINES), more(count - LOAD_FILE_MAX_LINES, LOAD_FILE_MAX_LINES + 1)].join('\n')), shown: `1-${LOAD_FILE_MAX_LINES}` };
  }
  const parts: string[] = [];
  const shown: { from: number; to: number }[] = [];
  const problems: string[] = [];
  // In file order and merged: an overlap never loads a line twice, and a reversed list never reads as one stretch.
  const ordered: { from: number; to: number }[] = [];
  for (const r of [...ranges].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const prev = ordered[ordered.length - 1];
    if (prev !== undefined && r.from <= prev.to + 1) prev.to = Math.max(prev.to, r.to);
    else ordered.push({ ...r });
  }
  let held = false;
  let room = LOAD_FILE_MAX_LINES;
  // The lines asked for past the cap, and the first of them.
  let left = 0;
  let next: number | undefined;
  for (const r of ordered) {
    if (r.from > count) {
      problems.push(`lines ${span(r)}: past the end of the file, which has ${count} ${count === 1 ? 'line' : 'lines'}`);
      continue;
    }
    const to = Math.min(r.to, count);
    if (to < r.to) problems.push(`lines ${span(r)}: the file ends at line ${count}`);
    if (room === 0) {
      left += to - r.from + 1;
      next ??= r.from;
      continue;
    }
    const end = Math.min(to, r.from + room - 1);
    if (end < to) (left += to - end), (next = end + 1);
    const last = shown[shown.length - 1];
    if (last !== undefined && r.from > last.to + 1) parts.push(`[lines ${span({ from: last.to + 1, to: r.from - 1 })} not loaded]`);
    const taken = lines.slice(r.from - 1, end);
    if (taken.some((line) => line.trim() !== '')) held = true;
    parts.push(...taken);
    room -= taken.length;
    shown.push({ from: r.from, to: end });
  }
  const problem = problems.length > 0 ? problems.join('; ') : undefined;
  if (shown.length === 0) return { problem: problem ?? 'no lines asked for' };
  if (!held) return { problem: [problem, `lines ${shown.map(span).join(',')}: only blank lines`].filter((p) => p !== undefined).join('; ') };
  if (left > 0) parts.push(more(left, next!));
  return { body: capped(parts.join('\n')), shown: shown.map(span).join(','), ...(problem !== undefined ? { problem } : {}) };
}

