// A fake session as tests/adapter.test.ts drives one, for the adapter-level tests kept in their own files.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { fakeEngine, usage, type Script } from './engine.ts';

export const FORWARD = 'mcp__forward-compaction__forward_compaction';
export const SECTIONS = { objective: 'Ship U5.', next: 'Wire session.compact.', done: { add: ['The fake.'] }, remaining: { add: ['The adapter.'] } };
export const A1 = 'a1b2c3d4e5';

export type Fake = ReturnType<typeof fakeEngine>;
const fakes: Fake[] = [];
/** For `afterEach`: every $ call the plugin made was scripted, and each fake's home is removed. */
export function cleanup(): void {
  for (const f of fakes.splice(0)) {
    expect(f.unscripted, 'every $ call the plugin made was scripted').toEqual([]);
    f.cleanup();
  }
}

/** A session on a 1M main window and a 1M sub-agent max context, ceilings at 120k, nudges from 30k every 10k; Claude Code asks at 63k. */
export async function begin(script: Script = {}): Promise<Fake> {
  const sizes = (party: string) => ({ [`FORWARD_COMPACTION_${party}_CEILING`]: '120000', [`FORWARD_COMPACTION_${party}_NUDGE_START`]: '30000', [`FORWARD_COMPACTION_${party}_NUDGE_EVERY`]: '10000' });
  const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT: '1m', ...sizes('MAIN'), ...sizes('SUBAGENT') };
  const f = fakeEngine({ window: 1_000_000, ...script, env: { ...env, ...script.env } });
  fakes.push(f);
  await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
  return f;
}

export const step = (f: Fake, tokens: number, agentId?: string) =>
  f.dispatch('turn.step', { turnId: 't1', index: 0, model: 'claude-sonnet-4-5', messageCount: 4, ...(agentId ? { agentId } : {}) }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(tokens) }));

export const spawn = (f: Fake, agentId = A1, prompt = 'Brief for agent one') =>
  f.dispatch('agent.spawn', { tool_use_id: 'tu-spawn', prompt, description: 'one', subagentType: 'general-purpose', provider: { kind: 'local' } }, async () => ({ model: 'sonnet', agentId }));

export const store = (f: Fake, agentId?: string, id = 'tu-h') =>
  f.dispatch('tool.call', { tool: FORWARD, tool_use_id: id, ...(agentId ? { agentId } : {}), ...SECTIONS }, async () => ({ result: 'not ours' }));

/** A transcript holding the forward_compaction call `id`, its result, and two messages after it. */
export function transcript(id = 'tu-h') {
  return [
    { role: 'user', text: 'Brief for agent one', toolUses: [], handle: 'h0' },
    { role: 'assistant', text: 'storing', toolUses: [{ tool_use_id: id, tool: FORWARD, input: SECTIONS }], handle: 'h1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'Frontier stored' }], handle: 'h2' },
    { role: 'assistant', text: 'reading on after the frontier', toolUses: [], handle: 'h3' },
    { role: 'user', text: 'a later note', toolUses: [], handle: 'h4' },
  ];
}

/** The decision rows written this session, read once session.end has flushed them. */
export async function rows(f: Fake): Promise<Record<string, unknown>[]> {
  await f.dispatch('session.end', { reason: 'other' }, async () => ({}));
  const dir = join(f.home, '.local/state/forward-compaction/logs/decisions');
  return readdirSync(dir).filter((n) => n.endsWith('.jsonl')).flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

/** The level file `name` (errors, warnings, info) of this session, once session.end has flushed it. */
export async function level(f: Fake, name: string): Promise<Record<string, unknown>[]> {
  await rows(f);
  const path = join(f.home, `.local/state/forward-compaction/logs/${name}.jsonl`);
  for (let i = 0; i < 50 && !existsSync(path); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
/** The msg of each `event` row in the level file `name`. */
export const logged = async (f: Fake, name: string, event: string): Promise<unknown[]> => (await level(f, name)).filter((r) => r.event === event).map((r) => r.msg);
