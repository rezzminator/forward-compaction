import { HAIKU_HOLDS } from './decide.ts';
// The forward handoff tool's own part: what the model writes (its frontier) and how it is read.
// Validation never refuses a call: a field over its limit is trimmed and marked, and only a missing required field is sent back.

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
  /** What in the arguments could not be used, for the wake text's Unresolved block; absent when nothing. */
  problems?: string[];
};

export type ForwardParse = { args: ForwardArgs } | { nudge: string };

export const FORWARD_TOOL_DESCRIPTION =
  "Hand off to yourself — compact at a clean point, never mid-edit. Code carries your user messages, skills, files, plan, git and running work; you write the frontier. `next` is the first action toward the user's latest explicit request. `done` holds verified items only; `findings` quote errors verbatim, nothing unconfirmed. Installs when your turn ends: end it then. Returns the stored size and saved path; a missing required field returns an error naming it. Example: forward_handoff({objective:'ship X', done:['a: tests pass'], remaining:['b'], next:'run c'})";

type Property = { type: string; description: string; items?: unknown };

const list = (description: string): Property => ({ type: 'array', items: { type: 'string' }, description });

export const FORWARD_INPUT_SCHEMA: { type: 'object'; properties: Record<string, Property>; required: string[]; additionalProperties: false } = {
  type: 'object',
  properties: {
    objective: { type: 'string', description: `The outcome now worked toward: which of the user's asks is current and what done means. At most ${FORWARD_LIMITS.objective} characters.` },
    done: list(`Finished pieces, each with how it was verified. At most ${FORWARD_LIMITS.doneItems} items, ${FORWARD_LIMITS.doneItems * FORWARD_LIMITS.doneChars} characters in all.`),
    remaining: list(`Every step left, in order. At most ${FORWARD_LIMITS.remainingItems} items, ${FORWARD_LIMITS.remainingItems * FORWARD_LIMITS.remainingChars} characters in all.`),
    next: { type: 'string', description: `The first concrete action after the wake, in line with the user's latest explicit request. At most ${FORWARD_LIMITS.next} characters.` },
    blocked: list(`What waits on whom. At most ${FORWARD_LIMITS.blockedItems} items, ${FORWARD_LIMITS.blockedItems * FORWARD_LIMITS.blockedChars} characters in all.`),
    findings: list(`Decisions with why, dead ends, discovered facts; errors verbatim; nothing unconfirmed. At most ${FORWARD_LIMITS.findingsItems} items, ${FORWARD_LIMITS.findingsItems * FORWARD_LIMITS.findingsChars} characters in all.`),
    load_files: {
      type: 'array',
      description: `Files code reads from disk at handoff time into the wake text, at most ${FORWARD_LIMITS.loadFiles}: {path, lines?: "10-40", why}.`,
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
function stringField(value: unknown, max: number, name: string, trimmed: string[]): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const text = value.trim();
  if (text.length > max) trimmed.push(name);
  return trimText(text, max);
}

/**
 * A list field: undefined when it is missing; blank items are dropped. The cap is the field's total budget
 * (items x chars) and its item count, never an item alone: a model that writes one long line keeps it whole
 * while the field fits. The list is cut once, where it crosses either, and marked.
 */
function listField(value: unknown, items: number, chars: number, name: string, trimmed: string[]): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  let raw: unknown[];
  if (typeof value === 'string') raw = value.split('\n').map((line) => line.replace(/^\s*[-*•]\s+/, ''));
  else if (Array.isArray(value)) raw = value;
  else return undefined;
  const all = raw.map((item) => (typeof item === 'string' ? item : item === undefined || item === null ? '' : String(item)).trim()).filter((item) => item !== '');
  const budget = items * chars;
  const out: string[] = [];
  let used = 0;
  let cut = false;
  for (const item of all) {
    if (out.length === items) {
      out[items - 1] = `${out[items - 1]!} ${TRIMMED}`;
      cut = true;
      break;
    }
    if (used + item.length > budget) {
      const room = budget - used;
      if (room > TRIMMED.length + 20) out.push(trimText(item, room));
      else if (out.length > 0) out[out.length - 1] = `${out[out.length - 1]!} ${TRIMMED}`;
      cut = true;
      break;
    }
    out.push(item);
    used += item.length;
  }
  if (cut) trimmed.push(name);
  return out;
}

/** The text of every field the tool does not define, as `name: text`: what a model wrote is never dropped silently. */
function unknownFields(input: Record<string, unknown>): string[] {
  return Object.entries(input)
    .filter(([key, value]) => !(key in FORWARD_INPUT_SCHEMA.properties) && typeof value === 'string' && value.trim() !== '')
    .map(([key, value]) => `${key}: ${(value as string).trim()}`);
}

function loadFiles(value: unknown, trimmed: string[], problems: string[]): LoadFileArg[] {
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
    out.push({ path: path.trim(), ...(range !== undefined ? { lines: range } : {}), why: trimText(typeof why === 'string' ? why.trim() : '', FORWARD_LIMITS.whyChars) });
  }
  if (out.length > FORWARD_LIMITS.loadFiles) {
    out.length = FORWARD_LIMITS.loadFiles;
    trimmed.push('load_files');
  }
  return out;
}

