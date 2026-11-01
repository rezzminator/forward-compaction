// Standing orders: the person's orders that bind the rest of the work, carried verbatim by every frontier in
// `standing_orders` and remembered per party, so the plugin carries every one a frontier leaves out until the person lifts it.
// The plugin never guesses an order from the person's wording: the model names it, the plugin holds it.

/**
 * One standing order as the frontier carries it: the person's words verbatim. `liftClaimed`: the words of a lift the
 * frontier sent for it that no recorded message holds, so it still binds; the wake shows them beside it.
 */
export type StandingOrder = { order: string; liftClaimed?: string };
/** An order the person lifted: its text as a previous frontier carried it, and the person's lifting words. */
export type LiftedOrder = { order: string; by: string };

/** What the drop check holds a frontier to: the party's remembered orders and the texts a lift may quote. */
export type OrderMemory = { remembered: readonly StandingOrder[]; said: readonly string[]; party: 'main' | 'subagent' };

export const ORDERS_HEADING = '## Standing orders — binding until the person lifts them';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const blank = (v: unknown): boolean => typeof v !== 'string' || v.trim() === '';
/** Text as a match reads it: one space for every run of whitespace, lower case. A model quoting the person rejoins lines and re-cases words; the words stay the person's. */
const plain = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();
/** Whether `said` holds `words`, across spacing and letter case. */
const holds = (said: string, words: string): boolean => plain(said).includes(plain(words));

/** Whether a lift is proven: a said text holds `by`, after the message that gave the order (the first holding its words), which cannot lift its own order; none holds the order's words: any text counts. */
function liftedAfterGiven(said: readonly string[], order: string, by: string): boolean {
  const given = said.findIndex((text) => holds(text, order));
  return said.some((text, i) => (given < 0 || i > given) && holds(text, by));
}

/** The `standing_orders` entries and `lifted` entries that are well formed, and one note per bad entry or non-array, naming its place and never its text. */
function wellFormed(standing: unknown, lifted: unknown): { standing: StandingOrder[]; asked: LiftedOrder[]; notes: string[] } {
  const notes: string[] = [];
  const kept = { standing: [] as StandingOrder[], asked: [] as LiftedOrder[] };
  if (standing !== undefined && !Array.isArray(standing)) notes.push('standing_orders must be an array of {order}: none read from it.');
  else for (const [i, o] of (standing ?? []).entries()) {
    const { order } = isObject(o) ? o : ({} as Record<string, unknown>);
    if (blank(order)) notes.push(`standing_orders[${i}].order must be a non-blank string, the person's words verbatim: skipped.`);
    else kept.standing.push({ order: order as string });
  }
  if (lifted !== undefined && !Array.isArray(lifted)) notes.push('lifted must be an array of {order, by}: none read from it.');
  else for (const [i, l] of (lifted ?? []).entries()) {
    const { order, by } = isObject(l) ? l : ({} as Record<string, unknown>);
    if (blank(order)) notes.push(`lifted[${i}].order must be a non-blank string, the order's text as your last frontier carried it: skipped.`);
    else if (blank(by)) notes.push(`lifted[${i}].by must be a non-blank string, the person's words that lifted the order, verbatim: skipped.`);
    else kept.asked.push({ order: order as string, by: by as string });
  }
  return { standing: kept.standing, asked: kept.asked, notes };
}

/**
 * The orders the frontier stores: those it carries and those the party's last frontier carried that it left out, minus
 * those the person lifted. An order leaves only on a lift whose `by` (trimmed) is contained in one of `said` after the one
 * that gave the order, in ledger order. No order is
 * lost: a lift without such words leaves the order binding with its words as `liftClaimed`, and an order the frontier
 * left out is carried on, each named in the notes. A lift naming no order is ignored.
 */
export function carryOrders(memory: OrderMemory, standing: unknown, lifted: unknown): { standing: StandingOrder[]; lifted: LiftedOrder[]; notes: string[] } {
  const read = wellFormed(standing, lifted);
  const notes = read.notes;
  const known = new Map<string, StandingOrder>();
  // A remembered order's earlier claimed lift is not this frontier's: each order starts from its words alone.
  for (const o of [...memory.remembered, ...read.standing]) if (!known.has(o.order)) known.set(o.order, { order: o.order });
  const sources = memory.party === 'main' ? 'no message from the person' : 'neither your brief nor any message delivered to you';
  const gone = new Map<string, LiftedOrder>();
  for (const l of read.asked) {
    const order = known.get(l.order);
    if (order === undefined) notes.push(`lifted "${l.order}" names no standing order: ignored.`);
    else if (gone.has(l.order)) continue;
    else if (liftedAfterGiven(memory.said, l.order, l.by)) gone.set(l.order, { order: l.order, by: l.by });
    else if (order.liftClaimed === undefined) (order.liftClaimed = l.by), notes.push(`order "${l.order}" still binding: ${sources} contains "${l.by}"; the wake shows your lift beside it.`);
  }
  const carried = new Set(read.standing.map((o) => o.order));
  for (const o of memory.remembered) if (!carried.has(o.order) && !gone.has(o.order) && known.get(o.order)?.liftClaimed === undefined) notes.push(`order "${o.order}" was left out of your frontier and is carried on: it binds until the person lifts it.`);
  return { standing: [...known.values()].filter((o) => !gone.has(o.order)), lifted: [...gone.values()], notes };
}

/** The orders `$.state` kept for a party, each entry whose `order` is a string (an older frontier's `at` is not read); undefined when nothing usable was kept. */
export function keptOrders(kept: unknown): StandingOrder[] | undefined {
  if (!Array.isArray(kept)) return undefined;
  return kept.filter((o): o is StandingOrder => isObject(o) && typeof o.order === 'string').map(({ order }) => ({ order }));
}

/** The wake's first section: each binding order, an unproven lift beside it, then each order lifted since, once, with the lifting words; undefined with neither. */
export function ordersSection(standing: readonly StandingOrder[], lifted: readonly LiftedOrder[]): string | undefined {
  if (standing.length === 0 && lifted.length === 0) return undefined;
  return [
    ORDERS_HEADING,
    ...standing.flatMap((o) => [`- ${o.order}`, ...(o.liftClaimed === undefined ? [] : [`  (your frontier lifted it with "${o.liftClaimed}", but no message recorded for you holds those words: it still binds)`])]),
    ...lifted.flatMap((l) => ['### Lifted, no longer binding', l.order, `The person lifted it: "${l.by}"`]),
  ].join('\n');
}
