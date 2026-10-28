// The replay recorder (spec § Tests, replay gate 1): the real plugin's register, with every hook invocation,
// every `$` call the plugin makes, every `next` and every return written as one row file under `rows/`.
// assemble.sh copies it beside hooks/forward-compaction.ts and names it the assembled plugin's only module.
import type { EngineInterface, On, Register } from 'claude-code';
// assemble.sh rewrites this import to './forward-compaction.ts', the copy beside it.
import { register as plugin } from '../../plugins/forward-compaction/hooks/forward-compaction.ts';

/** Relative, so under the session's cwd that launch.sh sets: whether `$.fs.write` reaches outside it is unverified (O2). */
const ROWS = 'rows';
/** Characters per written part: at most 1.5 MiB of UTF-8, far below the 4 MiB Claude Code refuses (A2). */
export const PART_CHARS = 512 * 1024;

export type Row = { seq: number; id: number; phase: 'version' | 'start' | 'call' | 'next' | 'nextResult' | 'end'; hook?: string; path?: string; input?: unknown; args?: unknown; result?: unknown; error?: unknown; sync?: true };

let seq = 0;
let invocations = 0;
let failed = 0;
let versioned = false;

const pad = (n: number): string => String(n).padStart(6, '0');
/** Functions and bigints have no JSON form: a function is named, never dropped silently. */
export const json = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (typeof v === 'function' ? '[function]' : typeof v === 'bigint' ? String(v) : v));
const errorOf = (error: unknown): { message: string; code?: unknown; name?: string } => {
  const e = error as { message?: unknown; code?: unknown; name?: unknown } | null;
  return { message: typeof e?.message === 'string' ? e.message : String(error), ...(e?.code !== undefined ? { code: e.code } : {}), ...(typeof e?.name === 'string' ? { name: e.name } : {}) };
};

/** The file names one row is written under: `{seq}.json` whole, or `{seq}.json.{k}of{n}` parts when longer than PART_CHARS. */
export function rowFiles(row: Row): { name: string; text: string }[] {
  const text = json(row);
  if (text.length <= PART_CHARS) return [{ name: `${pad(row.seq)}.json`, text }];
  const n = Math.ceil(text.length / PART_CHARS);
  return Array.from({ length: n }, (_, k) => ({ name: `${pad(row.seq)}.json.${k + 1}of${n}`, text: text.slice(k * PART_CHARS, (k + 1) * PART_CHARS) }));
}

/** The seq is taken now, the write is not awaited: a failed write is counted, and sanitize names the seq it lacks. */
function writeRow($: EngineInterface, fields: Omit<Row, 'seq'>): void {
  const row = { seq: ++seq, ...fields } as Row;
  for (const file of rowFiles(row)) {
    $.fs.write(`${ROWS}/${file.name}`, file.text).catch((error: unknown) => {
      failed++;
      $.ui.log(`forward-compaction recorder: writing row ${row.seq} failed (${failed} so far): ${errorOf(error).message}`);
    });
  }
}

/** Once per process: the Claude Code version the fixture is filed under. */
async function writeVersion($: EngineInterface): Promise<void> {
  if (versioned) return;
  versioned = true;
  try {
    writeRow($, { id: 0, phase: 'version', result: await $.session.version(), ...(unrecorded.length > 0 ? { error: { message: `hooks not recorded: ${unrecorded.join(', ')}` } } : {}) });
  } catch (error) {
    writeRow($, { id: 0, phase: 'version', error: errorOf(error) });
  }
}

/** The plugin's environment reads, each spelled as the literal Claude Code requires; `tests/replay.test.ts` holds this list to the adapter's. */
export const ENV_NAMES = ['HOME', 'PLUGIN_LOG_DIR', 'CLAUDE_CONFIG_DIR', 'FORWARD_COMPACTION_MAIN_MAX_CONTEXT', 'FORWARD_COMPACTION_MAIN_CEILING', 'FORWARD_COMPACTION_MAIN_NUDGE_START', 'FORWARD_COMPACTION_MAIN_NUDGE_EVERY', 'FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT', 'FORWARD_COMPACTION_SUBAGENT_CEILING', 'FORWARD_COMPACTION_SUBAGENT_NUDGE_START', 'FORWARD_COMPACTION_SUBAGENT_NUDGE_EVERY', 'FORWARD_COMPACTION_CEILING_NATIVE', 'FORWARD_COMPACTION_IGNORE_MODELS', 'FORWARD_COMPACTION_KEEP_SKILLS', 'FORWARD_COMPACTION_DEBUG'] as const;

