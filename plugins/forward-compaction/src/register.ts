import { FORWARD_INPUT_SCHEMA, FORWARD_TOOL, FORWARD_TOOL_DESCRIPTION } from './handoff.ts';
import { LOOK_BACK_DESCRIPTION, LOOK_BACK_INPUT_SCHEMA, LOOK_BACK_TOOL } from './look-back.ts';

/** Registering the tools holds a turn no longer than this: past it the turn goes on and the plugin stops waiting on registration. */
export const ENSURE_TOOLS_TIMEOUT_MS = 5_000;
/** Of session.end's one bound, the share left for Claude Code's own end step after the log writes. */
export const END_CORE_RESERVE_MS = 300;
/** Registering a tool is tried on this many hook calls before it is given up on. */
export const REGISTER_TRIES = 3;
/** Rows held back while the environment layer is still being read; later ones are dropped. */
export const PENDING_BEFORE_CONFIG = 500;

export type ToolKind = 'forward_compaction' | 'look_back';

/** The tools still worth a registration try: enabled, not registered yet, and tried fewer than `max` times. */
export function toolsToRegister(
  enabled: Record<ToolKind, boolean>,
  registered: Record<ToolKind, boolean>,
  tries: Record<ToolKind, number>,
  max: number,
): ToolKind[] {
  return (['forward_compaction', 'look_back'] as const).filter((kind) => enabled[kind] && !registered[kind] && tries[kind] < max);
}

/** Each tool's registration spec, and what is lost when it cannot be registered. */
export const TOOLS = {
  forward_compaction: { name: FORWARD_TOOL, description: FORWARD_TOOL_DESCRIPTION, inputSchema: FORWARD_INPUT_SCHEMA, isDeferred: false, lost: 'no party can hand off' },
  look_back: { name: LOOK_BACK_TOOL, description: LOOK_BACK_DESCRIPTION, inputSchema: LOOK_BACK_INPUT_SCHEMA, lost: 'transcript recovery is unavailable' },
} as const;
