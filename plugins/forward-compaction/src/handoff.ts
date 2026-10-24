// The forward_compaction tool contract: what the model may send, what is refused (never trimmed), and what the receipt says.

import { k } from './nudge.ts';
import { loadFilesRoom } from './window.ts';

/** The tool's name as registered; the model sees `mcp__forward-compaction__forward_compaction`. */
export const FORWARD_TOOL = 'forward_compaction';

export const FORWARD_TOOL_DESCRIPTION =
  'Hands off your context — at a clean milestone once context is large. Stores your handoff, one argument per section (20,000 characters in all), written for yourself after a reset; at your next compaction everything before this call is replaced by it plus recorded facts (the person\'s messages or your brief, your skills), and every later message stays verbatim. Returns a receipt of when it installs; a refusal names what to fix and stores nothing. Example: forward_compaction({"objective": "…", "done": "…", "remaining": "…", "next": "…", "load_files": []}). Exact old detail later → look_back.';

/** The handoff's sections in the order they are assembled: the argument, its heading, whether it is required, and what it holds. */
const SECTIONS = [
  { key: 'objective', heading: 'Objective', required: true, description: 'What the work is for and what done means.' },
  { key: 'done', heading: 'Done', required: true, description: 'Finished pieces, each with how it was verified.' },
  { key: 'remaining', heading: 'Remaining', required: true, description: 'Every step left, in order.' },
  { key: 'next', heading: 'Next', required: true, description: 'The first concrete action after the wake.' },
  { key: 'blocked', heading: 'Blocked', required: false, description: 'Optional: what waits on whom.' },
  { key: 'findings', heading: 'Findings', required: false, description: 'Optional: decisions with why, errors verbatim.' },
] as const;

export const FORWARD_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['objective', 'done', 'remaining', 'next'],
  properties: {
    objective: { type: 'string', description: SECTIONS[0].description },
    done: { type: 'string', description: SECTIONS[1].description },
    remaining: { type: 'string', description: SECTIONS[2].description },
    next: { type: 'string', description: SECTIONS[3].description },
    blocked: { type: 'string', description: SECTIONS[4].description },
    findings: { type: 'string', description: SECTIONS[5].description },
    load_files: {
      type: 'array',
      maxItems: 8,
      description: 'Files carried whole into the new context, read when it installs. Files that come to more than 5% of your window are refused at the call: pass lines ranges or fewer files.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'why'],
        properties: {
          path: { type: 'string', description: 'Absolute path.' },
          lines: { type: 'string', description: 'Line ranges, like "10-40" or "1-60,160-185".' },
          why: { type: 'string', maxLength: 200, description: 'What you need it for.' },
        },
      },
    },
  },
} as const;

// Format caps: design budgets on what the model may send, never a measured size.
/** The assembled handoff's cap: a frontier stays a page or two the woken model reads whole, well inside any wake budget. */
export const HANDOFF_MAX_CHARS = 20_000;
/** Load files per call: enough for a plan, a spec and the files in hand, few enough that each is named and chosen. */
export const LOAD_FILES_MAX = 8;
/** A load file's `why`: one line saying what it is for. */
export const WHY_MAX_CHARS = 200;
/** A load file's size on disk (1 MiB): a file past it is a dump to slice with `lines`, not a file to carry whole. */
export const LOAD_FILE_MAX_BYTES = 1_048_576;

/** One file the model asked to carry whole into the wake; every field is the model's own text, kept verbatim. */
export type LoadFile = { path: string; lines?: string; why: string };

export type ParsedHandoff = { handoff: string; loadFiles: LoadFile[] };
export type Refusal = { refusal: string };

