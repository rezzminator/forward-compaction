import { afterEach, describe, expect, it } from 'vitest';
import { fakeEngine, usage, type Script } from './fakes/engine.ts';

// The adapter's wiring of two session-lifetime facts: a new turn ends the request-too-long inference (D8), and the
// person's messages outlive a plugin reload through the host's session state.

type Fake = ReturnType<typeof fakeEngine>;
const fakes: Fake[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) {
    expect(f.unscripted, 'every $ call the plugin made was scripted').toEqual([]);
    f.cleanup();
  }
});

async function begin(script: Script = {}): Promise<Fake> {
  const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', FORWARD_COMPACTION_MAIN_CEILING: '120000', FORWARD_COMPACTION_MAIN_NUDGE_START: '30000', FORWARD_COMPACTION_MAIN_NUDGE_EVERY: '10000' };
  const f = fakeEngine({ window: 1_000_000, ...script, env });
  fakes.push(f);
  await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
  return f;
}

const step = (f: Fake, tokens: number) =>
  f.dispatch('turn.step', { turnId: 't1', index: 0, model: 'claude-sonnet-4-5', messageCount: 4 }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(tokens) }));
const messages = [
  { role: 'user', text: 'start', toolUses: [], handle: 'h0' },
  { role: 'assistant', text: 'working', toolUses: [], handle: 'h1' },
];
const ask = (f: Fake) => f.dispatch('session.compact', { trigger: 'auto', messages }, async () => ({ skip: 'native ran' }));
const WAITING = { skip: "forward-compaction: holding Claude Code's compaction for main until its handoff is stored or the ceiling is reached" };

describe('a request too long (D8)', () => {
  it('reads a second held ask with no step between as too long inside a turn, but not across a new turn', async () => {
    const f = await begin();
    await step(f, 110_000);
    expect(await ask(f)).toEqual(WAITING);
    await f.dispatch('turn.start', { text: '', turnId: 't2' }, async () => ({}));
    expect(await ask(f)).toEqual(WAITING);
    const r = await ask(f); // the same turn, no step between: too long, so the mechanical wake
    expect(r.messages[1].text).toMatch(/^\[forward-compaction: no frontier written by the model\].*Claude Code reported your request too long/);
  });
});

describe("the person's messages across a plugin reload", () => {
  it('carries the messages typed before a reload into the wake after it', async () => {
    const state = new Map<string, { value: unknown; version: number }>();
    const before = await begin({ state });
    await before.dispatch('prompt.submit', { text: 'typed before the reload', origin: { kind: 'composer' } }, async () => ({}));
    const after = await begin({ state });
    await step(after, 125_000);
    const r = await ask(after);
    expect(r.messages[0].text).toContain("## The person's messages, oldest first (1 of 1)\n### ");
    expect(r.messages[0].text).toContain('typed before the reload');
  });
});
