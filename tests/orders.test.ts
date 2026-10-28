import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeEngine, usage, type Script } from './fakes/engine.ts';
import { parseFrontier } from '../plugins/forward-compaction/src/frontier.ts';
import { keptOrders, ORDERS_HEADING, ordersSection } from '../plugins/forward-compaction/src/orders.ts';
import { addEntry, liftSources, newLedger } from '../plugins/forward-compaction/src/ledger.ts';
import { Parties } from '../plugins/forward-compaction/src/parties.ts';
import { buildWake, mechanicalWake, type BuiltMessage, type WakeFacts, type WakeMessage } from '../plugins/forward-compaction/src/wake.ts';

// Standing orders: the person's binding orders, carried by every frontier in `standing_orders`, remembered per party
// across installs, the person's /compact and a plugin reload, carried on by the plugin when a frontier drops one without the person's lifting words,
// and rendered above the frontier in every wake, the mechanical one included.

const ORDER = { order: 'do not spawn more', at: '2026-10-27T14:53:00.000Z' };
const valid = { objective: 'finish the round', decisions: 'none', done: 'round 1', remaining: 'round 2', next: 'wait for the chats' };

describe('parseFrontier: standing_orders and lifted', () => {
  const LATER = Date.parse(ORDER.at) + 60_000;
  const memory = (said: string[] = []) => ({ remembered: [ORDER], said: said.map((text) => ({ text, at: LATER })), party: 'main' as const });

  it('takes the orders verbatim and none by default', () => {
    expect(parseFrontier(valid)).toMatchObject({ standingOrders: [], lifted: [], notes: [] });
    expect(parseFrontier({ ...valid, standing_orders: [ORDER] })).toMatchObject({ standingOrders: [ORDER] });
  });

  it("matches the person's words across spacing and letter case, for an order's time and for a lift", () => {
    const order = { order: 'Delete END TO END', at: '2026-10-28T12:10:00Z' };
    const said = [
      { text: 'Yes, I want you to delete end to end\nall of it', at: Date.parse('2026-10-28T12:28:00Z') },
      { text: 'Alright, write this plane DOWN\n\nWe will do THIS plan', at: Date.parse('2026-10-28T13:00:00Z') },
    ];
    const memory = { remembered: [], said, party: 'main' as const };
    expect(parseFrontier({ ...valid, standing_orders: [order] }, memory).standingOrders).toEqual([{ order: order.order, at: '2026-10-28T12:28:00.000Z' }]);
    const by = 'Alright, write this plane DOWN We will do THIS plan';
    const lift = parseFrontier({ ...valid, lifted: [{ order: order.order, by }] }, { ...memory, remembered: [{ order: order.order, at: '2026-10-28T12:28:00.000Z' }] });
    expect(lift).toMatchObject({ standingOrders: [], lifted: [{ order: order.order, at: '2026-10-28T12:28:00.000Z', by }], notes: [] });
  });

  it('re-times a remembered order from the message that gave it, leaving one no message holds as it was', () => {
    const said = [{ text: 'God speed, you got this', at: Date.parse('2026-10-27T23:12:50Z') }];
    const remembered = [{ order: 'God speed, you got this', at: '2026-10-28T00:00:00Z' }, ORDER];
    expect(parseFrontier({ ...valid, standing_orders: remembered }, { remembered, said, party: 'main' }).standingOrders)
      .toEqual([{ order: 'God speed, you got this', at: '2026-10-27T23:12:50.000Z' }, ORDER]);
  });

  it("stamps an order with the time of the person's first message that holds it, never the model's guess", () => {
    const said = [{ text: 'ok', at: Date.parse('2026-10-28T03:07:29.631Z') }, { text: 'Land it right on develop', at: Date.parse('2026-10-28T03:08:02.143Z') }, { text: 'again: Land it right on develop', at: Date.parse('2026-10-28T04:00:00Z') }];
    const guessed = { order: 'Land it right on develop', at: '2026-10-28T03:00:00Z' };
    expect(parseFrontier({ ...valid, standing_orders: [guessed, ORDER] }, { remembered: [], said, party: 'main' }).standingOrders)
      .toEqual([{ order: guessed.order, at: '2026-10-28T03:08:02.143Z' }, ORDER]);
  });

  it('skips every bad order entry and names it, one line each, never quoting the order', () => {
    const out = parseFrontier({ ...valid, standing_orders: [{ order: ' ', at: 'yesterday' }, { order: 'x', at: 'yesterday' }, ORDER], lifted: [{ order: 'x' }] });
    expect(out.notes).toEqual([
      "standing_orders[0].order must be a non-blank string, the person's words verbatim: skipped.",
      'standing_orders[1].at must be the ISO time of the person\'s message, like "2026-10-27T14:53:00Z": skipped.',
      "lifted[0].by must be a non-blank string, the person's words that lifted the order, verbatim: skipped.",
    ]);
    expect(out.standingOrders).toEqual([ORDER]);
    expect(parseFrontier({ ...valid, standing_orders: 'do not spawn' }).notes).toEqual(['standing_orders must be an array of {order, at}: none read from it.']);
    expect(parseFrontier({ ...valid, lifted: {} }).notes).toEqual(['lifted must be an array of {order, by}: none read from it.']);
  });

  it('carries a remembered order the frontier left out, naming it with its time', () => {
    const out = parseFrontier(valid, memory());
    expect(out.standingOrders).toEqual([ORDER]);
    expect(out.notes).toEqual(['order "do not spawn more" (given 2026-10-27T14:53:00.000Z) was left out of your frontier and is carried on: it binds until the person lifts it.']);
    expect(parseFrontier({ ...valid, standing_orders: [ORDER] }, memory())).toMatchObject({ standingOrders: [ORDER], lifted: [], notes: [] });
  });

  it('accepts a lift only in words the party was sent, and leaves every other order binding', () => {
    const second = { order: 'never push', at: '2026-10-27T15:00:00Z' };
    const m = { remembered: [ORDER, second], said: [{ text: 'ok, spawn two more chats', at: LATER }], party: 'main' as const };
    const bad = parseFrontier({ ...valid, lifted: [{ order: ORDER.order, by: 'spawn as many as you like' }] }, m);
    expect(bad.standingOrders).toEqual([ORDER, second]);
    expect(bad.lifted).toEqual([]);
    expect(bad.notes[0]).toBe('order "do not spawn more" still binding: no message from the person after 2026-10-27T14:53:00.000Z contains "spawn as many as you like".');
    expect(bad.notes).toHaveLength(2);
    expect(parseFrontier({ ...valid, standing_orders: [second], lifted: [{ order: ORDER.order, by: 'spawn two more' }] }, m)).toMatchObject({
      standingOrders: [second], lifted: [{ order: ORDER.order, at: ORDER.at, by: 'spawn two more' }], notes: [],
    });
  });

  it('ignores a lift of an order no frontier carried, and keeps an order both carried and lifted binding unless the words prove the lift', () => {
    const m = memory(['go ahead']);
    expect(parseFrontier({ ...valid, standing_orders: [ORDER], lifted: [{ order: 'something else', by: 'go ahead' }] }, m)).toMatchObject({ standingOrders: [ORDER], notes: ['lifted "something else" names no standing order: ignored.'] });
    expect(parseFrontier({ ...valid, standing_orders: [ORDER], lifted: [{ order: ORDER.order, by: 'nobody said' }] }, m)).toMatchObject({ standingOrders: [ORDER], lifted: [] });
    expect(parseFrontier({ ...valid, standing_orders: [ORDER], lifted: [{ order: ORDER.order, by: 'go ahead' }] }, m)).toMatchObject({ standingOrders: [], lifted: [{ order: ORDER.order, by: 'go ahead' }] });
  });

  it("names a sub-agent's sources as its brief and the messages delivered to it", () => {
    const out = parseFrontier({ ...valid, lifted: [{ order: ORDER.order, by: 'nobody said this' }] }, { remembered: [ORDER], said: [{ text: 'brief', at: LATER }], party: 'subagent' });
    expect(out.notes[0]).toContain('neither your brief nor any message delivered to you after');
  });

  it('lifts an order only by words sent after it was given: the same words said before it lift nothing (the woonwacht case)', () => {
    const order = { order: 'never run the paid replay', at: '2026-10-27T14:53:00Z' };
    const before = { text: 'God speed', at: Date.parse('2026-10-27T14:22:00Z') };
    const after = { text: 'Ship it all / God speed', at: Date.parse('2026-10-27T17:44:00Z') };
    const lift = { ...valid, lifted: [{ order: order.order, by: ' God speed ' }] };
    expect(parseFrontier(lift, { remembered: [order], said: [before], party: 'main' })).toMatchObject({ standingOrders: [order], lifted: [] });
    expect(parseFrontier(lift, { remembered: [order], said: [before, after], party: 'main' })).toMatchObject({ lifted: [{ order: order.order, at: order.at, by: ' God speed ' }] });
  });
});

