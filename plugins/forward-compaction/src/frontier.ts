// The forward_compaction tool contract: what the model may send, how a call changes the frontier the plugin holds
// (lists.ts), and what the result says. A call is never refused: whatever cannot be read is one note.

import { k, andList } from './nudge';
import type { WakeFile } from './wake';
import { LISTS, listApply, textApply, TEXTS, type Held, type Left, type ListCount, type ListName, type TextName } from './lists';
import { repairJson } from './repair';

/** The tool's name as registered; the model sees `mcp__forward-compaction__forward_compaction`. */
export const FORWARD_TOOL = 'forward_compaction';

export const FORWARD_TOOL_DESCRIPTION =
  'Compacts your large context between steps: once the step in hand has its result saved and checked, before reading for the next; what you have read is dropped. Your frontier is kept as numbered lists; send only changes: add texts, remove or edit by number; what you leave out stays. One fact or step per item. MANDATORY: keep it clean: each call removes what is finished, lifted or wrong, edits what changed. Always stores. Example: forward_compaction({"next": "Run the gate", "done": {"add": ["Parser merged, 41 tests pass"]}, "remaining": {"remove": [3]}}). Exact old detail later → look_back.';

/** What each list holds, as its field's description says it. */
const LIST_DESCRIPTION: Record<ListName, string> = {
  decisions: "Every ruling the user gave on how something gets done, in the user's words, each with its undo when one exists. A question the user put on hold goes to blocked.",
  done: 'Finished pieces, each with how it was verified; every figure with the command that produced it.',
  remaining: 'Every step left, in order. An added step lands last, or before a step it names: {"before": 4, "text": "..."}.',
  blocked: "Every question or choice on hold until the user answers, in the user's words; removed once answered.",
  findings: 'Your own choices with why, errors verbatim, the commands and recipes you will need again.',
  orders:
    "Every rule of the user's that binds the rest of the work (a prohibition, a limit, a rule), in the user's words; several may share one item. An instruction for one part of the work is no order: it goes to remaining. A rule the user changes is edited. A rule the user lifts leaves entirely, never kept as a LIFTED note: remove its item, or edit the item down to its other rules. Example: [2] reads 'Never push. Tests go in tests/. One CHANGELOG line per fix.' and the user drops the CHANGELOG rule. Wrong: {\"edit\": [{\"id\": 2, \"text\": \"Never push. Tests go in tests/. LIFTED: one CHANGELOG line per fix.\"}]}. Right: {\"edit\": [{\"id\": 2, \"text\": \"Never push. Tests go in tests/.\"}]}.",
};

/** One list field: its three operations, each optional. */
const listSchema = (name: ListName) => ({
  type: 'object',
  additionalProperties: false,
  description: LIST_DESCRIPTION[name],
  properties: {
    add: {
      type: 'array',
      description: 'New items, one text each; the result gives each its number. Your first call has only adds.',
      items: name === 'remaining' ? { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: false, required: ['text'], properties: { before: { type: 'integer' }, text: { type: 'string' } } }] } : { type: 'string' },
    },
    remove: { type: 'array', description: 'Numbers of items to drop, as the wake shows them: [2, 5].', items: { type: 'integer' } },
    edit: { type: 'array', description: 'Replaces one item\'s whole text: [{"id": 4, "text": "..."}].', items: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: { type: 'integer' }, text: { type: 'string' } } } },
  },
});

export const FORWARD_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    objective: { type: 'string', description: 'What the work is for and what done means. Send it on your first call, then only when it changes.' },
    next: { type: 'string', description: 'Every call: the first concrete action after the wake.' },
    decisions: listSchema('decisions'),
    done: listSchema('done'),
    remaining: listSchema('remaining'),
    blocked: listSchema('blocked'),
    findings: listSchema('findings'),
    orders: listSchema('orders'),
    storage: {
      type: 'object',
      additionalProperties: false,
      description: 'Markdown files you keep for a later step and read or edit yourself with Read and Edit; the wake lists each by name and description.',
      properties: {
        add: {
          type: 'array',
          description: '[{"name": "survey.md", "description": "one line the wake shows", "value": "the whole content"}] writes the file; without value it lists a file you wrote in the storage folder, or changes a listed entry\'s description.',
          items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' }, value: { type: 'string' } } },
        },
        remove: { type: 'array', description: 'Names to stop listing: ["survey.md"].', items: { type: 'string' } },
      },
    },
    load_files: {
      type: 'array',
      description: 'Files read into the new context when it installs: each up to 250 lines; a longer file or range carries its first 250 and names where to Read the rest.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Absolute path.' },
          lines: { type: 'string', description: 'Line ranges, like "10-40" or "1-60,160-185".' },
          why: { type: 'string', description: "One line, shown as the caption above the file's content." },
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

