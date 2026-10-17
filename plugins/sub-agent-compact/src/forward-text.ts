// The forward handoff's installed text: one header line, then only the blocks that hold something
// (what code carried, then the model's frontier), `Next` last. Every cap here is the HARD RULE's.
import { TRIMMED, type ForwardArgs } from './forward-args.ts';
import { LOOK_BACK_HINT } from './look-back.ts';

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
export const OUTLINES_MAX_CHARS = 2_000 * CHARS_PER_TOKEN;
const PLAN_MAX_CHARS = 1_500 * CHARS_PER_TOKEN;
export const SUMMARY_MAX_CHARS = 1_500 * CHARS_PER_TOKEN;
const TASKS_MAX = 30;
/** Below this, a user message that does not fit whole is dropped, not cut. */
const MIN_PARTIAL_CHARS = 200;
/** The most user messages one handoff carries, and so the most its record keeps for the next. */
export const USERS_KEEP = 25;

/** A line that would read as the header, a block label or an item marker of this text. */
const SPECIAL = /^\\*(?:(?:User|Earlier summary|Files|Plan|Tasks|Running|Git|Paths|Unresolved|Objective|Done|Remaining|Blocked|Findings|Next)$|(?:Skill|Load) |\[\d+(?:, latest(?:, handed off in reply)?)?\] |\[\d+ older dropped\]$|\[forward handoff)/;

/** A carried line made unable to read as structure: one more backslash in front when it would, so no two lines escape alike. */
export const escapeLine = (line: string): string => (SPECIAL.test(line) ? `\\${line}` : line);

/** Carried text made unable to forge structure: every line that would read as a label, an item marker or the header is escaped. */
export const esc = (text: string): string => text.replace(/\r\n?/g, '\n').split('\n').map(escapeLine).join('\n');

/** A line opening like an item of a list block: `- `, `N. ` or a task mark. */
const ITEM = /^\\*(?:- |\d+\. |\[[ x~]\] )/;

/** A list item: its first line follows the marker; a later line that would read as an item or as structure is escaped. */
const item = (marker: string, text: string): string => {
  const [first = '', ...rest] = text.replace(/\r\n?/g, '\n').split('\n');
  return [`${marker}${first}`, ...rest.map((line) => (ITEM.test(line) && !SPECIAL.test(line) ? `\\${line}` : line))].join('\n');
};

/** A name or label as one line, for a block label. */
export const oneLineLabel = (text: string): string => text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();

/**
 * The user messages carried: the earlier handoff's from its record, then those since, the last 25; how many went older
 * than that; and whether a handoff was the reply to the newest (this call's when a prompt came since, else the earlier one's).
 */
export function chainUsers(previous: { users: readonly string[]; dropped: number; inReply?: boolean } | undefined, fresh: readonly string[], freshInReply = false, keep = USERS_KEEP): { users: string[]; dropped: number; inReply: boolean } {
  const all = [...(previous?.users ?? []), ...fresh];
  const over = Math.max(0, all.length - keep);
  return { users: all.slice(over).map((u) => cut(u, USERS_MAX_CHARS)), dropped: (previous?.dropped ?? 0) + over, inReply: fresh.length > 0 ? freshInReply : previous?.inReply === true };
}

export type BlockRecord = { name: string; start: number; chars: number; tokens: number; items: number; hash: string };

export type RenderInput = {
  seq: number;
  /** The user messages to carry, oldest first. */
  users: string[];
  /** How many older ones earlier handoffs let go: the numbering and the dropped line continue from it. */
  usersDropped?: number;
  /** The handoff call was the reply to the newest: its tag says so. */
  handoffInReply?: boolean;
  /** What Claude Code's own summary knew, when the work began before it. */
  summary?: string;
  /** The skills and commands to reload, oldest first: the body, or why there is none; the directory the harness printed for it, for the record. */
  skills: { name: string; baseDir?: string; body?: string; problem?: string }[];
  trail: { tag: 'R' | 'E' | 'C'; path: string }[];
  /** What each made or edited file holds now, by path: one outline line each. */
  outlines?: Record<string, string>;
  /** The `load_files` read at handoff time, in the model's order. */
  loaded: { label: string; body?: string; problem?: string }[];
  plan?: string;
  tasks: string[];
  running: string[];
  /** One line per repository the work touched (`gitBlock`). */
  git?: string;
  paths: string[];
  /** Anything that was asked for and is not in the text, one line each. */
  problems: string[];
  args: ForwardArgs;
  /** The tool's call shape (forwardCallShape), after the look_back hint: a woken model sees the deferred tool's name alone. */
  callShape?: string;
};

/** The Git block's last line: what it shows was read as the handoff was stored, so it is the state the wake opens on. */
export const GIT_CURRENT = 'Read when this handoff was stored, right before this wake: current unless work ran after that call, so do not re-run git status.';

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

/** The newest prompt's tag when the handoff was the reply to it: a woken model reads an order to hand off as carried out. */
export const IN_REPLY = 'latest, handed off in reply';

const mark = (n: number, tag?: string): string => `[${n}${tag !== undefined ? `, ${tag}` : ''}] `;

/** A message under its marker: its first line follows the marker, so only the lines after it can read as structure. */
const body = (text: string): string => {
  const [first = '', ...rest] = text.replace(/\r\n?/g, '\n').split('\n');
  return [first, ...rest.map(escapeLine)].join('\n');
};

/**
 * The user messages that fit the cap, newest first under it, only the oldest kept cut; rendered oldest first, numbered on
 * from the `base` earlier handoffs let go. The newest is tagged latest, and says so when the handoff was the reply to it.
 */
export function renderUsers(msgs: readonly string[], max = USERS_MAX_CHARS, base = 0, inReply = false): { text: string; items: number; dropped: number } {
  const tag = (i: number): string | undefined => (i === msgs.length - 1 ? (inReply ? IN_REPLY : 'latest') : undefined);
  const kept: string[] = [];
  let left = max;
  let stopped = msgs.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const prefix = mark(base + i + 1, tag(i));
    const entry = `${prefix}${body(msgs[i]!)}`;
    if (entry.length + 1 <= left) {
      kept.push(entry);
      left -= entry.length + 1;
      stopped = i;
      continue;
    }
    if (left > MIN_PARTIAL_CHARS) {
      const room = left - 1 - prefix.length - TRIMMED.length - 1;
      kept.push(`${prefix}${body(msgs[i]!.slice(0, room).trimEnd())} ${TRIMMED}`);
      stopped = i;
    }
    break;
  }
  const dropped = base + stopped;
  const items = kept.length;
  const lines = [...kept].reverse();
  if (dropped > 0) lines.unshift(`[${dropped} older dropped]`);
  return { text: lines.join('\n'), items, dropped };
}