function envGet($: EngineInterface, name: string): Promise<string | undefined> {
  switch (name) {
    case 'HOME': return $.env.get('HOME');
    case 'PLUGIN_LOG_DIR': return $.env.get('PLUGIN_LOG_DIR');
    case 'CLAUDE_CONFIG_DIR': return $.env.get('CLAUDE_CONFIG_DIR');
    case 'FORWARD_COMPACTION_MAIN_MAX_CONTEXT': return $.env.get('FORWARD_COMPACTION_MAIN_MAX_CONTEXT');
    case 'FORWARD_COMPACTION_MAIN_CEILING': return $.env.get('FORWARD_COMPACTION_MAIN_CEILING');
    case 'FORWARD_COMPACTION_MAIN_NUDGE_START': return $.env.get('FORWARD_COMPACTION_MAIN_NUDGE_START');
    case 'FORWARD_COMPACTION_MAIN_NUDGE_EVERY': return $.env.get('FORWARD_COMPACTION_MAIN_NUDGE_EVERY');
    case 'FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT': return $.env.get('FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT');
    case 'FORWARD_COMPACTION_SUBAGENT_CEILING': return $.env.get('FORWARD_COMPACTION_SUBAGENT_CEILING');
    case 'FORWARD_COMPACTION_SUBAGENT_NUDGE_START': return $.env.get('FORWARD_COMPACTION_SUBAGENT_NUDGE_START');
    case 'FORWARD_COMPACTION_SUBAGENT_NUDGE_EVERY': return $.env.get('FORWARD_COMPACTION_SUBAGENT_NUDGE_EVERY');
    case 'FORWARD_COMPACTION_CEILING_NATIVE': return $.env.get('FORWARD_COMPACTION_CEILING_NATIVE');
    case 'FORWARD_COMPACTION_IGNORE_MODELS': return $.env.get('FORWARD_COMPACTION_IGNORE_MODELS');
    case 'FORWARD_COMPACTION_KEEP_SKILLS': return $.env.get('FORWARD_COMPACTION_KEEP_SKILLS');
    case 'FORWARD_COMPACTION_DEBUG': return $.env.get('FORWARD_COMPACTION_DEBUG');
    default: throw new Error(`recorder: env ${name} is not in ENV_NAMES (scripts/replay/recorder.ts)`);
  }
}

/** The plugin's state keys: Claude Code requires each ref's plugin and key as string literals, so each is spelled out; `tests/replay.test.ts` holds this list to the adapter's. */
export const STATE_KEYS = ['judged', 'orders', 'prompts', 'skills'] as const;

function stateGet($: EngineInterface, ref: { key: string; id?: string }): unknown {
  switch (ref.key) {
    case 'judged': return $.state.get({ plugin: 'forward-compaction', key: 'judged', id: ref.id } as never);
    case 'orders': return $.state.get({ plugin: 'forward-compaction', key: 'orders', id: ref.id } as never);
    case 'prompts': return $.state.get({ plugin: 'forward-compaction', key: 'prompts', id: ref.id } as never);
    case 'skills': return $.state.get({ plugin: 'forward-compaction', key: 'skills', id: ref.id } as never);
    default: throw new Error(`recorder: state key ${ref.key} is not in STATE_KEYS (scripts/replay/recorder.ts)`);
  }
}

function stateSet($: EngineInterface, ref: { key: string; id?: string }, value: unknown): unknown {
  switch (ref.key) {
    case 'judged': return $.state.set({ plugin: 'forward-compaction', key: 'judged', id: ref.id } as never, value as never);
    case 'orders': return $.state.set({ plugin: 'forward-compaction', key: 'orders', id: ref.id } as never, value as never);
    case 'prompts': return $.state.set({ plugin: 'forward-compaction', key: 'prompts', id: ref.id } as never, value as never);
    case 'skills': return $.state.set({ plugin: 'forward-compaction', key: 'skills', id: ref.id } as never, value as never);
    default: throw new Error(`recorder: state key ${ref.key} is not in STATE_KEYS (scripts/replay/recorder.ts)`);
  }
}

/** Arguments as the plugin gave them, without the trailing undefined a wrapper adds. */
const given = (...args: unknown[]): unknown[] => {
  while (args.length > 0 && args.at(-1) === undefined) args.pop();
  return args;
};

