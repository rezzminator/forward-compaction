// The frontier as the plugin holds it: numbered lists the model changes by item number, and two texts. An item's
// number is per list, starts at 1, never shifts and is never reused; the model sends only changes, and a list or text
// it leaves out stays as it is. Pure: the files that keep a party's lists are disk.ts's.
import type { ModelSwitch } from './model-switch';

/** The lists, in the order a call's changes are applied and its result lines read. */
export const LISTS = ['orders', 'decisions', 'done', 'remaining', 'blocked', 'findings'] as const;
export type ListName = (typeof LISTS)[number];
/** The two texts: one text each, replaced whole. */
export const TEXTS = ['objective', 'next'] as const;
export type TextName = (typeof TEXTS)[number];

/** `round`: the party's count of installed compactions (`Held.rounds`) when the item was added or last edited; absent is 0. `added`: when the item was added, ISO 8601 UTC from the adapter's clock, kept through an edit; absent on an item stored before it was kept, and none is invented. It lives only in the files on disk: no text the plugin hands a model or draws on the user's card carries it. */
export type Item = { id: number; text: string; round?: number; added?: string };
/** A list as it is held and kept on disk: its live items in shown order, and the next free number. */
export type List = { next_id: number; items: Item[] };
/** A value that left a list: removed, or replaced by an edit. */
export type Left = { id: number; text: string; left: 'removed' | 'edited'; added?: string };
/** One storage entry as the wake lists it (storage.ts). */
export type StorageEntry = { name: string; description: string };

/** Everything the plugin holds of one party's frontier. `rounds`: the compactions installed for the party while it held an item, absent is 0; each item's rounds unchanged are counted against it. `floor`: the party's context, in tokens as Claude Code reported it, at its first reading ever, or after its last compaction the larger of its first two readings, `settling` while only the first is in; a compaction that frees next to nothing is told by it (parties.ts `finishReached`), and with a working room set the party's nudges start that room above it (nudge.ts `nudgeStart`). */
export type Held = { objective?: string; next?: string; lists: Record<ListName, List>; storage: StorageEntry[]; rounds?: number; floor?: number; settling?: true; modelSwitch?: ModelSwitch };

export const emptyList = (): List => ({ next_id: 1, items: [] });
export const emptyHeld = (): Held => ({ lists: Object.fromEntries(LISTS.map((name) => [name, emptyList()])) as Record<ListName, List>, storage: [] });

/** Text as a match reads it: one space for every run of whitespace, lower case. A model sending an item again rejoins lines and re-cases words; the words stay its own. */
export const plain = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** What a wake ends an item with once it has passed `n` compactions with no change; nothing before its first. */
export const unchangedTag = (n: number): string => (n < 1 ? '' : ` [${n} round${n === 1 ? '' : 's'} unchanged]`);
const TAG = /\s*\[\d+ rounds? unchanged\]/;
/** An item's text as sent, without a tag the model copied back from a wake. */
const untagged = (text: string): string => text.replace(new RegExp(`${TAG.source}\\s*$`), '');
/** An item's text without the number the model wrote before it (`[9] Parser merged`): the list numbers its items itself. An edit's text loses only its own number. */
const unnumbered = (text: string, id?: number): string => text.replace(/^\s*\[(\d+)\]\s+(?=\S)/, (whole, n: string) => (id === undefined || Number(n) === id ? '' : whole));
/** What a wake says once, after lists that show a tag; '' when none of `shown` does. */
export const unchangedNote = (...shown: (string | undefined)[]): string =>
  shown.some((text) => text !== undefined && TAG.test(text)) ? ' An item tagged [N rounds unchanged] has passed N compactions with no change: keep it only while it is still true and still needed, and a standing order while it binds.' : '';

export const kind = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const blank = (v: unknown): boolean => typeof v !== 'string' || v.trim() === '';

