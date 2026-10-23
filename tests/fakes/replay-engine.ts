// The replay engine (spec § Tests, replay gate 5): a recording's hook invocations driven through the real `register`
// on the recorded timeline: each starts at its start row and its fake `next` is answered at its nextResult row, so the
// ones started meanwhile (a Skill call's skill.prompt, another party's steps) run inside it as they did live; every
// `$` call answered from that invocation's recorded calls. A call the recording lacks is
// `unrecorded $ call {path} in {hook} #{id}`: re-record. `#{id}` is the invocation's number, the recorder's `id`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { register } from '../../plugins/forward-compaction/hooks/forward-compaction.ts';
import type { Row } from '../../scripts/replay/recorder.ts';

type Fn = (...args: any[]) => any;
export type Outcome = { seq?: number; result?: any; error?: { message: string; code?: unknown } };
export type Call = { path: string; args: unknown[]; sync?: true } & Outcome;
export type Invocation = {
  id: number; hook: string; seq: number; endSeq: number; input: any; parent?: number;
  calls: Call[]; next?: { seq?: number; input: any }; nextResult?: Outcome; end?: Outcome;
};
export type Replay = { replayed: Invocation[]; unrecorded: string[] };

export function loadFixture(path: string): Row[] {
  const raw = readFileSync(path);
  const text = path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Row);
}

/** The recorded view: one entry per invocation, in start order, with its calls, next and end; nesting from the next windows. */
export function invocations(rows: readonly Row[]): Invocation[] {
  const byId = new Map<number, Invocation>();
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (row.phase === 'version') continue;
    if (row.phase === 'start') {
      byId.set(row.id, { id: row.id, hook: row.hook!, seq: row.seq, endSeq: Infinity, input: row.input, calls: [] });
      continue;
    }
    const inv = byId.get(row.id);
    if (!inv) throw new Error(`row ${row.seq}: invocation #${row.id} has no start row`);
    const outcome: Outcome = { seq: row.seq, ...('result' in row ? { result: row.result } : {}), ...(row.error !== undefined ? { error: row.error as Outcome['error'] } : {}) };
    if (row.phase === 'call') inv.calls.push({ path: row.path!, args: (row.args as unknown[]) ?? [], ...(row.sync ? { sync: true as const } : {}), ...outcome });
    else if (row.phase === 'next') inv.next = { seq: row.seq, input: row.input };
    else if (row.phase === 'nextResult') inv.nextResult = outcome;
    else if (row.phase === 'end') {
      inv.end = outcome;
      inv.endSeq = row.seq;
    }
  }
  const list = [...byId.values()].sort((a, b) => a.seq - b.seq);
  for (const inv of list) {
    // The innermost open next window around this start is its parent.
    const around = list.filter((p) => p !== inv && p.next?.seq !== undefined && p.next.seq < inv.seq && inv.seq < (p.nextResult?.seq ?? Infinity));
    const parent = around.sort((a, b) => b.next!.seq! - a.next!.seq!)[0];
    if (parent) inv.parent = parent.id;
  }
  return list;
}

const norm = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => (typeof v === 'function' ? '[function]' : v)) ?? 'undefined';
const failure = (error: NonNullable<Outcome['error']>): Error => Object.assign(new Error(error.message), error.code !== undefined ? { code: error.code } : {});
const isGenerator = (fn: unknown): boolean => typeof fn === 'function' && fn.constructor?.name === 'AsyncGeneratorFunction';