describe('the sources a lift is checked against', () => {
  it("are main's person messages, and a sub-agent's brief and delivered messages, never a notice or another party's", () => {
    let l = newLedger();
    l = addEntry(l, { kind: 'person', party: 'main', at: 1, text: 'person said' });
    l = addEntry(l, { kind: 'notice', party: 'main', at: 2, origin: 'task-notification', text: 'a notice' });
    l = addEntry(l, { kind: 'brief', party: 'agent:a1', at: 3, text: 'the brief', spawnedBy: 'main' });
    l = addEntry(l, { kind: 'received', party: 'agent:a1', at: 4, origin: 'coordinator', text: 'delivered' });
    l = addEntry(l, { kind: 'received', party: 'agent:b2', at: 5, origin: 'coordinator', text: 'to another' });
    expect(liftSources(l, 'main')).toEqual([{ text: 'person said', at: 1 }]);
    expect(liftSources(l, 'agent:a1')).toEqual([{ text: 'the brief', at: 3 }, { text: 'delivered', at: 4 }]);
  });
});

describe('keptOrders: what $.state gives back', () => {
  it('takes a list of {order, at} and nothing else', () => {
    expect(keptOrders([ORDER])).toEqual([ORDER]);
    expect(keptOrders(undefined)).toBeUndefined();
    expect(keptOrders('x')).toBeUndefined();
    expect(keptOrders([ORDER, { order: 3, at: 'x' }, null])).toEqual([ORDER]);
  });
});