/** An item number as sent: a whole number, or a string of one (`"3"`, `"[3]"`); undefined for anything else. */
function idOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\[?\d+\]?\s*$/.test(v) ? Number(v.replace(/[^\d]/g, '')) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The most characters of an item that left a result line shows: enough to recognise it. Its whole text is in the list's history file (disk.ts) and in the transcript, where look_back finds it. */
export const LEFT_SHOWN_CHARS = 80;
/** An item that left, as a result line shows it: whole up to LEFT_SHOWN_CHARS, else its first LEFT_SHOWN_CHARS on one line and `…`, so a wake that repeats the result carries no text the call replaced. */
const leftShown = (text: string): string => (text.length <= LEFT_SHOWN_CHARS ? text : `${text.slice(0, LEFT_SHOWN_CHARS).replace(/\s+/g, ' ')}…`);
/** An item's value as it leaves, its `added` carried into its history line. */
const leaving = (item: Item, left: Left['left']): Left => ({ id: item.id, text: item.text, left, ...(item.added !== undefined ? { added: item.added } : {}) });

export type ListCount = { added: number; removed: number; edited: number; skipped: number };
export type ListOutcome = { list: List; lines: string[]; notes: string[]; left: Left[]; count: ListCount };

type Add = { text: string; before?: number; at: string };

/** A list's change as the call sent it, read leniently: `{ add, remove, edit }`, a plain text as one added item (an operation's name alone as nothing), an array as its adds; each entry that cannot be read is one note naming its place. */
function readChange(name: ListName, change: unknown): { adds: Add[]; removes: { id: number; at: string }[]; edits: { id: number; text: string; at: string }[]; notes: string[] } {
  const out = { adds: [] as Add[], removes: [] as { id: number; at: string }[], edits: [] as { id: number; text: string; at: string }[], notes: [] as string[] };
  if (change === undefined) return out;
  let ops: Record<string, unknown>;
  if (typeof change === 'string') {
    if (change.trim() === '') return (out.notes.push(`${name} was blank: nothing changed.`), out);
    const word = change.trim().toLowerCase();
    if (['add', 'remove', 'edit'].includes(word)) return (out.notes.push(`${name} was only the word "${word}", an operation with no item: nothing changed.`), out);
    out.notes.push(`${name} was a text, not {add, remove, edit}: taken as one added item.`);
    ops = { add: [change] };
  } else if (Array.isArray(change)) {
    out.notes.push(`${name} was an array, not {add, remove, edit}: taken as its adds.`);
    ops = { add: change };
  } else if (isObject(change)) ops = change;
  else return (out.notes.push(`${name} must be {add, remove, edit}; got ${kind(change)}: nothing changed.`), out);
  for (const key of Object.keys(ops)) if (!['add', 'remove', 'edit'].includes(key)) out.notes.push(`${name}.${key} is not add, remove or edit: ignored.`);
  const entries = (key: string, one: (v: unknown) => boolean): unknown[] => {
    const v = ops[key];
    if (v === undefined) return [];
    if (Array.isArray(v)) return v;
    if (one(v)) return [v];
    out.notes.push(`${name}.${key} must be an array; got ${kind(v)}: skipped.`);
    return [];
  };
  for (const [i, entry] of entries('add', (v) => typeof v === 'string' || isObject(v)).entries()) {
    const at = `${name}.add[${i}]`;
    const { text, before } = isObject(entry) ? entry : { text: entry, before: undefined };
    if (isObject(entry)) for (const key of Object.keys(entry)) if (key !== 'text' && key !== 'before') out.notes.push(`${at}.${key} is not text or before: ignored.`);
    if (blank(text)) {
      out.notes.push(`${at} ${typeof text === 'string' ? 'is blank' : `must be a text; got ${kind(text)}`}: skipped.`);
      continue;
    }
    if (before !== undefined && name !== 'remaining') out.notes.push(`${at}.before is for remaining only: added last.`);
    const step = name === 'remaining' && before !== undefined ? idOf(before) : undefined;
    if (name === 'remaining' && before !== undefined && step === undefined) out.notes.push(`${at}.before must be a step number; got ${kind(before)}: added last.`);
    out.adds.push({ text: unnumbered(untagged(text as string)), at, ...(step !== undefined ? { before: step } : {}) });
  }
  for (const [i, entry] of entries('remove', (v) => idOf(v) !== undefined).entries()) {
    const id = idOf(entry);
    if (id === undefined) out.notes.push(`${name}.remove[${i}] must be an item number; got ${kind(entry)}: skipped.`);
    else out.removes.push({ id, at: `${name}.remove[${i}]` });
  }
  for (const [i, entry] of entries('edit', isObject).entries()) {
    const at = `${name}.edit[${i}]`;
    if (!isObject(entry)) {
      out.notes.push(`${at} must be {id, text}; got ${kind(entry)}: skipped.`);
      continue;
    }
    const { id: sent, text } = entry;
    const id = idOf(sent);
    if (id === undefined) out.notes.push(`${at}.id must be an item number; got ${kind(sent)}: skipped.`);
    else if (blank(text)) out.notes.push(`${at}.text ${typeof text === 'string' ? 'is blank' : `must be a text; got ${kind(text)}`}: skipped.`);
    else out.edits.push({ id, text: unnumbered(untagged(text as string), id), at });
  }
  return out;
}

