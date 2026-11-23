import { afterEach, describe, expect, it } from 'vitest';
import { fakeEngine, usage } from './fakes/engine.ts';
import { callKey, callResultRow, callRow, type CallMeasure, type CallProps } from '../plugins/forward-compaction/src/call-row.ts';
import type { RowNode } from '../plugins/forward-compaction/src/wake-row.ts';

const FORWARD = 'mcp__forward-compaction__forward_compaction';
const END = 'forward-compaction is experimental. If it gave you any trouble, append a short note of what happened to your reply.';
const BEHIND = 'The newest messages after this call that fit are kept verbatim behind it, the rest named as not carried';

/** A main chat's call past its notice point, as its result reads: every kind of change, two files to load. */
const STORED = [
  'objective replaced',
  'Added to decisions: [2], [3]',
  'Edited in done: [1], was: Cause found',
  'Removed from remaining: [3] the old step, which named [9] and [12]',
  'Removed from findings: [6] a wrong finding',
  'Edited in findings: [7], was: old',
  'next replaced',
  'Stored map.md (9,320 characters, as it is in the folder)',
  'Described notes.md',
  'Storage no longer lists old.md',
  'remaining.add[2] must be a text; got a number: skipped.',
  'Frontier: 9,321 characters in 28 items (orders 18, decisions 2, done 1, remaining 1, findings 6)',
  'Storage: 2 files (map.md, notes.md)',
  `Frontier stored with 2 files to load. It installs at the end of this turn, or at Claude Code's next compaction ask if one comes first. ${BEHIND}, so finish the step in hand; you need not stop.`,
  END,
].join('\n');
/** A call below its notice point that changed nothing but `next`, which it sent as it was held. */
const UPDATED = ['next unchanged', 'Frontier: 40 characters in 1 items (done 1)', 'Storage: none', 'Frontier updated. Nothing compacts: your context is still too small for a compaction to pay, and stays as it is. Carry on; a forward-compaction notice asks for the call once it has grown enough.', END].join('\n');
/** A sub-agent's first call, with no objective, before Claude Code asked, as a build before the result's storage line wrote it. */
const WAITING = ['next set', 'Frontier: 4 characters in 0 items', `Frontier stored, without objective: send it before it installs, or the wake names it missing. Claude Code has not asked to compact you yet: it installs at Claude Code's next ask, from about 67k context. ${BEHIND}. Carry on with your work.`, END].join('\n');
const FAILED = `forward_compaction failed, nothing stored: disk full\n${END}`;

const DIM = { dimColor: true };
const T = (value: string, props: RowNode['props'] = {}): RowNode => ({ type: 'Text', props, children: [value] });
const line = (label: string, ...cells: RowNode[]): RowNode => ({ type: 'Text', props: {}, children: [T(label.padEnd(11), DIM), ...cells.flatMap((c, i) => (i === 0 ? [c] : ['  ', c]))] });
const drawn = (head: RowNode[], lines?: RowNode[]): RowNode => ({
  type: 'Box', props: { flexDirection: 'column', marginTop: 1 },
  children: [{ type: 'Text', props: {}, children: head }, ...(lines === undefined ? [] : [{ type: 'Box' as const, props: { flexDirection: 'row' }, children: [T('  ⎿  ', DIM), { type: 'Box' as const, props: { flexDirection: 'column' }, children: lines }] }])],
});
const DONE = [T('● ', { color: 'success' }), T('forward_compaction', { bold: true })];
const NOTHING: RowNode = { type: 'Box', props: { display: 'none' } };
const EMPTY = T('0', DIM), SAME = T('unchanged', DIM), NONE = T('none', DIM);

const call = (over: Partial<CallProps> = {}): CallProps => ({ tool: FORWARD, input: { next: 'x' }, isRunning: false, isErrored: false, ...over });

