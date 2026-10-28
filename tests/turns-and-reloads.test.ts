import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeEngine, usage, type Script } from './fakes/engine.ts';

// The adapter's wiring of session-lifetime facts: a new turn ends the request-too-long inference (D8), the person's
// messages outlive a plugin reload through the host's session state, finished tool calls record the party's work, and a
// sub-agent far past its nudges has every call run, unrefused.

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
const WAITING = { skip: "forward-compaction: holding Claude Code's compaction for main until its frontier is stored or the ceiling is reached" };

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

describe('the prompts across a plugin reload', () => {
  it('carries the messages typed before a reload into the wake after it', async () => {
    const state = new Map<string, { value: unknown; version: number }>();
    const before = await begin({ state });
    await before.dispatch('prompt.submit', { text: 'typed before the reload', origin: { kind: 'composer' } }, async () => ({}));
    const after = await begin({ state });
    await after.dispatch('prompt.submit', { text: 'typed after the reload', origin: { kind: 'composer' } }, async () => ({}));
    await step(after, 125_000);
    const r = await ask(after);
    expect(r.messages[0].text).toContain("## The person's messages, oldest first (2 of 2)\n### ");
    expect(r.messages[0].text.indexOf('typed before the reload')).toBeLessThan(r.messages[0].text.indexOf('typed after the reload'));
    expect(r.messages[0].text.indexOf('typed before the reload')).toBeGreaterThan(-1);
  });

  it("carries a sub-agent's brief and its coordinator's messages from before a reload into its wake", async () => {
    const state = new Map<string, { value: unknown; version: number }>();
    const before = await begin({ state });
    await before.dispatch('agent.spawn', { tool_use_id: 'tu-spawn', prompt: 'Brief for agent one', description: 'one', subagentType: 'general-purpose', provider: { kind: 'local' } }, async () => ({ model: 'sonnet', agentId: 'a1b2c3d4e5' }));
    await before.dispatch('session.receive', { agentId: 'a1b2c3d4e5', origin: { kind: 'coordinator' }, text: 'also check the docs' }, async () => ({}));
    const after = await begin({ state, agents: () => [{ id: 'a1b2c3d4e5', type: 'general-purpose', status: 'running', description: 'one' }] });
    await after.dispatch('turn.step', { turnId: 't1', index: 0, model: 'claude-sonnet-4-5', messageCount: 4, agentId: 'a1b2c3d4e5' }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(170_000) }));
    const r = await after.dispatch('session.compact', { trigger: 'auto', agentId: 'a1b2c3d4e5', messages }, async () => ({ skip: 'native ran' }));
    expect(r.messages[0].text).toContain('## Your brief\nBrief for agent one');
    expect(r.messages[0].text).toContain('also check the docs');
  });
});

describe('the skills across a plugin reload', () => {
  it("carries main's skills loaded before a reload into the wake after it, one loaded since winning", async () => {
    const state = new Map<string, { value: unknown; version: number }>();
    const before = await begin({ state });
    for (const [skill, text] of [['god-speed', 'GOD SPEED BODY'], ['ponytail', 'OLD PONYTAIL']]) {
      await before.dispatch('tool.call', { tool: 'Skill', tool_use_id: `tu-${skill}`, skill }, async () => {
        await before.dispatch('skill.prompt', { skill, text, frontmatter: {} }, async () => ({ text }));
        return { result: 'loaded' };
      });
    }
    const after = await begin({ state });
    await after.dispatch('tool.call', { tool: 'Skill', tool_use_id: 'tu-p2', skill: 'ponytail' }, async () => {
      await after.dispatch('skill.prompt', { skill: 'ponytail', text: 'NEW PONYTAIL', frontmatter: {} }, async () => ({ text: 'NEW PONYTAIL' }));
      return { result: 'loaded' };
    });
    await step(after, 125_000);
    const facts = (await ask(after)).messages[0].text;
    expect(facts).toContain('## Skills in force, as loaded');
    expect(facts).toContain('GOD SPEED BODY');
    expect(facts).toContain('NEW PONYTAIL');
    expect(facts).not.toContain('OLD PONYTAIL');
  });
});

