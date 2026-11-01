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

const ORDER = { order: 'do not spawn more' };
const valid = { objective: 'finish the round', decisions: 'none', done: 'round 1', remaining: 'round 2', next: 'wait for the chats' };

describe('parseFrontier: standing_orders and lifted', () => {
  const memory = (said: string[] = []) => ({ remembered: [ORDER], said, party: 'main' as const });

  it('takes the orders verbatim and none by default', () => {
    expect(parseFrontier(valid)).toMatchObject({ standingOrders: [], lifted: [], notes: [] });
    expect(parseFrontier({ ...valid, standing_orders: [ORDER] })).toMatchObject({ standingOrders: [ORDER] });
  });

  it("keeps every non-blank order whatever else its entry holds, with no message of the person's holding it", () => {
    const orders = [{ order: 'never run any git command.', at: '2026-10-29' }, { order: 'Write no files.' }, { order: 'Land it on develop', at: 'yesterday' }];
    expect(parseFrontier({ ...valid, standing_orders: orders }, { remembered: [], said: [], party: 'main' })).toMatchObject({
      standingOrders: [{ order: 'never run any git command.' }, { order: 'Write no files.' }, { order: 'Land it on develop' }],
      notes: [],
    });
  });

  it("lifts an order in the person's words across spacing and letter case, whenever they were said", () => {
    const order = { order: 'Delete END TO END' };
    const said = ['God speed', 'Alright, write this plane DOWN\n\nWe will do THIS plan'];
    const by = 'Alright, write this plane DOWN We will do THIS plan';
    expect(parseFrontier({ ...valid, lifted: [{ order: order.order, by }] }, { remembered: [order], said, party: 'main' })).toMatchObject({ standingOrders: [], lifted: [{ order: order.order, by }], notes: [] });
    expect(parseFrontier({ ...valid, lifted: [{ order: order.order, by: ' God speed ' }] }, { remembered: [order], said, party: 'main' })).toMatchObject({ lifted: [{ order: order.order, by: ' God speed ' }] });
  });

  it('skips every bad order entry and names it, one line each, never quoting the order', () => {
    const out = parseFrontier({ ...valid, standing_orders: [{ order: ' ' }, { order: 'x', at: 'yesterday' }, ORDER], lifted: [{ order: 'x' }] });
    expect(out.notes).toEqual([
      "standing_orders[0].order must be a non-blank string, the person's words verbatim: skipped.",
      "lifted[0].by must be a non-blank string, the person's words that lifted the order, verbatim: skipped.",
    ]);
    expect(out.standingOrders).toEqual([{ order: 'x' }, ORDER]);
    expect(parseFrontier({ ...valid, standing_orders: 'do not spawn' }).notes).toEqual(['standing_orders must be an array of {order}: none read from it.']);
    expect(parseFrontier({ ...valid, lifted: {} }).notes).toEqual(['lifted must be an array of {order, by}: none read from it.']);
  });

  it('carries a remembered order the frontier left out, naming it', () => {
    const out = parseFrontier(valid, memory());
    expect(out.standingOrders).toEqual([ORDER]);
    expect(out.notes).toEqual(['order "do not spawn more" was left out of your frontier and is carried on: it binds until the person lifts it.']);
    expect(parseFrontier({ ...valid, standing_orders: [ORDER] }, memory())).toMatchObject({ standingOrders: [ORDER], lifted: [], notes: [] });
  });

  it('accepts a lift only in words the party was sent, keeping an unproven one beside its still binding order', () => {
    const second = { order: 'never push' };
    const m = { remembered: [ORDER, second], said: ['ok, spawn two more chats'], party: 'main' as const };
    const bad = parseFrontier({ ...valid, lifted: [{ order: ORDER.order, by: 'spawn as many as you like' }] }, m);
    expect(bad.standingOrders).toEqual([{ order: ORDER.order, liftClaimed: 'spawn as many as you like' }, second]);
    expect(bad.lifted).toEqual([]);
    expect(bad.notes).toEqual([
      'order "do not spawn more" still binding: no message from the person contains "spawn as many as you like"; the wake shows your lift beside it.',
      'order "never push" was left out of your frontier and is carried on: it binds until the person lifts it.',
    ]);
    expect(parseFrontier({ ...valid, standing_orders: [second], lifted: [{ order: ORDER.order, by: 'spawn two more' }] }, m)).toMatchObject({
      standingOrders: [second], lifted: [{ order: ORDER.order, by: 'spawn two more' }], notes: [],
    });
  });

  it('ignores a lift of an order no frontier carried, and keeps an order both carried and lifted binding unless the words prove the lift', () => {
    const m = memory(['go ahead']);
    expect(parseFrontier({ ...valid, standing_orders: [ORDER], lifted: [{ order: 'something else', by: 'go ahead' }] }, m)).toMatchObject({ standingOrders: [ORDER], notes: ['lifted "something else" names no standing order: ignored.'] });
    expect(parseFrontier({ ...valid, standing_orders: [ORDER], lifted: [{ order: ORDER.order, by: 'nobody said' }] }, m)).toMatchObject({ standingOrders: [{ ...ORDER, liftClaimed: 'nobody said' }], lifted: [] });
    expect(parseFrontier({ ...valid, standing_orders: [ORDER], lifted: [{ order: ORDER.order, by: 'go ahead' }] }, m)).toMatchObject({ standingOrders: [], lifted: [{ order: ORDER.order, by: 'go ahead' }] });
  });

  it("refuses a lift quoting the message that gave the order, and lifts on a later message's words", () => {
    const said = ['Alright, do not spawn more, let these finish. Spawn as many as you like later', 'ok, spawn two more chats'];
    const by = 'Spawn as many as you like later';
    const own = parseFrontier({ ...valid, standing_orders: [ORDER], lifted: [{ order: ORDER.order, by }] }, { remembered: [ORDER], said, party: 'main' });
    expect(own.standingOrders).toEqual([{ ...ORDER, liftClaimed: by }]);
    expect(own.lifted).toEqual([]);
    expect(own.notes).toEqual([`order "do not spawn more" still binding: no message from the person contains "${by}"; the wake shows your lift beside it.`]);
    expect(parseFrontier({ ...valid, standing_orders: [ORDER], lifted: [{ order: ORDER.order, by: 'spawn two more chats' }] }, { remembered: [ORDER], said, party: 'main' })).toMatchObject({
      standingOrders: [], lifted: [{ order: ORDER.order, by: 'spawn two more chats' }], notes: [],
    });
  });

  it("names a sub-agent's sources as its brief and the messages delivered to it", () => {
    const out = parseFrontier({ ...valid, lifted: [{ order: ORDER.order, by: 'nobody said this' }] }, { remembered: [ORDER], said: ['brief'], party: 'subagent' });
    expect(out.notes[0]).toBe('order "do not spawn more" still binding: neither your brief nor any message delivered to you contains "nobody said this"; the wake shows your lift beside it.');
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
    expect(liftSources(l, 'main')).toEqual(['person said']);
    expect(liftSources(l, 'agent:a1')).toEqual(['the brief', 'delivered']);
  });
});