/**
 * One call's change to one list: removes and edits aim at the numbers the model saw, then the adds take the next free
 * numbers. A number both removed and edited is removed; a number that is not live, a blank text or a malformed entry is
 * skipped; an added text equal to a live item (`plain`) is skipped as `already [n]`; each with one note or line. In
 * `remaining` an add may name a live step to stand `before`; one that is not live puts it last. An item added or edited
 * takes `round`, the party's count of installed compactions, from which its rounds unchanged are counted; an added one
 * takes `addedAt`, the call's time, as its `added`, which an edit keeps. Never throws.
 */
export function listApply(name: ListName, list: List, change: unknown, round = 0, addedAt?: string): ListOutcome {
  const stamp = (item: Item): Item => (round > 0 ? Object.assign(item, { round }) : item);
  const read = readChange(name, change);
  const notes = [...read.notes];
  const seen = new Map(list.items.map((item) => [item.id, item]));
  const removed = new Set<number>();
  for (const r of read.removes) {
    if (!seen.has(r.id)) notes.push(`${r.at}: [${r.id}] is not a live item: skipped.`);
    else removed.add(r.id);
  }
  const items = list.items.map((item) => ({ ...item }));
  const left: Left[] = [];
  const lines: string[] = [];
  const edited: string[] = [];
  for (const e of read.edits) {
    const item = items.find((it) => it.id === e.id);
    if (item === undefined) notes.push(`${e.at}: [${e.id}] is not a live item: skipped.`);
    else if (removed.has(e.id)) notes.push(`${e.at}: [${e.id}] is also removed: removed.`);
    else if (item.text === e.text) notes.push(`${e.at}: [${e.id}] already reads so: unchanged.`);
    else (left.push(leaving(item, 'edited')), edited.push(`Edited in ${name}: [${item.id}], was: ${leftShown(item.text)}`), (item.text = e.text), stamp(item));
  }
  const removedLines: string[] = [];
  const kept = items.filter((item) => {
    if (!removed.has(item.id)) return true;
    left.push(leaving(item, 'removed')), removedLines.push(`Removed from ${name}: [${item.id}] ${leftShown(item.text)}`);
    return false;
  });
  let next = list.next_id;
  const added: number[] = [];
  const skipped: string[] = [];
  for (const a of read.adds) {
    const same = kept.find((item) => plain(item.text) === plain(a.text));
    if (same !== undefined) {
      skipped.push(`Skipped in ${name}: already [${same.id}]`);
      continue;
    }
    const item = stamp({ id: next++, text: a.text });
    if (addedAt !== undefined) item.added = addedAt;
    const at = a.before === undefined ? -1 : kept.findIndex((it) => it.id === a.before);
    if (a.before !== undefined && at < 0) notes.push(`${a.at}.before: [${a.before}] is not a live step: added last.`);
    if (at < 0) kept.push(item);
    else kept.splice(at, 0, item);
    added.push(item.id);
  }
  if (added.length > 0) lines.push(`Added to ${name}: ${added.map((id) => `[${id}]`).join(', ')}`);
  lines.push(...removedLines, ...edited, ...skipped);
  return { list: { next_id: next, items: kept }, lines, notes, left, count: { added: added.length, removed: removedLines.length, edited: edited.length, skipped: skipped.length } };
}