describe("the party's work, from its finished tool calls", () => {
  it('lists the files and tasks of the calls that finished, never a denied one', async () => {
    const f = await begin();
    await f.dispatch('tool.call', { tool: 'Read', tool_use_id: 'r1', file_path: '/w/read.ts' }, async () => ({ result: {}, text: 'body' }));
    await f.dispatch('tool.call', { tool: 'Edit', tool_use_id: 'e1', file_path: '/w/edited.ts' }, async () => ({ result: {}, text: 'ok' }));
    await f.dispatch('tool.call', { tool: 'Write', tool_use_id: 'w1', file_path: '/w/denied.ts' }, async () => ({ deny: 'not allowed' }));
    await f.dispatch('tool.call', { tool: 'TodoWrite', tool_use_id: 't1', todos: [{ content: 'ship', status: 'in_progress' }] }, async () => ({ result: {}, text: 'ok' }));
    await step(f, 125_000);
    const facts = (await ask(f)).messages[0].text;
    expect(facts).toContain('## Files touched, newest first (R read, E edited, W written)\nE /w/edited.ts\nR /w/read.ts');
    expect(facts).toContain('## Tasks, as last set\n[~] ship');
    expect(facts).not.toContain('/w/denied.ts');
  });
});

describe('a sub-agent far past its nudges', () => {
  const A = 'a1b2c3d4e5';
  const agentStep = (f: Fake, tokens: number) => f.dispatch('turn.step', { turnId: 't1', index: 0, model: 'claude-sonnet-4-5', messageCount: 4, agentId: A }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(tokens) }));
  const write = (f: Fake) => f.dispatch('tool.call', { tool: 'Write', tool_use_id: 'w', file_path: '/w/a.ts', content: 'x', agentId: A }, async () => ({ result: {}, text: 'body' }));

  it('has every call run, below its ceiling, and no nudge says any call waits', async () => {
    const f = await begin();
    await f.dispatch('agent.spawn', { tool_use_id: 'tu-spawn', prompt: 'Brief', description: 'one', subagentType: 'general-purpose', provider: { kind: 'local' } }, async () => ({ model: 'sonnet', agentId: A }));
    const nudges: string[] = [];
    for (const tokens of [85_000, 105_000, 125_000, 150_000]) {
      await agentStep(f, tokens);
      const r = await write(f);
      expect(r).toMatchObject({ text: 'body' });
      expect(r.deny).toBeUndefined();
      nudges.push(...(r.context ?? []).map(String));
    }
    expect(nudges.length).toBeGreaterThan(1);
    for (const n of nudges) expect(n).not.toMatch(/your other calls wait|did not run/);
  });
});

describe("the person's answers to AskUserQuestion", () => {
  it("records main's answered questions as the person's words and carries each into the wake beside the ten newest typed", async () => {
    const f = await begin();
    const questions = [{ question: 'What should notes and guidance show?', header: 'Quotes', options: [], multiSelect: false }];
    const result = { questions, answers: { 'What should notes and guidance show?': 'Quote if verbatim, else segment' }, annotations: {} };
    await f.dispatch('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'tu-q1', questions }, async () => ({ result }));
    for (let i = 0; i < 11; i++) await f.dispatch('prompt.submit', { text: `typed ${i}.`, origin: { kind: 'composer' } }, async () => ({}));
    await step(f, 125_000);
    const text = (await ask(f)).messages[0].text;
    expect(text).toContain("## The person's messages, oldest first (11 of 12, 1 of them answering your questions; the 1 oldest are not carried: look_back finds them)");
    expect(text).toMatch(/### \S+ \(the person answering your question\)\nWhat should notes and guidance show\?\nAnswer: Quote if verbatim, else segment\n/);
    expect(text).not.toContain('typed 0.');
    expect(text).toContain('typed 10.');
  });
});
