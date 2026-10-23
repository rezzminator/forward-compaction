/** The tool's name as the installed copy registered it; a `-dev` copy's differs. */
export const DEFAULT_TOOL = 'mcp__forward-compaction__forward_compaction';

function k(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

/** 0 below `start`, 1 at it, and one more per `every` tokens past it. */
export function nudgeLevel(tokens: number, start: number, every: number): number {
  if (tokens < start) return 0;
  return 1 + Math.floor((tokens - start) / Math.max(1, every));
}

export type NudgeInput = {
  /** The party's context reading. */
  tokens: number;
  /** The context at which Claude Code starts asking to compact the party. */
  askPoint: number;
  /** The context at which the plugin compacts the party mechanically. */
  ceiling: number;
  /** True once an automatic ask for the party was held with no handoff stored. */
  asked: boolean;
  /** The registered `forward_compaction` name; DEFAULT_TOOL when absent. */
  tool?: string;
};

/**
 * What the model reads after a tool result once its context passes a nudge point: "soon" while Claude Code
 * has not asked to compact the party, "now" once the reading is at the ask point or an ask was held.
 */
export function nudgeText({ tokens, askPoint, ceiling, asked, tool = DEFAULT_TOOL }: NudgeInput): string {
  if (asked || tokens >= askPoint) {
    return `forward-compaction: Claude Code is asking to compact you (${k(tokens)} tokens) and no handoff is stored. Call ${tool} now, at a clean point. At ${k(ceiling)} the plugin compacts you mechanically, with no frontier from you. If this tool is not in your tool list, carry on.`;
  }
  return `forward-compaction: your context is ${k(tokens)} tokens. At your next milestone, at a clean point and never mid-edit, call ${tool} with your handoff (## Objective, ## Done, ## Remaining, ## Next). The plugin keeps the person's messages or your brief, your skills, and every message after the call; you write the frontier. If only your final answer is left, give it instead. If this tool is not in your tool list, carry on: a mechanical compaction at ${k(ceiling)} keeps your brief, skills and newest messages.`;
}
