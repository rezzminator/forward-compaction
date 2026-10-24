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
  /** A sub-agent's gate mark (`gateMark`): the nudge says that from there every other call is refused until it hands off. */
  gateAt?: number;
};

/** What the model reads after a tool result once its context passes a nudge point: hand off at the next clean milestone; the model picks the moment, not whether. */
/** Said in every nudge and refusal: a model that reads the handoff as a cost cuts its task short to avoid one. */
export const FREE = 'A handoff costs you nothing: you continue from it with every message after it, as many times as the work needs, so carry the task through to its end; never cut it short to avoid one.';

export function nudgeText({ tokens, window, ceiling, tool = DEFAULT_TOOL, gateAt }: NudgeInput): string {
  const percent = Math.round((tokens / Math.max(1, window)) * 100);
  return `forward-compaction: your context is ${k(tokens)} tokens (${percent}% of your ${k(window)} max context), and every call re-sends all of it. Hand off at your next clean milestone: once the step in hand is finished and its results are written down, and before you start the next step, call ${tool} with objective, done, remaining and next. You pick the milestone, not whether: skip it only if nothing is left but writing your result and your final answer. ${gateAt !== undefined && tokens < gateAt ? `From ${k(gateAt)} your other calls wait until you have handed off. ` : ''}At ${k(ceiling)} the plugin compacts you mechanically, with no frontier from you. ${FREE} If this tool is not in your tool list, carry on.`;
}

/** How many nudge levels past its first nudge a sub-agent's calls start waiting for its handoff: one, so the first nudge leaves it one step to pick its milestone. */
export const GATE_STEPS = 1;

/** The context at which a gate level closes. */
export const gateMark = (start: number, every: number, gateLevel: number): number => start + (gateLevel - 1) * every;

export type GateInput = { party: 'main' | 'subagent'; level: number; gateLevel?: number; stored: boolean; ignored: boolean; tool: string; open: readonly string[] };

/**
 * Whether a call waits for the party's handoff: a managed sub-agent at or past its gate level (GATE_STEPS past its first
 * nudge since the last install) with nothing stored, calling anything but the tools that lead to the handoff (`open`).
 * A fast reader passes its milestones between two nudges; the gate makes the handoff its next call instead of the
 * mechanical wake. Main is never gated: its person steers it.
 */
export function gated({ party, level, gateLevel, stored, ignored, tool, open }: GateInput): boolean {
  return party === 'subagent' && !ignored && !stored && gateLevel !== undefined && level >= gateLevel && !open.includes(tool);
}

/** The refusal a gated call answers with: nothing ran, hand off now, then repeat the call. */
export function gateText({ tokens, ceiling, tool = DEFAULT_TOOL }: { tokens: number; ceiling: number; tool?: string }): string {
  return `forward-compaction: this call did not run. Your context is ${k(tokens)} tokens and you have not handed off; at ${k(ceiling)} the plugin compacts you mechanically and your work so far is lost. Call ${tool} now, with objective, done, remaining and next: what you have read and concluded so far goes in done and findings, what is left in remaining. Then repeat this call; every call runs again once the handoff is stored. ${FREE}`;
}
