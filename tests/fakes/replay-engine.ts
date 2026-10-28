// The replay engine (spec § Tests, replay gate 5): a recording's hook invocations driven through the real `register`
// on the recorded timeline: each starts at its start row and its fake `next` is answered at its nextResult row, so the
// ones started meanwhile (a Skill call's skill.prompt, another party's steps) run inside it as they did live. The
// replay pins what carries format risk, the engine's events and the shapes of its answers, never the plugin's own
// call sequence: each `$` path is answered by its class in ANSWERS. A format-bearing call the recording cannot answer
// is `unrecorded $ call {path} in {hook} #{id}`: re-record. `#{id}` is the invocation's number, the recorder's `id`.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { register } from '../../plugins/forward-compaction/hooks/forward-compaction.ts';
import type { PATHS, Row } from '../../scripts/replay/recorder.ts';

type Fn = (...args: any[]) => any;
export type Outcome = { seq?: number; result?: any; error?: { message: string; code?: unknown } };
export type Call = { path: string; args: unknown[]; sync?: true } & Outcome;
export type Invocation = {
  id: number; hook: string; seq: number; endSeq: number; input: any; parent?: number;
  calls: Call[]; next?: { seq?: number; input: any }; nextResult?: Outcome; end?: Outcome;
};
export type Replay = { replayed: Invocation[]; unrecorded: string[] };

/**
 * How the replay answers each `$` path the plugin calls; `tests/replay.test.ts` holds its keys to the recorder's PATHS.
 * - `recorded`: a read of engine state, whose answer's shape is the format risk. The plugin's own call with the same
 *   arguments in the same invocation takes that recorded answer; any other takes the latest answer recorded for the
 *   path (and, with `subject`, the same first argument: another variable or file is other state) at or before that
 *   point of the timeline, as the world state then. None recorded by then is `unrecorded $ call`.
 * - `harness`: a utility or an effect, answered by the harness deterministically, so the plugin may add, drop or
 *   reorder these calls: session.id the recorded id, clock.now the recorded timeline time, clock.after a timer that
 *   never fires, process.run the plugin's argv really run in the replay sandbox, ui.log captured, tool.register the
 *   recorded registration of that tool name.
 */
export const ANSWERS: Record<(typeof PATHS)[number], { from: 'recorded'; subject?: true } | { from: 'harness'; sync?: true }> = {
  'agent.list': { from: 'recorded' },
  'env.get': { from: 'recorded', subject: true },
  'fs.read': { from: 'recorded', subject: true },
  'fs.stat': { from: 'recorded', subject: true },
  // the breakdown asked for is the argument: an answer to another argument is other state
  'session.usage': { from: 'recorded', subject: true },
  // a transcript read: the agent asked for is the argument
  'session.messages': { from: 'recorded', subject: true },
  // an effect, but the plugin reads its answer (a skip reason or the compaction's), so its shape is engine format
  'session.compact': { from: 'recorded' },
  'session.id': { from: 'harness' },
  'clock.now': { from: 'harness' },
  'clock.after': { from: 'harness', sync: true },
  'process.run': { from: 'harness' },
  'ui.log': { from: 'harness', sync: true },
  'tool.register': { from: 'harness' },
  // the host's session state, held by the harness for the replay: what the plugin set is what it gets
  'state.get': { from: 'harness' },
  'state.set': { from: 'harness' },
};

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

/**
 * Replays a recording through the real plugin. Zero invocations is a failure, never a pass (Law 15). `sandbox` is
 * the directory process.run runs in, standing in for the filesystem root: the recorded home maps to `{sandbox}{home}`
 * and any other absolute path is refused as a failure. Without one, a temporary directory is made and removed.
 */
export async function replay(rows: readonly Row[], sandbox?: string): Promise<Replay> {
  const recorded = invocations(rows);
  if (recorded.length === 0) throw new Error('replayed 0 invocations');
  const root = sandbox ?? mkdtempSync(join(tmpdir(), 'fc-replay-'));
  try {
    return await drive(recorded, root);
  } finally {
    if (sandbox === undefined) rmSync(root, { recursive: true, force: true });
  }
}

