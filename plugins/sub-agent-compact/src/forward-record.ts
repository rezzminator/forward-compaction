// What a forward handoff leaves on disk: where, and the measurement record the experiment reads.
import { estimateTokens, fnv1a, type BlockRecord } from './forward-text.ts';
import { isHarnessText, type HandoffMessage } from './handoff.ts';

/** A skill or command a wake carried: its name, and the directory the harness printed for it. */
export type SkillRef = { name: string; baseDir?: string };
const isSkillRef = (x: unknown): x is SkillRef => x !== null && typeof x === 'object' && typeof (x as SkillRef).name === 'string' && ((x as SkillRef).baseDir === undefined || typeof (x as SkillRef).baseDir === 'string');

type TrailEntry = { tag: 'R' | 'E' | 'C'; path: string };
const isTrailEntry = (t: unknown): t is TrailEntry =>
  t !== null && typeof t === 'object' && ['R', 'E', 'C'].includes((t as TrailEntry).tag) && typeof (t as TrailEntry).path === 'string';

const ROOT = 'sub-agent-compact/forward-handoff';

const safe = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * Where records live, the one written first: `$HOME/.local/state/sub-agent-compact/forward-handoff`, which a
 * CLAUDE_CONFIG_DIR or account switch leaves in place, then `<config dir>/sub-agent-compact/forward-handoff`, where
 * earlier versions wrote and which stays read. Without HOME the config directory's is written. None → [].
 */
export function forwardRoots({ home, configDir }: { home?: string; configDir?: string }): string[] {
  const roots = [...(home ? [`${home}/.local/state/${ROOT}`] : []), ...(configDir ? [`${configDir}/${ROOT}`] : [])];
  return [...new Set(roots)];
}

/** The directory of one loop's calls under a root: the session's for the main chat, `agent-<id>` inside it for a sub-agent. */
export function forwardSessionDir(root: string, session: string, agentId?: string): string {
  const dir = `${root}/${safe(session)}`;
  return agentId === undefined ? dir : `${dir}/agent-${safe(agentId)}`;
}

/** The directory of one call: `<root>/<session>[/agent-<id>]/<n>`. */
export function forwardDir(root: string, session: string, seq: number, agentId?: string): string {
  return `${forwardSessionDir(root, session, agentId)}/${seq}`;
}

/** The number of the next call, from the names already in the session's directory. */
export function nextSeq(names: readonly string[]): number {
  let top = 0;
  for (const name of names) if (/^\d+$/.test(name)) top = Math.max(top, Number(name));
  return top + 1;
}

/**
 * The claim of a call number in one process, so the answer is the directory's own: from $2, the first number free in
 * the session's directory $1 and, when $3 names one, in the other root's; mkdir makes it, atomically, so an earlier
 * call's files are never written over. Prints the number; exits 1 when $1 cannot hold one.
 */
export const FORWARD_CLAIM_SCRIPT = `mkdir -p "$1" || exit 1
n=$2
while :; do
  if [ -n "$3" ] && [ -e "$3/$n" ]; then n=$((n + 1)); continue; fi
  if mkdir "$1/$n" 2>/dev/null; then printf %s "$n"; exit 0; fi
  [ -e "$1/$n" ] || exit 1
  n=$((n + 1))
done`;

/** The argv of the claim: the session directory a call is saved in, the number to start from, the other root's session directory or none. */
export function forwardClaimArgv(sessionDir: string, start: number, otherSessionDir?: string): string[] {
  return ['/bin/sh', '-c', FORWARD_CLAIM_SCRIPT, 'forward-claim', sessionDir, String(start), otherSessionDir ?? ''];
}

/** The `saved {dir}` a wake text's Paths line names, the last such line's; undefined when it names none. */
export function savedOf(text: string): string | undefined {
  const lines = [...text.matchAll(/^Paths\n(.+)$/gm)];
  const item = lines.at(-1)?.[1]?.split(' · ').find((part) => part.startsWith('saved /'));
  return item?.slice('saved '.length);
}

/** The number of the call `dir` is when it is one of this party's own, under a root: `<root>/<session>[/agent-<id>]/<n>`. */
export function ownCall(dir: string, roots: readonly string[], session: string, agentId?: string): number | undefined {
  for (const root of roots) {
    const prefix = `${forwardSessionDir(root, session, agentId)}/`;
    if (dir.startsWith(prefix) && /^\d+$/.test(dir.slice(prefix.length))) return Number(dir.slice(prefix.length));
  }
  return undefined;
}

/**
 * The number this call is stored under: past every call the listing shows, the ones this process counted, and the
 * handoff the context holds now, so a handoff that was armed but never saved (its claim failed) and then lost from the
 * process's count by a restart is never numbered again, and never read back as this call's own earlier handoff.
 */
