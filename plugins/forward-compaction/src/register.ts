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