export type TextOutcome = { text?: string; lines: string[]; notes: string[]; left?: string };

/** One call's `objective` or `next`: a text replaces the stored one whole, the one replaced leaving; a text left out keeps it (`next` says so); anything but a non-blank text is one note and keeps it. */
export function textApply(name: TextName, held: string | undefined, sent: unknown): TextOutcome {
  const keep = held === undefined ? 'nothing stored' : 'kept';
  if (sent === undefined) return { ...(held !== undefined ? { text: held } : {}), lines: name === 'next' && held !== undefined ? [`next kept: ${held}`] : [], notes: [] };
  if (typeof sent !== 'string') return { ...(held !== undefined ? { text: held } : {}), lines: [], notes: [`${name} must be a text; got ${kind(sent)}: ${keep}.`] };
  if (sent.trim() === '') return { ...(held !== undefined ? { text: held } : {}), lines: [], notes: [`${name} was blank: ${keep}.`] };
  if (held === undefined) return { text: sent, lines: [`${name} set`], notes: [] };
  if (held === sent) return { text: sent, lines: [`${name} unchanged`], notes: [] };
  return { text: sent, lines: [`${name} replaced`], notes: [], left: held };
}

/** The frontier's sections in the order the wake shows them, each list's live items one per line as `[n] text`. */
export const SECTIONS: readonly { key: TextName | Exclude<ListName, 'orders'>; heading: string }[] = [
  { key: 'objective', heading: 'Objective' },
  { key: 'decisions', heading: 'Decisions' },
  { key: 'done', heading: 'Done' },
  { key: 'remaining', heading: 'Remaining' },
  { key: 'next', heading: 'Next' },
  { key: 'blocked', heading: 'Blocked' },
  { key: 'findings', heading: 'Findings' },
];

/** A list's live items as the wake shows them, each ending with the rounds it has passed unchanged of the party's `rounds` (`unchangedTag`). */
export const itemLines = (list: List, rounds = 0): string[] => list.items.map((item) => `[${item.id}] ${item.text}${unchangedTag(rounds - (item.round ?? 0))}`);

/**
 * A done list split for a wake: walking from the newest item (highest number) to the oldest, an item is shown while
 * the shown items' texts sum to at most `maxChars`, the newest always, even alone over it; every older item is earlier.
 * Shown keeps the list's order, earlier is oldest first. Nothing moves in the store: the split is made at each rendering.
 */
export function doneSplit(items: readonly Item[], maxChars: number): { shown: Item[]; earlier: Item[] } {
  const newest = [...items].sort((a, b) => b.id - a.id), shown = new Set<number>();
  let chars = 0;
  for (const item of newest) {
    if (shown.size > 0 && chars + item.text.length > maxChars) break;
    chars += item.text.length, shown.add(item.id);
  }
  return { shown: items.filter((item) => shown.has(item.id)), earlier: newest.filter((item) => !shown.has(item.id)).reverse() };
}

/**
 * The done items done-earlier.md holds, oldest first: the earlier ones at `maxChars` (`doneSplit`) and every live item
 * numbered up to `through`, the highest number the file already held (Infinity: every one). A rewrite so drops no live
 * item the file held: one the party's wake did not show stays readable there until a wake that shows it has reached the
 * party (disk.ts `doneReached`). One number says it all: the split is by number, so the file's items are always the lowest.
 */
export function doneFiled(items: readonly Item[], maxChars: number, through: number): Item[] {
  const top = Math.max(through, doneSplit(items, maxChars).earlier.at(-1)?.id ?? 0);
  return items.filter((item) => item.id <= top).sort((a, b) => a.id - b.id);
}

/** A wake's done list with earlier items (`doneSplit`) and the file that holds them whole (disk.ts `DONE_EARLIER_FILE`), its absolute path. */
export type DoneWake = { shown: Item[]; earlier: Item[]; path: string };

