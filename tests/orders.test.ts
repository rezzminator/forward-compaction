import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeEngine, usage, type FileEntry, type Script } from './fakes/engine.ts';
import { keptOrders, ORDERS_HEADING, ordersSection } from '../plugins/forward-compaction/src/orders.ts';
import type { BuiltMessage, WakeMessage } from '../plugins/forward-compaction/src/kept.ts';
import { buildWake, mechanicalWake, type WakeFacts } from '../plugins/forward-compaction/src/wake.ts';

// Standing orders: a numbered list the model adds to and removes from by number, shown above everything else in every
// wake. An order stays until a call removes it: a call that leaves orders out changes nothing.

const ORDER = 'do not spawn more';
/** The wake's section that opens with `heading`, whole. */
const sectionOf = (text: string, heading: string): string | undefined => text.split('\n\n').find((s) => s.startsWith(heading));

describe('keptOrders: what the previous build kept in $.state', () => {
  it.each([
    [[{ order: ORDER }], [ORDER]],
    [[{ order: 'never push', at: '2026-10-27T14:53:00.000Z' }, { order: 'Write no files.' }], ['never push', 'Write no files.']],
    [[{ order: ORDER }, { order: 3, at: 'x' }, { order: '  ' }, null], [ORDER]],
    [[], []],
    [undefined, undefined],
    ['x', undefined],
  ])('%j -> %j', (kept, want) => {
    expect(keptOrders(kept)).toEqual(want);
  });
});

describe('the wake renders the standing orders above everything', () => {
  type Msg = WakeMessage & { handle: string };
  const call: Msg = { role: 'assistant', text: 'compacting', toolUses: [{ tool_use_id: 't9', tool: 'mcp__forward-compaction__forward_compaction', input: {} }], handle: 'h1' };
  const answer: Msg = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't9', text: 'Frontier stored' }], handle: 'h2' };
  const facts: WakeFacts = { user: [{ at: Date.UTC(2026, 9, 27, 14, 53), text: 'Alright, do not spawn more' }], notices: [], received: [], skills: [], unattributedSkills: [] };
  const shared = { messages: [call, answer], party: 'main' as const, tokens: 41_000, askPoint: 63_000, now: 0, charsPerToken: 3.5, facts: () => facts };
  const orders = [{ id: 1, text: ORDER }, { id: 3, text: 'never force-push' }];

  it('opens the facts with each live order by its number, before every other section, and the frontier works within them', () => {
    const wake = buildWake({ ...shared, toolUseId: 't9', frontier: '## Next\nround 2', orders });
    const f = (wake.messages[0] as BuiltMessage).text;
    const sections = f.split('\n\n').filter((s) => s.startsWith('## '));
    expect(sections[0]).toBe(`${ORDERS_HEADING}\n[1] ${ORDER}\n[3] never force-push`);
    expect(f.indexOf(ORDERS_HEADING)).toBeLessThan(f.indexOf("## The user's messages"));
    expect((wake.messages[1] as BuiltMessage).text.split('\n')[0]).toBe('[forward-compaction: frontier] Below is your frontier as forward-compaction holds it: continue from its ## Next, within the standing orders above. When a notice next asks for a forward_compaction call, send only changes, by item number; whatever you leave out stays.');
    expect(wake.sizes[0]).toEqual({ section: ORDERS_HEADING, chars: sections[0]!.length });
    const aged = buildWake({ ...shared, toolUseId: 't9', frontier: '## Next\nround 2', rounds: 2, orders: [orders[0]!, { ...orders[1]!, round: 2 }] });
    expect(sectionOf((aged.messages[0] as BuiltMessage).text, ORDERS_HEADING)).toBe(`${ORDERS_HEADING}\n[1] ${ORDER} [2 rounds unchanged]\n[3] never force-push`);
    expect((aged.messages[1] as BuiltMessage).text.split('\n')[0]).toBe('[forward-compaction: frontier] Below is your frontier as forward-compaction holds it: continue from its ## Next, within the standing orders above. When a notice next asks for a forward_compaction call, send only changes, by item number; whatever you leave out stays. An item tagged [N rounds unchanged] has passed N compactions with no change: keep it only while it is still true and still needed, and a standing order until the user lifts it.');
  });

  it('carries them whole whatever the budget, and the mechanical wake carries them the same way', () => {
    const long = 'never '.repeat(20_000).trim();
    const built = buildWake({ ...shared, askPoint: 1_000, toolUseId: 't9', frontier: 'h', orders: [{ id: 1, text: long }] });
    expect(sectionOf((built.messages[0] as BuiltMessage).text, ORDERS_HEADING)).toBe(`${ORDERS_HEADING}\n[1] ${long}`);
    const mech = mechanicalWake({ ...shared, reason: { kind: 'ceiling', ceiling: 120_000 }, orders: [{ id: 1, text: ORDER }] });
    expect(sectionOf((mech.messages[0] as BuiltMessage).text, ORDERS_HEADING)).toBe(`${ORDERS_HEADING}\n[1] ${ORDER}`);
    expect((mech.messages[1] as BuiltMessage).text).toContain('then continue, within the standing orders above;');
  });

  it('has no section and no clause with no orders', () => {
    expect(ordersSection([])).toBeUndefined();
    const wake = buildWake({ ...shared, toolUseId: 't9', frontier: 'h', orders: [] });
    expect((wake.messages[0] as BuiltMessage).text.split('\n\n')[0]).toMatch(/^\[forward-compaction: facts\]/);
    expect(sectionOf((wake.messages[0] as BuiltMessage).text, '## Standing orders')).toBeUndefined();
    expect((wake.messages[1] as BuiltMessage).text.split('\n')[0]).toBe('[forward-compaction: frontier] Below is your frontier as forward-compaction holds it: continue from its ## Next. When a notice next asks for a forward_compaction call, send only changes, by item number; whatever you leave out stays.');
  });
});

