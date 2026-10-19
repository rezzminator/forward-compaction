// The forward handoff tool's own part: what the model writes (its frontier) and how it is read.
// Validation never refuses a call for its size: a field over its limit is trimmed and marked, and the wake names each cut. A
// missing required field is sent back; a `next` that opens by re-reading what the wake carries is stored, and the wake says so (rereadTarget).

/** The tool's short name; the model calls it as `mcp__sub-agent-compact__forward_handoff`. */
export const FORWARD_TOOL = 'forward_handoff';

/** Marks a field or item cut to its limit. */
export const TRIMMED = '[trimmed]';

export const FORWARD_LIMITS = {
  objective: 600,
  doneItems: 15,
  doneChars: 200,
  remainingItems: 15,
  remainingChars: 200,
  next: 400,
  blockedItems: 10,
  blockedChars: 200,
  findingsItems: 15,
  findingsChars: 300,
  loadFiles: 8,
  whyChars: 200,
} as const;

export type LoadFileArg = { path: string; lines?: string; why: string };

/**
 * A field cut to its limit: what it held and what it holds, in characters or, for a count of entries, in items; for a list,
 * its items before and after (only those past the count limit are dropped) and how many kept items were shortened.
 */
export type Cut = { field: string; unit: 'characters' | 'items'; before: number; after: number; itemsBefore?: number; itemsAfter?: number; shortened?: number };

/** A list field that arrived as a string, and the number of items it became. */
export type Converted = { field: string; items: number };

export type ForwardArgs = {
  objective: string;
  done: string[];
  remaining: string[];
  next: string;
  blocked: string[];
  findings: string[];
  loadFiles: LoadFileArg[];
  dropSkills: string[];
  /** The names of the fields that were cut to their limits. */
  trimmed: string[];
  /** Each cut with its size before and after; absent when none. */
  cuts?: Cut[];
  /** The list fields that arrived as a string; absent when none. */
  converted?: Converted[];
  /** What in the arguments could not be used, for the wake text's Unresolved block; absent when nothing. */
  problems?: string[];
};

export type ForwardParse = { args: ForwardArgs } | { nudge: string };

export const FORWARD_TOOL_DESCRIPTION =
  "Hand off to yourself — compact at a clean point, never mid-edit. Code carries your user messages, skills, files, plan, git and running work; you write the frontier. `next` is the first action toward the user's latest explicit request, never re-reading what the wake holds. `done` holds verified items only; `findings` quote errors verbatim, nothing unconfirmed. Installs before your next request. Returns the stored size and saved path; a missing required field returns an error naming it. Example: forward_handoff({objective:'ship X', done:['a: tests pass'], remaining:['b'], next:'run c'})";

type Property = { type: string; description: string; items?: unknown };

const list = (description: string): Property => ({ type: 'array', items: { type: 'string' }, description });

export const FORWARD_INPUT_SCHEMA: { type: 'object'; properties: Record<string, Property>; required: string[]; additionalProperties: false } = {
  type: 'object',
  properties: {
    objective: { type: 'string', description: `The outcome now worked toward: which of the user's asks is current and what done means. At most ${FORWARD_LIMITS.objective} characters.` },
    done: list(`Finished pieces, each with how it was verified. At most ${FORWARD_LIMITS.doneItems} items, ${FORWARD_LIMITS.doneItems * FORWARD_LIMITS.doneChars} characters in all.`),
    remaining: list(`Every step left, in order. At most ${FORWARD_LIMITS.remainingItems} items, ${FORWARD_LIMITS.remainingItems * FORWARD_LIMITS.remainingChars} characters in all.`),
    next: { type: 'string', description: `The first concrete action after the wake, in line with the user's latest explicit request; never re-reading a load_files file or checking git, which the wake already holds. At most ${FORWARD_LIMITS.next} characters.` },
    blocked: list(`What waits on whom. At most ${FORWARD_LIMITS.blockedItems} items, ${FORWARD_LIMITS.blockedItems * FORWARD_LIMITS.blockedChars} characters in all.`),
    findings: list(`Decisions with why, dead ends, discovered facts; errors verbatim; nothing unconfirmed. At most ${FORWARD_LIMITS.findingsItems} items, ${FORWARD_LIMITS.findingsItems * FORWARD_LIMITS.findingsChars} characters in all.`),
    load_files: {
      type: 'array',
      description: `Files code reads from disk at handoff time into the wake text, at most ${FORWARD_LIMITS.loadFiles}: {path, lines?: "10-40" or "1-60,160-185", why}.`,
      items: { type: 'object', properties: { path: { type: 'string' }, lines: { type: 'string' }, why: { type: 'string' } }, required: ['path', 'why'] },
    },
    drop_skills: list('Skills or commands not to reload after the wake.'),
  },
  required: ['objective', 'done', 'remaining', 'next'],
  additionalProperties: false,
};

