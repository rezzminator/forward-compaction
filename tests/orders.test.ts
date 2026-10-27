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
// across installs, the person's /compact and a plugin reload, refused when dropped without the person's lifting words,
// and rendered above the frontier in every wake, the mechanical one included.

const P = 'forward_compaction refused, nothing stored: ';
const ORDER = { order: 'do not spawn more', at: '2026-10-27T14:53:00.000Z' };
const valid = { objective: 'finish the round', done: 'round 1', remaining: 'round 2', next: 'wait for the chats' };

describe('parseFrontier: standing_orders and lifted', () => {
  const LATER = Date.parse(ORDER.at) + 60_000;
  const memory = (said: string[] = []) => ({ remembered: [ORDER], said: said.map((text) => ({ text, at: LATER })), party: 'main' as const });
  const refusal = (input: unknown, m?: Parameters<typeof parseFrontier>[1]): string | undefined => {
    const out = parseFrontier(input, m);
    return 'refusal' in out ? out.refusal : undefined;
  };

  it('takes the orders verbatim and none by default', () => {
    expect(parseFrontier(valid)).toMatchObject({ standingOrders: [], lifted: [] });
    expect(parseFrontier({ ...valid, standing_orders: [ORDER] })).toMatchObject({ standingOrders: [ORDER] });
  });

  it('names every bad order entry with the other bad arguments, one line each, never quoting the order', () => {
    expect(refusal({ ...valid, next: '', standing_orders: [{ order: ' ', at: 'yesterday' }], lifted: [{ order: 'x' }] })).toBe([
      `${P}next must be a non-blank string; got a blank string.`,
      'standing_orders[0].order must be a non-blank string: the person\'s words, verbatim.',
      'standing_orders[0].at must be the ISO time of the person\'s message, like "2026-10-27T14:53:00Z".',
      'lifted[0].by must be a non-blank string: the person\'s words that lifted the order, verbatim.',
    ].join('\n'));
    expect(refusal({ ...valid, standing_orders: 'do not spawn' })).toBe(`${P}standing_orders must be an array of {order, at}.`);
    expect(refusal({ ...valid, lifted: {} })).toBe(`${P}lifted must be an array of {order, by}.`);
  });

  it('refuses a frontier that leaves out a remembered order, naming it with its time and both fixes', () => {
    const text = refusal(valid, memory())!;
    expect(text.startsWith(P)).toBe(true);
    expect(text).toContain('"do not spawn more" (given 2026-10-27T14:53:00.000Z)');
    expect(text).toContain('Carry it in standing_orders as it was');
    expect(text).toContain('list it in lifted with the person\'s words that lifted it, verbatim');
    expect(parseFrontier(valid, memory())).toMatchObject({ orderFaults: 1 });
    expect(parseFrontier({ ...valid, standing_orders: [ORDER] }, memory())).toMatchObject({ standingOrders: [ORDER], lifted: [] });
  });

  it('accepts a lift only in words the party was sent, and lists every fault in one refusal', () => {
    const second = { order: 'never push', at: '2026-10-27T15:00:00Z' };
    const m = { remembered: [ORDER, second], said: [{ text: 'ok, spawn two more chats', at: LATER }], party: 'main' as const };
    const lifted = [{ order: ORDER.order, by: 'spawn as many as you like' }];
    const text = refusal({ ...valid, lifted }, m)!;
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('lifted "do not spawn more": its by text is in no message of the person\'s');
    expect(text).toContain('"never push" (given 2026-10-27T15:00:00Z)');
    expect(parseFrontier({ ...valid, standing_orders: [second], lifted: [{ order: ORDER.order, by: 'spawn two more' }] }, m)).toMatchObject({
      standingOrders: [second], lifted: [{ order: ORDER.order, at: ORDER.at, by: 'spawn two more' }],
    });
  });

  it('refuses a lift of an order no frontier carried, and an order both carried and lifted', () => {
    const m = memory(['go ahead']);
    expect(refusal({ ...valid, standing_orders: [ORDER], lifted: [{ order: 'something else', by: 'go ahead' }] }, m)).toContain('lifted "something else" is no standing order your last frontier carried');
    expect(refusal({ ...valid, standing_orders: [ORDER], lifted: [{ order: ORDER.order, by: 'go ahead' }] }, m)).toContain('"do not spawn more" is both in standing_orders and in lifted');
  });

  it("names a sub-agent's sources as its brief and the messages delivered to it", () => {
    expect(refusal({ ...valid, lifted: [{ order: ORDER.order, by: 'nobody said this' }] }, { remembered: [ORDER], said: [{ text: 'brief', at: LATER }], party: 'subagent' })).toContain('is in neither your brief nor any message delivered to you');
  });

  it('lifts an order only by words sent after it was given: the same words said before it lift nothing (the woonwacht case)', () => {
    const order = { order: 'never run the paid replay', at: '2026-10-27T14:53:00Z' };
    const before = { text: 'God speed', at: Date.parse('2026-10-27T14:22:00Z') };
    const after = { text: 'Ship it all / God speed', at: Date.parse('2026-10-27T17:44:00Z') };
    const lift = { ...valid, lifted: [{ order: order.order, by: ' God speed ' }] };
    expect(refusal(lift, { remembered: [order], said: [before], party: 'main' })).toContain('lifted "never run the paid replay": its by text is in no message of the person\'s sent after the order was given (2026-10-27T14:53:00Z), so it lifts nothing.');
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
// frontier B dropped it and was accepted, and the woken agent spawned 12 paid chats.
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
  it('refuses frontier B without the order, refuses a lift nobody said, and stores a lift in the words the person sent', async () => {
    const f = await begin();
    await say(f, 'Alright, do not spawn more, let these finish and finilize it');
    expect(await frontier(f, 'tu-a', A)).toContain('Frontier stored');
    f.advance(10 * 60_000);
    await say(f, 'Fix all the failures, make the engine and ALL offices stable / God speed');

    const dropped = await frontier(f, 'tu-b');
    expect(dropped.startsWith(P)).toBe(true);
    expect(dropped).toContain('"do not spawn more" (given 2026-10-27T14:53:00.000Z) was in your last frontier and is not in this one');

    const invented = await frontier(f, 'tu-b', { lifted: [{ order: ORDER.order, by: 'spawn as many chats as you need' }] });
    expect(invented.startsWith(P)).toBe(true);
    expect(invented).toContain('its by text is in no message of the person\'s');

    await say(f, 'ok, spawn as many chats as you need');
    expect(await frontier(f, 'tu-b', { lifted: [{ order: ORDER.order, by: 'spawn as many chats as you need' }] })).toContain('Frontier stored');
    const r = await rows(f);
    expect(r.filter((row) => row.event === 'stored').map((row) => [row.orders, row.lifted])).toEqual([[1, 0], [0, 1]]);
    expect(r.filter((row) => row.event === 'refused')).toEqual([
      expect.objectContaining({ party: 'main', reason: 'standing-orders', faults: 1 }),
      expect.objectContaining({ party: 'main', reason: 'standing-orders', faults: 1 }),
    ]);
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

  it("keeps the order across the person's /compact: the next frontier still carries it or lifts it", async () => {
    const f = await begin();
    await frontier(f, 'tu-a', A);
    expect(await ask(f, transcript('tu-a'), 'manual')).toEqual({ skip: 'native ran' });
    expect(f.texts().some((t) => t.includes('stored frontier was dropped'))).toBe(true);
    expect(await frontier(f, 'tu-b')).toContain('"do not spawn more" (given 2026-10-27T14:53:00.000Z)');
    expect(await frontier(f, 'tu-b', A)).toContain('Frontier stored');
  });

  it('keeps the order across a plugin reload, for the drop check and the mechanical wake', async () => {
    const state = new Map<string, { value: unknown; version: number }>();
    const before = await begin({ state });
    await frontier(before, 'tu-a', A);
    const after = await begin({ state });
    expect(await frontier(after, 'tu-b')).toContain('"do not spawn more" (given 2026-10-27T14:53:00.000Z)');
    await step(after, 125_000);
    const mech = await ask(after, transcript('tu-x'));
    expect(mech.messages[0].text).toContain(`${ORDERS_HEADING}\n### ${ORDER.at}\n${ORDER.order}`);
  });
});