async function drive(recorded: Invocation[], root: string): Promise<Replay> {
  const hooks = new Map<string, Fn>();
  register(((name: string, fn: Fn) => void hooks.set(name, fn)) as any, {} as any);
  const unrecorded: string[] = [];
  const replayed: Invocation[] = [];
  const signal = new AbortController().signal;
  const world = recorded.flatMap((inv) => inv.calls).sort((a, b) => a.seq! - b.seq!);
  const held = new Map<string, { value: unknown; version: number }>();
  const home = world.find((c) => c.path === 'env.get' && c.args[0] === 'HOME' && typeof c.result === 'string')?.result as string | undefined;
  /** The seq of the next timeline event: every call recorded before it happened by now. */
  let now = 0;

  /** The plugin's argv run for real, every absolute path in it mapped under the sandbox; a path outside the recorded home is refused. */
  function run(argv: string[], init: { cwd?: string; stdin?: string; timeoutMs?: number } | undefined, refuse: (path: string) => Error): unknown {
    const inside = (path: string): string => {
      const mapped = resolve(`${root}${path}`);
      if (home === undefined || !(path === home || path.startsWith(`${home}/`)) || !mapped.startsWith(`${root}/`)) throw refuse(path);
      return mapped;
    };
    // argv[0] is the program and a `-c` script is code, never a path the plugin chose.
    const args = argv.map((a, i) => (i === 0 || (i === 2 && argv[1] === '-c') || !a.startsWith('/') ? a : inside(a)));
    // runCwd gives `/` when every path is absolute: the sandbox stands in for it.
    const cwd = init?.cwd === undefined || init.cwd === '/' ? root : inside(init.cwd);
    const r = spawnSync(args[0]!, args.slice(1), { cwd, input: init?.stdin ?? '', encoding: 'utf8', timeout: init?.timeoutMs, env: { PATH: process.env.PATH, HOME: home === undefined ? root : `${root}${home}` } });
    if (r.error) throw r.error;
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, isStdoutTruncated: false, isStderrTruncated: false };
  }

  function engine(rec: Invocation, out: Invocation): any {
    const pool = rec.calls.map((call) => ({ call, used: false }));
    const latest = (match: (c: Call) => boolean): Call | undefined => world.filter((c) => c.seq! < now && match(c)).at(-1);
    const answer = (path: string, args: unknown[]): unknown => {
      const missing = (why = ''): Error => {
        const line = `unrecorded $ call ${path} in ${rec.hook} #${rec.id}${why}`;
        unrecorded.push(line);
        out.calls.push({ path, args, error: { message: line } });
        return new Error(line);
      };
      const how = ANSWERS[path as keyof typeof ANSWERS];
      if (how === undefined) throw missing(' (a path ANSWERS does not classify)');
      if (how.from === 'harness') {
        let result: unknown;
        try {
          if (path === 'session.id') {
            const id = world.find((c) => c.path === 'session.id' && !c.error);
            if (!id) throw missing();
            result = id.result;
          } else if (path === 'clock.now') {
            const time = latest((c) => c.path === 'clock.now' && !c.error) ?? world.find((c) => c.path === 'clock.now' && !c.error);
            if (!time) throw missing();
            result = time.result;
          } else if (path === 'tool.register') {
            const name = (args[0] as { name?: unknown } | undefined)?.name;
            const reg = world.find((c) => c.path === 'tool.register' && !c.error && (c.args[0] as { name?: unknown } | undefined)?.name === name);
            if (!reg) throw missing(` for tool ${String(name)}`);
            result = reg.result;
          } else if (path === 'process.run') {
            result = run(args[0] as string[], args[1] as any, (p) => {
              const line = `process.run outside the replay sandbox: ${p} in ${rec.hook} #${rec.id}`;
              unrecorded.push(line);
              return new Error(line);
            });
          } else if (path === 'clock.after') result = { cancel: () => undefined }; // a timer never fires in replay
          else if (path === 'state.get') result = held.get(JSON.stringify(args[0])) ?? { value: undefined, version: 0 };
          else if (path === 'state.set') {
            const version = (held.get(JSON.stringify(args[0]))?.version ?? 0) + 1;
            held.set(JSON.stringify(args[0]), { value: args[1], version });
            result = { isSet: true, version };
          }
        } catch (error) {
          // missing() has written this call's row already; any other failure (a refused path, a spawn error) is written here
          if (out.calls.at(-1)?.args !== args) out.calls.push({ path, args, error: { message: error instanceof Error ? error.message : String(error) } });
          if (how.sync) throw error;
          return Promise.reject(error);
        }
        out.calls.push({ path, args, result });
        return how.sync ? result : Promise.resolve(result);
      }
      const subject = (c: Call): boolean => !how.subject || norm(c.args[0]) === norm(args[0]);
      const exact = pool.find((p) => !p.used && p.call.path === path && norm(p.call.args) === norm(args));
      if (exact) exact.used = true;
      const call = exact?.call ?? latest((c) => c.path === path && subject(c));
      if (!call) throw missing();
      out.calls.push({ path, args, ...(call.error ? { error: call.error } : { result: call.result }) });
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
  for (const [i, { rec, resume }] of timeline.entries()) {
    now = timeline[i + 1]?.seq ?? Infinity;
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
export const SECTIONS = { objective: 'Replay the synthetic fixture.', decisions: 'none', done: 'Recorded it.', remaining: 'Replay it.', next: 'Check I3 and I5.' };
export const SKILL_TEXT = 'Base directory for this skill: /HOME/project/.claude/skills/replay-rules\n\n# Replay rules\nThe marker for this skill is replay-rules-marker-7f3a.';
export const BRIEF = 'Brief for agent one: read the filler and compact.';

/** The sub-agent's transcript at its ask: the forward_compaction call, its result, and two messages after it. */
export function askMessages(): unknown[] {
  return [
    { role: 'user', text: BRIEF, toolUses: [], handle: 'h0' },
    { role: 'assistant', text: 'storing', toolUses: [{ tool_use_id: 'tu-h', tool: FORWARD, input: SECTIONS }], handle: 'h1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'tu-h', text: 'Frontier stored' }], handle: 'h2' },
    { role: 'assistant', text: 'reading on after the frontier', toolUses: [], handle: 'h3' },
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
      usage: async () => ({ context: { tokens: 0, window: 1_000_000 } }),
      version: async () => ({ version: 'synthetic' }),
      compact: async () => ({ skip: 'synthetic' }),
    },
    state: { get: async () => ({ value: undefined, version: 0 }), set: async () => ({ isSet: true, version: 1 }) },
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
  await call('tool.call', { tool: FORWARD, tool_use_id: 'tu-h', agentId: A1, ...SECTIONS });
  await step(64_000);
  await call('session.compact', { trigger: 'auto', agentId: A1, messages: askMessages() }, async () => ({ summary: 'the native summarizer ran' }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return rows;
}