describe('Parties: the remembered orders', () => {
  it('are the last stored frontier\'s, kept across an install and a dropped frontier', () => {
    const p = new Parties();
    p.store('main', { text: 'h', loadFiles: [], toolUseId: 't1', since: 1, standingOrders: [ORDER] });
    p.installed('main');
    expect(p.get('main').orders).toEqual([ORDER]);
    p.store('main', { text: 'h', loadFiles: [], toolUseId: 't2', since: 2, standingOrders: [ORDER] });
    p.takeStored('main');
    expect(p.get('main').orders).toEqual([ORDER]);
    p.store('main', { text: 'h', loadFiles: [], toolUseId: 't3', since: 3, standingOrders: [] });
    expect(p.get('main').orders).toEqual([]);
  });

  it('carry a lift of a replaced, never installed frontier into the one replacing it, to be shown once', () => {
    const p = new Parties();
    const lift = { order: ORDER.order, at: ORDER.at, by: 'spawn again' };
    p.store('main', { text: 'h', loadFiles: [], toolUseId: 't1', since: 1, standingOrders: [], lifted: [lift] });
    p.store('main', { text: 'h', loadFiles: [], toolUseId: 't2', since: 2, standingOrders: [] });
    expect(p.get('main').stored?.lifted).toEqual([lift]);
    p.store('main', { text: 'h', loadFiles: [], toolUseId: 't3', since: 3, standingOrders: [ORDER] });
    expect(p.get('main').stored?.lifted).toEqual([]);
  });

  it('are restored from what $.state kept, unless a frontier stored in this process already set them', () => {
    const p = new Parties();
    p.restoreOrders('main', 'junk');
    expect(p.get('main').orders).toBeUndefined();
    p.restoreOrders('main', [ORDER]);
    expect(p.get('main').orders).toEqual([ORDER]);
    p.store('agent:a1', { text: 'h', loadFiles: [], toolUseId: 't1', since: 1, standingOrders: [] });
    p.restoreOrders('agent:a1', [ORDER]);
    expect(p.get('agent:a1').orders).toEqual([]);
  });
});

