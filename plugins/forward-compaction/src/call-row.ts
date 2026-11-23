// A forward_compaction call as the transcript draws it. Outside the expanded view the call's row draws what the call did
// in place of its raw arguments and result: every list with what it holds and its changes by item number, both texts,
// the storage, the load files, what it wrote, the frontier's size and whether it compacts, changed by the call or not.
// The expanded view (ctrl+o, --verbose, an export) and the stored result, the one the model reads,
// keep every character. Pure: the row's props arrive as plain data and the tree leaves as plain data.

import { FORWARD_TOOL } from './frontier';
import { LISTS, num, TEXTS, type ListName, type TextName } from './lists';
import { k } from './nudge';
import type { RowNode } from './wake-row';

/** The props of a tool call's transcript row that decide its drawing (`ui.render`'s ToolUse; a ToolResult row has no `input`). */
export type CallProps = { tool: string; input?: unknown; output?: unknown; isRunning?: boolean; isErrored: boolean; isInterrupted?: boolean; isExpanded?: boolean };

/** What Claude Code measured of the request that made a call (`turn.step` usage): the tokens it wrote, and the context with them. */
export type CallMeasure = { output?: number; context?: number };

/** One list's changes by item number, as the result's lines name them. */
export type ListChange = { added: number[]; edited: number[]; removed: number[] };

/** What a call's result says it did and holds. `when`: the receipt's own words for the install; `sizes`: the result's size line, `held` each list's items by it (a list it leaves out holds none); `storage.held`: the listed files by the result's storage line, absent when it has none. */
export type CallStats = {
  compacts: boolean; when?: string; files: number; without?: string;
  lists: Partial<Record<ListName, ListChange>>; texts: Partial<Record<TextName, 'set' | 'replaced'>>;
  storage: { stored: string[]; described: string[]; unlisted: string[]; held?: string[] };
  sizes?: { chars: string; items: string }; held?: Record<ListName, number>;
};

/** A call's key in the adapter's measures: its arguments as JSON, which the step that asked for it and its row both carry (a step names no call id). */
export const callKey = (input: unknown): string => JSON.stringify(input) ?? '';

const isList = (name: string): name is ListName => (LISTS as readonly string[]).includes(name);
const ids = (text: string): number[] => [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));

/**
 * Reads a call's result (frontier.ts `receipt` after lists.ts `listApply`, `textApply`, `sizeLines` and storage.ts
 * `storageApply`, `storageHeld`) back into what it did; undefined for a text that is no stored or updated frontier (a failed call).
 */
export function callStats(result: string): CallStats | undefined {
  const lines = result.split('\n'), door = lines.map((line) => /^Frontier (stored|updated)(?: with (\d+) files? to load)?(?:, without ([^:]+):)?.*$/.exec(line)).find((m) => m !== null);
  if (door === undefined || door === null) return undefined;
  const when = /[Ii]t installs ([^.:,]+)/.exec(door[0])?.[1]?.replace(/\byour\b/g, 'the'); // the receipt's first words on the install: "at the end of this turn"
  const stats: CallStats = { compacts: door[1] === 'stored', files: Number(door[2] ?? 0), lists: {}, texts: {}, storage: { stored: [], described: [], unlisted: [] }, ...(when !== undefined && door[1] === 'stored' ? { when } : {}), ...(door[3] !== undefined ? { without: door[3] } : {}) };
  const change = (name: string): ListChange | undefined => (isList(name) ? (stats.lists[name] ??= { added: [], edited: [], removed: [] }) : undefined);
  for (const line of lines) {
    const list = /^(Added to|Edited in|Removed from) (\w+): (.*)$/.exec(line), text = /^(\w+) (set|replaced)$/.exec(line), size = /^Frontier: ([\d,]+) characters in (\d+) items(?: \((.+)\))?$/.exec(line), store = /^Storage: (?:none|\d+ files? \((.*)\))$/.exec(line);
    if (list !== null) change(list[2]!)?.[list[1] === 'Added to' ? 'added' : list[1] === 'Edited in' ? 'edited' : 'removed'].push(...(list[1] === 'Added to' ? ids(list[3]!) : ids(list[3]!).slice(0, 1)));
    else if (text !== null && (TEXTS as readonly string[]).includes(text[1]!)) stats.texts[text[1] as TextName] = text[2] as 'set' | 'replaced';
    else if (size !== null) (stats.sizes = { chars: size[1]!, items: size[2]! }), (stats.held = Object.fromEntries(LISTS.map((name) => [name, Number(new RegExp(`\\b${name} (\\d+)`).exec(size[3] ?? '')?.[1] ?? 0)])) as Record<ListName, number>);
    else if (store !== null) stats.storage.held = store[1] === undefined ? [] : store[1].split(', ');
    else if (line.startsWith('Stored ')) stats.storage.stored.push(line.slice(7).split(' ')[0]!);
    else if (line.startsWith('Described ')) stats.storage.described.push(line.slice(10));
    else if (line.startsWith('Storage no longer lists ')) stats.storage.unlisted.push(line.slice(24));
  }
  return stats;
}

