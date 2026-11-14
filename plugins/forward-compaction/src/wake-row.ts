// The wake's built messages as the transcript draws them. Outside the expanded view the facts draw nothing and the
// message after them one dim line; the expanded view (ctrl+o, --verbose, an export) and the stored message, the one the
// model reads, keep every character. Pure: the row's props arrive as plain data and the tree leaves as plain data.

/** How each message the wake builds opens: wake.ts writes these and a row is known as the wake's by them. */
export const WAKE_OPENING = {
  facts: '[forward-compaction: facts]',
  frontier: '[forward-compaction: frontier]',
  mechanical: '[forward-compaction: no frontier written by the model]',
} as const;

/** The one line a folded row draws; the facts row above it draws nothing, so each wake reads as this line alone. */
export const FOLDED_LINE = {
  frontier: 'forward-compaction installed the frontier: the transcript view (ctrl+o) shows it and the recorded facts in full',
  mechanical: 'forward-compaction compacted mechanically, no frontier was written: the transcript view (ctrl+o) shows its note and the recorded facts in full',
} as const;

/** The props of a user-role transcript row that decide its drawing (`ui.render`'s UserMessage). */
export type RowProps = { text: string; origin: { kind: string }; isExpanded: boolean };

/** A node of the tree drawn in the row's place: a Box or a Text, strings as a Text's children. */
export type RowNode = { type: 'Box' | 'Text'; props: Record<string, string | number | boolean>; children?: (RowNode | string)[] };

/**
 * What a user-role row draws in the engine's place, or undefined where the engine draws it: only a message the wake
 * built (the engine stamps a hook's message `unclassified`; the person's own typing never folds) and only while folded.
 */
export function wakeRow(row: RowProps): RowNode | undefined {
  if (row.isExpanded || row.origin.kind !== 'unclassified') return undefined;
  if (row.text.startsWith(WAKE_OPENING.facts)) return { type: 'Box', props: { display: 'none' } };
  const line = row.text.startsWith(WAKE_OPENING.frontier) ? FOLDED_LINE.frontier : row.text.startsWith(WAKE_OPENING.mechanical) ? FOLDED_LINE.mechanical : undefined;
  // The engine's blank row above a message belongs to its own drawing, so the folded line brings its own.
  return line === undefined ? undefined : { type: 'Box', props: { marginTop: 1 }, children: [{ type: 'Text', props: { dimColor: true }, children: [line] }] };
}