/**
 * `$` as the plugin sees it. Claude Code refuses a module that passes `$` itself anywhere (a Proxy over it included),
 * so every path the adapter calls is written out here, spelled `$.noun.event(...)`; `tests/replay.test.ts` holds
 * this list to the adapter's. Each call is answered by the engine and written with its path, arguments and outcome;
 * a path missing here is written as an error row and throws, so the recording shows it.
 */
export const PATHS = ['agent.list', 'clock.after', 'clock.now', 'env.get', 'fs.read', 'fs.stat', 'process.run', 'session.compact', 'session.id', 'session.messages', 'session.usage', 'state.get', 'state.set', 'tool.register', 'ui.log'] as const;

function engineFor($: EngineInterface, id: number): any {
  const call = (path: string, args: unknown[], run: () => unknown): unknown => {
    const done = (outcome: { result: unknown } | { error: unknown }, sync?: true): void => writeRow($, { id, phase: 'call', path, args, ...outcome, ...(sync ? { sync } : {}) });
    let out: unknown;
    try {
      out = run();
    } catch (error) {
      done({ error: errorOf(error) }, true);
      throw error;
    }
    if (out === null || typeof (out as { then?: unknown } | undefined)?.then !== 'function') {
      done({ result: out }, true);
      return out;
    }
    return (out as Promise<unknown>).then(
      (result) => (done({ result }), result),
      (error: unknown) => {
        done({ error: errorOf(error) });
        throw error;
      },
    );
  };
  const surface: Record<string, Record<string, (...args: any[]) => unknown>> = {
    agent: { list: () => call('agent.list', [], () => $.agent.list()) },
    clock: {
      now: () => call('clock.now', [], () => $.clock.now()),
      after: (ms: number, fn: () => void) => call('clock.after', [ms, fn], () => $.clock.after(ms, fn)),
    },
    env: { get: (name: string) => call('env.get', [name], () => envGet($, name)) },
    fs: {
      read: (path: string, options?: any) => call('fs.read', given(path, options), () => (options === undefined ? $.fs.read(path) : $.fs.read(path, options))),
      stat: (path: string) => call('fs.stat', [path], () => $.fs.stat(path)),
    },
    process: { run: (argv: string[], init?: any) => call('process.run', given(argv, init), () => $.process.run(argv, init)) },
    session: {
      compact: (args?: any) => call('session.compact', given(args), () => (args === undefined ? $.session.compact() : $.session.compact(args))),
      id: () => call('session.id', [], () => $.session.id()),
      messages: (args?: any) => call('session.messages', given(args), () => (args === undefined ? $.session.messages() : $.session.messages(args))),
      usage: (args?: any) => call('session.usage', given(args), () => (args === undefined ? $.session.usage() : $.session.usage(args))),
    },
    state: {
      get: (ref: any) => call('state.get', [ref], () => stateGet($, ref)),
      set: (ref: any, value: unknown) => call('state.set', [ref, value], () => stateSet($, ref, value)),
    },
    tool: { register: (spec: any) => call('tool.register', [spec], () => $.tool.register(spec)) },
    ui: { log: (text: string, options?: any) => call('ui.log', given(text, options), () => (options === undefined ? $.ui.log(text) : $.ui.log(text, options))) },
  };
  const missing = (path: string) => (...args: unknown[]) => call(path, args, () => {
    throw new Error(`recorder: $.${path} is not in PATHS (scripts/replay/recorder.ts)`);
  });
  return new Proxy(surface, {
    get(target, noun) {
      if (typeof noun === 'symbol' || noun === 'then') return undefined;
      const methods = target[noun] ?? {};
      return new Proxy(methods, { get: (m, verb) => (typeof verb === 'symbol' ? undefined : m[verb] ?? missing(`${noun}.${verb}`)) });
    },
  });
}

/** `next` with every property the engine gives it (signal, budget, to, ...), its call and its answer written. */
function nextOf(engine: EngineInterface, next: any, id: number, generator: boolean): any {
  return new Proxy(next, {
    apply(target, self, args: unknown[]) {
      writeRow(engine, { id, phase: 'next', input: args[0] });
      if (generator) {
        return (async function* () {
          try {
            const result: unknown = yield* Reflect.apply(target, self, args);
            writeRow(engine, { id, phase: 'nextResult', result });
            return result;
          } catch (error) {
            writeRow(engine, { id, phase: 'nextResult', error: errorOf(error) });
            throw error;
          }
        })();
      }
      return Promise.resolve(Reflect.apply(target, self, args)).then(
        (result: unknown) => (writeRow(engine, { id, phase: 'nextResult', result }), result),
        (error: unknown) => {
          writeRow(engine, { id, phase: 'nextResult', error: errorOf(error) });
          throw error;
        },
      );
    },
  });
}

