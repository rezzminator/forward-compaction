import { FORWARD_INPUT_SCHEMA, FORWARD_TOOL, FORWARD_TOOL_DESCRIPTION } from './frontier';
import { LOOK_BACK_DESCRIPTION, LOOK_BACK_INPUT_SCHEMA, LOOK_BACK_TOOL } from './look-back';

/** Registering the tools holds a turn no longer than this: past it the turn goes on and the plugin stops waiting on registration. */
export const ENSURE_TOOLS_TIMEOUT_MS = 5_000;
/** Of session.end's one bound, the share left for Claude Code's own end step after the log writes. */
export const END_CORE_RESERVE_MS = 300;
/** Registering a tool is tried on this many hook calls in a row; after that, on a later hook once a wait is over, for the rest of the session. */
export const REGISTER_TRIES = 3;
/** The wait after the REGISTER_TRIES-th failed try, doubling with each failure after it: a session that cannot take a tool is not asked on every hook. */
export const REGISTER_BACKOFF_MS = 30_000;
/** The longest wait between two tries: a tool the session takes later still comes into use within it. */
export const REGISTER_BACKOFF_MAX_MS = 15 * 60_000;
/** Rows held back while the environment layer is still being read; later ones are counted, and the count is written once it is read. */
export const PENDING_BEFORE_CONFIG = 500;

export type ToolKind = 'forward_compaction' | 'look_back';

/** Holds each row while fewer than PENDING_BEFORE_CONFIG wait; returns how many found no room, for the one row that counts them. */
export function holdPending(pending: string[], rows: readonly string[]): number {
  let lost = 0;
  for (const row of rows) if (pending.length < PENDING_BEFORE_CONFIG) pending.push(row);
  else lost++;
  return lost;
}

/** When a tool whose `tries`-th registration try failed at `failedAt` (ms) is tried again: at the next hook for the first REGISTER_TRIES, then after a doubling wait capped at REGISTER_BACKOFF_MAX_MS. */
export function nextTry(tries: number, failedAt: number): number {
  return tries < REGISTER_TRIES ? failedAt : failedAt + Math.min(REGISTER_BACKOFF_MS * 2 ** (tries - REGISTER_TRIES), REGISTER_BACKOFF_MAX_MS);
}

/** The tools worth a registration try at `now` (ms): enabled, not registered yet, and due (`due`, from `nextTry`; 0 before any try). */
export function toolsToRegister(
  enabled: Record<ToolKind, boolean>,
  registered: Record<ToolKind, boolean>,
  due: Record<ToolKind, number>,
  now: number,
): ToolKind[] {
  return (['forward_compaction', 'look_back'] as const).filter((kind) => enabled[kind] && !registered[kind] && due[kind] <= now);
}

/** Each tool's registration spec, and what is lost when it cannot be registered. */
export const TOOLS = {
  forward_compaction: { name: FORWARD_TOOL, description: FORWARD_TOOL_DESCRIPTION, inputSchema: FORWARD_INPUT_SCHEMA, isDeferred: false, lost: 'no party can compact' },
  look_back: { name: LOOK_BACK_TOOL, description: LOOK_BACK_DESCRIPTION, inputSchema: LOOK_BACK_INPUT_SCHEMA, isDeferred: false, lost: 'transcript recovery is unavailable' },
} as const;
