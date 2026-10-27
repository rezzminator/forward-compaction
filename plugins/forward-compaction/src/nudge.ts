/** The tool's name as the installed copy registered it; a `-dev` copy's differs. */
export const DEFAULT_TOOL = 'mcp__forward-compaction__forward_compaction';

/** A token size for model-facing and screen text: thousands as `51k`, a million or more as `1M` or `1.5M`. */
export function k(tokens: number): string {
  const thousands = Math.round(tokens / 1000);
  return thousands < 1000 ? `${thousands}k` : `${Math.round(tokens / 100_000) / 10}M`;
}

/** 0 below `start`, 1 at it, and one more per `every` tokens past it. */
export function nudgeLevel(tokens: number, start: number, every: number): number {
  if (tokens < start) return 0;
  return 1 + Math.floor((tokens - start) / Math.max(1, every));
}

export type NudgeInput = {
  /** The party's last measured reading. */
  tokens: number;
  /** The party's model window, which the nudge percentages are taken against. */
  window: number;
  /** The context at which the plugin compacts the party mechanically. */
  ceiling: number;
  /** The registered `forward_compaction` name; DEFAULT_TOOL when absent. */
  tool?: string;
  /** A sub-agent's gate mark (`gateMark`): the nudge says that from there every other call is refused until it compacts. */
  gateAt?: number;
};

/** What the model reads after a tool result once its context passes a nudge point: compact once the current step is done, never in the middle of one; the model picks the moment, not whether. */
export function nudgeText({ tokens, window, ceiling, tool = DEFAULT_TOOL, gateAt }: NudgeInput): string {
  const percent = Math.round((tokens / Math.max(1, window)) * 100);
  return `forward-compaction: context ${k(tokens)} (${percent}% of ${k(window)}). Once your current step is done — never in the middle of one — call ${tool} with objective, done, remaining and next; skip it if only your final answer is left.${gateAt !== undefined && tokens < gateAt ? ` From ${k(gateAt)} your other calls wait for it.` : ''} At ${k(ceiling)} you are compacted mechanically. No such tool? Carry on.`;
}

/** How many nudge levels past its first nudge a sub-agent's calls start waiting for its frontier: one, so the first nudge leaves it one step to pick its milestone. */
export const GATE_STEPS = 1;

/** The context at which a gate level closes. */
export const gateMark = (start: number, every: number, gateLevel: number): number => start + (gateLevel - 1) * every;

export type GateInput = { party: 'main' | 'subagent'; level: number; gateLevel?: number; stored: boolean; ignored: boolean; tool: string; open: readonly string[] };

/**
 * Whether a call waits for the party's frontier: a managed sub-agent at or past its gate level (GATE_STEPS past its first
 * nudge since the last install) with nothing stored, calling anything but the tools that lead to the frontier (`open`).
 * A fast reader passes its milestones between two nudges; the gate makes the frontier its next call instead of the
 * mechanical wake. Main is never gated: its person steers it.
 */
export function gated({ party, level, gateLevel, stored, ignored, tool, open }: GateInput): boolean {
  return party === 'subagent' && !ignored && !stored && gateLevel !== undefined && level >= gateLevel && !open.includes(tool);
}

/** The refusal a gated call answers with: nothing ran, compact now, then repeat the call; a repeat in the next request runs (Parties `gateAnswer`), so a party with only its result left repeats it. */
export function gateText({ tokens, tool = DEFAULT_TOOL }: { tokens: number; tool?: string }): string {
  return `forward-compaction: this call did not run — at ${k(tokens)} you compact first. Call ${tool} (objective, done, remaining, next), then repeat this call. Only your result and final answer left, or no such tool? Repeat this call: it runs.`;
}