/** The plugin's own hooks, by event, as its register handed them over. */
const hooks = new Map<string, (...args: any[]) => any>();
const passOn = async (_$: unknown, e: unknown, next: (e: unknown) => unknown) => next(e);

/** One invocation of the plugin's hook for `hook`, recorded: its start, the plugin's own work, its end. */
async function invoke(hook: string, $: EngineInterface, e: unknown, next: unknown): Promise<unknown> {
  const id = ++invocations;
  if (hook === 'session.start') await writeVersion($);
  writeRow($, { id, phase: 'start', hook, input: e });
  try {
    const result: unknown = await (hooks.get(hook) ?? passOn)(engineFor($, id), e, nextOf($, next, id, false));
    writeRow($, { id, phase: 'end', result });
    return result;
  } catch (error) {
    writeRow($, { id, phase: 'end', error: errorOf(error) });
    throw error;
  }
}

/** A generator hook (turn.step): its yields pass through unrecorded, its final return is the end row. */
async function* invokeSteps(hook: string, $: EngineInterface, e: unknown, next: unknown): AsyncGenerator<unknown, unknown, unknown> {
  const id = ++invocations;
  writeRow($, { id, phase: 'start', hook, input: e });
  const fn = hooks.get(hook);
  try {
    const result: unknown = fn ? yield* fn(engineFor($, id), e, nextOf($, next, id, true)) : yield* (nextOf($, next, id, true) as (e: unknown) => AsyncGenerator<unknown, unknown, unknown>)(e);
    writeRow($, { id, phase: 'end', result });
    return result;
  } catch (error) {
    writeRow($, { id, phase: 'end', error: errorOf(error) });
    throw error;
  }
}

/** Every event the plugin registers. Claude Code reads `on("<event>", hook)` statically, so each is written out; a hook the plugin adds and this list lacks is named in the version row, and sanitize refuses the recording. */
export const RECORDED = ['session.start', 'tool.call', 'session.compact', 'turn.step', 'turn.start', 'turn.complete', 'prompt.submit', 'prompt.attachment', 'session.receive', 'skill.prompt', 'agent.spawn', 'classic.Stop', 'classic.SubagentStop', 'session.end'] as const;
let unrecorded: string[] = [];

export const register: Register = (on: On, options) => {
  const result = plugin(((pattern: string, ...rest: any[]) => {
    if (rest.length !== 1 || hooks.has(pattern)) unrecorded.push(`${pattern} (${rest.length === 1 ? 'registered twice' : 'with a matcher'})`);
    hooks.set(pattern, rest.at(-1));
    return { dispose: () => undefined };
  }) as unknown as On, options);
  unrecorded = unrecorded.concat([...hooks.keys()].filter((name) => !(RECORDED as readonly string[]).includes(name)));
  on('session.start', async ($, e, next) => invoke('session.start', $, e, next) as any);
  on('tool.call', async ($, e, next) => invoke('tool.call', $, e, next) as any);
  on('session.compact', async ($, e, next) => invoke('session.compact', $, e, next) as any);
  on('turn.step', async function* ($, e, next) { return (yield* invokeSteps('turn.step', $, e, next) as AsyncGenerator<any, any, any>) as any; });
  on('turn.start', async ($, e, next) => invoke('turn.start', $, e, next) as any);
  on('turn.complete', async ($, e, next) => invoke('turn.complete', $, e, next) as any);
  on('prompt.submit', async ($, e, next) => invoke('prompt.submit', $, e, next) as any);
  on('prompt.attachment', async ($, e, next) => invoke('prompt.attachment', $, e, next) as any);
  on('session.receive', async ($, e, next) => invoke('session.receive', $, e, next) as any);
  on('skill.prompt', async ($, e, next) => invoke('skill.prompt', $, e, next) as any);
  on('agent.spawn', async ($, e, next) => invoke('agent.spawn', $, e, next) as any);
  on('classic.Stop', async ($, e, next) => invoke('classic.Stop', $, e, next) as any);
  on('classic.SubagentStop', async ($, e, next) => invoke('classic.SubagentStop', $, e, next) as any);
  on('session.end', async ($, e, next) => invoke('session.end', $, e, next) as any);
  return result;
};
