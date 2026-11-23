import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeEngine, usage, type Script } from './fakes/engine.ts';
import { fromFacts, store, transcript } from './fakes/session.ts';

// The adapter's wiring of the audited faults (2026-10-27): each row keys and judges its party once, a lift is
// checked against its time, a rejected turn-end install is an error, and the wake carries what the party ran.

type Fake = ReturnType<typeof fakeEngine>;
const fakes: Fake[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) {
    expect(f.unscripted, 'every $ call the plugin made was scripted').toEqual([]);
    f.cleanup();
  }
});

const FORWARD = 'mcp__forward-compaction__forward_compaction';
const LOOK_BACK = 'mcp__forward-compaction__look_back';
const SECTIONS = { objective: 'Fix the audit.', next: 'Write its test.', done: { add: ['Item 20.'] }, remaining: { add: ['Item 21.'] } };
const A1 = 'a1b2c3d4e5';

async function begin(script: Script = {}): Promise<Fake> {
  const sizes = (party: string) => ({ [`FORWARD_COMPACTION_${party}_CEILING`]: '120000', [`FORWARD_COMPACTION_${party}_NUDGE_START`]: '30000', [`FORWARD_COMPACTION_${party}_NUDGE_EVERY`]: '10000' });
  const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT: '1m', ...sizes('MAIN'), ...sizes('SUBAGENT') };
  const f = fakeEngine({ window: 1_000_000, ...script, env: { ...env, ...script.env } });
  fakes.push(f);
  await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
  return f;
}

const step = (f: Fake, tokens: number, agentId?: string, model: string | undefined = 'claude-sonnet-4-5') =>
  f.dispatch('turn.step', { turnId: 't1', index: 0, ...(model !== undefined ? { model } : {}), messageCount: 4, ...(agentId ? { agentId } : {}) }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(tokens) }));
const spawn = (f: Fake, agentId = A1, prompt = 'Brief for agent one', subagentType = 'general-purpose') =>
  f.dispatch('agent.spawn', { tool_use_id: 'tu-spawn', prompt, description: 'one', subagentType, provider: { kind: 'local' } }, async () => ({ model: 'sonnet', agentId }));

