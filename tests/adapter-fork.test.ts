// The adapter under FORWARD_COMPACTION_MAIN_FORK: main's due points, the fork awaited inside the compaction ask, its reply
// stored through the forward_compaction door, and each failure's fallback (fork.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { fakeEngine, type Script } from './fakes/engine.ts';
import { logged, rows } from './fakes/session.ts';

const FORWARD = 'mcp__forward-compaction__forward_compaction';
const SECTIONS = { objective: 'Ship U5.', next: 'Wire session.compact.', done: { add: ['The fake.'] }, remaining: { add: ['The adapter.'] } };
const FRONTIER = '## Objective\nShip U5.\n\n## Done\n[1] The fake.\n\n## Remaining\n[1] The adapter.\n\n## Next\nWire session.compact.';
const USAGE = { input_tokens: 3, output_tokens: 400, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0 };
const ANSWER = { isAnswered: true, text: JSON.stringify(SECTIONS), usage: USAGE, effort: 'low' };
const UPKEEP = 'forward-compaction brings this frontier up to date itself at each compaction: nothing is asked of you for it.';
/** A mid-turn transcript: main's last call is answered by a result its last request has not sent. */
const MID = [
  { role: 'user', text: 'go', toolUses: [], handle: 'h0' },
  { role: 'assistant', text: 'reading the parser', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/x' } }], handle: 'h1' },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: 'file body' }], handle: 'h2' },
];
const END = [{ role: 'user', text: 'go', toolUses: [], handle: 'h0' }, { role: 'assistant', text: 'all done', toolUses: [], handle: 'h1' }];

type Fake = ReturnType<typeof fakeEngine>;
const fakes: Fake[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) {
    expect(f.unscripted, 'every $ call the plugin made was scripted').toEqual([]);
    f.cleanup();
  }
});