/** The model's arguments read into limits, or the one nudge naming every required field that is missing. */
export function parseForwardArgs(input: Record<string, unknown>): ForwardParse {
  const trimmed: string[] = [];
  const objective = stringField(input.objective, FORWARD_LIMITS.objective, 'objective', trimmed);
  const done = listField(input.done, FORWARD_LIMITS.doneItems, FORWARD_LIMITS.doneChars, 'done', trimmed);
  const remaining = listField(input.remaining, FORWARD_LIMITS.remainingItems, FORWARD_LIMITS.remainingChars, 'remaining', trimmed);
  const next = stringField(input.next, FORWARD_LIMITS.next, 'next', trimmed);
  const missing = [['objective', objective], ['done', done], ['remaining', remaining], ['next', next]].filter(([, v]) => v === undefined).map(([k]) => k as string);
  if (missing.length > 0) return { nudge: `Not stored: required ${missing.length === 1 ? 'field' : 'fields'} missing: ${missing.join(', ')}. Call forward_handoff again with ${missing.length === 1 ? 'it' : 'them'}.` };
  const blocked = listField(input.blocked, FORWARD_LIMITS.blockedItems, FORWARD_LIMITS.blockedChars, 'blocked', trimmed) ?? [];
  const findings = listField([...(listField(input.findings, Infinity, Infinity, 'findings', []) ?? []), ...unknownFields(input)], FORWARD_LIMITS.findingsItems, FORWARD_LIMITS.findingsChars, 'findings', trimmed) ?? [];
  const problems: string[] = [];
  const files = loadFiles(input.load_files, trimmed, problems);
  const dropSkills: string[] = [];
  for (const raw of listField(input.drop_skills, 100, 100, 'drop_skills', []) ?? []) {
    const name = raw.startsWith('/') ? raw.slice(1) : raw;
    if (name !== '' && !dropSkills.includes(name)) dropSkills.push(name);
  }
  // Report order is the field order of the tool, not of the checks.
  const order = ['objective', 'done', 'remaining', 'next', 'blocked', 'findings', 'load_files'];
  trimmed.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { args: { objective: objective!, done: done!, remaining: remaining!, next: next!, blocked, findings, loadFiles: files, dropSkills, trimmed, ...(problems.length > 0 ? { problems } : {}) } };
}

function k(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

/** What the main chat reads after a tool result once its context passes a nudge point, with the forward handoff tool on. */
export function forwardNudgeText({ tokens, level, autoCompact, toolName }: { tokens: number; level: number; autoCompact: number; toolName: string }): string {
  return [
    `sub-agent-compact: your context is ${k(tokens)} tokens, and every request re-sends all of it.`,
    'If the person is waiting on an answer, or only your final answer is left, give it and do not hand off.',
    level > 0 ? `Nudge ${level + 1}: at the next clean point, not mid-edit, call ${toolName}.` : `At the next clean point, not mid-edit, call ${toolName}.`,
    'Code carries the user messages, skills, files, plan, git and running work; you write the objective, done, remaining, findings and next.',
    `Compaction is forced at ${k(autoCompact)} whether you hand off or not.`,
  ].join(' ');
}

/** The tool's reply once the forward handoff is stored: its size by block, where it is saved, and to end the turn. */
export function forwardStoredText({ tokens, dir, blocks }: { tokens: number; dir?: string; blocks: { name: string; tokens: number }[] }): string {
  const sizes = blocks.map((b) => `${b.name} ${k(b.tokens)}`).join(', ');
  return `Forward handoff stored (${k(tokens)} tokens: ${sizes}).${dir !== undefined ? ` Saved to ${dir}.` : ''} It installs when this turn ends: end your turn now with one line to the person; do not call more tools.`;
}

/**
 * The reply to a forward handoff from a party that woke from one and is still below its first nudge point: a second
 * handoff there saves nothing, and a woken model that reads its handoff order as open would loop. Undefined otherwise.
 */
export function forwardRefusal({ woke, tokens, nudgeStart }: { woke: boolean; tokens: number | undefined; nudgeStart: number }): string | undefined {
  if (!woke || tokens === undefined || tokens >= nudgeStart) return undefined;
  return `Not stored: you woke from a forward handoff, and your context is ${k(tokens)}, below ${k(nudgeStart)}, where a handoff first pays. It is installed: continue its work from its Next block.`;
}

/** What a Haiku party reads when Claude Code's compaction of it is held for its forward handoff. */
export function forwardHoldText(toolName: string): string {
  return `sub-agent-compact: Claude Code is compacting your context now. Call ${toolName} as your very next step (objective, done, remaining, next); within ${HAIKU_HOLDS} steps it compacts with or without it.`;
}
