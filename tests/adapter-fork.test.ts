// The adapter under FORWARD_COMPACTION_MAIN_FORK: a /compact the user types in an idle main chat awaits a fork inside its
// compaction ask, stores the reply through the forward_compaction door and installs it; every failure ends in Claude
// Code's own summary; every other point is the model-written path (fork.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { fakeEngine, type Script } from './fakes/engine.ts';
import { logged, rows } from './fakes/session.ts';

const FORWARD = 'mcp__forward-compaction__forward_compaction';
const SECTIONS = { objective: 'Ship U5.', next: 'Wire session.compact.', done: { add: ['The fake.'] }, remaining: { add: ['The adapter.'] } };
const FORKED = { next: 'Write the docs.', remaining: { add: ['The docs.'] } };
const FRONTIER = '## Objective\nShip U5.\n\n## Done\n[1] The fake.\n\n## Remaining\n[1] The adapter.\n[2] The docs.\n\n## Next\nWrite the docs.';
const USAGE = { input_tokens: 3, output_tokens: 400, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0 };
const ANSWER = { isAnswered: true, text: JSON.stringify(FORKED), usage: USAGE, effort: 'low' };
const CHANGES = 'When a notice next asks for a forward_compaction call, send only changes, by item number; whatever you leave out stays.';
/** A mid-turn transcript: main's last call is answered by a result the model has not answered yet. */
const MID = [
  { role: 'user', text: 'go', toolUses: [], handle: 'h0' },
  { role: 'assistant', text: 'reading the parser', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/x' } }], handle: 'h1' },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: 'file body' }], handle: 'h2' },
];
/** An idle transcript: main's turn ended with its answer. */
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
const call = (f: Fake) => f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-h', ...SECTIONS }, async () => ({ result: 'not ours' }));
const compact = (f: Fake, messages: unknown[] = END, instructions?: string) => f.dispatch('session.compact', { trigger: 'manual', messages, ...(instructions !== undefined ? { instructions } : {}) }, async () => ({ skip: 'native ran' }));
const answer = (f: Fake) => f.dispatch('turn.complete', { reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' }, async () => ({ text: 'done' }));
const picked = (all: Record<string, unknown>[], event: string, keys: string[]) => all.filter((r) => r.event === event).map((r) => Object.fromEntries(keys.map((key) => [key, r[key]])));

describe('a /compact typed in an idle main chat', () => {
  it('forks with the stored lists and the typed text, stores the reply as a call and installs it, the stored frontier kept', async () => {
    const f = await begin({ fork: () => ANSWER });
    await step(f, 51_000);
    await call(f);
    const out = await compact(f, END, 'keep the parser');
    expect(f.forkCalls.map((c) => c.effort)).toEqual(['low']);
    const prompt = f.forkCalls[0]!.prompt.split('\n\n');
    expect(prompt[2]).toBe('The user typed this with /compact: keep the parser');
    expect(prompt).toContain('### remaining\n[1] The adapter.');
    expect(out.messages.at(-1)).toEqual(END[1]);
    const head = out.messages.at(-2).text as string;
    expect(head.startsWith(`[forward-compaction: frontier] Below is your frontier, brought up to date by forward-compaction from the conversation at this compaction: continue from its ## Next. ${CHANGES}`)).toBe(true);
    expect(head).toContain(`=== frontier ===\n${FRONTIER}\n=== end of frontier ===`);
    const all = await rows(f);
    expect(picked(all, 'stored', ['writer', 'compacts'])).toEqual([{ writer: undefined, compacts: true }, { writer: 'fork', compacts: true }]);
    expect(picked(all, 'fork', ['trigger', 'outcome', 'effort', 'usage', 'trailing'])).toEqual([{ trigger: 'manual', outcome: 'applied', effort: 'low', usage: { input: 3, cacheRead: 50_000, cacheWritten: 0, output: 400 }, trailing: 1 }]);
    expect(picked(all, 'compact', ['trigger', 'decision', 'why'])).toEqual([{ trigger: 'manual', decision: 'install', why: 'fork' }]);
    expect(picked(all, 'dropped', ['why'])).toEqual([]);
    expect(await logged(f, 'info', 'fork-start')).toEqual(["/compact at 51,000 tokens: a fork is writing main's frontier."]);
    expect(await logged(f, 'info', 'fork')).toEqual(["/compact: the fork wrote main's frontier in 0.0 s; it installs now."]);
  });

  it('with nothing stored, the fork writes the first frontier and no typed text adds nothing', async () => {
    const f = await begin({ fork: () => ({ ...ANSWER, text: JSON.stringify(SECTIONS) }) });
    await step(f, 20_000);
    const out = await compact(f);
    expect(f.forkCalls[0]!.prompt.split('\n\n')[2]!.startsWith('Reply with one JSON object')).toBe(true);
    expect(out.messages.at(-2).text).toContain('=== frontier ===\n## Objective\nShip U5.\n\n## Done\n[1] The fake.\n\n## Remaining\n[1] The adapter.\n\n## Next\nWire session.compact.\n=== end of frontier ===');
    expect(picked(await rows(f), 'compact', ['decision', 'why'])).toEqual([{ decision: 'install', why: 'fork' }]);
  });

  const failures: [string, Script['fork'], string, number][] = [
    ['nothing to fork', () => ({ isAnswered: false, reason: 'nothing-to-fork' }), 'nothing-to-fork', 1],
    ['aborted', () => ({ isAnswered: false, reason: 'aborted' }), 'aborted', 1],
    ['an API error', () => ({ isAnswered: false, reason: 'api-error', status: null, error: 'invalid_request', usage: null }), 'api-error', 1],
    ['an empty reply', () => ({ isAnswered: false, reason: 'empty-reply', status: 200, usage: USAGE }), 'empty-reply', 1],
    ['a reply holding no JSON object', () => ({ ...ANSWER, text: 'I cannot do that.' }), 'no-json', 1],
    ['a rejected call', () => { throw new Error('socket hang up'); }, 'threw', 1],
    ['a Claude Code without $.model.fork', null, 'no-fork', 0],
    ['a Claude Code without $.model', () => { throw new TypeError("Cannot read properties of undefined (reading 'fork')"); }, 'no-fork', 1],
    ['a Claude Code without $.model, as Bun says it', () => { throw new TypeError("undefined is not an object (evaluating '$.model.fork')"); }, 'no-fork', 1],
  ];
  it.each(failures)("%s: Claude Code's own summary runs and the stored frontier is dropped", async (_name, fork, outcome, calls) => {
    const f = await begin({ fork });
    await step(f, 51_000);
    await call(f);
    expect(await compact(f)).toEqual({ skip: 'native ran' });
    expect(f.forkCalls.length).toBe(calls);
    const all = await rows(f);
    expect(picked(all, 'fork', ['outcome'])).toEqual([{ outcome }]);
    expect(picked(all, 'compact', ['decision', 'why', 'fork'])).toEqual([{ decision: 'native', why: 'manual', fork: outcome }]);
    expect(await logged(f, 'errors', 'fork')).toEqual([`/compact: the fork wrote no frontier (${outcome}, 0.0 s); Claude Code's own compaction ran instead and main's stored frontier was dropped.`]);
    expect([await logged(f, 'errors', 'dropped'), await logged(f, 'warnings', 'dropped')]).toEqual([[], ["/compact ran Claude Code's own summary; main's stored frontier was dropped."]]);
  });

  it("a failed fork with nothing stored: Claude Code's own summary, the fork's line alone", async () => {
    const f = await begin({ fork: () => ({ ...ANSWER, text: 'I cannot do that.' }) });
    await step(f, 51_000);
    expect(await compact(f)).toEqual({ skip: 'native ran' });
    const all = await rows(f);
    expect([picked(all, 'compact', ['decision', 'fork']), picked(all, 'dropped', ['why'])]).toEqual([[{ decision: 'native', fork: 'no-json' }], []]);
    expect(await logged(f, 'errors', 'fork')).toEqual(["/compact: the fork wrote no frontier (no-json, 0.0 s); Claude Code's own compaction ran instead."]);
  });

  it("mid-turn: no fork, Claude Code's own summary, the stored frontier dropped", async () => {
    const f = await begin({ fork: () => ANSWER });
    await step(f, 51_000);
    await call(f);
    expect(await compact(f, MID)).toEqual({ skip: 'native ran' });
    expect(f.forkCalls).toEqual([]);
    const all = await rows(f);
    expect(picked(all, 'compact', ['decision', 'why'])).toEqual([{ decision: 'native', why: 'manual' }]);
    expect(picked(all, 'dropped', ['why'])).toEqual([{ why: 'manual' }]);
  });

  it("with the option off: no fork, Claude Code's own summary", async () => {
    const f = await begin({ env: { FORWARD_COMPACTION_MAIN_FORK: '0' }, fork: () => ANSWER });
    await step(f, 51_000);
    expect(await compact(f)).toEqual({ skip: 'native ran' });
    expect(f.forkCalls).toEqual([]);
    expect(picked(await rows(f), 'compact', ['decision', 'why'])).toEqual([{ decision: 'native', why: 'manual' }]);
  });
});

describe('with the option on, the model writes its own frontier everywhere else', () => {
  it('a nudge level sends its nudge, and an automatic ask is held with no fork', async () => {
    const f = await begin({ fork: () => ANSWER });
    await step(f, 51_000);
    const nudge = await read(f, 'tu-1');
    expect([nudge.length, nudge[0]!.startsWith('forward-compaction: context 51k and increasing.')]).toEqual([1, true]);
    expect(await f.dispatch('session.compact', { trigger: 'auto', messages: MID }, async () => ({ skip: 'native ran' }))).toHaveProperty('skip');
    expect(f.forkCalls).toEqual([]);
    const all = await rows(f);
    expect(picked(all, 'nudge', ['level'])).toEqual([{ level: 3 }]);
    expect(picked(all, 'compact', ['decision', 'why'])).toEqual([{ decision: 'skip', why: 'waiting' }]);
    expect(picked(all, 'fork', ['outcome'])).toEqual([]);
  });

  it('past the finish point main reads the finish notice, and its turn end with nothing stored compacts nothing', async () => {
    const f = await begin({ env: { FORWARD_COMPACTION_MAIN_FINISH_START: '20000' }, fork: () => ANSWER });
    await step(f, 15_000);
    await step(f, 25_000); // the finish point: past its start and one nudge-every above the floor the first reading set
    expect((await read(f, 'tu-1')).length).toBe(1);
    await answer(f);
    expect([f.compactCalls, f.forkCalls]).toEqual([[], []]);
    expect(picked(await rows(f), 'finish-notice', ['tokens'])).toEqual([{ tokens: 25_000 }]);
  });
});
