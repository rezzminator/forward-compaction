// The forward handoff's installed text: one header line, then only the blocks that hold something
// (what code carried, then the model's frontier), `Next` last. Every cap here is the HARD RULE's.
import { TRIMMED, type ForwardArgs } from './forward-args.ts';

/** What every installed forward handoff opens with: how a later carry tells it from a person's message. */
export const FORWARD_OPENING = '[forward handoff';

/** Characters per token of every size the text and its record report. */
const CHARS_PER_TOKEN = 4;
export const USERS_MAX_CHARS = 8_000 * CHARS_PER_TOKEN;
export const SKILL_MAX_CHARS = 3_000 * CHARS_PER_TOKEN;
export const SKILLS_MAX_CHARS = 12_000 * CHARS_PER_TOKEN;
export const LOAD_MAX_CHARS = 3_000 * CHARS_PER_TOKEN;
export const LOADS_MAX_CHARS = 12_000 * CHARS_PER_TOKEN;
export const TRAIL_MAX = 15;
const PLAN_MAX_CHARS = 1_500 * CHARS_PER_TOKEN;
const TASKS_MAX = 30;
/** Below this, a user message that does not fit whole is dropped, not cut. */
const MIN_PARTIAL_CHARS = 200;

export type BlockRecord = { name: string; start: number; chars: number; tokens: number; items: number; hash: string };