describe('callRow: what a forward_compaction call draws in place of its arguments and result', () => {
  it.each<[string, CallProps, CallMeasure | undefined, RowNode | undefined]>([
    ['a stored call draws every list with what it holds and each change by item number, both texts, the storage, the load files, what it wrote, the frontier and the context', call({ output: STORED }), { output: 2080, context: 218_300 }, drawn([...DONE, T('  frontier stored', { color: 'success' }), T(' · compacts at the end of this turn', DIM)], [
      line('orders', T('18')),
      line('decisions', T('2  '), T('+2 [2] [3]', { color: 'success' })),
      line('done', T('1  '), T('~1 [1]', { color: 'warning' })),
      line('remaining', T('1  '), T('-1 [3]', { color: 'error' })),
      line('blocked', EMPTY),
      line('findings', T('6  '), T('~1 [7]', { color: 'warning' }), T('-1 [6]', { color: 'error' })),
      line('objective', T('replaced', { color: 'warning' })),
      line('next', T('replaced', { color: 'warning' })),
      line('storage', T('2 files: map.md, notes.md'), T('+map.md', { color: 'success' }), T('~notes.md', { color: 'warning' }), T('-old.md', { color: 'error' })),
      line('load_files', T('2 read in at the install')),
      line('wrote', T('12 chars of arguments · its request wrote 2,080 tokens')),
      line('frontier', T('9,321 chars · 28 items')),
      line('context', T('218k at the call')),
    ])],
    ['a call below its notice point says nothing compacts, and one that changed nothing still draws every part, the empty ones too', call({ output: UPDATED }), undefined, drawn([...DONE, T('  frontier updated', { color: 'warning' }), T(' · nothing compacts, the context is still small', DIM)], [
      line('orders', EMPTY), line('decisions', EMPTY), line('done', T('1')), line('remaining', EMPTY), line('blocked', EMPTY), line('findings', EMPTY),
      line('objective', SAME), line('next', SAME), line('storage', NONE), line('load_files', NONE),
      line('wrote', T('12 chars of arguments')),
      line('frontier', T('40 chars · 1 item')),
    ])],
    ["a sub-agent's call names Claude Code's ask and what the frontier lacks, and a result with no storage line says the storage is not reported", call({ tool: 'mcp__forward-compaction-dev__forward_compaction', output: WAITING }), { output: 300 }, drawn([...DONE, T('  frontier stored', { color: 'success' }), T(" · compacts at Claude Code's next ask", DIM), T(' · without objective', { color: 'warning' })], [
      line('orders', EMPTY), line('decisions', EMPTY), line('done', EMPTY), line('remaining', EMPTY), line('blocked', EMPTY), line('findings', EMPTY),
      line('objective', T('missing', { color: 'error' })), line('next', T('set', { color: 'success' })), line('storage', T('not reported', DIM)), line('load_files', NONE),
      line('wrote', T('12 chars of arguments · its request wrote 300 tokens')),
      line('frontier', T('4 chars · 0 items')),
    ])],
    ['a call still running draws its name alone', call({ isRunning: true }), undefined, drawn([T('● ', DIM), T('forward_compaction', { bold: true }), T('  writing the frontier', DIM)])],
    ['a failed call stays whole', call({ output: FAILED }), undefined, undefined],
    ['a result that is no text stays whole', call({ output: { content: STORED } }), undefined, undefined],
    ['the expanded view keeps the arguments and the result whole', call({ output: STORED, isExpanded: true }), undefined, undefined],
    ['a call that errored stays whole', call({ output: STORED, isErrored: true }), undefined, undefined],
    ['a call an abort cut stays whole', call({ isInterrupted: true }), undefined, undefined],
    ["another tool's row stays whole", call({ tool: 'mcp__forward-compaction__look_back', output: STORED }), undefined, undefined],
  ])('%s', (_name, props, measure, tree) => {
    expect(callRow(props, measure)).toEqual(tree);
  });

  it.each<[string, CallProps, RowNode | undefined]>([
    ['the result of a call drawn whole draws nothing', call({ output: STORED }), NOTHING],
    ['the result of a failed call stays whole', call({ output: FAILED }), undefined],
    ['the expanded view keeps the result whole', call({ output: STORED, isExpanded: true }), undefined],
    ["another tool's result stays whole", call({ tool: 'Bash', output: STORED }), undefined],
  ])('%s', (_name, props, tree) => {
    expect(callResultRow(props)).toEqual(tree);
  });
});

describe('the adapter draws a forward_compaction call as what it did', () => {
  let f: ReturnType<typeof fakeEngine> | undefined;
  afterEach(() => { f?.cleanup(); f = undefined; });

  const ENGINE = { type: 'engine', ref: 0 };
  const draw = (component: string, props: Record<string, unknown>): Promise<unknown> => f!.dispatch('ui.render', { surface: 'terminal', component, requestId: 'tu-1', props }, async () => ENGINE);

  it('draws the real result of a call, then the tokens its request wrote once Claude Code measured them, and leaves every other row to the engine', async () => {
    f = fakeEngine({ window: 1_000_000 });
    await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
    const input = { objective: 'ship it', next: 'run the gate', done: { add: ['parser merged'] } };
    const answered = await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-1', ...input }, async () => ({ result: 'not ours' })) as { result: string };
    const props = { tool_use_id: 'tu-1', tool: FORWARD, input, output: answered.result, isRunning: false, isErrored: false, isInterrupted: false };
    const head = [...DONE, T('  frontier stored', { color: 'success' }), T(' · compacts at the end of this turn', DIM)];
    const changes = [line('orders', EMPTY), line('decisions', EMPTY), line('done', T('1  '), T('+1 [1]', { color: 'success' })), line('remaining', EMPTY), line('blocked', EMPTY), line('findings', EMPTY),
      line('objective', T('set', { color: 'success' })), line('next', T('set', { color: 'success' })), line('storage', NONE), line('load_files', NONE)];
    expect(callKey(input)).toBe('{"objective":"ship it","next":"run the gate","done":{"add":["parser merged"]}}');
    expect(await draw('ToolUse', props)).toEqual(drawn(head, [...changes, line('wrote', T('78 chars of arguments')), line('frontier', T('32 chars · 1 item'))]));
    expect(f.invalidated).toEqual([]);

    await f.dispatch('turn.step', { turnId: 't1', index: 0, model: 'claude-sonnet-4-5', messageCount: 4 }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [{ name: 'Read', input: { file_path: '/x' } }, { name: FORWARD, input }], stopReason: 'tool_use', ...usage(50_000, 812) }));
    expect(f.invalidated).toEqual(['ui.render']);
    expect(await draw('ToolUse', props)).toEqual(drawn(head, [...changes, line('wrote', T('78 chars of arguments · its request wrote 812 tokens')), line('frontier', T('32 chars · 1 item')), line('context', T('51k at the call'))]));

    expect(await draw('ToolResult', props)).toEqual(NOTHING);
    expect(await draw('ToolUse', { ...props, isExpanded: true })).toBe(ENGINE);
    expect(await draw('ToolResult', { ...props, isExpanded: true })).toBe(ENGINE);
    expect(await draw('ToolUse', { ...props, tool: 'Read' })).toBe(ENGINE);
    expect(f.unscripted).toEqual([]);
  });
});