// The adapter, end to end: the bug as it happened (2026-10-27): frontier A quoted the user's "do not spawn more",
// frontier B dropped it, and the woken agent spawned 12 paid chats. Held as a list, B cannot drop it by leaving it out.
type Fake = ReturnType<typeof fakeEngine>;
const fakes: Fake[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) {
    expect(f.unscripted, 'every $ call the plugin made was scripted').toEqual([]);
    f.cleanup();
  }
});

const FORWARD = 'mcp__forward-compaction__forward_compaction';
const FIRST = { objective: 'finish the round', next: 'wait for the chats', done: { add: ['round 1'] }, remaining: { add: ['round 2'] } };
/** The fake clock's time at every call (`begin`), as an item's `added` stores it. */
const ADDED = '2026-10-27T14:53:00.000Z';
async function begin(script: Script = {}): Promise<Fake> {
  const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', FORWARD_COMPACTION_MAIN_CEILING: '120000', FORWARD_COMPACTION_MAIN_NUDGE_START: '30000', FORWARD_COMPACTION_MAIN_NUDGE_EVERY: '10000', ...script.env };
  const f = fakeEngine({ window: 1_000_000, now: Date.UTC(2026, 9, 27, 14, 53), ...script, env });
  fakes.push(f);
  await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
  return f;
}
const say = (f: Fake, text: string) => f.dispatch('prompt.submit', { text, origin: { kind: 'composer' } }, async () => ({}));
const call = (f: Fake, id: string, args: Record<string, unknown>) =>
  f.dispatch('tool.call', { tool: FORWARD, tool_use_id: id, ...args }, async () => ({ result: 'not ours' })).then((r: { result: string }) => r.result.split('\n'));
const step = (f: Fake, tokens: number) =>
  f.dispatch('turn.step', { turnId: 't1', index: 0, model: 'claude-sonnet-4-5', messageCount: 4 }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(tokens) }));