/** The decision rows written this session, read once session.end has flushed them. */
async function rows(f: Fake): Promise<Record<string, unknown>[]> {
  await f.dispatch('session.end', { reason: 'other' }, async () => ({}));
  const dir = join(f.home, '.local/state/forward-compaction/logs/decisions');
  return readdirSync(dir).filter((n) => n.endsWith('.jsonl')).flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

describe('S6: look-back rows key a sub-agent as agent:{id}', () => {
  it("writes a sub-agent's look_back row under agent:{id}, main's under main", async () => {
    const f = await begin();
    await f.dispatch('tool.call', { tool: LOOK_BACK, tool_use_id: 'tu-l1', agentId: A1, query: 'brief' }, async () => ({ result: 'not ours' }));
    await f.dispatch('tool.call', { tool: LOOK_BACK, tool_use_id: 'tu-l2', query: 'brief' }, async () => ({ result: 'not ours' }));
    expect((await rows(f)).filter((r) => r.event === 'look-back').map((r) => r.party)).toEqual([`agent:${A1}`, 'main']);
  });
});

describe('L10 + L11: one ignore row per judgement, across a step with no model and a plugin reload', () => {
  it('judges main unknown until a step names its model, keeps that judgement through a modelless step, and writes no row again after a reload', async () => {
    const state = new Map<string, { value: unknown; version: number }>();
    const before = await begin({ state });
    await step(before, 20_000);
    await step(before, 21_000, undefined, undefined);
    await spawn(before);
    await step(before, 20_000, A1);
    await step(before, 21_000, A1, undefined);
    const first = (await rows(before)).filter((r) => r.event === 'ignore').map((r) => [r.party, r.judged]);
    expect(first).toEqual([['main', 'unknown'], ['main', 'managed'], [`agent:${A1}`, 'unknown'], [`agent:${A1}`, 'managed']]);

    const after = await begin({ state });
    await step(after, 22_000);
    await step(after, 22_000, A1);
    expect((await rows(after)).filter((r) => r.event === 'ignore')).toEqual([]);
  });
});

describe("L5 + S1 + S5: each sub-agent is measured against its own model's max context", () => {
  const unset = { FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT: '', FORWARD_COMPACTION_SUBAGENT_CEILING: '', FORWARD_COMPACTION_SUBAGENT_NUDGE_START: '', FORWARD_COMPACTION_SUBAGENT_NUDGE_EVERY: '' };
  const read = (f: Fake, id: string, agentId: string) => f.dispatch('tool.call', { tool: 'Read', tool_use_id: id, file_path: '/x', agentId }, async () => ({ result: 'file' }));
  const ask = (f: Fake, agentId: string) => f.dispatch('session.compact', { trigger: 'auto', agentId, messages: [{ role: 'user', text: 'Brief for agent one', toolUses: [], handle: 'h0' }] }, async () => ({ skip: 'native ran' }));
  it('nudges a [1m] sub-agent at 165k and again at 230k (the start and the step are the same on every max context) and holds it there, where a 200k one at 170k is past its 160k ceiling and is woken mechanically', async () => {
    const f = await begin({ env: unset });
    await spawn(f, 'b1b1b1b1b1');
    await spawn(f, 'c2c2c2c2c2');
    await step(f, 170_000, 'b1b1b1b1b1', 'claude-haiku-4-5');
    const grown = async (tokens: number) => (await step(f, tokens, 'c2c2c2c2c2', 'claude-opus-5-5[1m]'), ((await read(f, `tu-${tokens}`, 'c2c2c2c2c2')).context ?? []).join('\n'));
    expect([await grown(40_000), await grown(164_999)]).toEqual(['', '']);
    expect(await grown(165_000)).toMatch(/^forward-compaction: context 165k and increasing\. /);
    expect(await grown(229_999)).toBe('');
    expect(await grown(230_000)).toMatch(/^forward-compaction: context 230k, and every request re-sends all of it\. /);
    expect(await ask(f, 'b1b1b1b1b1')).toHaveProperty('messages');
    expect(await ask(f, 'c2c2c2c2c2')).toHaveProperty('skip');
  });

  it("measures a sub-agent on main's model id against main's 1M window: at 170k it is held, where one on a 200k model is woken mechanically", async () => {
    const f = await begin({ env: unset });
    await step(f, 40_000, undefined, 'claude-fable-5-2');
    await spawn(f, 'b1b1b1b1b1');
    await step(f, 170_000, 'b1b1b1b1b1', 'claude-fable-5-2');
    await spawn(f, 'c2c2c2c2c2');
    await step(f, 170_000, 'c2c2c2c2c2', 'claude-haiku-4-5');
    expect(await ask(f, 'b1b1b1b1b1')).toHaveProperty('skip');
    expect(await ask(f, 'c2c2c2c2c2')).toHaveProperty('messages');
  });
});

describe('M2 + M4: the wake carries the commands the party ran', () => {
  it("lists a sub-agent's Bash commands verbatim with their descriptions, newest first, never their output, and of the session's background tasks only those tied to it", async () => {
    const f = await begin();
    await spawn(f);
    await step(f, 64_000, A1);
    const bash = (id: string, command: string, description: string) => f.dispatch('tool.call', { tool: 'Bash', tool_use_id: id, agentId: A1, command, description }, async () => ({ result: 'OUTPUT-NEVER-CARRIED' }));
    await bash('tu-b1', 'npm run build', 'Build the plugin');
    await bash('tu-b2', "npx vitest run fixes.test.ts -t 'S6'", 'Run the S6 test');
    const tasks = [{ id: 'b7', type: 'shell', status: 'running', description: 'Sleep', command: 'sleep 1800' }, { id: 'b8', type: 'shell', status: 'running', description: 'Build the plugin', command: 'npm run build' }];
    await f.dispatch('classic.Stop', { background_tasks: tasks, session_crons: [{ id: 'c1', schedule: '0 9 * * *', recurring: true, prompt: 'check ci' }] }, async () => ({}));
    await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-h', agentId: A1, ...SECTIONS }, async () => ({ result: 'not ours' }));
    const messages = [
      { role: 'user', text: 'Brief for agent one', toolUses: [], handle: 'h0' },
      { role: 'assistant', text: 'storing', toolUses: [{ tool_use_id: 'tu-h', tool: FORWARD, input: SECTIONS }], handle: 'h1' },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'tu-h', text: 'Frontier stored' }], handle: 'h2' },
    ];
    const wake = fromFacts(await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages }, async () => ({ skip: 'native ran' })))[0]!.text;
    expect(wake).toContain("## Shell commands you ran, newest first\n### Run the S6 test\nnpx vitest run fixes.test.ts -t 'S6'\n### Build the plugin\nnpm run build");
    expect(wake).not.toContain('OUTPUT-NEVER-CARRIED');
    expect(wake).toContain('## Background shells and agents you started (from the Stop event 0s before install)\n- shell b8 running: npm run build\n(not listed: 2 other background tasks or crons of this session, not recorded as yours)');
    expect(wake).not.toContain('sleep 1800');
  });
});