const FIELDS = [...SECTIONS.map((section) => section.key), 'load_files'];
const PREFIX = 'forward_compaction refused, nothing stored: ';
const refuse = (text: string): Refusal => ({ refusal: PREFIX + text });
const num = (n: number): string => n.toLocaleString('en-US');
const kind = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const isAbsolutePath = (p: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One line per bad argument: an unknown field, a required section missing, not a string or blank, an optional one given but not a string. */
function argumentFaults(fields: Record<string, unknown>): string[] {
  const unknown = Object.keys(fields).filter((key) => !FIELDS.includes(key)).map((key) => `unknown field "${key}". The fields are ${FIELDS.slice(0, -1).join(', ')} and load_files.`);
  const sections = SECTIONS.flatMap(({ key, required }) => {
    const value = fields[key];
    if (required && (typeof value !== 'string' || value.trim() === '')) return [`${key} must be a non-blank string; got ${typeof value === 'string' ? 'a blank string' : kind(value)}.`];
    if (!required && value !== undefined && typeof value !== 'string') return [`${key} must be a string when given; got ${kind(value)}.`];
    return [];
  });
  return [...unknown, ...sections];
}

/**
 * Validates the model's tool input before anything is stored (V1-V11 of the spec table), every bad argument named in
 * one refusal, then assembles the handoff from its sections in order, an absent or blank optional one left out. Each
 * section's text and the files come back exactly as sent: nothing is trimmed, a fault is refused for the model to fix.
 * `$.fs.stat` checks (V12-V15) are the adapter's, through `loadFileRefusal`.
 */
export function parseHandoff(input: unknown): ParsedHandoff | Refusal {
  const fields = isObject(input) ? input : {};
  const faults = argumentFaults(fields);
  if (faults.length > 0) return refuse(faults.join('\n'));
  const handoff = SECTIONS.flatMap(({ key, heading }) => {
    const text = fields[key];
    return typeof text === 'string' && text.trim() !== '' ? [`## ${heading}\n${text}`] : [];
  }).join('\n\n');
  if (handoff.length > HANDOFF_MAX_CHARS) return refuse(`the handoff assembled from your sections is ${num(handoff.length)} characters, over the ${num(HANDOFF_MAX_CHARS)} cap. Shorten it (detail can go in load_files, or stay in the transcript for look_back) and call again.`);
  const files = fields.load_files;

  if (files === undefined) return { handoff, loadFiles: [] };
  if (!Array.isArray(files)) return refuse('load_files must be an array of {path, lines?, why}.');
  if (files.length > LOAD_FILES_MAX) return refuse(`load_files has ${files.length} entries, over the ${LOAD_FILES_MAX} cap.`);
  const loadFiles: LoadFile[] = [];
  for (const [i, entry] of files.entries()) {
    const { path, why, lines: ranges } = isObject(entry) ? entry : ({} as Record<string, unknown>);
    if (typeof path !== 'string' || !isAbsolutePath(path)) return refuse(`load_files[${i}].path must be an absolute path; got "${String(path)}".`);
    const whyLength = typeof why === 'string' ? why.length : 0;
    if (typeof why !== 'string' || why.trim() === '' || whyLength > WHY_MAX_CHARS) return refuse(`load_files[${i}].why must be 1\u2013${WHY_MAX_CHARS} characters; it is ${whyLength}.`);
    if (ranges !== undefined && (typeof ranges !== 'string' || parseLineRanges(ranges) === undefined)) return refuse(`load_files[${i}].lines "${String(ranges)}" is not a range like "10-40" or "1-60,160-185".`);
    loadFiles.push({ path, why, ...(ranges !== undefined ? { lines: ranges as string } : {}) });
  }
  return { handoff, loadFiles };
}

/** What the adapter learned from `$.fs.stat(path)` on one load file: its stat, or `absent` (ENOENT), or the error text of any other throw. */
export type FileCheck = { kind: 'file' | 'dir' | 'other'; size: number } | { absent: true } | { error: string };

/** V12-V15: the refusal for one load file (`index` is its place in `load_files`, from 0), or undefined when it can be carried. */
export function loadFileRefusal(index: number, path: string, check: FileCheck): string | undefined {
  const at = `load_files[${index}] ${path}`;
  if ('error' in check) return PREFIX + `${at} could not be checked: ${check.error}.`;
  if ('absent' in check) return PREFIX + `${at}: no such file.`;
  if (check.kind !== 'file') return PREFIX + `${at} is not a regular file.`;
  if (check.size > LOAD_FILE_MAX_BYTES) return PREFIX + `${at} is ${num(check.size)} bytes, over the ${num(LOAD_FILE_MAX_BYTES)} cap for a carried file.`;
  return undefined;
}

/** `tokens`: the party's last reading, absent when it has none; it picks the sentence and is never printed, being a step behind the call. */
export type ReceiptInput =
  | { party: 'main'; chars: number; files: number; tokens?: number; askPoint?: number; replaced?: boolean }
  | { party: 'subagent'; chars: number; files: number; tokens?: number; askPoint: number; replaced?: boolean };

/** The tool result of a stored handoff: when it installs, true to the party's door (a sub-agent's only door is Claude Code's ask). */
export function receipt(input: ReceiptInput): string {
  const stored = `Handoff stored (${num(input.chars)} characters, ${input.files} files).`;
  const behind = 'Everything after this call is kept verbatim behind it';
  const replaced = input.replaced ? ' It replaces the handoff you stored before.' : '';
  if (input.party === 'main') return `${stored} It installs at the end of this turn, or at Claude Code's next compaction ask if one comes first. ${behind}, so finish the step in hand; you need not stop.${replaced}`;
  if (input.tokens !== undefined && input.tokens >= input.askPoint) return `${stored} It installs at Claude Code's next compaction ask, before your next request. ${behind}.${replaced}`;
  return `${stored} Claude Code has not asked to compact you yet: it installs at Claude Code's next ask, from about ${k(input.askPoint)} context. ${behind}. Carry on with your work.${replaced}`;
}

/**
 * The refusal for load files whose content comes to more than `loadFilesRoom` of the party's max context at its measured
 * characters per token (`ratio`), each file named with its size (`chars`, as read for the wake: a `lines` range counts its
 * lines alone); undefined when they fit, and with no ratio (unmeasured yet), when nothing can be measured. Refused, never trimmed.
 */
export function loadRoomRefusal(files: readonly { path: string; chars: number }[], maxContext: number, ratio: number | undefined): string | undefined {
  const room = loadFilesRoom(maxContext, ratio);
  const total = files.reduce((sum, f) => sum + f.chars, 0);
  if (total <= room) return undefined;
  return [
    PREFIX + `load_files come to ${num(total)} characters, over the ${num(room)}-character room for carried files (5% of your ${k(maxContext)} max context):`,
    ...files.map((f) => `- ${f.path}: ${num(f.chars)} characters`),
    'Pass lines ranges (like "10-40" or "1-60,160-185") to carry only what you need, or fewer files, and call again.',
  ].join('\n');
}

/** The answer to a forward_compaction call from a party whose model is on the ignore list (`Parties.ignored`, the entry it matched): refused, nothing stored. Undefined for a party the plugin manages. */
export function ignoredRefusal(matched: string | undefined, ceiling: number | undefined): string | undefined {
  if (matched === undefined) return undefined;
  return `forward_compaction refused, nothing stored: your model is on forward-compaction's ignore list ("${matched}"), so it takes no handoff from you; carry on with your work, and at ${ceiling === undefined ? 'your ceiling' : k(ceiling)} the plugin compacts you mechanically.`;
}

/** Keys the tool.call event carries beside the tool's arguments. */
const EVENT_KEYS = new Set(['tool', 'tool_use_id', 'agentId']);

/** The arguments of a tool call: every key of the event but its own (a key that is not a field included, so the check names it) or, when none is there, the event's `input`. */
export function toolInput(e: Record<string, unknown>): Record<string, unknown> {
  const top: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(e)) if (!EVENT_KEYS.has(key) && key !== 'input' && value !== undefined) top[key] = value;
  if (Object.keys(top).length > 0) return top;
  const nested = e.input;
  return nested !== null && typeof nested === 'object' && !Array.isArray(nested) ? (nested as Record<string, unknown>) : {};
}