/** adapter.test.ts's session (main nudged from 30k every 10k, ceiling 120k, Claude Code asking at 63k) with the fork on. */
async function begin(script: Script = {}): Promise<Fake> {
  const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', FORWARD_COMPACTION_MAIN_CEILING: '120000', FORWARD_COMPACTION_MAIN_NUDGE_START: '30000', FORWARD_COMPACTION_MAIN_NUDGE_EVERY: '10000', FORWARD_COMPACTION_MAIN_FORK: '1', FORWARD_COMPACTION_MAIN_FORK_EFFORT: 'low' };
  const f = fakeEngine({ window: 1_000_000, ...script, env: { ...env, ...script.env } });
  fakes.push(f);
  await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
  return f;
}
const step = (f: Fake, tokens: number) => f.dispatch('turn.step', { turnId: 't1', index: 0, model: 'claude-sonnet-4-5', messageCount: 4 }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: { input_tokens: 0, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, output_tokens: 0 } }));
const read = async (f: Fake, id: string): Promise<string[]> => (await f.dispatch('tool.call', { tool: 'Read', tool_use_id: id, file_path: '/x' }, async () => ({ result: 'file' }))).context ?? [];
const ask = (f: Fake, messages: unknown[] = MID) => f.dispatch('session.compact', { trigger: 'auto', messages }, async () => ({ skip: 'native ran' }));
const answer = (f: Fake) => f.dispatch('turn.complete', { reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' }, async () => ({ text: 'done' }));
const picked = (all: Record<string, unknown>[], event: string, keys: string[]) => all.filter((r) => r.event === event).map((r) => Object.fromEntries(keys.map((key) => [key, r[key]])));

describe('main fork at a nudge level', () => {
  it('sends no nudge, then the next automatic ask forks, stores the reply as a call and installs it with the unanswered messages', async () => {
    const f = await begin({ fork: () => ANSWER });
    await step(f, 51_000);
    expect(await read(f, 'tu-1')).toEqual([]);
    const out = await ask(f);
    expect(f.forkCalls.map((c) => c.effort)).toEqual(['low']);
    expect(f.forkCalls[0]!.prompt).toContain('## Tool results after the conversation above\n\nThe conversation above ends at its last tool calls. These are their results, which it does not show: count them in.\n\n### Read (r1)\nfile body\n\n');
    expect(out.messages.slice(-2)).toEqual(MID.slice(-2));
    const head = out.messages.at(-3).text as string;
    expect(head.startsWith(`[forward-compaction: frontier] Below is your frontier, brought up to date by forward-compaction from the conversation at this compaction: continue from its ## Next. ${UPKEEP}`)).toBe(true);
    expect(head).toContain(`=== frontier ===\n${FRONTIER}\n=== end of frontier ===`);
    const all = await rows(f);
    expect(picked(all, 'fork-due', ['point', 'notice', 'tokens'])).toEqual([{ point: 3, notice: 'nudge', tokens: 51_000 }]);
    expect(picked(all, 'stored', ['writer', 'compacts'])).toEqual([{ writer: 'fork', compacts: true }]);
    expect(picked(all, 'fork', ['point', 'outcome', 'effort', 'usage', 'trailing'])).toEqual([{ point: 3, outcome: 'applied', effort: 'low', usage: { input: 3, cacheRead: 50_000, cacheWritten: 0, output: 400 }, trailing: 2 }]);
    expect(picked(all, 'compact', ['decision', 'why'])).toEqual([{ decision: 'install', why: 'fork' }]);
    expect(await logged(f, 'errors', 'fork')).toEqual([]);
  });

  it('a failed fork skips the ask and main reads the nudge instead; the next level forks again', async () => {
    const f = await begin({ fork: () => ({ isAnswered: false, reason: 'api-error', status: null, error: 'invalid_request', usage: null }) });
    await step(f, 51_000);
    expect(await read(f, 'tu-1')).toEqual([]);
    expect(await ask(f)).toEqual({ skip: 'forward-compaction: the fork wrote no frontier (api-error)' });
    const nudge = await read(f, 'tu-2');
    expect([nudge.length, nudge[0]!.startsWith('forward-compaction: context 51k and increasing.')]).toEqual([1, true]);
    await step(f, 61_000);
    expect(await read(f, 'tu-3')).toEqual([]);
    const all = await rows(f);
    expect(picked(all, 'fork-due', ['point'])).toEqual([{ point: 3 }, { point: 4 }]);
    expect(picked(all, 'compact', ['decision', 'why', 'outcome'])).toEqual([{ decision: 'skip', why: 'fork-failed', outcome: 'api-error' }]);
    expect(picked(all, 'nudge', ['level', 'fallback'])).toEqual([{ level: 3, fallback: 'fork-failed' }]);
    expect(await logged(f, 'errors', 'fork')).toEqual(['the fork wrote no frontier at nudge level 3 (api-error, 0.0 s); main reads the nudge instead.']);
  });

  it('nothing to fork yet skips the ask with the fork still due, and the next ask forks', async () => {
    let calls = 0;
    const f = await begin({ fork: () => (++calls === 1 ? { isAnswered: false, reason: 'nothing-to-fork' } : ANSWER) });
    await step(f, 51_000);
    await read(f, 'tu-1');
    expect(await ask(f)).toEqual({ skip: 'forward-compaction: the fork wrote no frontier (nothing-to-fork)' });
    expect(await read(f, 'tu-2')).toEqual([]);
    await step(f, 52_000);
    expect(await ask(f)).toHaveProperty('messages');
    expect(picked(await rows(f), 'compact', ['decision', 'why'])).toEqual([{ decision: 'skip', why: 'fork-retry' }, { decision: 'install', why: 'fork' }]);
  });

  it.each(['$.model.fork is not a function', "Cannot read properties of undefined (reading 'fork')"])("a Claude Code without $.model.fork reads the nudge, and the option is off from then on: %s", async (thrown) => {
    const f = await begin({ fork: () => { throw new TypeError(thrown); } });
    await step(f, 51_000);
    await read(f, 'tu-1');
    expect(await ask(f)).toEqual({ skip: 'forward-compaction: the fork wrote no frontier (threw)' });
    expect((await read(f, 'tu-2')).length).toBe(1);
    await step(f, 61_000);
    expect((await read(f, 'tu-3')).length).toBe(1);
    expect(f.forkCalls.length).toBe(1);
    expect(picked(await rows(f), 'nudge', ['level', 'fallback'])).toEqual([{ level: 3, fallback: 'fork-failed' }, { level: 4, fallback: undefined }]);
  });

  it('at the ceiling with nothing due a fork is tried first, and its failure installs the mechanical wake, asking for no call', async () => {
    const f = await begin({ fork: () => ({ isAnswered: false, reason: 'empty-reply', status: 200, error: undefined, usage: USAGE }) });
    await step(f, 120_000);
    const out = await ask(f);
    expect((out.messages[1].text as string).startsWith('[forward-compaction: no frontier written by the model]')).toBe(true);
    expect(out.messages[1].text).toContain(UPKEEP);
    const all = await rows(f);
    expect(picked(all, 'fork', ['point', 'outcome', 'then'])).toEqual([{ point: 'ceiling', outcome: 'empty-reply', then: 'mechanical' }]);
    expect(picked(all, 'compact', ['decision', 'why'])).toEqual([{ decision: 'mechanical', why: 'ceiling' }]);
  });

  it("a model's own call that compacts installs with no fork", async () => {
    const f = await begin({ fork: () => ANSWER });
    await step(f, 51_000);
    await read(f, 'tu-1');
    await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-h', ...SECTIONS }, async () => ({ result: 'not ours' }));
    expect(await ask(f)).toHaveProperty('messages');
    expect(f.forkCalls).toEqual([]);
    expect(picked(await rows(f), 'compact', ['decision', 'why'])).toEqual([{ decision: 'install', why: 'stored' }]);
  });
});

describe('main fork at the turn end', () => {
  const finish = { FORWARD_COMPACTION_MAIN_FINISH_START: '20000' };

  it("past the finish point the turn end's own ask forks with no results section and installs the frontier", async () => {
    const out: unknown[] = [];
    const holder: { f?: Fake } = {};
    const f = await begin({ env: finish, fork: () => ANSWER, compact: async () => { const r = await holder.f!.dispatch('session.compact', { trigger: 'plugin', messages: END }, async () => ({ skip: 'native ran' })); out.push(r); return r; } });
    holder.f = f;
    await step(f, 15_000);
    await step(f, 25_000); // the finish point: past its start and one nudge-every above the floor the first reading set
    await answer(f);
    expect(f.compactCalls).toEqual([[]]);
    expect(f.forkCalls[0]!.prompt).not.toContain('## Tool results');
    expect((out[0] as { messages: unknown[] }).messages.at(-1)).toEqual(END[1]);
    const all = await rows(f);
    expect(picked(all, 'fork-due', ['point', 'notice'])).toEqual([{ point: 'finish', notice: 'finish-notice' }]);
    expect(picked(all, 'compact', ['trigger', 'decision', 'why'])).toEqual([{ trigger: 'plugin', decision: 'install', why: 'fork' }]);
  });

  it("a nudge level the turn's last request reached forks at the turn end, told the turn has ended", async () => {
    const holder: { f?: Fake } = {};
    const f = await begin({ fork: () => ANSWER, compact: async () => holder.f!.dispatch('session.compact', { trigger: 'plugin', messages: END }, async () => ({ skip: 'native ran' })) });
    holder.f = f;
    await step(f, 51_000);
    await answer(f);
    expect(f.compactCalls).toEqual([[]]);
    expect(f.forkCalls[0]!.prompt.split('\n\n')[1]).toBe("This conversation is about to be compacted. Everything above this message is dropped except its last assistant message; the work continues from the frontier alone, beside the user's own messages and standing orders, which the plugin carries verbatim. The turn has ended: that last message was sent to the user as it stands, and the next thing to arrive is the user's next message. Bring the frontier below up to this moment, so the work continues with nothing lost.");
    const all = await rows(f);
    expect(picked(all, 'fork-due', ['point', 'notice'])).toEqual([{ point: 3, notice: 'nudge' }]);
    expect(picked(all, 'compact', ['trigger', 'decision', 'why'])).toEqual([{ trigger: 'plugin', decision: 'install', why: 'fork' }]);
  });

  it('below every notice point the turn end compacts nothing', async () => {
    const f = await begin({ env: finish, fork: () => ANSWER });
    await step(f, 15_000);
    await answer(f);
    expect([f.compactCalls, f.forkCalls]).toEqual([[], []]);
  });

  it('a headless chat reads the finish notice with its tool result, as with the fork off', async () => {
    const f = await begin({ env: finish, fork: () => ANSWER });
    await f.dispatch('prompt.submit', { text: 'go', origin: { kind: 'sdk' } }, async () => ({}));
    await step(f, 15_000);
    await step(f, 25_000); // the finish point: past its start and one nudge-every above the floor the first reading set
    expect((await read(f, 'tu-1')).length).toBe(1);
    await answer(f);
    expect([f.compactCalls, f.forkCalls]).toEqual([[], []]);
    const all = await rows(f);
    expect([picked(all, 'finish-notice', ['tokens']), picked(all, 'fork-due', ['point'])]).toEqual([[{ tokens: 25_000 }], []]);
  });
});