describe("a sub-agent's own stop: it is no longer running", () => {
  it("leaves the stopping sub-agent out of the shells its SubagentStop lists, keeping every other task", async () => {
    const f = await begin();
    await spawn(f);
    await step(f, 64_000);
    const tasks = [
      { id: A1, type: 'subagent', status: 'running', description: 'List hook events' },
      { id: 'b7', type: 'local_bash', status: 'running', command: 'sleep 1800' },
    ];
    await f.dispatch('classic.SubagentStop', { agent_id: A1, background_tasks: tasks }, async () => ({}));
    await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-m', ...SECTIONS }, async () => ({ result: 'not ours' }));
    const messages = [
      { role: 'user', text: 'go', toolUses: [], handle: 'h0' },
      { role: 'assistant', text: 'storing', toolUses: [{ tool_use_id: 'tu-m', tool: FORWARD, input: SECTIONS }], handle: 'h1' },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'tu-m', text: 'Frontier stored' }], handle: 'h2' },
    ];
    const wake = (await f.dispatch('session.compact', { trigger: 'auto', messages }, async () => ({ skip: 'native ran' }))).messages[0].text;
    expect(wake).toContain('- local_bash b7 running: sleep 1800');
    expect(wake).not.toContain(`subagent ${A1} running`);
  });
});

describe('a background shell started after the last Stop snapshot', () => {
  it('is named in the shells heading as left out of the list, never read as none running', async () => {
    const f = await begin();
    await spawn(f);
    await step(f, 64_000);
    await f.dispatch('classic.SubagentStop', { agent_id: A1, background_tasks: [] }, async () => ({}));
    f.advance(30_000);
    await f.dispatch('tool.call', { tool: 'Bash', tool_use_id: 'tu-s', command: 'sleep 900', description: 'Sleep', run_in_background: true }, async () => ({ result: 'Command running in background with ID: bz1' }));
    await f.dispatch('tool.call', { tool: 'Bash', tool_use_id: 'tu-l', command: 'ls', description: 'List' }, async () => ({ result: 'a' }));
    await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-m', ...SECTIONS }, async () => ({ result: 'not ours' }));
    const messages = [
      { role: 'user', text: 'go', toolUses: [], handle: 'h0' },
      { role: 'assistant', text: 'storing', toolUses: [{ tool_use_id: 'tu-m', tool: FORWARD, input: SECTIONS }], handle: 'h1' },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'tu-m', text: 'Frontier stored' }], handle: 'h2' },
    ];
    const wake = (await f.dispatch('session.compact', { trigger: 'auto', messages }, async () => ({ skip: 'native ran' }))).messages[0].text;
    expect(wake).toContain('## Background shells and crons (session-wide, from the Stop event 30s before install; 1 background command started since is not in this list)\n(none running)');
  });
});

describe('S (brief 45k): a resumed sub-agent keeps its brief', () => {
  it("records the resuming message as a delivered message, never as the agent's brief", async () => {
    const f = await begin();
    await spawn(f);
    await step(f, 64_000, A1);
    await f.dispatch('agent.spawn', { tool_use_id: 'tu-resume', prompt: 'Continue with item 2', description: 'one', subagentType: 'general-purpose', provider: { kind: 'local' }, resume: { agentId: A1 } }, async () => ({ model: 'sonnet', agentId: A1 }));
    await f.dispatch('turn.start', { text: 'Continue with item 2', turnId: 't2', agentId: A1 }, async () => ({})); // the resumed run begins with the same message
    await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-h', agentId: A1, ...SECTIONS }, async () => ({ result: 'not ours' }));
    const messages = [
      { role: 'user', text: 'Brief for agent one', toolUses: [], handle: 'h0' },
      { role: 'assistant', text: 'storing', toolUses: [{ tool_use_id: 'tu-h', tool: FORWARD, input: SECTIONS }], handle: 'h1' },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'tu-h', text: 'Frontier stored' }], handle: 'h2' },
    ];
    const wake = (await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: messages.slice(1) }, async () => ({ skip: 'native ran' }))).messages[0].text;
    expect(wake).toContain('## Your brief\nBrief for agent one');
    expect(wake).toMatch(/## Messages delivered to you\n### \S+ \(resume\)\nContinue with item 2/);
    expect(wake.split('Continue with item 2').length - 1).toBe(1);
  });
});

