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
};

/** What the model reads after a tool result once its context passes a nudge point: hand off at the next clean milestone; the model picks the moment, not whether. */
export function nudgeText({ tokens, window, ceiling, tool = DEFAULT_TOOL }: NudgeInput): string {
  const percent = Math.round((tokens / Math.max(1, window)) * 100);
  return `forward-compaction: your context is ${k(tokens)} tokens (${percent}% of your ${k(window)} max context), and every call re-sends all of it. Hand off at your next clean milestone: once the step in hand is finished and its results are written down, and before you start the next step, call ${tool} with objective, done, remaining and next. You pick the milestone, not whether: skip it only if nothing is left but writing your result and your final answer. At ${k(ceiling)} the plugin compacts you mechanically, with no frontier from you. If this tool is not in your tool list, carry on.`;
}
