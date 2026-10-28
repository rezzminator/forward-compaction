import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeEngine, usage } from './fakes/engine.ts';

// A sub-agent's runs: one waiting on its background children ends a turn and is resumed by each child's notification,
// so its party outlives a turn end. And what reaches a party between its forward_compaction call and the install opens the wake.

const FORWARD = 'mcp__forward-compaction__forward_compaction';
const SECTIONS = { objective: 'Ship U5.', done: 'The fake.', remaining: 'The adapter.', next: 'Wire session.compact.' };
const A1 = 'a1b2c3d4e5';

type Fake = ReturnType<typeof fakeEngine>;
const fakes: Fake[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) {
    expect(f.unscripted, 'every $ call the plugin made was scripted').toEqual([]);
    f.cleanup();
  }
});

/** Main held where 60%, 15% and 5% of 200k fall on a 1M window; sub-agents on their defaults (200k max context, nudges from 80k every 20k, ceiling 160k). */
async function begin(): Promise<Fake> {
  const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', FORWARD_COMPACTION_MAIN_CEILING: '120000', FORWARD_COMPACTION_MAIN_NUDGE_START: '30000', FORWARD_COMPACTION_MAIN_NUDGE_EVERY: '10000' };
  const f = fakeEngine({ window: 1_000_000, env });
  fakes.push(f);
  await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
  return f;
}

const step = (f: Fake, tokens: number, agentId?: string) =>
  f.dispatch('turn.step', { turnId: 't1', index: 0, model: 'claude-sonnet-4-5', messageCount: 4, ...(agentId ? { agentId } : {}) }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(tokens) }));
const spawn = (f: Fake) =>
  f.dispatch('agent.spawn', { tool_use_id: 'tu-spawn', prompt: 'Brief for agent one', description: 'one', subagentType: 'general-purpose', provider: { kind: 'local' } }, async () => ({ model: 'sonnet', agentId: A1 }));
const store = (f: Fake, agentId?: string) =>
  f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-h', ...(agentId ? { agentId } : {}), ...SECTIONS }, async () => ({ result: 'not ours' }));
const read = (f: Fake, id: string, agentId?: string) => f.dispatch('tool.call', { tool: 'Read', tool_use_id: id, file_path: '/x', ...(agentId ? { agentId } : {}) }, async () => ({ result: 'file' }));

/** A transcript holding the forward_compaction call, its result, and two messages after it. */
function transcript() {
  return [
    { role: 'user', text: 'Brief for agent one', toolUses: [], handle: 'h0' },
    { role: 'assistant', text: `storing ${'p'.repeat(200_000)}`, toolUses: [{ tool_use_id: 'tu-h', tool: FORWARD, input: SECTIONS }], handle: 'h1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'tu-h', text: 'Frontier stored' }], handle: 'h2' },
    { role: 'assistant', text: 'reading on after the frontier', toolUses: [], handle: 'h3' },
    { role: 'user', text: 'a later note', toolUses: [], handle: 'h4' },
  ];
}

/** The decision rows written this session, read once session.end has flushed them. */
async function rows(f: Fake): Promise<Record<string, unknown>[]> {
  await f.dispatch('session.end', { reason: 'other' }, async () => ({}));
  const dir = join(f.home, '.local/state/forward-compaction/logs/decisions');
  return readdirSync(dir).filter((n) => n.endsWith('.jsonl')).flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

describe("a sub-agent's runs, and what arrives between a frontier and its install", () => {
  // A sub-agent waiting on its background children ends a run and is resumed by each child's notification: one request a run.
  const run = async (f: Fake, body: () => Promise<unknown>) => {
    await f.dispatch('turn.start', { text: '', turnId: 't1', agentId: A1 }, async () => ({}));
    const out = await body();
    await f.dispatch('turn.complete', { reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1', agentId: A1 }, async () => ({ text: '' }));
    return out;
  };
  const ask = (f: Fake) => f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: transcript() }, async () => ({ skip: 'native ran' }));

  it("keeps a sub-agent's nudges and reading across its runs, and gives it the mechanical wake at the next run's ask past its ceiling", async () => {
    const f = await begin();
    await spawn(f);
    const levels: number[] = [];
    for (const tokens of [80_000, 100_000, 120_000, 140_000]) {
      const r = (await run(f, async () => (await step(f, tokens, A1), read(f, `tu-${tokens}`, A1)))) as { context?: unknown[]; deny?: string };
      expect(r.deny).toBeUndefined();
      if ((r.context ?? []).length > 0) levels.push(tokens);
    }
    expect(levels).toEqual([80_000, 100_000, 120_000, 140_000]);
    await run(f, () => step(f, 160_000, A1));
    expect(((await run(f, () => ask(f))) as { messages: { text: string }[] }).messages[1]?.text).toMatch(/past the 160k ceiling/);
  });

  it("installs a sub-agent's frontier stored in one run at an ask in its next run", async () => {
    const f = await begin();
    await spawn(f);
    await run(f, async () => (await step(f, 90_000, A1), store(f, A1)));
    expect(await run(f, () => ask(f))).toHaveProperty('messages');
    expect((await rows(f)).filter((row) => row.event === 'compact').map((row) => row.decision)).toEqual(['install']);
  });

  const ARRIVED = '## Arrived after you wrote your frontier: you have not read these yet';
  const wakeText = (r: unknown): string => ((r as { messages: { text: string }[] }).messages ?? []).map((m) => m.text).join('\n');

  it('carries what woke a sub-agent between its frontier and the install, which the compacted messages lack, into its wake', async () => {
    const f = await begin();
    await spawn(f);
    await run(f, async () => (await step(f, 90_000, A1), store(f, A1)));
    await f.dispatch('turn.start', { text: '<task-notification>digger 7 done: 42 offices</task-notification>', turnId: 't2', agentId: A1 }, async () => ({}));
    const text = wakeText(await ask(f));
    expect(text).toContain(ARRIVED);
    expect(text).toMatch(/\(run-start\)\n<task-notification>digger 7 done: 42 offices<\/task-notification>/);
  });

  it("carries main's notification and the person's message that arrived between its frontier and the install, and only those, into the wake", async () => {
    const f = await begin();
    await f.dispatch('prompt.submit', { text: '<task-notification>old agent done</task-notification>', origin: { kind: 'task-notification' } }, async () => ({}));
    await step(f, 30_000);
    await store(f);
    await f.dispatch('prompt.submit', { text: '<task-notification>gitter done: abc123</task-notification>', origin: { kind: 'task-notification' }, turnId: 't1' }, async () => ({}));
    await f.dispatch('prompt.submit', { text: 'and also check the logs', origin: { kind: 'composer' }, turnId: 't1' }, async () => ({}));
    const text = wakeText(await f.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' })));
    const from = text.indexOf(ARRIVED);
    const arrived = text.slice(from, text.indexOf('\n## ', from + 1));
    expect(text).toContain(ARRIVED);
    expect(arrived).toMatch(/\(task-notification\)\n<task-notification>gitter done: abc123<\/task-notification>/);
    expect(arrived).toMatch(/\(person\)\nand also check the logs/);
    expect(arrived).not.toContain('old agent done');
    expect(text).toMatch(/## Notifications delivered to you\n### [^\n]+ \(task-notification\)\n<task-notification>old agent done/);
  });
});