/** `text` cut to `max` characters, ending in the mark. */
function trimText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - TRIMMED.length - 1).trimEnd()} ${TRIMMED}`;
}

/** A string field: undefined when it is missing (not a string, or blank). */
function stringField(value: unknown, max: number, name: string, trimmed: string[], cuts: Cut[]): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const text = value.trim();
  const out = trimText(text, max);
  if (text.length > max) {
    trimmed.push(name);
    cuts.push({ field: name, unit: 'characters', before: text.length, after: out.length });
  }
  return out;
}

const INLINE_MARK = /(?:^|\s)\(?(\d{1,2})[.)]\s+/g;

/** A string sent for a list, as its items: a JSON array's, one line's inline `1) a 2) b` numbering, else its lines without bullets or numbers. */
function splitText(value: string): string[] {
  const text = value.trim();
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((item) => (typeof item === 'string' ? item : JSON.stringify(item) ?? ''));
    } catch {
      // Not JSON: read as lines below.
    }
  }
  const lines = value.split('\n');
  if (lines.filter((line) => line.trim() !== '').length === 1) {
    const marks = [...text.matchAll(INLINE_MARK)].map((m) => ({ at: m.index, end: m.index + m[0].length, n: Number(m[1]) }));
    if (marks.length >= 2 && marks.every((m, at) => m.n === at + 1)) {
      const items = marks.map((m, at) => text.slice(m.end, marks[at + 1]?.at ?? text.length));
      return [text.slice(0, marks[0]!.at), ...items];
    }
  }
  return lines.map((line) => line.replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s+/, ''));
}

/**
 * A list field: undefined when it is missing; blank items are dropped. The cap is the field's total budget
 * (items x chars) and its item count, never an item alone: a model that writes one long line keeps it whole
 * while the field fits. Past the count, the last items are dropped. Past the budget, every item keeps its head:
 * the items under a fair share stay whole, and the rest are cut to that share, each ending in the mark. Within the
 * count limit the share is never below one item's chars, so no item is dropped for its size.
 */
function listField(value: unknown, items: number, chars: number, name: string, trimmed: string[], cuts: Cut[], converted: Converted[]): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  let raw: unknown[];
  if (typeof value === 'string') raw = splitText(value);
  else if (Array.isArray(value)) raw = value;
  else return undefined;
  const all = raw.map((item) => (typeof item === 'string' ? item : item === undefined || item === null ? '' : String(item)).trim()).filter((item) => item !== '');
  if (typeof value === 'string' && all.length > 0) converted.push({ field: name, items: all.length });
  const budget = items * chars;
  const counted = all.slice(0, items);
  const total = counted.reduce((n, item) => n + item.length, 0);
  let out = counted;
  let shortened = 0;
  if (total > budget) {
    const share = fairShare(counted.map((item) => item.length), budget);
    out = counted.map((item) => (item.length > share ? trimText(item, share) : item));
    shortened = counted.filter((item) => item.length > share).length;
  }
  if (out.length < all.length || shortened > 0) {
    trimmed.push(name);
    cuts.push({ field: name, unit: 'characters', before: all.reduce((n, item) => n + item.length, 0), after: out.reduce((n, item) => n + item.length, 0), itemsBefore: all.length, itemsAfter: out.length, shortened });
  }
  return out;
}

/** The largest whole share such that every length capped at it sums to at most `budget` (water-filling). */
function fairShare(lengths: readonly number[], budget: number): number {
  const sorted = [...lengths].sort((a, b) => a - b);
  let left = budget;
  for (const [at, length] of sorted.entries()) {
    const even = Math.floor(left / (sorted.length - at));
    if (length > even) return even;
    left -= length;
  }
  return Infinity;
}

/** The text of every field the tool does not define, as `name: text`: what a model wrote is never dropped silently. */
function unknownFields(input: Record<string, unknown>): string[] {
  return Object.entries(input)
    .filter(([key, value]) => !(key in FORWARD_INPUT_SCHEMA.properties) && typeof value === 'string' && value.trim() !== '')
    .map(([key, value]) => `${key}: ${(value as string).trim()}`);
}

function loadFiles(value: unknown, trimmed: string[], problems: string[], cuts: Cut[]): LoadFileArg[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push('load_files: not a list of {path, lines?, why}');
    return [];
  }
  const out: LoadFileArg[] = [];
  for (const [at, item] of value.entries()) {
    const path = item !== null && typeof item === 'object' ? (item as Record<string, unknown>).path : undefined;
    if (typeof path !== 'string' || path.trim() === '') {
      problems.push(`load_files item ${at + 1}: no path`);
      continue;
    }
    const { lines, why } = item as Record<string, unknown>;
    const range = typeof lines === 'number' ? String(lines) : typeof lines === 'string' && lines.trim() !== '' ? lines.trim() : undefined;
    const reason = typeof why === 'string' ? why.trim() : '';
    const kept = trimText(reason, FORWARD_LIMITS.whyChars);
    if (reason.length > FORWARD_LIMITS.whyChars) cuts.push({ field: `load_files why (${path.trim()})`, unit: 'characters', before: reason.length, after: kept.length });
    out.push({ path: path.trim(), ...(range !== undefined ? { lines: range } : {}), why: kept });
  }
  if (out.length > FORWARD_LIMITS.loadFiles) {
    cuts.push({ field: 'load_files', unit: 'items', before: out.length, after: FORWARD_LIMITS.loadFiles });
    out.length = FORWARD_LIMITS.loadFiles;
    trimmed.push('load_files');
  }
  return out;
}

/** What a field holds, in the words of the reply that names one of the wrong type. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return value.trim() === '' ? 'a blank string' : 'a string';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

/** The order the tool lists its fields in: every report about them follows it. */
const FIELD_ORDER = ['objective', 'done', 'remaining', 'next', 'blocked', 'findings', 'load_files', 'drop_skills'];
const rank = (field: string): number => FIELD_ORDER.indexOf(field.split(' ')[0]!);

/**
 * The model's arguments read into limits, or the one nudge naming every required field that is missing, each one of the
 * wrong type with what it got, and the call's whole shape: after a wake the deferred tool's schema is not in context.
 */
export function parseForwardArgs(input: Record<string, unknown>, toolName: string = FORWARD_TOOL): ForwardParse {
  const trimmed: string[] = [];
  const cuts: Cut[] = [];
  const converted: Converted[] = [];
  const objective = stringField(input.objective, FORWARD_LIMITS.objective, 'objective', trimmed, cuts);
  const done = listField(input.done, FORWARD_LIMITS.doneItems, FORWARD_LIMITS.doneChars, 'done', trimmed, cuts, converted);
  const remaining = listField(input.remaining, FORWARD_LIMITS.remainingItems, FORWARD_LIMITS.remainingChars, 'remaining', trimmed, cuts, converted);
  const next = stringField(input.next, FORWARD_LIMITS.next, 'next', trimmed, cuts);
  const required: [string, unknown, string][] = [['objective', objective, 'a string'], ['done', done, 'an array of strings'], ['remaining', remaining, 'an array of strings'], ['next', next, 'a string']];
  const missing = required.filter(([, got]) => got === undefined);
  if (missing.length > 0) {
    const wrong = missing.filter(([name]) => input[name] !== undefined).map(([name, , expects]) => `${name}: got ${kindOf(input[name])}, expects ${expects}.`);
    const head = `Not stored: required ${missing.length === 1 ? 'field' : 'fields'} missing: ${missing.map(([name]) => name).join(', ')}.`;
    return { nudge: [head, ...wrong, forwardCallShape(toolName)].join(' ') };
  }
  const blocked = listField(input.blocked, FORWARD_LIMITS.blockedItems, FORWARD_LIMITS.blockedChars, 'blocked', trimmed, cuts, converted) ?? [];
  // A string sent for findings is converted once, by the first read; the second only caps the list the unknown fields join.
  const findings = listField([...(listField(input.findings, Infinity, Infinity, 'findings', [], [], converted) ?? []), ...unknownFields(input)], FORWARD_LIMITS.findingsItems, FORWARD_LIMITS.findingsChars, 'findings', trimmed, cuts, []) ?? [];
  const problems: string[] = [];
  const files = loadFiles(input.load_files, trimmed, problems, cuts);
  const dropSkills: string[] = [];
  for (const raw of listField(input.drop_skills, 100, 100, 'drop_skills', [], [], converted) ?? []) {
    const name = raw.startsWith('/') ? raw.slice(1) : raw;
    if (name !== '' && !dropSkills.includes(name)) dropSkills.push(name);
  }
  // Report order is the field order of the tool, not of the checks.
  trimmed.sort((a, b) => rank(a) - rank(b));
  cuts.sort((a, b) => rank(a.field) - rank(b.field));
  converted.sort((a, b) => rank(a.field) - rank(b.field));
  return { args: { objective: objective!, done: done!, remaining: remaining!, next: next!, blocked, findings, loadFiles: files, dropSkills, trimmed, ...(cuts.length > 0 ? { cuts } : {}), ...(converted.length > 0 ? { converted } : {}), ...(problems.length > 0 ? { problems } : {}) } };
}

function k(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

const listShape = (items: number, chars: number): string => `array of strings, at most ${items} items, ${items * chars} characters in all`;

/**
 * The call's whole shape in one sentence: every field's name, type and limit. The tool is deferred, so a woken model
 * sees only its name; every text that sends it toward the tool carries this.
 */
export function forwardCallShape(toolName: string): string {
  const L = FORWARD_LIMITS;
  return [
    `Call ${toolName} with an object: objective (string, at most ${L.objective} characters), done (${listShape(L.doneItems, L.doneChars)}), remaining (${listShape(L.remainingItems, L.remainingChars)}), next (string, at most ${L.next} characters);`,
    `optional: blocked (${listShape(L.blockedItems, L.blockedChars)}), findings (${listShape(L.findingsItems, L.findingsChars)}), load_files (array of {path, lines?, why} objects, at most ${L.loadFiles}, why at most ${L.whyChars} characters), drop_skills (array of strings).`,
    'A field over its limit is trimmed, never refused.',
  ].join(' ');
}

/** What the main chat reads after a tool result once its context passes a nudge point, with the forward handoff tool on. */
export function forwardNudgeText({ tokens, level, autoCompact, toolName }: { tokens: number; level: number; autoCompact: number; toolName: string }): string {
  return [
    `sub-agent-compact: your context is ${k(tokens)} tokens, and every request re-sends all of it.`,
    'If the person is waiting on an answer, or only your final answer is left, give it and do not hand off.',
    level > 0 ? `Nudge ${level + 1}: at the next clean point, not mid-edit, call ${toolName}.` : `At the next clean point, not mid-edit, call ${toolName}.`,
    'Code carries the user messages, skills, files, plan, git and running work; you write the objective, done, remaining, findings and next.',
    `Compaction is forced at ${k(autoCompact)} whether you hand off or not.`,
    forwardCallShape(toolName),
  ].join(' ');
}

const cutText = (c: Cut): string =>
  c.itemsBefore !== undefined && c.itemsAfter !== undefined && c.itemsBefore !== c.itemsAfter
    ? `${c.field} ${c.itemsBefore} -> ${c.itemsAfter} items, ${c.before} -> ${c.after} ${c.unit}`
    : `${c.field} ${c.before} -> ${c.after} ${c.unit}`;

/**
 * The tool's reply once the forward handoff is stored: its size by block; each field cut to fit, with its size before
 * and after; each list read from a string and into how many items; each entry the wake does not hold, and why; where it
 * is saved; and when it installs. The install comes before the party's next request, so a sub-agent never reads this:
 * every fact it needs about a cut is in the wake. A main chat whose install waits for its turn's end is told to end it.
 */
export function forwardStoredText({ tokens, dir, blocks, cuts = [], converted = [], unloaded = [], toolName = FORWARD_TOOL, party = 'main' }: { tokens: number; dir?: string; blocks: { name: string; tokens: number }[]; cuts?: readonly Cut[]; converted?: readonly Converted[]; unloaded?: readonly string[]; toolName?: string; party?: 'main' | 'sub' }): string {
  const sizes = blocks.map((b) => `${b.name} ${k(b.tokens)}`).join(', ');
  const notes: string[] = [];
  if (cuts.length > 0) notes.push(`Cut to fit: ${cuts.map(cutText).join('; ')}; the wake names each cut and where its uncut field is${dir !== undefined ? `: ${dir}/args.json` : ''}.`);
  if (converted.length > 0) notes.push(`${converted.map((c) => `${c.field} was a string, read as ${c.items} ${c.items === 1 ? 'item' : 'items'}`).join('; ')}: send lists as arrays of strings.`);
  if (unloaded.length > 0) notes.push(`Not in the wake: ${unloaded.join('; ')}.`);
  const again = cuts.length > 0 || unloaded.length > 0;
  if (again && party === 'main') notes.push(`Calling ${toolName} again before it installs replaces this call.`);
  const installs = party === 'sub' ? 'It installs before your next request.' : `It installs before your next request, else when this turn ends: end your turn now with one line to the person; ${again ? 'do not call any other tool' : 'do not call more tools'}.`;
  // The saved directory stays right before the last sentence: a recovery reads it from there, the last such clause.
  return [`Forward handoff stored (${k(tokens)} tokens: ${sizes}).`, ...notes, ...(dir !== undefined ? [`Saved to ${dir}.`] : []), installs].join(' ');
}

/**
 * Whether a tool call is work past a wake, which ends the woken party's guard against a second handoff: any tool but
 * reaching the handoff (ToolSearch) or the plugin's own tools (`own`: the handoff, look_back and compact tools). A
 * woken model that loops calls those alone; one that ran any other tool has taken up the work again.
 */
export function worksPastWake(tool: unknown, own: readonly string[]): boolean {
  return typeof tool === 'string' && tool !== '' && tool !== 'ToolSearch' && !own.includes(tool);
}

/**
 * The reply to a forward handoff from a party that woke from one, has done no work since (worksPastWake), and is still
 * below its first nudge point: a second handoff there saves nothing, and a woken model that reads its handoff order as
 * open would loop. Undefined otherwise. The person's own ask after the wake lets the call through (askedToCompact), so
 * the reply says how to get one.
 */
export function forwardRefusal({ woke, tokens, nudgeStart }: { woke: boolean; tokens: number | undefined; nudgeStart: number }): string | undefined {
  if (!woke || tokens === undefined || tokens >= nudgeStart) return undefined;
  return `Not stored: you woke from a forward handoff and have done no work since, and your context is ${Math.floor(tokens / 1000)}k, below ${k(nudgeStart)}, where a handoff first pays. It is installed: continue its work from its Next block. A handoff the person asks for is stored: a message of theirs after this wake that asks to compact or hand off lets the call through, and their /compact compacts at once.`;
}

const ASK = /(?<![\w-])(?:compact\w*|hand[ -]?offs?|forward[_ ]handoff)\b/gi;
const NOT = /\b(?:don'?t|do not|never|not|no|stop|without)\b/i;

/**
 * Whether the person asked for a compaction or a handoff in one of these messages, the ones written since the wake: a
 * word for it (compact, compaction, handoff, hand off, forward_handoff) with no negation before it in its clause. A
 * name that only ends in it (sub-agent-compact, auto-compact) is no ask.
 */
export function askedToCompact(prompts: readonly string[]): boolean {
  return prompts.some((prompt) => [...prompt.matchAll(ASK)].some((m) => !NOT.test(prompt.slice(0, m.index).split(/[.!?;:,\n]/).pop() ?? '')));
}

const READ_VERB = /^\s*(?:re-?read|read|reload|open|cat|view|skim|review|look at)\b/i;
const GIT_CHECK = /\bgit\b.*\bstatus\b|\bcheck(?:ing)?\s+(?:the\s+)?git\b/i;
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What a `next` opens by re-reading that the wake already holds: a load_files entry, by its place in the list, or git. */
export type Reread = { load: number } | { git: true };

/**
 * What the first action of a `next` re-reads that the wake carries, or undefined: a file load_files puts in the wake, or
 * git, which the wake carries in its Git block. Only the first clause counts (up to `;`, `,`, `. ` or `then`): re-reading
 * as a later step is the model's call. The call is stored either way; the wake tells the woken model it holds it.
 */
export function rereadTarget(next: string, loads: readonly LoadFileArg[]): Reread | undefined {
  const first = next.split(/;|,|\.\s|\bthen\b/i)[0] ?? '';
  if (READ_VERB.test(first)) {
    const at = loads.findIndex(({ path }) => {
      const base = path.split('/').pop() ?? '';
      return first.includes(path) || (base.length >= 4 && new RegExp(`(?:^|[\\s/\`'"])${escapeRe(base)}(?=$|[\\s\`'":])`).test(first));
    });
    if (at >= 0) return { load: at };
  }
  if (GIT_CHECK.test(first)) return { git: true };
  return undefined;
}