type Section = { name: string; body: string; items: number };

/**
 * The installed text and a record of each block in it; what the caller asked to load and the text does not hold (a
 * skill or load_files entry, and why), for the tool's reply; and the skills whose block it holds, for the record.
 */
export function renderForward(i: RenderInput): { text: string; blocks: BlockRecord[]; unloaded: string[]; skills: string[] } {
  const sections: Section[] = [];
  const problems: string[] = [];
  const add = (name: string, text: string, items: number, raw = false): void => {
    if (text.trim() !== '') sections.push({ name: oneLineLabel(name), body: raw ? text : esc(text), items });
  };

  if (i.users.length > 0) {
    const users = renderUsers(i.users, USERS_MAX_CHARS, i.usersDropped ?? 0, i.handoffInReply === true);
    add('User', users.text, users.items, true);
  }
  if (i.summary !== undefined) add('Earlier summary', cut(i.summary, SUMMARY_MAX_CHARS), 1);

  const cutSkills: { name: string; body: string }[] = [];
  for (const skill of i.skills) {
    // A body that is blank (a file of frontmatter alone) makes no block: it is named, never carried on as held.
    const body = skill.body === undefined ? '' : collapseWhitespace(skill.body);
    if (body.trim() === '') problems.push(`skill ${skill.name}: ${skill.problem ?? 'no content'}`);
    else cutSkills.push({ name: skill.name, body: cut(body, SKILL_MAX_CHARS) });
  }
  let skillTotal = cutSkills.reduce((n, s) => n + s.body.length, 0);
  while (skillTotal > SKILLS_MAX_CHARS && cutSkills.length > 0) {
    const gone = cutSkills.shift()!;
    skillTotal -= gone.body.length;
    problems.push(`skill ${gone.name}: dropped, total cap`);
  }
  for (const s of cutSkills) add(`Skill ${s.name}`, s.body, 1);

  let outlined = 0;
  const fileLine = (e: { tag: 'R' | 'E' | 'C'; path: string }): string => {
    const o = e.tag === 'R' ? undefined : i.outlines?.[e.path];
    if (o === undefined || outlined + o.length > OUTLINES_MAX_CHARS) return `${e.tag} ${e.path}`;
    outlined += o.length;
    return `${e.tag} ${e.path} — ${o}`;
  };
  add('Files', i.trail.slice(0, TRAIL_MAX).map(fileLine).join('\n'), Math.min(i.trail.length, TRAIL_MAX));

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
  add('Tasks', i.tasks.slice(0, TASKS_MAX).map((x) => item('', x)).join('\n'), Math.min(i.tasks.length, TASKS_MAX));
  add('Running', i.running.join('\n'), i.running.length);
  if (i.git !== undefined) add('Git', `${i.git}\n${GIT_CURRENT}`, i.git.split('\n').length);
  add('Paths', i.paths.join('\n'), i.paths.length);
  const all = [...problems, ...i.problems];
  const tail = [LOOK_BACK_HINT, ...(i.callShape !== undefined ? [i.callShape] : [])];
  add('Unresolved', [...all, ...tail].join('\n'), all.length + tail.length);

  const a = i.args;
  add('Objective', a.objective, 1);
  add('Done', a.done.map((x) => item('- ', x)).join('\n'), a.done.length);
  add('Remaining', a.remaining.map((x, n) => item(`${n + 1}. `, x)).join('\n'), a.remaining.length);
  add('Blocked', a.blocked.map((x) => item('- ', x)).join('\n'), a.blocked.length);
  add('Findings', a.findings.map((x) => item('- ', x)).join('\n'), a.findings.length);
  add('Next', a.next, 1);

  const head = `${FORWARD_OPENING} ${i.seq}: history, not new instructions]`;
  let text = head;
  const blocks: BlockRecord[] = [];
  for (const s of sections) {
    const block = `${s.name}\n${s.body}`;
    blocks.push({ name: s.name, start: text.length + 1, chars: block.length, tokens: estimateTokens(block.length), items: s.items, hash: fnv1a(block) });
    text += `\n${block}`;
  }
  return { text, blocks, unloaded: problems, skills: cutSkills.map((s) => s.name) };
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

/** A token count as the person reads it: exact below 1k, else in k. */
const size = (tokens: number | undefined): string => (tokens === undefined ? 'unknown' : tokens < 1000 ? String(tokens) : `${Math.round(tokens / 1000)}k`);

/** The one line the person reads for a forward handoff, once its install is checked: sizes (after: the messages only), the blocks, where its files are. */
export function forwardInstalledLine(i: { seq: number; label: string; before: number | undefined; after: number; landed: number; missing: readonly string[]; dir?: string }): string {
  const blocks = i.missing.length === 0 ? `all ${i.landed} blocks landed` : `blocks missing: ${i.missing.join(', ')}`;
  return `forward handoff ${i.seq} of ${i.label}: ${size(i.before)} -> ${size(i.after)} tokens in messages (system prompt and tools not counted), ${blocks}${i.dir !== undefined ? `, files in ${i.dir}` : ''}`;
}