/** The level rows of `file` written this session, read once session.end has flushed them. */
async function levels(f: Fake, file: 'errors.jsonl' | 'warnings.jsonl'): Promise<Record<string, unknown>[]> {
  await rows(f);
  const path = join(f.home, '.local/state/forward-compaction/logs', file);
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
const turnEnd = (f: Fake) => f.dispatch('turn.complete', { reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' }, async () => ({ text: 'done' }));

describe('L7: a rejected turn-end install is an error', () => {
  it('logs turn-end-rejected at error, says it on screen, and keeps the frontier for the next door', async () => {
    const f = await begin({ compact: () => Promise.reject(new Error('$.session.compact: a turn is running (t2)')) });
    await step(f, 64_000);
    await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-h', ...SECTIONS }, async () => ({ result: 'not ours' }));
    await turnEnd(f);
    expect(f.texts()).toContain("main's frontier did not install at turn end: $.session.compact: a turn is running (t2). It stays stored for the next turn end or ask.");
    expect((await levels(f, 'errors.jsonl')).filter((r) => r.event === 'turn-end-rejected').map((r) => r.where)).toEqual(['hooks/forward-compaction.ts#turnEnds']);
  });
});

describe('a turn-end install marks only the turn it ends', () => {
  it("installs the next turn's frontier at that turn's end", async () => {
    const call = (id: string) => [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: FORWARD, input: SECTIONS }], handle: `${id}-1` }, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'Frontier stored' }], handle: `${id}-2` }];
    let messages = call('tu-1');
    const f: Fake = await begin({ compact: () => f.dispatch('session.compact', { trigger: 'plugin', messages }, async () => ({ skip: 'native ran' })) });
    await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-1', ...SECTIONS }, async () => ({ result: 'not ours' }));
    await turnEnd(f);
    await f.dispatch('turn.start', { text: 'Part 3', turnId: 't2' }, async () => ({}));
    await step(f, 20_000); await step(f, 20_000); await step(f, 50_000); // the woken main, back at its notice point: the 30k start above its 20k floor
    messages = call('tu-2');
    await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-2', ...SECTIONS }, async () => ({ result: 'not ours' }));
    await turnEnd(f);
    expect((await rows(f)).filter((r) => r.event === 'compact').map((r) => `${r.trigger}:${r.decision}`)).toEqual(['plugin:install', 'plugin:install']);
  });
});

describe('L8 + L9: one row per registration failure, and every error and warning row names its origin', () => {
  it('writes one error row and one screen line per tool that failed to register, each with its raising function and a specific event', async () => {
    const f = await begin({ registerError: 'no tools in this session', breakdown: { rawMaxTokens: 1_000_000, autocompactSource: 'model-default', autoCompactThreshold: 967_000 } });
    expect(f.texts().filter((line) => line.includes('registering the'))).toHaveLength(2);
    const errors = await levels(f, 'errors.jsonl');
    const warnings = await levels(f, 'warnings.jsonl');
    expect(errors.filter((r) => String(r.msg).includes('registering the')).map((r) => [r.event, r.where])).toEqual([
      ['tool-register-failed', 'hooks/forward-compaction.ts#registerTool'], ['tool-register-failed', 'hooks/forward-compaction.ts#registerTool'],
    ]);
    expect(warnings.map((r) => [r.event, r.where])).toContainEqual(['compact-window', 'hooks/forward-compaction.ts#sessionBegins']);
    expect([...errors, ...warnings].filter((r) => r.event === 'error' || r.event === 'warning' || r.where === 'hooks/forward-compaction.ts#record')).toEqual([]);
  });

  it('tries a failed registration again on a later hook once its wait is over, past REGISTER_TRIES, so the tool comes back', async () => {
    let failing = true;
    const f = await begin({ registerError: () => (failing ? 'no tools yet' : undefined) });
    const call = () => f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-r', ...SECTIONS }, async () => ({ result: 'not ours' }));
    const turn = () => f.dispatch('turn.start', { text: '', turnId: 't1' }, async () => ({}));
    for (let i = 0; i < 3; i++) await turn();
    failing = false;
    await turn();
    expect((await call()).result).toBe('not ours');
    f.advance(30_000);
    await turn();
    expect((await call()).result.split('\n')[6]).toMatch(/^Frontier stored\. /);
  });
});