export function firstSeq(i: { listed: readonly string[]; counted?: number; held?: string }): number {
  const held = i.held !== undefined ? /^\[forward handoff (\d+)/.exec(i.held)?.[1] : undefined;
  return Math.max(nextSeq(i.listed), (i.counted ?? 0) + 1, held !== undefined ? Number(held) + 1 : 1);
}

/** The directory of the call before this one, undefined for the first. */
export function previousDir(root: string, session: string, seq: number, agentId?: string): string | undefined {
  return seq > 1 ? forwardDir(root, session, seq - 1, agentId) : undefined;
}

export type ForwardRecord = Record<string, unknown>;

/** The record of one call at handoff time: the size of every block and of the whole text. */
export function buildRecord(i: { seq: number; session: string; agentId?: string; dir: string; text: string; blocks: readonly BlockRecord[]; users: readonly string[]; usersDropped: number; handoffInReply?: boolean; trail?: readonly TrailEntry[]; summary?: string; tokensBefore?: number; trimmed: readonly string[]; skills?: readonly SkillRef[]; queueCursor?: number; at?: string; loads?: { asked: number; failed: number } }): ForwardRecord {
  return {
    seq: i.seq,
    session: i.session,
    ...(i.agentId !== undefined ? { agentId: i.agentId } : {}),
    dir: i.dir,
    textHash: fnv1a(i.text),
    users: [...i.users],
    usersDropped: i.usersDropped,
    ...(i.queueCursor !== undefined ? { queueCursor: i.queueCursor } : {}),
    ...(i.handoffInReply === true ? { handoffInReply: true } : {}),
    ...(i.summary !== undefined ? { summary: i.summary } : {}),
    ...(i.skills !== undefined ? { skills: i.skills.map((x) => ({ name: x.name, ...(x.baseDir !== undefined ? { baseDir: x.baseDir } : {}) })) } : {}),
    ...(i.trail !== undefined ? { trail: i.trail.map((t) => ({ tag: t.tag, path: t.path })) } : {}),
    ...(i.at !== undefined ? { at: i.at } : {}),
    ...(i.tokensBefore !== undefined ? { tokensBefore: i.tokensBefore } : {}),
    trimmed: [...i.trimmed],
    ...(i.loads !== undefined ? { loads: { asked: i.loads.asked, failed: i.loads.failed } } : {}),
    total: { chars: i.text.length, tokens: estimateTokens(i.text.length) },
    blocks: i.blocks.map((b) => ({ name: b.name, chars: b.chars, tokens: b.tokens, items: b.items, hash: b.hash })),
  };
}

/**
 * The install row's load counts: a forward handoff's load_files from its record (asked, and those that did not load),
 * else the load_on_wake entries of a plain handoff. A record saved before it counted its loads counts its Load blocks,
 * the ones that landed, and leaves the failures unknown (null).
 */
export function handoffLoads(entries: number, failed: number, record?: ForwardRecord): { loads: number; loadsFailed: number | null } {
  if (record === undefined) return { loads: entries, loadsFailed: failed };
  const counted = record.loads as { asked?: unknown; failed?: unknown } | undefined;
  if (typeof counted?.asked === 'number' && typeof counted.failed === 'number') return { loads: counted.asked, loadsFailed: counted.failed };
  const blocks = Array.isArray(record.blocks) ? (record.blocks as { name?: unknown }[]) : [];
  return { loads: blocks.filter((b) => typeof b.name === 'string' && b.name.startsWith('Load ')).length, loadsFailed: null };
}

/** The record once installed: the size after (the messages only), and what the install check found. */
export function withInstall(record: ForwardRecord, i: { tokensAfter: number; check: { landed: number; missing: string[]; hash: string; ok: boolean } }): ForwardRecord {
  return { ...record, tokensAfter: i.tokensAfter, tokensAfterScope: 'messages', install: i.check };
}

/**
 * The wake's line for a held handoff no record carries: every place looked, the saved one that is another party's,
 * the saved records found holding another handoff, and the records that could not be read.
 */
export function missingRecordProblem(i: { number?: string; looked: readonly string[]; foreign?: string; others: readonly string[]; unreadable: readonly string[] }): string {
  const others = i.others.length > 0 ? ` (${i.others.join(', ')} ${i.others.length === 1 ? 'holds' : 'hold'} another handoff's record)` : '';
  return `earlier handoff${i.number !== undefined ? ` ${i.number}` : ''}: its record is missing from ${i.looked.join(', ')}${i.foreign ?? ''}${others}, so the prompts before it are not carried${i.unreadable.length > 0 ? ` (${i.unreadable.join('; ')})` : ''}`;
}

/** The wake's line for a drop_skills name neither the earlier wake carried nor an invocation since matches: nothing to drop, or unchecked when the transcript could not be read. */
export function dropSkillProblem(name: string, read: boolean): string {
  return read ? `drop_skills ${name}: not among the skills the last wake carried or invoked since, so there is nothing to drop; leave it out of drop_skills` : `drop_skills ${name}: unchecked, the transcript is unreadable`;
}

/**
 * The skills a record says its wake carried: its `skills` list, else, for a record written before it kept one, the names
 * of its `Skill {name}` blocks (no directory: each is found again by name). A malformed list carries none; a directory
 * that is not absolute is left out, and the skill is found again by name.
 */
function recordSkills(rec: Record<string, unknown>): SkillRef[] | undefined {
  // A directory is kept only when absolute, as one the harness printed is (invocations): a relative one would resolve anywhere.
  if (Array.isArray(rec.skills)) return rec.skills.every(isSkillRef) ? (rec.skills as SkillRef[]).map((x) => ({ name: x.name, ...(x.baseDir !== undefined && x.baseDir.startsWith('/') ? { baseDir: x.baseDir } : {}) })) : undefined;
  if (rec.skills !== undefined || !Array.isArray(rec.blocks)) return undefined;
  const names = rec.blocks.flatMap((b) => (b !== null && typeof b === 'object' && typeof (b as { name?: unknown }).name === 'string' && (b as { name: string }).name.startsWith('Skill ') ? [(b as { name: string }).name.slice('Skill '.length)] : []));
  return names.length > 0 ? names.map((name) => ({ name })) : undefined;
}

/** The prompts, file trail, summary knowledge and skills an earlier handoff carried, from its record: the one whose text is the one the session holds. Undefined when no record is. */
export function carriedFrom(records: readonly unknown[], heldText: string): { users: string[]; dropped: number; inReply?: boolean; trail?: TrailEntry[]; summary?: string; skills?: SkillRef[]; queueCursor?: number } | undefined {
  const hash = fnv1a(heldText);
  for (const r of records) {
    if (r === null || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (rec.textHash !== hash || !Array.isArray(rec.users) || !rec.users.every((u) => typeof u === 'string')) continue;
    return recordCarry(rec);
  }
  return undefined;
}

/** The latest readable record after native compaction replaced the installed wake. */
export function latestCarried(records: readonly unknown[]): { seq: number; carry: NonNullable<ReturnType<typeof carriedFrom>> } | undefined {
  const candidates = records.filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object' && Number.isSafeInteger((r as Record<string, unknown>).seq) && Number((r as Record<string, unknown>).seq) > 0 && typeof (r as Record<string, unknown>).textHash === 'string');
  for (const record of candidates.sort((a, b) => Number(b.seq) - Number(a.seq))) {
    // Use the same record validation as a hash-matched wake, without inventing a wake text.
    const carry = recordCarry(record);
    if (carry !== undefined) return { seq: Number(record.seq), carry };
  }
  return undefined;
}

function recordCarry(rec: Record<string, unknown>): NonNullable<ReturnType<typeof carriedFrom>> | undefined {
  if (!Array.isArray(rec.users) || !rec.users.every((u) => typeof u === 'string')) return undefined;
  return { ...(Number.isSafeInteger(rec.queueCursor) && Number(rec.queueCursor) >= 0 ? { queueCursor: Number(rec.queueCursor) } : {}), users: rec.users as string[], dropped: typeof rec.usersDropped === 'number' ? rec.usersDropped : 0, ...(rec.handoffInReply === true ? { inReply: true } : {}), ...(Array.isArray(rec.trail) && rec.trail.every(isTrailEntry) ? { trail: rec.trail as TrailEntry[] } : {}), ...(typeof rec.summary === 'string' ? { summary: rec.summary } : {}), ...((skills) => (skills !== undefined ? { skills } : {}))(recordSkills(rec)) };
}

/**
 * The forward handoff a reloaded plugin lost: the latest call of `toolName` whose reply says it was stored and saved,
 * with the directory its files are in. A call still standing in the transcript was never installed; a person's message
 * after it cancelled it, a message the harness wrote did not. A latest stored call saved nowhere recovers nothing.
 */
export function recoverForward(messages: readonly HandoffMessage[], toolName: string, roots: readonly string[]): { toolUseId: string; dir: string } | undefined {
  const replies = new Map<string, string>();
  for (const m of messages) for (const r of m.toolResults ?? []) replies.set(r.tool_use_id, r.text ?? '');
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && (m.toolResults ?? []).length === 0 && m.text.trim() !== '' && !isHarnessText(m.text)) return undefined;
    if (m.role !== 'assistant') continue;
    for (const use of [...m.toolUses].reverse()) {
      if (use.tool !== toolName) continue;
      const reply = replies.get(use.tool_use_id) ?? '';
      if (!reply.startsWith('Forward handoff stored')) continue;
      // The plugin's own clause is the reply's last, followed only by its closing sentence: a loaded file's name before it
      // may carry the same words, and a reply saved nowhere ends in the reason, so a name forging the clause there matches nothing.
      const saved = /^[\s\S]* Saved to (\/.+?)\. It installs (?:before your next request|when this turn ends)[^.]*\.$/.exec(reply);
      const dir = saved?.[1];
      if (dir === undefined || dir.split('/').includes('..') || !roots.some((root) => dir.startsWith(`${root}/`))) return undefined;
      return { toolUseId: use.tool_use_id, dir };
    }
  }
  return undefined;
}
