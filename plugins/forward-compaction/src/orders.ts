// Standing orders: the person's orders that bind the rest of the work, carried verbatim by every frontier in
// `standing_orders` and remembered per party, so the plugin carries every one a frontier leaves out until the person lifts it.
// The plugin never guesses an order from the person's wording: the model names it, the plugin holds it.

/** One standing order as the frontier carries it: the person's words verbatim and the ISO time of their message. */
export type StandingOrder = { order: string; at: string };
/** An order the person lifted: its text as a previous frontier carried it, its time when known, and the person's lifting words. */
export type LiftedOrder = { order: string; at?: string; by: string };

/** A text a lift may quote, with the time (ms) it was sent. */
export type SaidText = { text: string; at: number };
/** What the drop check holds a frontier to: the party's remembered orders and the texts a lift may quote. */
export type OrderMemory = { remembered: readonly StandingOrder[]; said: readonly SaidText[]; party: 'main' | 'subagent' };

export const ORDERS_HEADING = '## Standing orders — binding until the person lifts them';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const blank = (v: unknown): boolean => typeof v !== 'string' || v.trim() === '';
const isIsoTime = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v));

/** The `standing_orders` entries and `lifted` entries that are well formed, and one note per bad entry or non-array, naming its place and never its text. */
function wellFormed(standing: unknown, lifted: unknown): { standing: StandingOrder[]; asked: { order: string; by: string }[]; notes: string[] } {
  const notes: string[] = [];
  const kept = { standing: [] as StandingOrder[], asked: [] as { order: string; by: string }[] };
  if (standing !== undefined && !Array.isArray(standing)) notes.push('standing_orders must be an array of {order, at}: none read from it.');
  else for (const [i, o] of (standing ?? []).entries()) {
    const { order, at } = isObject(o) ? o : ({} as Record<string, unknown>);
    if (blank(order)) notes.push(`standing_orders[${i}].order must be a non-blank string, the person's words verbatim: skipped.`);
    else if (!isIsoTime(at)) notes.push(`standing_orders[${i}].at must be the ISO time of the person's message, like "2026-10-27T14:53:00Z": skipped.`);
    else kept.standing.push({ order: order as string, at });
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
 * those the person lifted. An order leaves only on a lift whose `by` (trimmed) is contained in one of `said` sent after
 * the order's `at`; words said before an order cannot lift it. No order is lost: a lift without such words leaves the
 * order binding, and an order the frontier left out is carried on, each named in the notes. A lift naming no order is ignored.
 */
export function carryOrders(memory: OrderMemory, standing: unknown, lifted: unknown): { standing: StandingOrder[]; lifted: LiftedOrder[]; notes: string[] } {
  const read = wellFormed(standing, lifted);
  const notes = read.notes;
  const known = new Map<string, StandingOrder>();
  for (const o of [...memory.remembered, ...read.standing]) if (!known.has(o.order)) known.set(o.order, o);
  const sources = memory.party === 'main' ? 'no message from the person' : 'neither your brief nor any message delivered to you';
  const gone = new Map<string, LiftedOrder>();
  for (const l of read.asked) {
    const order = known.get(l.order);
    if (order === undefined) notes.push(`lifted "${l.order}" names no standing order: ignored.`);
    else if (gone.has(l.order)) continue;
    else if (memory.said.some((m) => m.at > Date.parse(order.at) && m.text.includes(l.by.trim()))) gone.set(l.order, { order: l.order, at: order.at, by: l.by });
    else notes.push(`order "${l.order}" still binding: ${sources} after ${order.at} contains "${l.by}".`);
  }
  const carried = new Set(read.standing.map((o) => o.order));
  for (const o of memory.remembered) if (!carried.has(o.order) && !gone.has(o.order) && !notes.some((n) => n.startsWith(`order "${o.order}" still binding`))) notes.push(`order "${o.order}" (given ${o.at}) was left out of your frontier and is carried on: it binds until the person lifts it.`);
  return { standing: [...known.values()].filter((o) => !gone.has(o.order)), lifted: [...gone.values()], notes };
}

/** The orders `$.state` kept for a party, each a well-formed {order, at}; undefined when nothing usable was kept. */
export function keptOrders(kept: unknown): StandingOrder[] | undefined {
  if (!Array.isArray(kept)) return undefined;
  return kept.filter((o): o is StandingOrder => isObject(o) && typeof o.order === 'string' && typeof o.at === 'string').map(({ order, at }) => ({ order, at }));
}

/** The wake's first section: each binding order with its time, then each order lifted since, once, with the lifting words; undefined with neither. */
export function ordersSection(standing: readonly StandingOrder[], lifted: readonly LiftedOrder[]): string | undefined {
  if (standing.length === 0 && lifted.length === 0) return undefined;
  return [
    ORDERS_HEADING,
    ...standing.flatMap((o) => [`### ${o.at}`, o.order]),
    ...lifted.flatMap((l) => [`### Lifted, no longer binding${l.at === undefined ? '' : ` (given ${l.at})`}`, l.order, `The person lifted it: "${l.by}"`]),
  ].join('\n');
}
