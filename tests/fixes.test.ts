import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeEngine, usage, type Script } from './fakes/engine.ts';

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
const SECTIONS = { objective: 'Fix the audit.', decisions: 'none', done: 'Item 20.', remaining: 'Item 21.', next: 'Write its test.' };
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
const spawn = (f: Fake, agentId = A1, prompt = 'Brief for agent one') =>
  f.dispatch('agent.spawn', { tool_use_id: 'tu-spawn', prompt, description: 'one', subagentType: 'general-purpose', provider: { kind: 'local' } }, async () => ({ model: 'sonnet', agentId }));

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
  it('nudges a 200k sub-agent at 100k (past its 80k start) and leaves a [1m] one at 100k alone (its start is 400k)', async () => {
    const f = await begin({ env: unset });
    await spawn(f, 'b1b1b1b1b1');
    await step(f, 100_000, 'b1b1b1b1b1', 'claude-sonnet-5-5');
    expect(((await read(f, 'tu-r1', 'b1b1b1b1b1')).context ?? []).join('\n')).toMatch(/context 100k /);
    await spawn(f, 'c2c2c2c2c2');
    await step(f, 100_000, 'c2c2c2c2c2', 'claude-opus-5-5[1m]');
    expect((await read(f, 'tu-r2', 'c2c2c2c2c2')).context ?? []).toEqual([]);
    await step(f, 400_000, 'c2c2c2c2c2', 'claude-opus-5-5[1m]');
    expect(((await read(f, 'tu-r3', 'c2c2c2c2c2')).context ?? []).join('\n')).toMatch(/context 400k /);
  });
});

describe('M2 + M4: the wake carries the commands the party ran', () => {
  it("lists a sub-agent's Bash commands verbatim with their descriptions, newest first, never their output", async () => {
    const f = await begin();
    await spawn(f);
    await step(f, 64_000, A1);
    const bash = (id: string, command: string, description: string) => f.dispatch('tool.call', { tool: 'Bash', tool_use_id: id, agentId: A1, command, description }, async () => ({ result: 'OUTPUT-NEVER-CARRIED' }));
    await bash('tu-b1', 'npm run build', 'Build the plugin');
    await bash('tu-b2', "npx vitest run fixes.test.ts -t 'S6'", 'Run the S6 test');
    await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-h', agentId: A1, ...SECTIONS }, async () => ({ result: 'not ours' }));
    const messages = [
      { role: 'user', text: 'Brief for agent one', toolUses: [], handle: 'h0' },
      { role: 'assistant', text: 'storing', toolUses: [{ tool_use_id: 'tu-h', tool: FORWARD, input: SECTIONS }], handle: 'h1' },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'tu-h', text: 'Frontier stored' }], handle: 'h2' },
    ];
    const wake = (await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages }, async () => ({ skip: 'native ran' }))).messages[0].text;
    expect(wake).toContain("## Shell commands you ran, newest first\n### Run the S6 test\nnpx vitest run fixes.test.ts -t 'S6'\n### Build the plugin\nnpm run build");
    expect(wake).not.toContain('OUTPUT-NEVER-CARRIED');
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

describe('S (brief 45k): a resumed sub-agent keeps its brief', () => {
  it("records the resuming message as a delivered message, never as the agent's brief", async () => {
    const f = await begin();
    await spawn(f);
    await step(f, 64_000, A1);
    await f.dispatch('agent.spawn', { tool_use_id: 'tu-resume', prompt: 'Continue with item 2', description: 'one', subagentType: 'general-purpose', provider: { kind: 'local' }, resume: { agentId: A1 } }, async () => ({ model: 'sonnet', agentId: A1 }));
    await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-h', agentId: A1, ...SECTIONS }, async () => ({ result: 'not ours' }));
    const messages = [
      { role: 'user', text: 'Brief for agent one', toolUses: [], handle: 'h0' },
      { role: 'assistant', text: 'storing', toolUses: [{ tool_use_id: 'tu-h', tool: FORWARD, input: SECTIONS }], handle: 'h1' },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'tu-h', text: 'Frontier stored' }], handle: 'h2' },
    ];
    const wake = (await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: messages.slice(1) }, async () => ({ skip: 'native ran' }))).messages[0].text;
    expect(wake).toContain('## Your brief\nBrief for agent one');
    expect(wake).toMatch(/## Messages delivered to you\n### \S+ \(resume\)\nContinue with item 2/);
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
});