/** A woken main past its notice point again: two readings settle its floor at 20k, the third stands its 30k nudge start above it, so its next call compacts. */
const grown = async (f: Fake) => { for (const tokens of [20_000, 20_000, 50_000]) await step(f, tokens); };
const transcript = (id: string) => [
  { role: 'user', text: 'start', toolUses: [], handle: 'h0' },
  { role: 'assistant', text: 'compacting', toolUses: [{ tool_use_id: id, tool: FORWARD, input: FIRST }], handle: 'h1' },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'Frontier stored' }], handle: 'h2' },
];
const ask = (f: Fake, messages: unknown[], trigger = 'auto') => f.dispatch('session.compact', { trigger, messages }, async () => ({ skip: 'native ran' }));
const ordersIn = async (f: Fake, id: string): Promise<string | undefined> => sectionOf((await ask(f, transcript(id))).messages[0].text, ORDERS_HEADING);
async function rows(f: Fake): Promise<Record<string, unknown>[]> {
  await f.dispatch('session.end', { reason: 'other' }, async () => ({}));
  const dir = join(f.home, '.local/state/forward-compaction/logs/decisions');
  return readdirSync(dir).filter((n) => n.endsWith('.jsonl')).flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

// Each case drives several frontier cycles through the hooks: CPU-bound seconds that a loaded host stretches past vitest's 5 s default.
describe('the standing orders and the other lists, through the hooks and their files', { timeout: 30_000 }, () => {
  it('keeps an order a later call leaves out, answers a lift with orders.remove, and drops it only on its number', async () => {
    const f = await begin();
    await say(f, 'Alright, do not spawn more, let these finish and finilize it');
    expect((await call(f, 'tu-a', { ...FIRST, orders: { add: [ORDER] } })).slice(0, 5)).toEqual(['objective set', 'Added to orders: [1]', 'Added to done: [1]', 'Added to remaining: [1]', 'next set']);
    expect((await call(f, 'tu-b', { next: 'merge round 2' })).slice(0, 1)).toEqual(['next replaced']);
    expect(await ordersIn(f, 'tu-b')).toBe(`${ORDERS_HEADING}\n[1] ${ORDER}`);

    await grown(f);
    expect((await call(f, 'tu-c', { next: 'spawn', lifted: [{ order: ORDER, by: 'spawn as many chats as you need' }] })).slice(0, 2)).toEqual(['next replaced', 'lifted is no field: to lift an order, send its number in orders.remove. Nothing lifted.']);
    expect(await ordersIn(f, 'tu-c')).toBe(`${ORDERS_HEADING}\n[1] ${ORDER} [1 round unchanged]`);

    await grown(f);
    expect((await call(f, 'tu-d', { next: 'spawn', orders: { remove: [1] } })).slice(0, 2)).toEqual([`Removed from orders: [1] ${ORDER}`, 'next unchanged']);
    expect(await ordersIn(f, 'tu-d')).toBeUndefined();
    const r = await rows(f);
    expect(r.filter((row) => row.event === 'stored').map((row) => (row.lists as Record<string, unknown>).orders ?? null)).toEqual([{ added: 1, removed: 0, edited: 0, skipped: 0 }, null, null, { added: 0, removed: 1, edited: 0, skipped: 0 }]);
    expect(JSON.stringify(r)).not.toContain(ORDER);
  });

  it('takes a standing_orders entry as an order added, with a note', async () => {
    const f = await begin();
    expect((await call(f, 'tu-a', { ...FIRST, standing_orders: [{ order: ORDER }] })).slice(0, 6)).toEqual(['objective set', 'Added to orders: [1]', 'Added to done: [1]', 'Added to remaining: [1]', 'next set', 'standing_orders is now orders: its 1 entry is taken as orders.add.']);
    expect(await ordersIn(f, 'tu-a')).toBe(`${ORDERS_HEADING}\n[1] ${ORDER}`);
  });

  it("carries the order into the mechanical wake, and across the user's /compact", async () => {
    const f = await begin();
    await call(f, 'tu-a', { ...FIRST, orders: { add: [ORDER] } });
    expect(await ask(f, transcript('tu-a'), 'manual')).toEqual({ skip: 'native ran' });
    await step(f, 125_000);
    const mech = await ask(f, transcript('tu-x'));
    expect(mech.messages[1].text).toMatch(/^\[forward-compaction: no frontier written by the model\]/);
    expect(sectionOf(mech.messages[0].text, ORDERS_HEADING)).toBe(`${ORDERS_HEADING}\n[1] ${ORDER}`);
  });

  it('keeps every number and stored file across a restart, read back from its files, with each value that left in its history', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fc-orders-'));
    const files: Record<string, FileEntry> = {};
    const root = join(home, '.local/state/forward-compaction', basename(home), 'session-1');
    const before = await begin({ home, files });
    expect((await call(before, 'tu-a', { ...FIRST, orders: { add: [ORDER] }, remaining: { add: ['round 2', 'round 3', 'round 4'] } })).slice(0, 5)).toEqual(['objective set', 'Added to orders: [1]', 'Added to done: [1]', 'Added to remaining: [1], [2], [3]', 'next set']);
    expect((await call(before, 'tu-b', { done: { add: ['round 2'] }, remaining: { remove: [1], edit: [{ id: 2, text: 'round 3, twice' }], add: ['round 5'] }, storage: { add: [{ name: 'API Survey', description: 'the API survey', value: '# s' }] } })).slice(0, 6)).toEqual(['Added to done: [2]', 'Added to remaining: [4]', 'Removed from remaining: [1] round 2', 'Edited in remaining: [2], was: round 3', `next kept: ${FIRST.next}`, 'Stored api-survey.md (3 characters)']);
    await ask(before, transcript('tu-b'));
    const after = await begin({ home, files });
    expect((await call(after, 'tu-c', { objective: 'finish both rounds', orders: { add: ['never push'] }, remaining: { add: ['round 6'] }, storage: { add: [{ name: 'gate', description: 'the fence command', value: 'x' }], remove: ['api-survey.md'] } })).slice(0, 6)).toEqual(['objective replaced', 'Added to orders: [2]', 'Added to remaining: [5]', `next kept: ${FIRST.next}`, 'Stored gate.md (1 characters)', 'Storage no longer lists api-survey.md']);
    const wake = await ask(after, transcript('tu-c'));
    expect(sectionOf(wake.messages[0].text, ORDERS_HEADING)).toBe(`${ORDERS_HEADING}\n[1] ${ORDER} [1 round unchanged]\n[2] never push`);
    expect(sectionOf(wake.messages[0].text, '## Storage')).toBe(`## Storage — files in ${root}/storage/\ngate.md — the fence command`);
    expect([files[`${root}/storage/gate.md`]?.content, files[`${root}/history/storage/api-survey.md`]?.content, files[`${root}/storage/api-survey.md`]?.content]).toEqual(['x', '# s', '# s']);
    expect(wake.messages[1].text).toContain(`=== frontier ===\n## Objective\nfinish both rounds\n\n## Done\n[1] round 1 [1 round unchanged]\n[2] round 2 [1 round unchanged]\n\n## Remaining\n[2] round 3, twice [1 round unchanged]\n[3] round 4 [1 round unchanged]\n[4] round 5 [1 round unchanged]\n[5] round 6\n\n## Next\n${FIRST.next}\n=== end of frontier ===`);
    expect(files[`${root}/rounds.json`]?.content).toBe('{\n  "rounds": 2\n}\n');
    expect([files[`${root}/history/remaining.jsonl`]?.content, files[`${root}/history/objective.jsonl`]?.content]).toEqual([`{"id":2,"text":"round 3","left":"edited","added":"${ADDED}"}\n{"id":1,"text":"round 2","left":"removed","added":"${ADDED}"}\n`, '{"text":"finish the round"}\n']);
    expect(JSON.parse(files[`${root}/data/remaining.json`]?.content ?? 'null')).toEqual({ next_id: 6, items: [{ id: 2, text: 'round 3, twice', added: ADDED }, { id: 3, text: 'round 4', added: ADDED }, { id: 4, text: 'round 5', added: ADDED }, { id: 5, text: 'round 6', round: 1, added: ADDED }] });
    expect((await call(after, 'tu-d', { done: '{"add":["round 3"],"remaining":{"remove":[2]}}' })).slice(0, 4)).toEqual(['Added to done: [3]', 'Removed from remaining: [2] round 3, twice', `next kept: ${FIRST.next}`, 'done arrived as the text of its JSON: read as JSON, and remaining inside it taken out as its own field.']);
  });

  it('holds a change it could not write, names the list and the error without the folder, logs it, and writes it at the next call', async () => {
    let failing = true;
    const files: Record<string, FileEntry> = {};
    const f = await begin({ files, writeError: (path) => (failing && path.endsWith('/data/remaining.json') ? `EACCES: permission denied, open '${path}'` : undefined) });
    const root = join(f.home, '.local/state/forward-compaction', basename(f.home), 'session-1');
    expect((await call(f, 'tu-a', FIRST)).slice(4, 5)).toEqual(["Not saved to disk yet: remaining (EACCES: permission denied, open '…'); it is held and saved again at your next call."]);
    expect([files[`${root}/data/done.json`]?.content, files[`${root}/data/remaining.json`]]).toEqual([`${JSON.stringify({ next_id: 2, items: [{ id: 1, text: 'round 1', added: ADDED }] }, null, 2)}\n`, undefined]);
    expect(f.texts()).toEqual([`writing ${root}/data/remaining.json failed: EACCES: permission denied, open '${root}/data/remaining.json'; the change is held in memory and written again at the next call`]);
    failing = false;
    expect((await call(f, 'tu-b', { next: 'merge round 2' })).slice(0, 2)).toEqual(['next replaced', 'Frontier: 43 characters in 2 items (done 1, remaining 1)']);
    expect(JSON.parse(files[`${root}/data/remaining.json`]?.content ?? 'null')).toEqual({ next_id: 2, items: [{ id: 1, text: 'round 2', added: ADDED }] });
    expect((await rows(f)).filter((row) => row.event === 'stored').map((row) => row.writeFailed ?? null)).toEqual([['data/remaining.json'], null]);
  });

  it('applies two calls sent in one response one after the other, the second on the first', async () => {
    const files: Record<string, FileEntry> = {};
    const f = await begin({ files });
    const root = join(f.home, '.local/state/forward-compaction', basename(f.home), 'session-1');
    const [a, b] = await Promise.all([call(f, 'tu-a', { ...FIRST, storage: { add: [{ name: 'survey', description: 'the survey', value: 'v' }] } }), call(f, 'tu-b', { done: { add: ['round 2'] } })]);
    expect([a.slice(0, 5), b.slice(0, 2)]).toEqual([['objective set', 'Added to done: [1]', 'Added to remaining: [1]', 'next set', 'Stored survey.md (1 characters)'], ['Added to done: [2]', `next kept: ${FIRST.next}`]]);
    expect(JSON.parse(files[`${root}/data/done.json`]?.content ?? 'null')).toEqual({ next_id: 3, items: [{ id: 1, text: 'round 1', added: ADDED }, { id: 2, text: 'round 2', added: ADDED }] });
  });

  it('splits done past its cap: the newest items in the wake, the earlier ones whole in done-earlier.md named there and in the result, each edited or removed by number, none leaving the file before the party has read a wake that shows it, and every added time on disk alone', async () => {
    const files: Record<string, FileEntry> = {};
    const f = await begin({ files, env: { FORWARD_COMPACTION_DONE_MAX_CHARS: '20' } });
    const root = join(f.home, '.local/state/forward-compaction', basename(f.home), 'session-1'), path = `${root}/done-earlier.md`, record = `${root}/done-earlier.json`;
    const rest = 'finished work like the items below, edited or removed by number like them. Read the file when a step or the final report may rest on one.';
    f.advance(90_000); // the items' time, apart from the session's start a wake's facts name
    const at = '2026-10-27T14:54:30.000Z';
    const first = await call(f, 'tu-a', { ...FIRST, done: { add: ['round 1 merged', 'round 2 merged', 'round 3 merged'] } });
    expect(first.slice(0, -2)).toEqual(['objective set', 'Added to done: [1], [2], [3]', 'Added to remaining: [1]', 'next set', 'Frontier: 83 characters in 4 items (done 3, remaining 1)', `Done: 1 newest item stays in your wake, 2 earlier in ${path}`, 'Storage: none']);
    expect(files[path]?.content).toBe('[1] round 1 merged\n[2] round 2 merged\n');
    const wake = await ask(f, transcript('tu-a'));
    const done = sectionOf(wake.messages[1].text, '## Done');
    expect(done).toBe(`## Done\n2 earlier done items, [1] to [2], are in ${path}, each whole under its number: ${rest}\n[3] round 3 merged`);
    const ids = (text: string): number[] => [...text.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1]));
    expect([...ids(files[path]!.content), ...ids(done!)]).toEqual(JSON.parse(files[`${root}/data/done.json`]!.content).items.map((item: { id: number }) => item.id));

    await grown(f);
    const second = await call(f, 'tu-b', { done: { edit: [{ id: 1, text: 'round 1 merged and tagged' }], remove: [2] } });
    expect([second.slice(0, 2), second.find((line) => line.startsWith('Done: '))]).toEqual([['Removed from done: [2] round 2 merged', 'Edited in done: [1], was: round 1 merged'], `Done: 1 newest item stays in your wake, 1 earlier in ${path}`]);
    expect(files[path]?.content).toBe('[1] round 1 merged and tagged\n');
    const later = await ask(f, transcript('tu-b'));
    expect(sectionOf(later.messages[1].text, '## Done')).toBe(`## Done\n1 earlier done item, [1], is in ${path}, whole under its number: ${rest}\n[3] round 3 merged [1 round unchanged]`);

    await grown(f);
    const third = await call(f, 'tu-c', { done: { remove: [3] } }); // [1] is now the newest, which the next wake shows: the wake the party has read names it and does not show it, so it stays in the file
    expect([third[0], third.find((line) => line.startsWith('Done: ')) ?? null, files[path]?.content, files[record]?.content]).toEqual(['Removed from done: [3] round 3 merged', null, '[1] round 1 merged and tagged\n', '{\n  "through": 1\n}\n']);
    const whole = await ask(f, [...later.messages, ...transcript('tu-c')]);
    expect([sectionOf(whole.messages[1].text, '## Done'), files[path]?.content]).toEqual(['## Done\n[1] round 1 merged and tagged [1 round unchanged]', '[1] round 1 merged and tagged\n']); // rendered, not yet read
    await ask(f, whole.messages); // a later ask's transcript holds that wake: the party has read [1]
    await grown(f);
    const fourth = await call(f, 'tu-d', { next: 'merge round 4' });
    expect([files[path]?.content, files[record]?.content]).toEqual(['No earlier done items: every live done item is in the wake.\n', '{\n  "through": 0\n}\n']);

    expect([JSON.parse(files[`${root}/data/done.json`]!.content), files[`${root}/history/done.jsonl`]?.content]).toEqual([
      { next_id: 4, items: [{ id: 1, text: 'round 1 merged and tagged', round: 1, added: at }] },
      `{"id":1,"text":"round 1 merged","left":"edited","added":"${at}"}\n{"id":2,"text":"round 2 merged","left":"removed","added":"${at}"}\n{"id":3,"text":"round 3 merged","left":"removed","added":"${at}"}\n`,
    ]);
    const shown = [...first, ...second, ...third, ...fourth, ...[wake, later, whole].flatMap((w) => w.messages.map((m: { text: string }) => m.text)), files[path]!.content, ...f.texts()];
    expect(shown.filter((text) => text.includes(at) || text.includes('added'))).toEqual([]);
    expect((await rows(f)).filter((row) => row.event === 'stored').map((row) => row.done)).toEqual([{ shown: 1, shownChars: 14, earlier: 2, earlierChars: 28 }, { shown: 1, shownChars: 14, earlier: 1, earlierChars: 25 }, ...Array(2).fill({ shown: 1, shownChars: 25, earlier: 0, earlierChars: 0 })]);
  });

  it('shows the whole done list, says nothing to the model and logs the failure when done-earlier.md cannot be written, and writes it at the next call', async () => {
    let failing = true;
    const files: Record<string, FileEntry> = {};
    const f = await begin({ files, env: { FORWARD_COMPACTION_DONE_MAX_CHARS: '20' }, writeError: (path) => (failing && path.endsWith('/done-earlier.md') ? `ENOSPC: no space left on device, open '${path}'` : undefined) });
    const root = join(f.home, '.local/state/forward-compaction', basename(f.home), 'session-1'), path = `${root}/done-earlier.md`;
    const first = await call(f, 'tu-a', { ...FIRST, done: { add: ['round 1 merged', 'round 2 merged', 'round 3 merged'] } });
    expect(first.slice(0, -2)).toEqual(['objective set', 'Added to done: [1], [2], [3]', 'Added to remaining: [1]', 'next set', 'Frontier: 83 characters in 4 items (done 3, remaining 1)', 'Storage: none']);
    expect(sectionOf((await ask(f, transcript('tu-a'))).messages[1].text, '## Done')).toBe('## Done\n[1] round 1 merged\n[2] round 2 merged\n[3] round 3 merged');
    expect([files[path], f.texts()]).toEqual([undefined, Array(3).fill(`writing ${path} failed: ENOSPC: no space left on device, open '${path}'; the change is held in memory and written again at the next call`)]); // at the call, and at the ask before the wake and after its install
    failing = false;
    await grown(f);
    expect((await call(f, 'tu-b', { next: 'merge round 4' })).find((line) => line.startsWith('Done: '))).toBe(`Done: 1 newest item stays in your wake, 2 earlier in ${path}`);
    expect(files[path]?.content).toBe('[1] round 1 merged\n[2] round 2 merged\n');
    expect((await rows(f)).filter((row) => row.event === 'stored').map((row) => [row.done, row.writeFailed ?? null])).toEqual([[{ shown: 3, shownChars: 42, earlier: 0, earlierChars: 0 }, ['done-earlier.md']], [{ shown: 1, shownChars: 14, earlier: 2, earlierChars: 28 }, null]]);
  });

  it("loads the frontier from its files and applies the call though the session state cannot be read", async () => {
    const home = mkdtempSync(join(tmpdir(), 'fc-orders-'));
    const root = join(home, '.local/state/forward-compaction', basename(home), 'session-1');
    const files: Record<string, FileEntry> = { [`${root}/orders.json`]: { content: JSON.stringify({ next_id: 2, items: [{ id: 1, text: ORDER }] }) } };
    class Down extends Map<string, { value: unknown; version: number }> {
      override get(key: string) {
        if (key.includes('"prompts"')) throw new Error('state store down');
        return super.get(key);
      }
    }
    const f = await begin({ home, files, state: new Down() });
    expect((await call(f, 'tu-a', { ...FIRST, orders: { add: ['never push'] } })).slice(0, 2)).toEqual(['objective set', 'Added to orders: [2]']);
    expect(await ordersIn(f, 'tu-a')).toBe(`${ORDERS_HEADING}\n[1] ${ORDER}\n[2] never push`);
    expect(f.texts().filter((line) => line.includes('state store down')).length).toBeGreaterThan(0);
  });

  it("numbers the previous build's remembered orders as the party's first, when it has no orders file", async () => {
    const state = new Map([[JSON.stringify({ plugin: 'forward-compaction', key: 'orders', id: 'session-1/main' }), { value: [{ order: ORDER, at: '2026-10-27T14:53:00.000Z' }], version: 1 }]]);
    const f = await begin({ state });
    expect((await call(f, 'tu-a', FIRST)).slice(0, 4)).toEqual(['objective set', 'Added to done: [1]', 'Added to remaining: [1]', 'next set']);
    expect(await ordersIn(f, 'tu-a')).toBe(`${ORDERS_HEADING}\n[1] ${ORDER}`);
  });
});