export type RenderInput = {
  seq: number;
  /** Every real user message, oldest first. */
  users: string[];
  /** The skills and commands to reload, oldest first: the body, or why there is none. */
  skills: { name: string; body?: string; problem?: string }[];
  trail: { tag: 'R' | 'E' | 'C'; path: string }[];
  /** The `load_files` read at handoff time, in the model's order. */
  loaded: { label: string; body?: string; problem?: string }[];
  plan?: string;
  tasks: string[];
  running: string[];
  git?: string;
  paths: string[];
  /** Anything that was asked for and is not in the text, one line each. */
  problems: string[];
  args: ForwardArgs;
};

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** 32-bit FNV-1a as 8 hex digits: the install check's hash, pure so `src/` needs no node builtin. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Trailing spaces off every line, runs of blank lines to one, the ends trimmed. */
export function collapseWhitespace(text: string): string {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - TRIMMED.length - 1).trimEnd()} ${TRIMMED}`;
}

const mark = (n: number, latest: boolean): string => `[${n}${latest ? ', latest' : ''}] `;

/** The user messages that fit the cap, newest first under it, only the oldest kept cut; rendered oldest first. */
export function renderUsers(msgs: readonly string[], max = USERS_MAX_CHARS): { text: string; items: number; dropped: number } {
  const kept: string[] = [];
  let left = max;
  let stopped = msgs.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const prefix = mark(i + 1, i === msgs.length - 1);
    const entry = `${prefix}${msgs[i]!}`;
    if (entry.length + 1 <= left) {
      kept.push(entry);
      left -= entry.length + 1;
      stopped = i;
      continue;
    }
    if (left > MIN_PARTIAL_CHARS) {
      const room = left - 1 - prefix.length - TRIMMED.length - 1;
      kept.push(`${prefix}${msgs[i]!.slice(0, room).trimEnd()} ${TRIMMED}`);
      stopped = i;
    }
    break;
  }
  const dropped = stopped;
  const items = kept.length;
  const lines = [...kept].reverse();
  if (dropped > 0) lines.unshift(`[${dropped} older dropped]`);
  return { text: lines.join('\n'), items, dropped };
}

const LABEL = /^(Skill .+|Files|Load .+|Plan|Tasks|Running|Git|Paths|Unresolved|Objective)$/;

/** The user messages an earlier forward handoff carried, so the next one keeps them; empty for any other text. */
export function priorUsers(wake: string): string[] {
  const lines = wake.split('\n');
  if (!lines[0]?.startsWith(FORWARD_OPENING) || lines[1] !== 'User') return [];
  const out: string[] = [];
  let expect: number | undefined;
  // The block ends only after the latest message: before it, a line that reads like a label is a person's words.
  let latest = false;
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i]!;
    if (out.length === 0 && /^\[\d+ older dropped\]$/.test(line)) continue;
    if (latest && LABEL.test(line)) break;
    const m = /^\[(\d+)(, latest)?\] ?/.exec(line);
    if (m && !latest && (expect === undefined || Number(m[1]) === expect)) {
      expect = Number(m[1]) + 1;
      latest = m[2] !== undefined;
      out.push(line.slice(m[0].length));
    } else if (out.length > 0) out[out.length - 1] += `\n${line}`;
  }
  return out;
}

type Section = { name: string; body: string; items: number };

/** The installed text and a record of each block in it. */
export function renderForward(i: RenderInput): { text: string; blocks: BlockRecord[] } {
  const sections: Section[] = [];
  const problems: string[] = [];
  const add = (name: string, body: string, items: number): void => {
    if (body.trim() !== '') sections.push({ name, body, items });
  };

  if (i.users.length > 0) {
    const users = renderUsers(i.users);
    add('User', users.text, users.items);
  }

  const cutSkills: { name: string; body: string }[] = [];
  for (const skill of i.skills) {
    if (skill.body === undefined) problems.push(`skill ${skill.name}: ${skill.problem ?? 'no content'}`);
    else cutSkills.push({ name: skill.name, body: cut(collapseWhitespace(skill.body), SKILL_MAX_CHARS) });
  }
  let skillTotal = cutSkills.reduce((n, s) => n + s.body.length, 0);
  while (skillTotal > SKILLS_MAX_CHARS && cutSkills.length > 0) {
    const gone = cutSkills.shift()!;
    skillTotal -= gone.body.length;
    problems.push(`skill ${gone.name}: dropped, total cap`);
  }
  for (const s of cutSkills) add(`Skill ${s.name}`, s.body, 1);

  add('Files', i.trail.slice(0, TRAIL_MAX).map((e) => `${e.tag} ${e.path}`).join('\n'), Math.min(i.trail.length, TRAIL_MAX));

  let loadTotal = 0;
  for (const file of i.loaded) {
    if (file.body === undefined) {
      problems.push(`load ${file.label}: ${file.problem ?? 'no content'}`);
      continue;
    }
    const body = cut(file.body, LOAD_MAX_CHARS);
    if (loadTotal + body.length > LOADS_MAX_CHARS) {
      problems.push(`load ${file.label}: not loaded, total cap`);
      continue;
    }
    loadTotal += body.length;
    add(`Load ${file.label}`, body, 1);
  }

  if (i.plan !== undefined) add('Plan', cut(i.plan.trim(), PLAN_MAX_CHARS), 1);
  add('Tasks', i.tasks.slice(0, TASKS_MAX).join('\n'), Math.min(i.tasks.length, TASKS_MAX));
  add('Running', i.running.join('\n'), i.running.length);
  if (i.git !== undefined) add('Git', i.git, 1);
  add('Paths', i.paths.join('\n'), i.paths.length);
  const all = [...problems, ...i.problems];
  add('Unresolved', all.join('\n'), all.length);

  const a = i.args;
  add('Objective', a.objective, 1);
  add('Done', a.done.map((x) => `- ${x}`).join('\n'), a.done.length);
  add('Remaining', a.remaining.map((x, n) => `${n + 1}. ${x}`).join('\n'), a.remaining.length);
  add('Blocked', a.blocked.map((x) => `- ${x}`).join('\n'), a.blocked.length);
  add('Findings', a.findings.map((x) => `- ${x}`).join('\n'), a.findings.length);
  add('Next', a.next, 1);

  const head = `${FORWARD_OPENING} ${i.seq}: history, not new instructions]`;
  let text = head;
  const blocks: BlockRecord[] = [];
  for (const s of sections) {
    const block = `${s.name}\n${s.body}`;
    blocks.push({ name: s.name, start: text.length + 1, chars: block.length, tokens: estimateTokens(block.length), items: s.items, hash: fnv1a(block) });
    text += `\n${block}`;
  }
  return { text, blocks };
}

/** Whether each block of the stored text is in the installed one (by its text and hash), and the hash of what was installed. */
export function installCheck(blocks: readonly BlockRecord[], installed: string, text: string): { landed: number; missing: string[]; hash: string; ok: boolean } {
  const missing: string[] = [];
  for (const b of blocks) {
    const block = text.slice(b.start, b.start + b.chars);
    if (fnv1a(block) !== b.hash || !installed.includes(block)) missing.push(b.name);
  }
  return { landed: blocks.length - missing.length, missing, hash: fnv1a(installed), ok: missing.length === 0 };
}