/** A call as read: each text and list change as sent (lists.ts reads them leniently), the storage change, the load files, and one note per argument skipped or read another way. */
export type ParsedCall = {
  texts: Partial<Record<TextName, unknown>>;
  lists: Partial<Record<ListName, unknown>>;
  /** Items the call sent outside its lists that join one: an unknown field's text joins findings, a `standing_orders` entry joins orders. */
  extra: Partial<Record<ListName, string[]>>;
  storage?: unknown;
  /** Absent when the call sent no `load_files`: the earlier call's stay. */
  loadFiles?: LoadFile[];
  /** The place in the call's `load_files` of each entry of `loadFiles`, so a note on one names the entry the model sent. */
  loadAt: number[];
  notes: string[];
};

/** Fields an older call shape held: each read one way or ignored, with a note. */
const OLD_FIELDS = ['standing_orders', 'lifted', 'keep_skills', 'drop_files', 'drop_skills'];
const FIELDS: string[] = [...TEXTS, ...LISTS, 'storage', 'load_files'];
const JSON_FIELDS = [...LISTS, 'storage', 'load_files', ...OLD_FIELDS] as string[];
const FIELDS_ARE = `The fields are ${FIELDS.slice(0, -1).join(', ')} and ${FIELDS.at(-1)}.`;
/** A value that holds nothing to keep: null, a blank text, an empty array or object. */
const hollow = (v: unknown): boolean => v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0) || (isObject(v) && Object.keys(v).length === 0);
const kind = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
/** Whether `p` is absolute, POSIX or Windows. */
export const isAbsolutePath = (p: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
/** `path` in `dir`: the session's directory, its trailing separators and the path's leading `./` dropped. */
const inDir = (dir: string, path: string): string => `${dir.replace(/[\\/]+$/, '')}/${path.replace(/^(\.[\\/])+/, '')}`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const FOLD = /<\/(\w+)>\s*<parameter name="(\w+)">/g;

/**
 * A text whose value holds its own closing tag and then `<parameter name="other">`: the model's call markup closed it
 * early and folded the parameters after it into its text. Each folded one is taken back out as its own field (a list,
 * storage or load_files one parsed as JSON, a list one that is no JSON kept as text), one note each. One that cannot be
 * (no field, one the call also sent, or a storage or load_files one that is not JSON) stays where it arrived, under its name.
 */
function unfold(input: Record<string, unknown>): { fields: Record<string, unknown>; notes: string[] } {
  const fields = { ...input };
  const notes: string[] = [];
  const known = [...FIELDS, ...OLD_FIELDS];
  for (const key of known) {
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
      const taken = `${at}: your call's markup closed ${key} early; taken back out as its own field.`;
      const keep = (why: string): void => void (kept.push(`[${name}, as it arrived inside ${key}]\n${text}`), notes.push(`${at}, but ${why}: kept in ${key} as it arrived.`));
      if (!known.includes(name)) keep(`${name} is no field`);
      else if (input[name] !== undefined) keep(`the call also sent ${name}`);
      else if (!JSON_FIELDS.includes(name)) (fields[name] = text, notes.push(taken));
      else {
        try {
          fields[name] = JSON.parse(text);
          notes.push(taken);
        } catch (err) {
          if ((LISTS as readonly string[]).includes(name)) (fields[name] = text, notes.push(taken));
          else keep(`it is not JSON (${(err as Error).message})`);
        }
      }
    }
    fields[key] = kept.join('\n\n');
  }
  return { fields, notes };
}

const OPS = ['add', 'remove', 'edit'];