describe('a call before the notice point only updates the frontier', () => {
  const UPDATED = 'Frontier updated. Nothing compacts: your context is still too small for a compaction to pay, and stays as it is. Carry on; a forward-compaction notice asks for the call once it has grown enough.';
  it('after a wake a call made before the context has grown again only updates the frontier: the receipt says so, the next ask and the turn end compact nothing, and a call from the notice point on (the 30k start above the settled floor: 71k after 20k and 41k) compacts', async () => {
    const f = await begin();
    const ask = (id: string) => f.dispatch('session.compact', { trigger: 'auto', messages: transcript(id) }, async () => ({ skip: 'native ran' }));
    const answer = (turnId: string) => f.dispatch('turn.complete', { reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId }, async () => ({ text: 'done' }));
    const read = (id: string) => f.dispatch('tool.call', { tool: 'Read', tool_use_id: id, file_path: '/x' }, async () => ({ result: 'file' }));
    const receiptOf = async (id: string) => (await store(f, undefined, id)).result.split('\n').find((line: string) => line.startsWith('Frontier stored') || line.startsWith('Frontier updated'));
    const AGAIN = ' This call applied on top of your earlier one since the last wake.';
    await step(f, 64_000);
    await store(f);
    expect(await ask('tu-h')).toHaveProperty('messages');
    await answer('t1');
    await step(f, 20_000); // the first request after the wake
    await step(f, 41_000); // the second, Claude Code's listings sent again: the floor
    expect(await receiptOf('tu-2')).toBe(UPDATED);
    expect(await ask('tu-2')).toEqual({ skip: "forward-compaction: holding Claude Code's compaction for main until its frontier is stored or the ceiling is reached" });
    await answer('t2');
    expect(f.compactCalls).toEqual([]);
    await step(f, 70_999);
    expect((await read('tu-r1')).context ?? []).toEqual([]);
    expect(await receiptOf('tu-3')).toBe(`${UPDATED}${AGAIN}`);
    await step(f, 71_000);
    expect((await read('tu-r2')).context?.at(-1)).toContain('forward-compaction: context 71k and increasing.');
    expect(await receiptOf('tu-4')).toBe(`Frontier stored. It installs before your next request, inside this turn: what you have read is gone then, and the rest of the turn, your reply to the user included, is written from the frontier. The newest messages after this call that fit are kept verbatim behind it, the rest named as not carried.${AGAIN}`);
    await answer('t3');
    expect(f.compactCalls).toEqual([[]]);
    const r = await rows(f);
    expect(r.filter((row) => row.event === 'stored').map((row) => [row.tokens, row.compacts])).toEqual([[64_000, true], [41_000, false], [70_999, false], [71_000, true]]);
    expect(r.filter((row) => row.event === 'compact').map((row) => [row.decision, row.why])).toEqual([['install', 'stored'], ['skip', 'waiting']]);
  });

  it.each([
    ['the first request after a wake', true, [[64_000, true], [20_000, false]]],
    ['the first request of a chat', false, [[20_000, false]]],
  ])('a call in %s, whose request Claude Code measures while the call is being answered, is judged by that reading and only updates the frontier', async (_name, woken, stored) => {
    const f = await begin();
    if (woken) {
      await step(f, 64_000);
      await store(f);
      expect(await f.dispatch('session.compact', { trigger: 'auto', messages: transcript('tu-h') }, async () => ({ skip: 'native ran' }))).toHaveProperty('messages');
    }
    const [called] = await Promise.all([store(f, undefined, 'tu-2'), step(f, 20_000)]);
    expect(called.result.split('\n').find((line: string) => line.startsWith('Frontier '))).toBe(UPDATED);
    expect((await rows(f)).filter((row) => row.event === 'stored').map((row) => [row.tokens, row.compacts])).toEqual(stored);
  });

  it.each([
    ['of a type FORWARD_COMPACTION_SUBAGENT_CALL_COMPACTS names compacts', 'flights:lander', true],
    ['of any other type only updates the frontier', 'general-purpose', false],
  ])("a sub-agent's call under its nudge start, %s", async (_name, subagentType, compacts) => {
    const f = await begin({ env: { FORWARD_COMPACTION_SUBAGENT_CALL_COMPACTS: 'Explore, flights:lander', FORWARD_COMPACTION_SUBAGENT_NUDGE_START: '100000' } });
    await spawn(f, A1, 'Brief for agent one', subagentType);
    await step(f, 20_000, A1);
    await step(f, 80_000, A1);
    expect((await store(f, A1)).result.split('\n').find((line: string) => line.startsWith('Frontier '))).toBe(compacts ? "Frontier stored. It installs at Claude Code's next compaction ask, before your next request. The newest messages after this call that fit are kept verbatim behind it, the rest named as not carried." : UPDATED);
    expect('messages' in (await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: transcript('tu-h') }, async () => ({ skip: 'native ran' })))).toBe(compacts);
    expect((await rows(f)).filter((row) => row.event === 'stored').map((row) => [row.party, row.tokens, row.compacts])).toEqual([[`agent:${A1}`, 80_000, compacts]]);
  });
});