/** Every forward_compaction answer, receipt or refusal, ends with this line; `logDir` is the level-log directory, where the issues file lives. */
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
 * A file's text as `load_files` asked for it: whole without ranges, else its ranges in file order, overlapping or
 * touching ones merged, the lines between two of them named by one `[lines a-b not loaded]` line. `shown` is the ranges that loaded, clipped to the file. A range
 * past the file's end, or clipped by it, is a `problem`, and an empty load is one too: a slice of nothing never
 * reaches the wake as a Load block that says nothing.
 */
export function sliceFile(text: string, ranges: readonly { from: number; to: number }[] | undefined): { body: string; shown: string; problem?: string } | { problem: string } {
  if (ranges === undefined) return text.trim() === '' ? { problem: 'the file is empty' } : { body: text, shown: '' };
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const count = lines.length;
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
  for (const r of ordered) {
    if (r.from > count) {
      problems.push(`lines ${span(r)}: past the end of the file, which has ${count} ${count === 1 ? 'line' : 'lines'}`);
      continue;
    }
    const to = Math.min(r.to, count);
    if (to < r.to) problems.push(`lines ${span(r)}: the file ends at line ${count}`);
    const last = shown[shown.length - 1];
    if (last !== undefined && r.from > last.to + 1) parts.push(`[lines ${span({ from: last.to + 1, to: r.from - 1 })} not loaded]`);
    const taken = lines.slice(r.from - 1, to);
    if (taken.some((line) => line.trim() !== '')) held = true;
    parts.push(...taken);
    shown.push({ from: r.from, to });
  }
  const problem = problems.length > 0 ? problems.join('; ') : undefined;
  if (shown.length === 0) return { problem: problem ?? 'no lines asked for' };
  if (!held) return { problem: [problem, `lines ${shown.map(span).join(',')}: only blank lines`].filter((p) => p !== undefined).join('; ') };
  return { body: parts.join('\n'), shown: shown.map(span).join(','), ...(problem !== undefined ? { problem } : {}) };
}

