// Standing orders: the person's orders that bind the rest of the work, carried verbatim by every frontier in
// `standing_orders` and remembered per party, so a frontier that leaves one out is refused unless the person lifted it.
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

/** One line per bad `standing_orders` or `lifted` entry, naming its place, never its text (a refusal row may log the lines). */
export function orderShapeFaults(standing: unknown, lifted: unknown): string[] {
  const faults: string[] = [];
  if (standing !== undefined && !Array.isArray(standing)) faults.push('standing_orders must be an array of {order, at}.');
  else for (const [i, o] of (standing ?? []).entries()) {
    const { order, at } = isObject(o) ? o : ({} as Record<string, unknown>);
    if (blank(order)) faults.push(`standing_orders[${i}].order must be a non-blank string: the person's words, verbatim.`);
    if (!isIsoTime(at)) faults.push(`standing_orders[${i}].at must be the ISO time of the person's message, like "2026-10-27T14:53:00Z".`);
  }
  if (lifted !== undefined && !Array.isArray(lifted)) faults.push('lifted must be an array of {order, by}.');
  else for (const [i, l] of (lifted ?? []).entries()) {
    const { order, by } = isObject(l) ? l : ({} as Record<string, unknown>);
    if (blank(order)) faults.push(`lifted[${i}].order must be a non-blank string: the order's text as your last frontier carried it.`);
    if (blank(by)) faults.push(`lifted[${i}].by must be a non-blank string: the person's words that lifted the order, verbatim.`);
  }
  return faults;
}

/**
 * The drop check: every remembered order is carried again (the same `order` text) or lifted in words the party was
 * sent after the order was given (`by`, trimmed, contained in one of `said` whose time is past the order's `at`): words
 * said before an order cannot lift it. Returns one fault line per order dropped, lift unheard, lift of an order no
 * frontier carried, or order both carried and lifted; and the lifts, each with its remembered time.
 */
export function orderFaults(memory: OrderMemory, standing: readonly StandingOrder[], lifted: readonly { order: string; by: string }[]): { faults: string[]; lifted: LiftedOrder[] } {
  const carried = new Set(standing.map((o) => o.order));
  const remembered = new Map(memory.remembered.map((o) => [o.order, o]));
  const sources = memory.party === 'main' ? "no message of the person's" : 'neither your brief nor any message delivered to you';
  const faults: string[] = [];
  for (const o of memory.remembered) {
    if (carried.has(o.order) || lifted.some((l) => l.order === o.order)) continue;
    faults.push(`standing order dropped: "${o.order}" (given ${o.at}) was in your last frontier and is not in this one. Carry it in standing_orders as it was, or, if the person lifted it, list it in lifted with the person's words that lifted it, verbatim: {"order": <its text>, "by": <their words>}.`);
  }
  for (const l of lifted) {
    if (!remembered.has(l.order)) faults.push(`lifted "${l.order}" is no standing order your last frontier carried: name one by its exact text, or leave it out.`);
    else if (carried.has(l.order)) faults.push(`"${l.order}" is both in standing_orders and in lifted: carry it, or lift it.`);
    else {
      const given = remembered.get(l.order)!.at;
      if (!memory.said.some((m) => m.at > Date.parse(given) && m.text.includes(l.by.trim()))) faults.push(`lifted "${l.order}": its by text is in ${sources} sent after the order was given (${given}), so it lifts nothing. Quote the person's lifting words exactly as they came, or carry the order in standing_orders.`);
    }
  }
  return { faults, lifted: lifted.map((l) => ({ order: l.order, ...(remembered.has(l.order) ? { at: remembered.get(l.order)!.at } : {}), by: l.by })) };
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
