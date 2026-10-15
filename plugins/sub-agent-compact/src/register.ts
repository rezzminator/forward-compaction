export type ToolKind = 'compact' | 'handoff' | 'forward' | 'look_back';

/** The tools still worth a registration try: enabled, not registered yet, and tried fewer than `max` times. */
export function toolsToRegister(
  enabled: Record<ToolKind, boolean>,
  registered: Record<ToolKind, boolean>,
  tries: Record<ToolKind, number>,
  max: number,
): ToolKind[] {
  return (['compact', 'handoff', 'forward', 'look_back'] as const).filter((kind) => enabled[kind] && !registered[kind] && tries[kind] < max);
}

/** The options as served: while the forward handoff is on it replaces the compact tool, so the model sees one way to hand off. */
export function servedOptions<T extends { compactTool: boolean; forwardHandoffTool: boolean }>(options: T): T {
  return options.forwardHandoffTool && options.compactTool ? { ...options, compactTool: false } : options;
}