/** What an argument's text holds when it is JSON: as it stands, or repaired (repair.ts) with the arguments found written after it in `beside`; undefined for a plain text. */
function jsonOf(key: string, text: string, list: boolean): { own: unknown; beside: Record<string, unknown>; repaired: boolean } | undefined {
  const json = /^\s*[[{]/.test(text);
  if (!json && !list) return undefined; // a list's text may be its operations written bare (`add: [...]`), which the repair reads
  if (json) {
    try {
      return { own: JSON.parse(text), beside: {}, repaired: false };
    } catch {
      // broken JSON: repaired below
    }
  }
  const fixed = repairJson(key, text);
  return fixed === undefined ? undefined : { ...fixed, repaired: true };
}

/**
 * A list, storage or load_files value that arrived as the text of its own JSON is read as that JSON, with one note; one
 * whose JSON is broken is repaired first (repair.ts). The text may also hold the fields the model wrote with it: inside a
 * list's object beside its operations (`{"add": [...], "remaining": {...}}`), or after a value closed early
 * (`{"add": [...]},"done": {...}}`); each is taken out as its own field. A text that is no JSON, or one holding a key that
 * is neither an operation nor a field the call left out, stays as it arrived, and lists.ts reads it as one added item.
 */
function unstring(fields: Record<string, unknown>, notes: string[]): void {
  const pending: string[] = [...LISTS, 'storage', 'load_files'];
  for (let key = pending.shift(); key !== undefined; key = pending.shift()) {
    const value = fields[key];
    if (typeof value !== 'string') continue;
    const list = (LISTS as readonly string[]).includes(key);
    const found = jsonOf(key, value, list);
    if (found === undefined) continue; // no JSON: a plain text, read as one
    const read = found.own;
    const inside = list && isObject(read) ? Object.keys(read).filter((k) => !OPS.includes(k)) : [];
    const others: Record<string, unknown> = { ...found.beside, ...Object.fromEntries(inside.map((k) => [k, (read as Record<string, unknown>)[k]])) };
    const names = Object.keys(others);
    if (names.some((k) => k === key || !FIELDS.includes(k) || fields[k] !== undefined)) continue;
    let mine: unknown; // stays undefined when the text held only other fields
    if (!list) {
      if (key === 'storage' ? !isObject(read) : !Array.isArray(read)) continue;
      mine = read;
    } else if (Array.isArray(read)) {
      if (read.length === 0 || !read.every((entry) => typeof entry === 'string' || isObject(entry))) continue;
      mine = read;
    } else if (isObject(read)) {
      const ops = Object.keys(read).filter((k) => OPS.includes(k));
      if (ops.length === 0 && names.length === 0) continue;
      if (ops.length > 0) mine = Object.fromEntries(ops.map((k) => [k, read[k]]));
    } else continue;
    if (mine === undefined) delete fields[key];
    else fields[key] = mine;
    for (const k of names) (fields[k] = others[k]), pending.push(k);
    const whole = found.repaired ? `${key} arrived as text whose JSON was broken: repaired and read, this result's lines show what it changed` : `${key} arrived as the text of its JSON: read as JSON`;
    notes.push(`${whole}${names.length === 0 ? '' : `, and ${andList(names)} inside it taken out as ${names.length === 1 ? 'its own field' : 'their own fields'}`}.`);
  }
}

/**
 * Reads the model's tool input; nothing is refused. Each text and list change is passed on as sent, for lists.ts to read
 * leniently, after a value sent as the text of its JSON is read as JSON (`unstring`). An unknown field's text joins findings under its name, one that holds nothing is ignored; `standing_orders` entries join orders as adds;
 * `lifted` is answered with orders.remove; keep_skills, drop_files, drop_skills and a load file's `later` are ignored;
 * each with one note. A load file's relative path is resolved against `cwd`, the session's directory, when known.
 * `$.fs.stat` checks (V12-V15) are the adapter's, through `loadFileNote`.
 */
export function parseCall(input: unknown, cwd?: string): ParsedCall {
  const { fields, notes } = unfold(isObject(input) ? input : {});
  unstring(fields, notes);
  const call: ParsedCall = { texts: {}, lists: {}, extra: {}, loadAt: [], notes };
  for (const name of TEXTS) if (fields[name] !== undefined) call.texts[name] = fields[name];
  for (const name of LISTS) if (fields[name] !== undefined) call.lists[name] = fields[name];
  if (fields.storage !== undefined) call.storage = fields.storage;
  const join = (name: ListName, text: string): void => void (call.extra[name] ??= []).push(text);
  for (const key of Object.keys(fields)) {
    if (FIELDS.includes(key)) continue;
    const value = fields[key];
    if (key === 'standing_orders') {
      const entries = Array.isArray(value) ? value : [value];
      const orders = entries.map((o) => (typeof o === 'string' ? o : isObject(o) && typeof o.order === 'string' ? o.order : '')).filter((o) => o.trim() !== '');
      for (const order of orders) join('orders', order);
      notes.push(`standing_orders is now orders: its ${orders.length} ${orders.length === 1 ? 'entry is' : 'entries are'} taken as orders.add.`);
    } else if (key === 'lifted') notes.push('lifted is no field: to lift an order, send its number in orders.remove. Nothing lifted.');
    else if (OLD_FIELDS.includes(key)) notes.push(`${key} is no field: ignored.`);
    else if (hollow(value)) notes.push(`unknown field "${key}" held nothing: ignored. ${FIELDS_ARE}`);
    else {
      join('findings', `[${key}, an argument forward_compaction does not take]\n${typeof value === 'string' ? value : JSON.stringify(value)}`);
      notes.push(`unknown field "${key}" added to findings. ${FIELDS_ARE}`);
    }
  }
  /** A path as sent, or resolved against `cwd`; a relative one is named in `notes` under `at`. */
  const resolve = (at: string, sent: string): string => {
    if (isAbsolutePath(sent)) return sent;
    if (cwd === undefined) return (notes.push(`${at} "${sent}" is relative and the session's directory is unknown: carried as given.`), sent);
    const path = inDir(cwd, sent);
    return (notes.push(`${at} "${sent}" is relative: carried as ${path}, in the session's directory.`), path);
  };
  const files = fields.load_files;
  if (files !== undefined && !Array.isArray(files)) notes.push('load_files must be an array of {path, lines?, why}: none carried.');
  else if (files !== undefined) {
    call.loadFiles = [];
    for (const [i, entry] of files.entries()) {
      const { path: sent, why, lines: ranges, later } = isObject(entry) ? entry : ({} as Record<string, unknown>);
      if (typeof sent !== 'string' || sent.trim() === '') {
        notes.push(`load_files[${i}].path must be a non-blank string; got ${kind(sent)}: skipped.`);
        continue;
      }
      const path = resolve(`load_files[${i}].path`, sent);
      const file: LoadFile = { path };
      if (later !== undefined) notes.push(`load_files[${i}].later is no field: ${path} is carried.`);
      if (ranges !== undefined && (typeof ranges !== 'string' || parseLineRanges(ranges) === undefined)) notes.push(`load_files[${i}].lines "${String(ranges)}" is not a range like "10-40" or "1-60,160-185": ${path} carried from line 1.`);
      else if (ranges !== undefined) file.lines = ranges as string;
      if (why !== undefined && typeof why !== 'string') notes.push(`load_files[${i}].why must be a string; got ${kind(why)}: ${path} carried without it.`);
      else if (why !== undefined && why.length > WHY_MAX_CHARS) (file.why = why.slice(0, WHY_MAX_CHARS)), notes.push(`load_files[${i}].why is ${why.length} characters, over ${WHY_MAX_CHARS}: cut to its first ${WHY_MAX_CHARS}.`);
      else if (why !== undefined && why.trim() !== '') file.why = why;
      call.loadFiles.push(file), call.loadAt.push(i);
    }
  }
  return call;
}

/** What one call did to the held frontier: the frontier after it, the result's lines and notes, each list and text changed with the values that left (for disk.ts), each list's counts, and the texts still missing. */
export type Applied = { held: Held; lines: string[]; notes: string[]; changed: { key: ListName | TextName; left: Left[] | string[] }[]; counts: Partial<Record<ListName, ListCount>>; missing: TextName[] };

/** Applies a call's texts and list changes to `held`, objective first, each list in LISTS order, an item joined from outside its list (`extra`) after the list's own change. Storage is storage.ts's. */
export function applyCall(held: Held, call: ParsedCall): Applied {
  const out: Applied = { held: { ...held, lists: { ...held.lists } }, lines: [], notes: [...call.notes], changed: [], counts: {}, missing: [] };
  const objective = textApply('objective', held.objective, call.texts.objective);
  for (const name of LISTS) {
    const changes = [call.lists[name], ...(call.extra[name] !== undefined ? [{ add: call.extra[name] }] : [])].filter((c) => c !== undefined);
    if (name === 'orders') out.lines.push(...objective.lines), out.notes.push(...objective.notes);
    for (const change of changes) {
      const r = listApply(name, out.held.lists[name], change, held.rounds);
      out.held.lists[name] = r.list;
      out.lines.push(...r.lines), out.notes.push(...r.notes);
      const c = out.counts[name] ?? { added: 0, removed: 0, edited: 0, skipped: 0 };
      out.counts[name] = { added: c.added + r.count.added, removed: c.removed + r.count.removed, edited: c.edited + r.count.edited, skipped: c.skipped + r.count.skipped };
      if (r.count.added + r.count.removed + r.count.edited > 0) out.changed.push({ key: name, left: r.left });
    }
  }
  const next = textApply('next', held.next, call.texts.next);
  out.lines.push(...next.lines), out.notes.push(...next.notes);
  for (const [name, r] of [['objective', objective], ['next', next]] as const) {
    if (r.text === undefined) delete out.held[name];
    else out.held[name] = r.text;
    if (r.text !== undefined && r.text !== held[name]) out.changed.push({ key: name, left: r.left === undefined ? [] : [r.left] });
    if (r.text === undefined) out.missing.push(name);
  }
  return out;
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

/** `tokens`: the party's last reading, absent when it has none; it picks the sentence and is never printed, being a step behind the call. `missing`: the texts the frontier still lacks, which its wake names. `hold`: why a sub-agent's call does not compact (parties.ts `checkpoint`). */
export type ReceiptInput =
  | { party: 'main'; files: number; tokens?: number; askPoint?: number; replaced?: boolean; missing?: readonly string[] }
  | { party: 'subagent'; files: number; tokens?: number; askPoint: number; replaced?: boolean; missing?: readonly string[]; hold?: 'early' | 'reading' };

/** The result's last sentences: when the frontier installs, true to the party's door (a sub-agent's only door is Claude Code's ask), and what it lacks; of a call that does not compact, why, and what the party does next. */
export function receipt(input: ReceiptInput): string {
  const missing = input.missing ?? [];
  const replaced = input.replaced ? ' This call applied on top of your earlier one since the last wake.' : '';
  const stored = `Frontier stored${input.files === 0 ? '' : ` with ${input.files} ${input.files === 1 ? 'file' : 'files'} to load`}${missing.length === 0 ? '' : `, without ${andList(missing)}: send ${missing.length === 1 ? 'it' : 'them'} before it installs, or the wake names ${missing.length === 1 ? 'it' : 'them'} missing`}.`;
  const behind = 'The newest messages after this call that fit are kept verbatim behind it, the rest named as not carried';
  if (input.party === 'main') return `${stored} It installs at the end of this turn, or at Claude Code's next compaction ask if one comes first. ${behind}, so finish the step in hand; you need not stop.${replaced}`;
  if (input.hold === 'early') return `${stored} No compaction now: your context has grown too little for one to pay, so nothing is dropped; a notice comes when one does. Carry on with your work.`;
  if (input.hold === 'reading') return `${stored} No compaction now: you have just read for the step ahead, and a compaction would drop that reading. Finish that step, then call again with what changed: that call compacts.`;
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


/** Each load file read now through `read` (`$.fs.read`), whole or by its lines, cut at `maxChars` when given; one that cannot be read is carried as its problem. */
export async function readLoadFiles(read: (path: string) => Promise<string>, files: readonly LoadFile[], maxChars?: number): Promise<WakeFile[]> {
  return Promise.all(files.map(async (file): Promise<WakeFile> => {
    try {
      const sliced = sliceFile(file.path, await read(file.path), file.lines === undefined ? undefined : parseLineRanges(file.lines), maxChars);
      return 'body' in sliced ? { ...file, ...(sliced.shown ? { lines: sliced.shown } : {}), content: sliced.body } : { ...file, problem: sliced.problem };
    } catch (error) {
      return { ...file, problem: error instanceof Error ? error.message : String(error) };
    }
  }));
}