/** The line a wake shows under done, before its shown items, naming the file the earlier ones are in. */
export function doneEarlierLine(earlier: readonly Item[], path: string): string {
  const ids = earlier.map((item) => item.id), rest = 'finished work like the items below, edited or removed by number like them. Read the file when a step or the final report may rest on one.';
  return ids.length === 1 ? `1 earlier done item, [${ids[0]}], is in ${path}, whole under its number: ${rest}` : `${ids.length} earlier done items, [${Math.min(...ids)}] to [${Math.max(...ids)}], are in ${path}, each whole under its number: ${rest}`;
}

/** The result's line for a done list with earlier items: how many stay in the wake and where the rest are; none without. */
export const doneLines = (done: DoneWake | undefined): string[] => (done === undefined || done.earlier.length === 0 ? [] : [`Done: ${done.shown.length} newest ${done.shown.length === 1 ? 'item stays' : 'items stay'} in your wake, ${done.earlier.length} earlier in ${done.path}`]);

/** The done items a wake shows and those in the file, each counted with its characters: the whole list shown when there is no split. */
export function doneSizes(done: List, split: DoneWake | undefined): { shown: number; shownChars: number; earlier: number; earlierChars: number } {
  const chars = (items: readonly Item[]): number => items.reduce((sum, item) => sum + item.text.length, 0), shown = split?.shown ?? done.items, earlier = split?.earlier ?? [];
  return { shown: shown.length, shownChars: chars(shown), earlier: earlier.length, earlierChars: chars(earlier) };
}

/** The frontier rendered from what is held: each section with content under its heading, an empty one left out; '' when nothing is held. With `done` holding earlier items, done shows its file's line and then only its shown items. */
export function renderFrontier(held: Held, done?: DoneWake): string {
  return SECTIONS.flatMap(({ key, heading }) => {
    if (key === 'objective' || key === 'next') return held[key] === undefined ? [] : [`## ${heading}\n${held[key]}`];
    const list = held.lists[key];
    if (key === 'done' && done !== undefined && done.earlier.length > 0) return [`## ${heading}\n${[doneEarlierLine(done.earlier, done.path), ...itemLines({ ...list, items: done.shown }, held.rounds)].join('\n')}`];
    return list.items.length === 0 ? [] : [`## ${heading}\n${itemLines(list, held.rounds).join('\n')}`];
  }).join('\n\n');
}

/** `held` after one more installed compaction: a frontier holding any item has passed one more round, one holding none counts nothing and is returned as it is. */
export function roundPassed(held: Held): Held {
  return LISTS.some((name) => held.lists[name].items.length > 0) ? { ...held, rounds: (held.rounds ?? 0) + 1 } : held;
}

/** The frontier's size: the characters of every live item, the objective and next; the live items, and each list's items and characters. */
export type FrontierSize = { chars: number; items: number; lists: { name: ListName; items: number; chars: number }[] };

export function frontierSize(held: Held): FrontierSize {
  const lists = LISTS.map((name) => ({ name, items: held.lists[name].items.length, chars: held.lists[name].items.reduce((sum, item) => sum + item.text.length, 0) }));
  const chars = lists.reduce((sum, l) => sum + l.chars, 0) + (held.objective?.length ?? 0) + (held.next?.length ?? 0);
  return { chars, items: lists.reduce((sum, l) => sum + l.items, 0), lists };
}

/** A count as text, thousands grouped: `9,321`. */
export const num = (n: number): string => n.toLocaleString('en-US');

/** The result's size line, lists with items only, and over `warnAt` characters with no list item, the line asking for a shorter objective and next. A frontier whose lists hold items is asked nothing: an item folded into another loses what told it apart (which row, which test), and the model then reports from the fold. No automatic cut. */
export function sizeLines(size: FrontierSize, warnAt: number): string[] {
  const filled = size.lists.filter((l) => l.items > 0);
  const lines = [`Frontier: ${num(size.chars)} characters in ${size.items} items${filled.length === 0 ? '' : ` (${filled.map((l) => `${l.name} ${l.items}`).join(', ')})`}`];
  if (size.chars > warnAt && filled.length === 0) lines.push(`Frontier is ${num(size.chars)} characters, over ${num(warnAt)}: in your next forward_compaction call send a shorter objective and next.`);
  return lines;
}
