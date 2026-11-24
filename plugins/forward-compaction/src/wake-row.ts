// The wake's built messages as the transcript draws them. Outside the expanded view the facts draw nothing and the
// message after them one dim line, with the install's measured sizes once they are known; the expanded view (ctrl+o, --verbose, an export) and the stored message, the one the
// model reads, keep every character. Pure: the row's props arrive as plain data and the tree leaves as plain data.

/** How each message the wake builds opens: wake.ts writes these and a row is known as the wake's by them. */
export const WAKE_OPENING = {
  facts: '[forward-compaction: facts]',
  frontier: '[forward-compaction: frontier]',
  mechanical: '[forward-compaction: no frontier written by the model]',
} as const;

/** The one line a folded row draws, as what happened and where to read it, the measured sizes going between them; the facts row above it draws nothing, so each wake reads as this line alone. */
export const FOLDED_LINE = {
  frontier: ['forward-compaction installed the frontier', 'the transcript view (ctrl+o) shows it and the recorded facts in full'],
  mechanical: ['forward-compaction compacted mechanically, no frontier was written', 'the transcript view (ctrl+o) shows its note and the recorded facts in full'],
} as const;

/** The props of a user-role transcript row that decide its drawing (`ui.render`'s UserMessage). */
export type RowProps = { text: string; origin: { kind: string }; isExpanded: boolean };

/** A node of the tree drawn in the row's place: a Box or a Text, strings as a Text's children. */
export type RowNode = { type: 'Box' | 'Text'; props: Record<string, string | number | boolean>; children?: (RowNode | string)[] };

/**
 * The origins the engine stamps on a message the wake built: `unclassified` in the main view, `coordinator` in a
 * sub-agent's view, which draws every message its parent's side put in the sub-agent's transcript as "From main".
 */
const WAKE_ORIGINS: ReadonlySet<string> = new Set(['unclassified', 'coordinator']);

/** The texts of the messages a wake's folded line stands for, its frontier message or a mechanical wake's note, in the transcript's order. */
const wakeHeads = (messages: readonly unknown[]): string[] =>
  messages.map((m) => (typeof m === 'object' && m !== null && 'text' in m ? m.text : undefined)).filter((t): t is string => typeof t === 'string' && (t.startsWith(WAKE_OPENING.frontier) || t.startsWith(WAKE_OPENING.mechanical)));

/** The text of the message a wake's folded line stands for: what the adapter finds the row again by. */
export const wakeHead = (messages: readonly unknown[]): string | undefined => wakeHeads(messages)[0];

/** The frontier as both wakes carry it, between its two marker lines. */
export const frontierBlock = (frontier: string): string => `=== frontier ===\n${frontier}\n=== end of frontier ===`;

/** Whether a transcript holds a wake rendered with `frontier`: one of its wake messages carries that frontier whole between its markers. The party has then read it; an empty frontier is held by none. */
export const wakeHeld = (messages: readonly unknown[], frontier: string): boolean => frontier !== '' && wakeHeads(messages).some((text) => text.includes(frontierBlock(frontier)));

/**
 * What a user-role row draws in the engine's place, or undefined where the engine draws it: only a message the wake
 * built (stamped one of `WAKE_ORIGINS`; the user's own typing never folds) and only while folded. `landed`: the
 * install's measured sizes (wake.ts `landedShort`), once a request after it reported them.
 */
export function wakeRow(row: RowProps, landed?: string): RowNode | undefined {
  if (row.isExpanded || !WAKE_ORIGINS.has(row.origin.kind)) return undefined;
  if (row.text.startsWith(WAKE_OPENING.facts)) return { type: 'Box', props: { display: 'none' } };
  const line = row.text.startsWith(WAKE_OPENING.frontier) ? FOLDED_LINE.frontier : row.text.startsWith(WAKE_OPENING.mechanical) ? FOLDED_LINE.mechanical : undefined;
  // The engine's blank row above a message belongs to its own drawing, so the folded line brings its own.
  return line === undefined ? undefined : { type: 'Box', props: { marginTop: 1 }, children: [{ type: 'Text', props: { dimColor: true }, children: [`${line[0]}${landed === undefined ? '' : `, ${landed}`}: ${line[1]}`] }] };
}
