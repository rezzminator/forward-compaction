// The forward handoff's installed text: one header line, then only the blocks that hold something
// (what code carried, then the model's frontier), `Next` last. Every cap here is the HARD RULE's.
import { TRIMMED, type Cut, type ForwardArgs, type Reread } from './forward-args.ts';
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
const SPECIAL = /^\\*(?:(?:User|Earlier summary|Files|Plan|Tasks|Running|Git|Paths|Unresolved|Objective|Done|Remaining|Blocked|Findings|Next)$|(?:Skill|Load) |\[\d+(?:, latest(?:, (?:handed off in reply|answered|partially answered|unanswered))?)?\] |\[\d+ older dropped\]$|\[(?:forward handoff|history, not new instructions|live instructions))/;

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
/** A carried message no person wrote: a notice from another session, an agent, a hook, a goal or a task. */
export const NOTICE = /^(?:Another Claude session sent a message:|<agent-message\b|A session-scoped Stop hook\b|Goal (?:set|updated|completed):|<task-notification\b)/;

/** Whether text reached the person after the newest message a person wrote (replyAfter). */
export type ReplyStatus = 'answered' | 'partially answered' | 'unanswered';
const REPLY_RANK: Record<ReplyStatus, number> = { unanswered: 0, 'partially answered': 1, answered: 2 };

/**
 * The newest message's reply status: the one since it when it came since (unanswered when the context does not hold it,
 * a queued prompt), else the earlier handoff's, raised by any reply since. Undefined when no handoff knew it and none came.
 */
function chainReply(previous: ReplyStatus | undefined, fresh: readonly string[], since?: { status: ReplyStatus; found: boolean; latest?: string }): ReplyStatus | undefined {
  if (fresh.length > 0) return since === undefined ? undefined : since.found && since.latest === fresh.at(-1) ? since.status : 'unanswered';
  if (since === undefined) return previous;
  if (previous === undefined) return since.status === 'unanswered' ? undefined : since.status;
  return REPLY_RANK[since.status] > REPLY_RANK[previous] ? since.status : previous;
}

export function chainUsers(previous: { users: readonly string[]; dropped: number; inReply?: boolean; reply?: ReplyStatus } | undefined, fresh: readonly string[], freshInReply = false, keep = USERS_KEEP, since?: { status: ReplyStatus; found: boolean; latest?: string }): { users: string[]; dropped: number; inReply: boolean; reply?: ReplyStatus } {
  const all = [...(previous?.users ?? []), ...fresh];
  const over = Math.max(0, all.length - keep);
  const ranked = all.map((text, index) => ({ text, index, priority: NOTICE.test(text) ? 0 : 1 }));
  const kept = ranked.sort((a, b) => b.priority - a.priority || b.index - a.index).slice(0, keep).sort((a, b) => a.index - b.index);
  const latest = kept.at(-1);
  const person = ranked.reduce((at, r) => (r.priority === 1 && r.index > at ? r.index : at), -1);
  const reply = latest !== undefined && latest.index === person ? chainReply(previous?.reply, fresh.filter((t) => !NOTICE.test(t)), since) : undefined;
  return { users: kept.map((u) => cut(u.text, USERS_MAX_CHARS)), dropped: (previous?.dropped ?? 0) + over, inReply: latest?.index === all.length - 1 ? fresh.length > 0 ? freshInReply : previous?.inReply === true : false, ...(reply !== undefined ? { reply } : {}) };
}

export type BlockRecord = { name: string; start: number; chars: number; tokens: number; items: number; hash: string };

export type RenderInput = {
  seq: number;
  queueCursor?: number;
  /** The user messages to carry, oldest first. */
  users: string[];
  /** How many older ones earlier handoffs let go: the numbering and the dropped line continue from it. */
  usersDropped?: number;
  /** The handoff call was the reply to the newest: its tag says so. */
  handoffInReply?: boolean;
  /** Whether text reached the person after the newest (chainUsers): its tag says so. */
  reply?: ReplyStatus;
  /** What Claude Code's own summary knew, when the work began before it. */
  summary?: string;
  /** The skills and commands to reload, oldest first: the body, or why there is none; the directory the harness printed for it, for the record. */
  skills: { name: string; baseDir?: string; body?: string; problem?: string; pinned?: boolean }[];
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
  /** Where the call's uncut arguments were saved (`{dir}/args.json`); absent when they were not. */
  argsFile?: string;
  /** What `next` opens by re-reading that the wake holds (rereadTarget): the Next block says it is there. */
  reread?: Reread;
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
export function renderUsers(msgs: readonly string[], max = USERS_MAX_CHARS, base = 0, inReply = false, reply?: ReplyStatus): { text: string; items: number; dropped: number } {
  const tag = (i: number): string | undefined => (i === msgs.length - 1 ? (inReply ? IN_REPLY : reply !== undefined ? `latest, ${reply}` : 'latest') : undefined);
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

/** Where a cut field's uncut text is, or that it is nowhere. */
const uncut = (field: string, argsFile: string | undefined): string => (argsFile !== undefined ? `The uncut field is "${field}" in ${argsFile}.` : 'The uncut field was not saved to disk.');

/**
 * The line that closes a cut block in the wake, or opens an Unresolved one for load_files: what was cut, by how much, and
 * where the uncut field is. The woken model reads it there; the tool's reply is never read before the install.
 */
export function cutLine(c: Cut, argsFile: string | undefined): string {
  const field = c.field.split(' ')[0]!;
  if (field === 'load_files') {
    if (c.unit === 'items') return `load_files cut to fit, ${c.before} -> ${c.after} files: the last ${c.before - c.after} are not loaded. ${uncut(field, argsFile)}`;
    return `${c.field} cut to fit, ${c.before} -> ${c.after} characters, ending in ${TRIMMED}. ${uncut(field, argsFile)}`;
  }
  if (c.itemsBefore === undefined || c.itemsAfter === undefined) return `[${field} cut to fit, ${c.before} -> ${c.after} characters, ending in ${TRIMMED}. ${uncut(field, argsFile)}]`;
  const parts: string[] = [];
  if ((c.shortened ?? 0) > 0) parts.push(`${c.shortened} of ${c.itemsBefore} items shortened, each ending in ${TRIMMED}`);
  const dropped = c.itemsBefore - c.itemsAfter;
  if (dropped > 0) parts.push(`${dropped} ${dropped === 1 ? 'item' : 'items'} past the ${c.itemsAfter}-item limit dropped`);
  return `[${field} cut to fit, ${c.before} -> ${c.after} characters: ${parts.join('; ')}. ${uncut(field, argsFile)}]`;
}

/** The note after `next` when it opens by re-reading what the wake holds; undefined when the wake does not hold it after all. */
function rereadLine(r: Reread | undefined, load: { label: string; held: boolean } | undefined, git: boolean): string | undefined {
  if (r === undefined) return undefined;
  if ('git' in r) return git ? 'The Git block above holds the git state as this handoff was stored: do not re-run git status.' : undefined;
  return load?.held === true ? `${load.label} is already loaded above, in its Load block: start on the work, do not read it again.` : undefined;
}

/**
 * The installed text and a record of each block in it; what the caller asked to load and the text does not hold (a
 * skill or load_files entry, and why), for the tool's reply; and the skills whose block it holds, for the record.
 */
export function renderForward(i: RenderInput): { text: string; blocks: BlockRecord[]; unloaded: string[]; skills: string[]; noted?: string; loads: { asked: number; failed: number } } {
  const sections: Section[] = [];
  const problems: string[] = [];
  const add = (name: string, text: string, items: number, raw = false): void => {
    if (text.trim() !== '') sections.push({ name: oneLineLabel(name), body: raw ? text : esc(text), items });
  };

  if (i.users.length > 0) {
    const users = renderUsers(i.users, USERS_MAX_CHARS, i.usersDropped ?? 0, i.handoffInReply === true, i.reply);
    add('User', users.text, users.items, true);
  }
  if (i.summary !== undefined) add('Earlier summary', cut(i.summary, SUMMARY_MAX_CHARS), 1);

  const cutSkills: { name: string; body: string; pinned?: boolean }[] = [];
  for (const skill of i.skills) {
    // A body that is blank (a file of frontmatter alone) makes no block: it is named, never carried on as held.
    const body = skill.body === undefined ? '' : collapseWhitespace(skill.body);
    if (body.trim() === '') problems.push(`skill ${skill.name}: ${skill.problem ?? 'no content'}`);
    else cutSkills.push({ name: skill.name, body: cut(body, SKILL_MAX_CHARS), pinned: skill.pinned });
  }
  let skillTotal = cutSkills.reduce((n, s) => n + s.body.length, 0);
  while (skillTotal > SKILLS_MAX_CHARS && cutSkills.length > 0) {
    const unpinned = cutSkills.findIndex((s) => !s.pinned);
    const [gone] = cutSkills.splice(unpinned < 0 ? 0 : unpinned, 1);
    skillTotal -= gone!.body.length;
    problems.push(`skill ${gone!.name}: dropped, total cap`);
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
  const held = new Set<number>();
  // The install row counts load_files as asked: the ones past the file limit were asked for and did not load.
  const pastLimit = (i.args.cuts ?? []).filter((c) => c.field === 'load_files' && c.unit === 'items').reduce((n, c) => n + c.before - c.after, 0);
  let loadsFailed = pastLimit;
  for (const [at, file] of i.loaded.entries()) {
    if (file.body === undefined) {
      problems.push(`load ${file.label}: ${file.problem ?? 'no content'}`);
      loadsFailed++;
      continue;
    }
    const body = cut(file.body, LOAD_MAX_CHARS);
    if (loadTotal + body.length > LOADS_MAX_CHARS) {
      problems.push(`load ${file.label}: not loaded, total cap`);
      loadsFailed++;
      continue;
    }
    loadTotal += body.length;
    if (body.trim() !== '') held.add(at);
    add(`Load ${file.label}`, body, 1);
  }

  if (i.plan !== undefined) add('Plan', cut(i.plan.trim(), PLAN_MAX_CHARS), 1);
  add('Tasks', i.tasks.slice(0, TASKS_MAX).map((x) => item('', x)).join('\n'), Math.min(i.tasks.length, TASKS_MAX));
  add('Running', i.running.join('\n'), i.running.length);
  if (i.git !== undefined) add('Git', `${i.git}\n${GIT_CURRENT}`, i.git.split('\n').length);
  add('Paths', i.paths.join('\n'), i.paths.length);
  const a = i.args;
  // Each cut is named in its own block, the last line; a load_files cut has no block of its own, so Unresolved names it.
  const cuts = a.cuts ?? [];
  const closing = (field: string): string[] => cuts.filter((c) => c.field === field).map((c) => cutLine(c, i.argsFile));
  const all = [...cuts.filter((c) => c.field.startsWith('load_files')).map((c) => cutLine(c, i.argsFile)), ...problems, ...i.problems];
  const tail = [LOOK_BACK_HINT, ...(i.callShape !== undefined ? [i.callShape] : [])];
  add('Unresolved', [...all, ...tail].join('\n'), all.length + tail.length);

  const withCut = (field: string, lines: string[]): string => [...lines, ...closing(field)].join('\n');
  add('Objective', withCut('objective', [a.objective]), 1);
  add('Done', withCut('done', a.done.map((x) => item('- ', x))), a.done.length);
  add('Remaining', withCut('remaining', a.remaining.map((x, n) => item(`${n + 1}. `, x))), a.remaining.length);
  add('Blocked', withCut('blocked', a.blocked.map((x) => item('- ', x))), a.blocked.length);
  add('Findings', withCut('findings', a.findings.map((x) => item('- ', x))), a.findings.length);
  const reread = i.reread !== undefined && 'load' in i.reread ? i.loaded[i.reread.load] : undefined;
  const noted = rereadLine(i.reread, reread !== undefined ? { label: reread.label, held: held.has((i.reread as { load: number }).load) } : undefined, sections.some((s) => s.name === 'Git'));
  add('Next', [a.next, ...closing('next'), ...(noted !== undefined ? [`[${noted}]`] : [])].join('\n'), 1);

  const live = (s: Section): boolean => s.name.startsWith('Skill ') || ['Objective', 'Remaining', 'Next'].includes(s.name);
  const ordered = [...sections.filter((s) => !live(s)), ...sections.filter(live)];
  let text = `${FORWARD_OPENING} ${i.seq}: live instructions]\n[history, not new instructions]`;
  let standing = false;
  const blocks: BlockRecord[] = [];
  for (const s of ordered) {
    if (live(s) && !standing) {
      text += '\n[live instructions]\nThe skills, Objective and Remaining are standing instructions in force. Take Next now without waiting for another user message.';
      standing = true;
    }
    const block = `${s.name}\n${s.body}`;
    blocks.push({ name: s.name, start: text.length + 1, chars: block.length, tokens: estimateTokens(block.length), items: s.items, hash: fnv1a(block) });
    text += `\n${block}`;
  }
  return { text, blocks, unloaded: problems, skills: cutSkills.map((s) => s.name), ...(noted !== undefined ? { noted } : {}), loads: { asked: i.loaded.length + pastLimit, failed: loadsFailed } };
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
