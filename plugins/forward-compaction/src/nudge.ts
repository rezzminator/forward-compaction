/** The tool's name as the installed copy registered it; a `-dev` copy's differs. */
export const DEFAULT_TOOL = 'mcp__forward-compaction__forward_compaction';

/** A token size for model-facing and screen text: thousands as `51k`, a million or more as `1M` or `1.5M`. */
export function k(tokens: number): string {
  const thousands = Math.round(tokens / 1000);
  return thousands < 1000 ? `${thousands}k` : `${Math.round(tokens / 100_000) / 10}M`;
}

/** Names as prose: `a`, `a and b`, `a, b and c`. */
export function andList(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** 0 below `start`, 1 at it, and one more per `every` tokens past it. */
export function nudgeLevel(tokens: number, start: number, every: number): number {
  if (tokens < start) return 0;
  return 1 + Math.floor((tokens - start) / Math.max(1, every));
}

export type NudgeInput = {
  /** The party's last measured reading. */
  tokens: number;
  /** The registered `forward_compaction` name; DEFAULT_TOOL when absent. */
  tool?: string;
};

/** What the model reads after a tool result once its context passes a nudge point: its size, and to compact at its first milestone; it may skip when it can finish soon, and keep going to that milestone when the work needs the larger context. It names no window and no ceiling. */
export function nudgeText({ tokens, tool = DEFAULT_TOOL }: NudgeInput): string {
  return `forward-compaction: context ${k(tokens)} and increasing. Try to wrap up and get yourself at the first milestone and call ${tool} with objective, decisions, done, remaining and next, and in load_files the files you will read again; skip if you can finish all of it soon, if you REALLY need larger context and your context has to keep large tokens for work, continue and do it at the first milestone. No such tool? Carry on.`;
}
