// What a forward handoff leaves on disk: where, and the measurement record the experiment reads.
import { estimateTokens, type BlockRecord } from './forward-text.ts';

const ROOT = 'sub-agent-compact/forward-handoff';

/** The directory of one session's calls. */
export function forwardSessionDir(configDir: string, session: string): string {
  return `${configDir}/${ROOT}/${session.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** The directory of one call: `<config dir>/sub-agent-compact/forward-handoff/<session>/<n>`. */
export function forwardDir(configDir: string, session: string, seq: number): string {
  return `${forwardSessionDir(configDir, session)}/${seq}`;
}

/** The number of the next call, from the names already in the session's directory. */
export function nextSeq(names: readonly string[]): number {
  let top = 0;
  for (const name of names) if (/^\d+$/.test(name)) top = Math.max(top, Number(name));
  return top + 1;
}

/** The directory of the call before this one, undefined for the first. */
export function previousDir(configDir: string, session: string, seq: number): string | undefined {
  return seq > 1 ? forwardDir(configDir, session, seq - 1) : undefined;
}

export type ForwardRecord = Record<string, unknown>;

/** The record of one call at handoff time: the size of every block and of the whole text. */
export function buildRecord(i: { seq: number; session: string; dir: string; text: string; blocks: readonly BlockRecord[]; tokensBefore?: number; trimmed: readonly string[]; at?: string }): ForwardRecord {
  return {
    seq: i.seq,
    session: i.session,
    dir: i.dir,
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