/** Replays a recording through the real plugin. Zero invocations is a failure, never a pass (Law 15). */
export async function replay(rows: readonly Row[]): Promise<Replay> {
  const recorded = invocations(rows);
  if (recorded.length === 0) throw new Error('replayed 0 invocations');
  const hooks = new Map<string, Fn>();
  register(((name: string, fn: Fn) => void hooks.set(name, fn)) as any, {} as any);
  const unrecorded: string[] = [];
  const replayed: Invocation[] = [];
  const signal = new AbortController().signal;

  function engine(rec: Invocation, out: Invocation): any {
    const pool = rec.calls.map((call) => ({ call, used: false }));
    const answer = (path: string, args: unknown[]): unknown => {
      const same = pool.filter((p) => !p.used && p.call.path === path);
      const hit = same.find((p) => norm(p.call.args) === norm(args)) ?? same[0];
      if (!hit) {
        const line = `unrecorded $ call ${path} in ${rec.hook} #${rec.id}`;
        unrecorded.push(line);
        out.calls.push({ path, args, error: { message: line } });
        throw new Error(line);
      }
      hit.used = true;
      const { call } = hit;
      out.calls.push({ path, args, ...(call.error ? { error: call.error } : { result: call.result }) });
      // shortcut: a timer never fires in replay; upgrade when a recorded hook's outcome depends on one firing.
      if (path === 'clock.after') return { cancel: () => undefined };
      if (call.sync) {
        if (call.error) throw failure(call.error);
        return call.result;
      }
      return call.error ? Promise.reject(failure(call.error)) : Promise.resolve(call.result);
    };
    const nouns = new Map<string, unknown>();
    return new Proxy({}, {
      get: (_t, noun) => {
        if (typeof noun === 'symbol' || noun === 'then') return undefined;
        if (!nouns.has(noun)) nouns.set(noun, new Proxy({}, { get: (_m, verb) => (typeof verb === 'symbol' || verb === 'then' ? undefined : (...args: unknown[]) => answer(`${noun}.${verb}`, args)) }));
        return nouns.get(noun);
      },
    });
  }

  /** One invocation in flight: its hook runs until it ends or awaits `next`, which the timeline answers at the recorded nextResult. */
  type Flight = { rec: Invocation; out: Invocation; state: 'running' | 'waiting' | 'done'; resolve?: () => void };
  const flights = new Map<number, Flight>();

  function launch(rec: Invocation): Flight {
    const out: Invocation = { id: rec.id, hook: rec.hook, seq: rec.seq, endSeq: rec.endSeq, input: rec.input, calls: [], ...(rec.parent !== undefined ? { parent: rec.parent } : {}) };
    replayed.push(out);
    const flight: Flight = { rec, out, state: 'running' };
    flights.set(rec.id, flight);
    const beneath = async (x: unknown): Promise<unknown> => {
      out.next = { input: x };
      if (!rec.nextResult) {
        unrecorded.push(`unrecorded next in ${rec.hook} #${rec.id}`);
        return undefined;
      }
      // The recording answered this next at its nextResult row: the timeline resumes the hook there.
      await new Promise<void>((resolve) => {
        flight.state = 'waiting';
        flight.resolve = resolve;
      });
      flight.state = 'running';
      out.nextResult = rec.nextResult;
      if (rec.nextResult.error) throw failure(rec.nextResult.error);
      return rec.nextResult.result;
    };
    const hook = hooks.get(rec.hook);
    const $ = engine(rec, out);
    void (async () => {
      try {
        let result: unknown;
        if (!hook) result = await beneath(rec.input);
        else if (isGenerator(hook)) {
          const next = Object.assign(async function* (x: unknown) { return await beneath(x); }, { signal });
          const it = hook($, rec.input, next);
          let step = await it.next();
          while (!step.done) step = await it.next();
          result = step.value;
        } else result = await hook($, rec.input, Object.assign(beneath, { signal }));
        out.end = { result };
      } catch (error) {
        out.end = { error: { message: error instanceof Error ? error.message : String(error) } };
      }
      flight.state = 'done';
    })();
    return flight;
  }

  /** Lets a flight run until it ends or awaits next; the plugin's queued work (log writes) settles with it, as the recording's did. */
  async function settle(flight: Flight): Promise<void> {
    for (let tick = 0; flight.state === 'running'; tick++) {
      if (tick === 10_000) throw new Error(`replay: ${flight.rec.hook} #${flight.rec.id} neither ended nor awaited next`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // The recorded timeline: each invocation starts at its start row, and its next is answered at its nextResult row, so
  // concurrent parties interleave as they did live. A hook that no longer calls next leaves the rest of the session to run.
  const timeline = recorded.flatMap((rec) => [
    { seq: rec.seq, rec, resume: false },
    ...(rec.nextResult?.seq !== undefined ? [{ seq: rec.nextResult.seq, rec, resume: true }] : []),
  ]).sort((a, b) => a.seq - b.seq);
  for (const { rec, resume } of timeline) {
    if (!resume) {
      await settle(launch(rec));
      continue;
    }
    const flight = flights.get(rec.id)!;
    if (flight.state !== 'waiting') continue;
    flight.resolve!();
    flight.state = 'running';
    await settle(flight);
  }
  for (const flight of flights.values()) if (flight.state !== 'done') unrecorded.push(`replay: ${flight.rec.hook} #${flight.rec.id} still awaits next at the end of the recording`);
  replayed.sort((a, b) => a.seq - b.seq);
  return { replayed, unrecorded };
}

// ---- The synthetic recording: a scripted engine under the real recorder, for the recorder's own tests. ----

export const A1 = 'a1b2c3d4e5';
export const FORWARD = 'mcp__forward-compaction__forward_compaction';
export const HANDOFF = '## Objective\nReplay the synthetic fixture.\n## Done\nRecorded it.\n## Remaining\nReplay it.\n## Next\nCheck I3 and I5.';
export const SKILL_TEXT = 'Base directory for this skill: /HOME/project/.claude/skills/replay-rules\n\n# Replay rules\nThe marker for this skill is replay-rules-marker-7f3a.';
export const BRIEF = 'Brief for agent one: read the filler and hand off.';

/** The sub-agent's transcript at its ask: the forward_compaction call, its result, and two messages after it. */
export function askMessages(): unknown[] {
  return [
    { role: 'user', text: BRIEF, toolUses: [], handle: 'h0' },
    { role: 'assistant', text: 'storing', toolUses: [{ tool_use_id: 'tu-h', tool: FORWARD, input: { handoff: HANDOFF } }], handle: 'h1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'tu-h', text: 'Handoff stored' }], handle: 'h2' },
    { role: 'assistant', text: 'reading on after the handoff', toolUses: [], handle: 'h3' },
    { role: 'user', text: 'a later note', toolUses: [], handle: 'h4' },
  ];
}

/** Records the synthetic session through scripts/replay/recorder.ts into `dir/rows/`; returns the rows directory. */
export async function recordSynthetic(dir: string): Promise<string> {
  const rows = join(dir, 'rows');
  mkdirSync(rows, { recursive: true });
  const { register: recorded } = await import('../../scripts/replay/recorder.ts');
  let now = Date.UTC(2026, 9, 23, 12, 0, 0);
  const env: Record<string, string> = { HOME: '/HOME', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000' };
  const $ = {
    agent: { list: async () => [{ id: A1, type: 'general-purpose', status: 'running', description: 'one' }] },
    clock: { now: async () => (now += 1000), after: () => ({ cancel: () => undefined }) },
    env: { get: async (name: string) => env[name] },
    fs: {
      write: async (path: string, text: string) => writeFileSync(join(dir, path), text),
      read: async (path: string) => { throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }); },
      stat: async (path: string) => { throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }); },
    },
    process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    session: {
      id: async () => '00000000-0000-0000-0000-000000000000',
      usage: async () => ({ context: { tokens: 0, window: 200_000 } }),
      version: async () => ({ version: 'synthetic' }),
      compact: async () => ({ skip: 'synthetic' }),
    },
    tool: { register: async (spec: { name: string }) => ({ tool: `mcp__forward-compaction__${spec.name}` }) },
    ui: { log: () => undefined },
  };
  const hooks = new Map<string, Fn>();
  recorded(((name: string, fn: Fn) => void hooks.set(name, fn)) as any, {} as any);
  const signal = new AbortController().signal;
  const call = (name: string, e: unknown, below: (x: any) => unknown = async () => ({})) => hooks.get(name)!($, e, Object.assign(async (x: unknown) => below(x), { signal }));
  const step = async (input: number) => {
    const it = hooks.get('turn.step')!($, { turnId: 't2', index: 0, model: 'claude-sonnet-4-5', messageCount: 4, agentId: A1 }, Object.assign(async function* () {
      return { turnId: 't2', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    }, { signal }));
    for (let s = await it.next(); !s.done; s = await it.next());
  };
  await call('session.start', { reason: 'startup' });
  await call('prompt.submit', { text: 'fix the parser', origin: { kind: 'human' }, turnId: 't1' });
  await call('tool.call', { tool: 'Agent', tool_use_id: 'tu-agent', prompt: BRIEF, description: 'one', subagent_type: 'general-purpose' }, async () => {
    await call('agent.spawn', { tool_use_id: 'tu-agent', prompt: BRIEF, description: 'one', subagentType: 'general-purpose', provider: { kind: 'local' } }, async () => ({ model: 'sonnet', agentId: A1 }));
    return { result: 'agent launched' };
  });
  await step(41_200);
  await call('tool.call', { tool: 'Skill', tool_use_id: 'tu-skill', agentId: A1, skill: 'forward-compaction:replay-rules' }, async () => {
    await call('skill.prompt', { skill: 'replay-rules', text: SKILL_TEXT, source: 'plugin' }, async (x: any) => x);
    return { result: 'Launching skill: forward-compaction:replay-rules' };
  });
  await step(45_000);
  await call('tool.call', { tool: FORWARD, tool_use_id: 'tu-h', agentId: A1, handoff: HANDOFF });
  await step(64_000);
  await call('session.compact', { trigger: 'auto', agentId: A1, messages: askMessages() }, async () => ({ summary: 'the native summarizer ran' }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return rows;
}
