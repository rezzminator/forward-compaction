// What a forward handoff leaves on disk: where, and the measurement record the experiment reads.
import { estimateTokens, fnv1a, type BlockRecord } from './forward-text.ts';

type TrailEntry = { tag: 'R' | 'E' | 'C'; path: string };
const isTrailEntry = (t: unknown): t is TrailEntry =>
  t !== null && typeof t === 'object' && ['R', 'E', 'C'].includes((t as TrailEntry).tag) && typeof (t as TrailEntry).path === 'string';

const ROOT = 'sub-agent-compact/forward-handoff';

const safe = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_');

/** The directory of one loop's calls: the session's for the main chat, `agent-<id>` inside it for a sub-agent. */
export function forwardSessionDir(configDir: string, session: string, agentId?: string): string {
  const dir = `${configDir}/${ROOT}/${safe(session)}`;
  return agentId === undefined ? dir : `${dir}/agent-${safe(agentId)}`;
}

/** The directory of one call: `<config dir>/sub-agent-compact/forward-handoff/<session>[/agent-<id>]/<n>`. */
export function forwardDir(configDir: string, session: string, seq: number, agentId?: string): string {
  return `${forwardSessionDir(configDir, session, agentId)}/${seq}`;
}

/** The number of the next call, from the names already in the session's directory. */
export function nextSeq(names: readonly string[]): number {
  let top = 0;
  for (const name of names) if (/^\d+$/.test(name)) top = Math.max(top, Number(name));
  return top + 1;
}

/** The directory of the call before this one, undefined for the first. */
export function previousDir(configDir: string, session: string, seq: number, agentId?: string): string | undefined {
  return seq > 1 ? forwardDir(configDir, session, seq - 1, agentId) : undefined;
}

export type ForwardRecord = Record<string, unknown>;

/** The record of one call at handoff time: the size of every block and of the whole text. */
export function buildRecord(i: { seq: number; session: string; agentId?: string; dir: string; text: string; blocks: readonly BlockRecord[]; users: readonly string[]; usersDropped: number; handoffInReply?: boolean; trail?: readonly TrailEntry[]; summary?: string; tokensBefore?: number; trimmed: readonly string[]; at?: string }): ForwardRecord {
  return {
    seq: i.seq,
    session: i.session,
    ...(i.agentId !== undefined ? { agentId: i.agentId } : {}),
    dir: i.dir,
    textHash: fnv1a(i.text),
    users: [...i.users],
    usersDropped: i.usersDropped,
    ...(i.handoffInReply === true ? { handoffInReply: true } : {}),
    ...(i.summary !== undefined ? { summary: i.summary } : {}),
    ...(i.trail !== undefined ? { trail: i.trail.map((t) => ({ tag: t.tag, path: t.path })) } : {}),
    ...(i.at !== undefined ? { at: i.at } : {}),
    ...(i.tokensBefore !== undefined ? { tokensBefore: i.tokensBefore } : {}),
    trimmed: [...i.trimmed],
    total: { chars: i.text.length, tokens: estimateTokens(i.text.length) },
    blocks: i.blocks.map((b) => ({ name: b.name, chars: b.chars, tokens: b.tokens, items: b.items, hash: b.hash })),
  };
}

/** The record once installed: the size after, and what the install check found. */
export function withInstall(record: ForwardRecord, i: { tokensAfter: number; check: { landed: number; missing: string[]; hash: string; ok: boolean } }): ForwardRecord {
  return { ...record, tokensAfter: i.tokensAfter, install: i.check };
}

/** The prompts, file trail and summary knowledge an earlier handoff carried, from its record: the one whose text is the one the session holds. Undefined when no record is. */
export function carriedFrom(records: readonly unknown[], heldText: string): { users: string[]; dropped: number; inReply?: boolean; trail?: TrailEntry[]; summary?: string } | undefined {
  const hash = fnv1a(heldText);
  for (const r of records) {
    if (r === null || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (rec.textHash !== hash || !Array.isArray(rec.users) || !rec.users.every((u) => typeof u === 'string')) continue;
    return { users: rec.users as string[], dropped: typeof rec.usersDropped === 'number' ? rec.usersDropped : 0, ...(rec.handoffInReply === true ? { inReply: true } : {}), ...(Array.isArray(rec.trail) && rec.trail.every(isTrailEntry) ? { trail: rec.trail as TrailEntry[] } : {}), ...(typeof rec.summary === 'string' ? { summary: rec.summary } : {}) };
  }
  return undefined;
}