describe('the wake renders the standing orders above the frontier', () => {
  type Msg = WakeMessage & { handle: string };
  const call: Msg = { role: 'assistant', text: 'compacting', toolUses: [{ tool_use_id: 't9', tool: 'mcp__forward-compaction__forward_compaction', input: {} }], handle: 'h1' };
  const answer: Msg = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't9', text: 'Frontier stored' }], handle: 'h2' };
  const facts: WakeFacts = { person: [{ at: Date.UTC(2026, 9, 27, 14, 53), text: 'Alright, do not spawn more' }], notices: [], received: [], skills: [], unattributedSkills: [] };
  const shared = { messages: [call, answer], party: 'main' as const, tokens: 41_000, askPoint: 63_000, now: 0, charsPerToken: 3.5, facts: () => facts };

  it('opens the facts with the binding section, whole, before every other section and the frontier', () => {
    const lift = { order: 'never push', at: '2026-10-27T00:08:00Z', by: 'push it now' };
    const wake = buildWake({ ...shared, toolUseId: 't9', frontier: '## Next\nround 2', orders: { standing: [ORDER], lifted: [lift] } });
    const f = (wake.messages[0] as BuiltMessage).text;
    const sections = f.split('\n\n').filter((s) => s.startsWith('## '));
    expect(sections[0]).toBe([
      ORDERS_HEADING,
      `### ${ORDER.at}`, ORDER.order,
      '### Lifted, no longer binding (given 2026-10-27T00:08:00Z)', 'never push', 'The person lifted it: "push it now"',
    ].join('\n'));
    expect(f.indexOf(ORDERS_HEADING)).toBeLessThan(f.indexOf("## The person's messages"));
    expect((wake.messages[1] as BuiltMessage).text).toContain('continue from its ## Next, within the standing orders above.');
    expect(wake.sizes[0]).toEqual({ section: ORDERS_HEADING, chars: sections[0]!.length });
  });

  it('carries them whole whatever the budget, and the mechanical wake carries them the same way', () => {
    const long = { order: 'never '.repeat(20_000), at: ORDER.at };
    const built = buildWake({ ...shared, askPoint: 1_000, toolUseId: 't9', frontier: 'h', orders: { standing: [long] } });
    expect((built.messages[0] as BuiltMessage).text).toContain(long.order);
    const mech = mechanicalWake({ ...shared, reason: { kind: 'ceiling', ceiling: 120_000 }, orders: { standing: [ORDER] } });
    expect((mech.messages[0] as BuiltMessage).text).toContain(`${ORDERS_HEADING}\n### ${ORDER.at}\n${ORDER.order}`);
    expect((mech.messages[1] as BuiltMessage).text).toContain('within the standing orders above');
  });

  it('has no section with no orders', () => {
    expect(ordersSection([], [])).toBeUndefined();
    const wake = buildWake({ ...shared, toolUseId: 't9', frontier: 'h' });
    expect((wake.messages[0] as BuiltMessage).text).not.toContain('## Standing orders');
    expect((wake.messages[1] as BuiltMessage).text).not.toContain('within the standing orders');
  });
});

// The adapter, end to end: the bug as it happened (2026-10-27): frontier A quoted the person's "do not spawn more",
// frontier B dropped it and was accepted without it, and the woken agent spawned 12 paid chats.
type Fake = ReturnType<typeof fakeEngine>;
const fakes: Fake[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) {
    expect(f.unscripted, 'every $ call the plugin made was scripted').toEqual([]);
    f.cleanup();
  }
});

const FORWARD = 'mcp__forward-compaction__forward_compaction';
async function begin(script: Script = {}): Promise<Fake> {
  const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', FORWARD_COMPACTION_MAIN_CEILING: '120000', FORWARD_COMPACTION_MAIN_NUDGE_START: '30000', FORWARD_COMPACTION_MAIN_NUDGE_EVERY: '10000' };
  const f = fakeEngine({ window: 1_000_000, now: Date.UTC(2026, 9, 27, 14, 53), ...script, env });
  fakes.push(f);
  await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
  return f;
}
const say = (f: Fake, text: string) => f.dispatch('prompt.submit', { text, origin: { kind: 'composer' } }, async () => ({}));
const frontier = (f: Fake, id: string, extra: Record<string, unknown> = {}) =>
  f.dispatch('tool.call', { tool: FORWARD, tool_use_id: id, ...valid, ...extra }, async () => ({ result: 'not ours' })).then((r: { result: string }) => r.result);
const step = (f: Fake, tokens: number) =>
  f.dispatch('turn.step', { turnId: 't1', index: 0, model: 'claude-sonnet-4-5', messageCount: 4 }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(tokens) }));