const DIM = { dimColor: true }, LABEL_WIDTH = 11, COUNT_WIDTH = 3;
const text = (value: string, props: RowNode['props'] = {}): RowNode => ({ type: 'Text', props, children: [value] });
/** One line of the block under the row: a dim label column, then its cells two spaces apart. */
const line = (label: string, ...cells: (RowNode | undefined)[]): RowNode => ({ type: 'Text', props: {}, children: [text(label.padEnd(LABEL_WIDTH), DIM), ...cells.filter((c) => c !== undefined).flatMap((c, i) => (i === 0 ? [c] : ['  ', c]))] });
const marked = (mark: string, numbers: number[], color: string): RowNode | undefined => (numbers.length === 0 ? undefined : text(`${mark}${numbers.length} ${numbers.map((n) => `[${n}]`).join(' ')}`, { color }));
const named = (mark: string, names: string[], color: string): RowNode | undefined => (names.length === 0 ? undefined : text(names.map((n) => `${mark}${n}`).join(' '), { color }));

/** A cell that says a part holds nothing or did not change. */
const quiet = (value: string): RowNode => text(value, DIM);
/** What a part holds, before its changes: padded to the count column when changes follow, dim when it holds nothing. */
const holds = (count: number | undefined, changes: (RowNode | undefined)[]): RowNode | undefined => (count === undefined ? undefined : text(changes.some((c) => c !== undefined) ? String(count).padEnd(COUNT_WIDTH) : String(count), count === 0 ? DIM : {}));

/**
 * The lines under a call's row, every one on every call: each list with what it holds and its changes, each text
 * (set, replaced, unchanged or missing), the storage's listed files and its changes, the load files, then what the
 * call wrote, the frontier's size and the context. A result with no storage line (a build before it) reads `not reported`.
 */
function statLines(stats: CallStats, input: unknown, measure: CallMeasure | undefined): RowNode[] {
  const lacks = stats.without?.split(' and ') ?? [], held = stats.storage.held;
  const stored = [named('+', stats.storage.stored, 'success'), named('~', stats.storage.described, 'warning'), named('-', stats.storage.unlisted, 'error')];
  return [
    ...LISTS.map((name) => { const c = stats.lists[name], cells = c === undefined ? [] : [marked('+', c.added, 'success'), marked('~', c.edited, 'warning'), marked('-', c.removed, 'error')]; return line(name, holds(stats.held?.[name], cells), ...cells); }),
    ...TEXTS.map((name) => line(name, stats.texts[name] !== undefined ? text(stats.texts[name], { color: stats.texts[name] === 'set' ? 'success' : 'warning' }) : lacks.includes(name) ? text('missing', { color: 'error' }) : quiet('unchanged'))),
    line('storage', held === undefined ? (stored.some((c) => c !== undefined) ? undefined : quiet('not reported')) : held.length === 0 ? quiet('none') : text(`${held.length} ${held.length === 1 ? 'file' : 'files'}: ${held.join(', ')}`), ...stored),
    line('load_files', stats.files === 0 ? quiet('none') : text(`${stats.files} read in at the install`)),
    line('wrote', text(`${num(callKey(input).length)} chars of arguments${measure?.output === undefined ? '' : ` · its request wrote ${num(measure.output)} tokens`}`)),
    ...(stats.sizes === undefined ? [] : [line('frontier', text(`${stats.sizes.chars} chars · ${stats.sizes.items} ${stats.sizes.items === '1' ? 'item' : 'items'}`))]),
    ...(measure?.context === undefined ? [] : [line('context', text(`${k(measure.context)} at the call`))]),
  ];
}

const ours = (row: CallProps): boolean => row.isExpanded !== true && !row.isErrored && row.isInterrupted !== true && row.tool.endsWith(`__${FORWARD_TOOL}`);

/**
 * What a tool call's row draws in the engine's place, or undefined where the engine draws it: only a forward_compaction
 * call, folded, running or answered with a stored or updated frontier. `measure`: what Claude Code measured of its request.
 */
export function callRow(row: CallProps, measure?: CallMeasure): RowNode | undefined {
  if (!ours(row)) return undefined;
  const stats = typeof row.output === 'string' ? callStats(row.output) : undefined;
  if (stats === undefined && row.output !== undefined) return undefined;
  const state = stats === undefined ? [text('  writing the frontier', DIM)]
    : stats.compacts ? [text('  frontier stored', { color: 'success' }), text(` · compacts${stats.when === undefined ? '' : ` ${stats.when}`}`, DIM)]
    : [text('  frontier updated', { color: 'warning' }), text(' · nothing compacts, the context is still small', DIM)];
  const head: RowNode = { type: 'Text', props: {}, children: [text('● ', stats === undefined ? DIM : { color: 'success' }), text(FORWARD_TOOL, { bold: true }), ...state, ...(stats?.without === undefined ? [] : [text(` · without ${stats.without}`, { color: 'warning' })])] };
  const block: RowNode[] = stats === undefined ? [] : [{ type: 'Box', props: { flexDirection: 'row' }, children: [text('  ⎿  ', DIM), { type: 'Box', props: { flexDirection: 'column' }, children: statLines(stats, row.input, measure) }] }];
  return { type: 'Box', props: { flexDirection: 'column', marginTop: 1 }, children: [head, ...block] };
}

/** What the result block under a call's row draws: nothing for a call `callRow` drew whole, else undefined (the engine's). */
export function callResultRow(row: CallProps): RowNode | undefined {
  return ours(row) && typeof row.output === 'string' && callStats(row.output) !== undefined ? { type: 'Box', props: { display: 'none' } } : undefined;
}
