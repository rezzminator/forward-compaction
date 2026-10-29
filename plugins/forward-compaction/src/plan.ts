// Plan mode and the plan file, as Claude Code's own plan-mode attachments (`prompt.attachment` `plan_mode`, `plan_mode_reentry`,
// `plan_mode_exit`) report them per party: the one place the plugin API names either.

/** What a party's plan-mode attachments last said: whether plan mode is on, and the plan file they name, when one did. */
export type PlanSeen = { mode: boolean; path?: string };
/** The plan a wake carries: `PlanSeen` with its plan file as read at install, its content or why it could not be read; neither when none was written. */
export type WakePlan = PlanSeen & { content?: string; problem?: string };

/** The attachment types that report plan mode and the plan file. */
export const PLAN_ROWS: ReadonlySet<string> = new Set(['plan_mode', 'plan_mode_reentry', 'plan_mode_exit']);

/** The party's plan state after one attachment: a plan-mode reminder or re-entry turns plan mode on, the exit note off, each naming the plan file; any other attachment leaves `prev`. */
export function planFrom(prev: PlanSeen | undefined, type: string, detail: unknown): PlanSeen | undefined {
  if (!PLAN_ROWS.has(type)) return prev;
  const named = (detail as { planFilePath?: unknown } | undefined)?.planFilePath;
  const path = typeof named === 'string' && named !== '' ? named : prev?.path;
  return { mode: type !== 'plan_mode_exit', ...(path !== undefined ? { path } : {}) };
}

/** `seen` with its plan file as read at install, `text` or the read's `error`: a file never written (ENOENT) or empty is no plan file; any other failure is named. */
export function planRead(seen: PlanSeen, read: { text: string } | { error: unknown }): WakePlan {
  if ('text' in read) return read.text.trim() === '' ? seen : { ...seen, content: read.text };
  const error = read.error as { code?: unknown; message?: unknown } | null;
  return error?.code === 'ENOENT' ? seen : { ...seen, problem: error instanceof Error ? error.message : String(read.error) };
}
