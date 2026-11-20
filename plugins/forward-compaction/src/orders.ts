// Standing orders: the user's orders that bind the rest of the work, held as the numbered list `orders` (lists.ts),
// shown above everything else in every wake until the model removes one by its number. The plugin never guesses an
// order from the user's wording: the model names it, the plugin holds it.
import { itemLines, type Item } from './lists';

export const ORDERS_HEADING = '## Standing orders — binding until the user lifts them';

/** The previous build's remembered orders `$.state` kept for a party, each entry whose `order` is a non-blank string; undefined when nothing usable was kept. They become the party's first numbered orders when it has no orders file yet. */
export function keptOrders(kept: unknown): string[] | undefined {
  if (!Array.isArray(kept)) return undefined;
  return kept.flatMap((o) => (typeof o === 'object' && o !== null && typeof o.order === 'string' && o.order.trim() !== '' ? [o.order as string] : []));
}

/** The wake's first section: each live order as `[n] text`; undefined with none. */
export function ordersSection(orders: readonly Item[]): string | undefined {
  if (orders.length === 0) return undefined;
  return [ORDERS_HEADING, ...itemLines({ next_id: 0, items: [...orders] })].join('\n');
}