describe('keptOrders: what $.state gives back', () => {
  it("takes each entry whose order is a string, an older frontier's at included, and nothing else", () => {
    expect(keptOrders([ORDER])).toEqual([ORDER]);
    expect(keptOrders([{ order: 'never push', at: '2026-10-27T14:53:00.000Z' }, { order: 'Write no files.' }])).toEqual([{ order: 'never push' }, { order: 'Write no files.' }]);
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
    const lift = { order: ORDER.order, by: 'spawn again' };
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

  it('opens the facts with the binding section, whole, before every other section and the frontier, an unproven lift beside its order', () => {
    const lift = { order: 'never push', by: 'push it now' };
    const claimed = { order: 'never force-push', liftClaimed: 'force it' };
    const wake = buildWake({ ...shared, toolUseId: 't9', frontier: '## Next\nround 2', orders: { standing: [ORDER, claimed], lifted: [lift] } });
    const f = (wake.messages[0] as BuiltMessage).text;
    const sections = f.split('\n\n').filter((s) => s.startsWith('## '));
    expect(sections[0]).toBe([
      ORDERS_HEADING,
      `- ${ORDER.order}`,
      '- never force-push',
      '  (your frontier lifted it with "force it", but no message recorded for you holds those words: it still binds)',
      '### Lifted, no longer binding', 'never push', 'The person lifted it: "push it now"',
    ].join('\n'));
    expect(f.indexOf(ORDERS_HEADING)).toBeLessThan(f.indexOf("## The person's messages"));
    expect((wake.messages[1] as BuiltMessage).text).toContain('continue from its ## Next, within the standing orders above.');
    expect(wake.sizes[0]).toEqual({ section: ORDERS_HEADING, chars: sections[0]!.length });
  });

  it('carries them whole whatever the budget, and the mechanical wake carries them the same way', () => {
    const long = { order: 'never '.repeat(20_000) };
    const built = buildWake({ ...shared, askPoint: 1_000, toolUseId: 't9', frontier: 'h', orders: { standing: [long] } });
    expect((built.messages[0] as BuiltMessage).text).toContain(long.order);
    const mech = mechanicalWake({ ...shared, reason: { kind: 'ceiling', ceiling: 120_000 }, orders: { standing: [ORDER] } });
    expect((mech.messages[0] as BuiltMessage).text).toContain(`${ORDERS_HEADING}\n- ${ORDER.order}`);
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

// Each case drives several frontier cycles over a 200k-character transcript through the hooks:
// CPU-bound seconds that a loaded host stretches past vitest's 5 s default.
describe('the dropped standing order, replayed', { timeout: 30_000 }, () => {
  it('stores frontier B without the order and carries it on, keeps it binding on a lift nobody said, and lifts it in the words the person sent', async () => {
    const f = await begin();
    await say(f, 'Alright, do not spawn more, let these finish and finilize it');
    expect(await frontier(f, 'tu-a', A)).toContain('Frontier stored');
    f.advance(10 * 60_000);
    await say(f, 'Fix all the failures, make the engine and ALL offices stable / God speed');

    const dropped = await frontier(f, 'tu-b');
    expect(dropped).toContain('Frontier stored');
    expect(dropped).toContain('order "do not spawn more" was left out of your frontier and is carried on');
    expect((await ask(f, transcript('tu-b'))).messages[0].text).toContain(`${ORDERS_HEADING}\n- ${ORDER.order}`);

    const invented = await frontier(f, 'tu-c', { lifted: [{ order: ORDER.order, by: 'spawn as many chats as you need' }] });
    expect(invented).toContain('Frontier stored');
    expect(invented).toContain('order "do not spawn more" still binding: no message from the person contains "spawn as many chats as you need"; the wake shows your lift beside it.');
    expect((await ask(f, transcript('tu-c'))).messages[0].text).toContain(`${ORDERS_HEADING}\n- ${ORDER.order}\n  (your frontier lifted it with "spawn as many chats as you need", but no message recorded for you holds those words: it still binds)`);

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
    expect(wake.messages[0].text).toContain(`${ORDERS_HEADING}\n- ${ORDER.order}`);
    await step(f, 125_000);
    const mech = await ask(f, transcript('tu-x'));
    expect(mech.messages[1].text).toMatch(/^\[forward-compaction: no frontier written by the model\]/);
    expect(mech.messages[0].text).toContain(`${ORDERS_HEADING}\n- ${ORDER.order}`);
  });

  it("keeps the order across the person's /compact: the next frontier has it carried on", async () => {
    const f = await begin();
    await frontier(f, 'tu-a', A);
    expect(await ask(f, transcript('tu-a'), 'manual')).toEqual({ skip: 'native ran' });
    expect(f.texts().some((t) => t.includes('stored frontier was dropped'))).toBe(true);
    const next = await frontier(f, 'tu-b');
    expect(next).toContain('Frontier stored');
    expect(next).toContain('order "do not spawn more" was left out of your frontier and is carried on');
  });

  it('keeps the order across a plugin reload, for the drop check and the mechanical wake', async () => {
    const state = new Map<string, { value: unknown; version: number }>();
    const before = await begin({ state });
    await frontier(before, 'tu-a', A);
    const after = await begin({ state });
    expect(await frontier(after, 'tu-b')).toContain('order "do not spawn more" was left out of your frontier and is carried on');
    await step(after, 125_000);
    const mech = await ask(after, transcript('tu-x'));
    expect(mech.messages[0].text).toContain(`${ORDERS_HEADING}\n- ${ORDER.order}`);
  });
});
