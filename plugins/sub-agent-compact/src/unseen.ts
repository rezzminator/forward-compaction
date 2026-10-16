// A compaction the plugin never heard of: Claude Code can compact the main chat without
// dispatching session.compact to user plugins (2.1.299 passes it over on a machine with managed
// settings). The next token reading is then the only trace, so a sharp fall is logged.

/** The share of the previous reading a reading falls to, or below, for the fall to count as a compaction. */
export const UNSEEN_DROP = 0.5;

/** True when main's reading fell to half the one before or less, and no session.compact was handled in between. */
export function unseenCompaction(before: number | undefined, after: number | undefined, seen: boolean): boolean {
  if (seen || before === undefined || after === undefined) return false;
  return after <= before * UNSEEN_DROP;
}
