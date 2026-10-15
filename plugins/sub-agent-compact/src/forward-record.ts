// What a forward handoff leaves on disk: where, and the measurement record the experiment reads.
import { estimateTokens, fnv1a, type BlockRecord } from './forward-text.ts';
import { isHarnessText, type HandoffMessage } from './handoff.ts';

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

/** The directory of the call before this one, undefined for the first. */
export function previousDir(root: string, session: string, seq: number, agentId?: string): string | undefined {
  return seq > 1 ? forwardDir(root, session, seq - 1, agentId) : undefined;
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
      // The plugin's own clause is the reply's last: a loaded file's name before it may carry the same words.
      const saved = /^[\s\S]* Saved to (\/.+?)\. It installs/.exec(reply);
      const dir = saved?.[1];
      if (dir === undefined || dir.split('/').includes('..') || !roots.some((root) => dir.startsWith(`${root}/`))) return undefined;
      return { toolUseId: use.tool_use_id, dir };
    }
  }
  return undefined;
}
