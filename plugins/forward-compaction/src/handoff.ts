// The forward_compaction tool contract: what the model may send, what is refused (never trimmed), and what the receipt says.

/** The tool's name as registered; the model sees `mcp__forward-compaction__forward_compaction`. */
export const FORWARD_TOOL = 'forward_compaction';

export const FORWARD_TOOL_DESCRIPTION =
  'Hands off your context — at a milestone once your context is large, or when a forward-compaction nudge asks. Stores your handoff; at Claude Code\'s next compaction everything before this call is replaced by it plus recorded facts (the person\'s messages or your brief, your skills), and every message after this call is kept verbatim. Returns a receipt saying when it installs; a refusal names what to fix and stores nothing. Example: forward_compaction({"handoff": "## Objective\\n…\\n## Done\\n…\\n## Remaining\\n…\\n## Next\\n…", "load_files": []}). Exact old detail later → look_back.';

export const FORWARD_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['handoff'],
  properties: {
    handoff: {
      type: 'string',
      description:
        'Markdown, at most 20000 characters, with these level-2 headings, each followed by at least one line: ## Objective (what the work is for and what done means), ## Done (finished pieces, each with how it was verified), ## Remaining (every step left, in order), ## Next (the first concrete action after the wake). Optional: ## Blocked (what waits on whom), ## Findings (decisions with why, errors verbatim). Write it for yourself after a reset: the messages before this call will be gone.',
    },
    load_files: {
      type: 'array',
      maxItems: 8,
      description: 'Files carried whole into the new context, read when it installs. A file too big to carry is named in the wake as not carried, never cut.',
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

export const HANDOFF_MAX_CHARS = 20_000;
export const LOAD_FILES_MAX = 8;
export const WHY_MAX_CHARS = 200;
export const LOAD_FILE_MAX_BYTES = 1_048_576;

/** One file the model asked to carry whole into the wake; every field is the model's own text, kept verbatim. */
export type LoadFile = { path: string; lines?: string; why: string };

export type ParsedHandoff = { handoff: string; loadFiles: LoadFile[] };
export type Refusal = { refusal: string };

const REQUIRED = ['Objective', 'Done', 'Remaining', 'Next'] as const;
const OPTIONAL = ['Blocked', 'Findings'] as const;
const PREFIX = 'forward_compaction refused, nothing stored: ';
const refuse = (text: string): Refusal => ({ refusal: PREFIX + text });
const num = (n: number): string => n.toLocaleString('en-US');
const kind = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const isAbsolutePath = (p: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The 1-based lines of `text` holding exactly `## {name}`; `\r` before the newline is whitespace. */
const headingLines = (lines: readonly string[], name: string): number[] => {
  const re = new RegExp(`^## ${name}\\s*$`);
  return lines.flatMap((line, i) => (re.test(line) ? [i] : []));
};

/**
 * Validates the model's tool input before anything is stored (V1-V11 of the spec table, first failure wins). The
 * handoff and the files come back exactly as sent: nothing is trimmed, a fault is refused for the model to fix.
 * `$.fs.stat` checks (V12-V15) are the adapter's, through `loadFileRefusal`.
 */
export function parseHandoff(input: unknown): ParsedHandoff | Refusal {
  const fields = isObject(input) ? input : {};
  for (const key of Object.keys(fields)) if (key !== 'handoff' && key !== 'load_files') return refuse(`unknown field "${key}". The fields are handoff and load_files.`);
  const { handoff, load_files: files } = fields;
  if (typeof handoff !== 'string') return refuse(`handoff must be a markdown string; got ${kind(handoff)}.`);
  if (handoff.length > HANDOFF_MAX_CHARS) return refuse(`the handoff is ${num(handoff.length)} characters, over the ${num(HANDOFF_MAX_CHARS)} cap. Shorten it (detail can go in load_files, or stay in the transcript for look_back) and call again.`);

  const lines = handoff.split('\n');
  const missing = REQUIRED.find((name) => headingLines(lines, name).length === 0);
  if (missing !== undefined) return refuse(`the handoff has no "## ${missing}" heading. Required, each followed by at least one line: ${REQUIRED.map((n) => `## ${n}`).join(', ')}. Call again with all four.`);
  for (const name of [...REQUIRED, ...OPTIONAL]) {
    const count = headingLines(lines, name).length;
    if (count > 1) return refuse(`the handoff has "## ${name}" ${count} times; give it once.`);
  }
  for (const name of REQUIRED) {
    const at = headingLines(lines, name)[0]!;
    const end = lines.findIndex((line, i) => i > at && line.startsWith('## '));
    if (!lines.slice(at + 1, end === -1 ? undefined : end).some((line) => line.trim() !== '')) return refuse(`"## ${name}" has no text under it.`);
  }

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

export type ReceiptInput =
  | { party: 'main'; chars: number; files: number; tokens?: number; askPoint?: number; replaced?: number }
  | { party: 'subagent'; chars: number; files: number; tokens: number; askPoint: number; replaced?: number };

const k = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

/** The tool result of a stored handoff: when it installs, true to the party's door (a sub-agent's only door is Claude Code's ask). */
export function receipt(input: ReceiptInput): string {
  const stored = `Handoff stored (${num(input.chars)} characters, ${input.files} files).`;
  const behind = 'Everything after this call is kept verbatim behind it';
  const replaced = input.replaced === undefined ? '' : ` It replaces the handoff you stored at ${k(input.replaced)}.`;
  if (input.party === 'main') return `${stored} It installs at the end of this turn, or at Claude Code's next compaction ask if one comes first. ${behind}, so finish the step in hand; you need not stop.${replaced}`;
  if (input.tokens >= input.askPoint) return `${stored} It installs at Claude Code's next compaction ask, before your next request. ${behind}.${replaced}`;
  return `${stored} Claude Code has not asked to compact you yet: it installs at Claude Code's next ask, from about ${k(input.askPoint)} context (you are at ${k(input.tokens)}). ${behind}. Carry on with your work.${replaced}`;
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