const transcript = (id: string) => [
  { role: 'user', text: 'start', toolUses: [], handle: 'h0' },
  { role: 'assistant', text: 'compacting', toolUses: [{ tool_use_id: id, tool: FORWARD, input: valid }], handle: 'h1' },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'Frontier stored' }], handle: 'h2' },
];
const ask = (f: Fake, messages: unknown[], trigger = 'auto') => f.dispatch('session.compact', { trigger, messages }, async () => ({ skip: 'native ran' }));
async function rows(f: Fake): Promise<Record<string, unknown>[]> {
  await f.dispatch('session.end', { reason: 'other' }, async () => ({}));
  const dir = join(f.home, '.local/state/forward-compaction/logs/decisions');
  return readdirSync(dir).filter((n) => n.endsWith('.jsonl')).flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}
const A = { standing_orders: [ORDER] };

describe('the dropped standing order, replayed', () => {
  it('stores frontier B without the order and carries it on, keeps it binding on a lift nobody said, and lifts it in the words the person sent', async () => {
    const f = await begin();
    await say(f, 'Alright, do not spawn more, let these finish and finilize it');
    expect(await frontier(f, 'tu-a', A)).toContain('Frontier stored');
    f.advance(10 * 60_000);
    await say(f, 'Fix all the failures, make the engine and ALL offices stable / God speed');

    const dropped = await frontier(f, 'tu-b');
    expect(dropped).toContain('Frontier stored');
    expect(dropped).toContain('order "do not spawn more" (given 2026-10-27T14:53:00.000Z) was left out of your frontier and is carried on');
    expect((await ask(f, transcript('tu-b'))).messages[0].text).toContain(`${ORDERS_HEADING}\n### ${ORDER.at}\n${ORDER.order}`);

    const invented = await frontier(f, 'tu-c', { lifted: [{ order: ORDER.order, by: 'spawn as many chats as you need' }] });
    expect(invented).toContain('Frontier stored');
    expect(invented).toContain('order "do not spawn more" still binding: no message from the person after 2026-10-27T14:53:00.000Z contains "spawn as many chats as you need".');

    await say(f, 'ok, spawn as many chats as you need');
    expect(await frontier(f, 'tu-d', { lifted: [{ order: ORDER.order, by: 'spawn as many chats as you need' }] })).toContain('Frontier stored');
    const r = await rows(f);
    expect(r.filter((row) => row.event === 'stored').map((row) => [row.orders, row.lifted])).toEqual([[1, 0], [1, 0], [1, 0], [0, 1]]);
    expect(r.filter((row) => row.event === 'refused')).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('do not spawn more');
  });

  it('installs frontier A with the order above it, then carries it into the mechanical wake after', async () => {
    const f = await begin();
    await say(f, 'Alright, do not spawn more, let these finish and finilize it');
    await frontier(f, 'tu-a', A);
    await step(f, 70_000);
    const wake = await ask(f, transcript('tu-a'));
    expect(wake.messages[0].text).toContain(`${ORDERS_HEADING}\n### ${ORDER.at}\n${ORDER.order}`);
    await step(f, 125_000);
    const mech = await ask(f, transcript('tu-x'));
    expect(mech.messages[1].text).toMatch(/^\[forward-compaction: no frontier written by the model\]/);
    expect(mech.messages[0].text).toContain(`${ORDERS_HEADING}\n### ${ORDER.at}\n${ORDER.order}`);
  });

  it("keeps the order across the person's /compact: the next frontier has it carried on", async () => {
    const f = await begin();
    await frontier(f, 'tu-a', A);
    expect(await ask(f, transcript('tu-a'), 'manual')).toEqual({ skip: 'native ran' });
    expect(f.texts().some((t) => t.includes('stored frontier was dropped'))).toBe(true);
    const next = await frontier(f, 'tu-b');
    expect(next).toContain('Frontier stored');
    expect(next).toContain('order "do not spawn more" (given 2026-10-27T14:53:00.000Z) was left out of your frontier and is carried on');
  });

  it('keeps the order across a plugin reload, for the drop check and the mechanical wake', async () => {
    const state = new Map<string, { value: unknown; version: number }>();
    const before = await begin({ state });
    await frontier(before, 'tu-a', A);
    const after = await begin({ state });
    expect(await frontier(after, 'tu-b')).toContain('order "do not spawn more" (given 2026-10-27T14:53:00.000Z) was left out of your frontier and is carried on');
    await step(after, 125_000);
    const mech = await ask(after, transcript('tu-x'));
    expect(mech.messages[0].text).toContain(`${ORDERS_HEADING}\n### ${ORDER.at}\n${ORDER.order}`);
  });
});
