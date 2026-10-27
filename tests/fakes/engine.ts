// A minimal `$` of Claude Code 2.1.309 for driving the adapter's `register`. Answers are scripted per test;
// a `$` call nothing scripts is recorded in `unscripted` (and throws), so a test names the path it lacks.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from '../../plugins/forward-compaction/hooks/forward-compaction.ts';

type Fn = (...args: any[]) => any;
export type ScreenCall = { text: string; opts?: unknown };
export type FileEntry = { content: string; kind?: 'file' | 'dir' | 'other' };

export type Script = {
  env?: Record<string, string>;
  /** Main's window `$.session.usage()` reports; a function is read at each call (a /model switch). */
  window?: number | (() => number);
  /** The `context.breakdown` `$.session.usage({ breakdown: 'summary' })` reports: by default a 100k compaction window asking at 63k; null reports none. */
  breakdown?: Record<string, unknown> | null;
  /** What `$.session.messages(args)` answers; an empty transcript by default. */
  messages?: (args?: { agentId?: string }) => unknown;
  files?: Record<string, FileEntry>;
  agents?: () => unknown;
  compact?: (args?: unknown) => unknown;
  now?: number;
  /** Answers a `$.process.run` in place of running it; `undefined` runs it for real. */
  run?: (argv: string[]) => { exitCode: number; stdout: string; stderr: string } | undefined;
  /** `$` calls that never settle. */
  hang?: ('session.id' | 'tool.register')[];
  /** `$.tool.register` rejects with this message (a session run with `--tools ""`). */
  registerError?: string;
  /** The host's session state (`$.state`); pass one map to two fakes to model a plugin reload in one session. */
  state?: Map<string, { value: unknown; version: number }>;
};

export function fakeEngine(script: Script = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fc-engine-'));
  const vars: Record<string, string> = { HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), ...script.env };
  const screen: ScreenCall[] = [];
  const unscripted: string[] = [];
  const compactCalls: unknown[][] = [];
  const hooks = new Map<string, Fn>();
  let now = script.now ?? Date.UTC(2026, 9, 23, 12, 0, 0);
  const never = new Promise<never>(() => {});
  const hangs = (call: 'session.id' | 'tool.register') => script.hang?.includes(call) === true;
  const state = script.state ?? new Map<string, { value: unknown; version: number }>();

  const enoent = (path: string) => Object.assign(new Error(`ENOENT: no such file, ${path}`), { code: 'ENOENT' });
  const base = {
    session: {
      id: () => (hangs('session.id') ? never : Promise.resolve('session-1')),
      cwd: async () => home,
      usage: async () => ({
        context: {
          tokens: 0,
          window: (typeof script.window === 'function' ? script.window() : script.window) ?? 200_000,
          ...(script.breakdown === null ? {} : { breakdown: script.breakdown ?? { rawMaxTokens: 100_000, autocompactSource: 'env', autoCompactThreshold: 63_000, isAutoCompactEnabled: true, model: 'claude-sonnet-4-5' } }),
        },
      }),
      messages: async (args?: { agentId?: string }) => (script.messages ? script.messages(args) : []),
      compact: async (...args: unknown[]) => {
        compactCalls.push(args);
        return script.compact ? script.compact(...args) : { messages: [] };
      },
    },
    env: { get: async (name: string) => vars[name] },
    fs: {
      stat: async (path: string) => {
        const file = script.files?.[path];
        if (!file) throw enoent(path);
        return { kind: file.kind ?? 'file', size: Buffer.byteLength(file.content), mtimeMs: now, isLink: false };
      },
      read: async (path: string) => {
        const file = script.files?.[path];
        if (!file) throw enoent(path);
        return file.content;
      },
    },
    process: {
      run: async (argv: string[], init?: { stdin?: string; cwd?: string }) => {
        const scripted = script.run?.(argv);
        if (scripted !== undefined) return scripted;
        const out = spawnSync(argv[0]!, argv.slice(1), { input: init?.stdin, cwd: init?.cwd, encoding: 'utf8' });
        return { exitCode: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
      },
    },
    clock: { now: async () => now, after: (ms: number, fn: () => void) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; } },
    ui: { log: (text: string, opts?: unknown) => void screen.push(opts === undefined ? { text } : { text, opts }) },
    agent: { list: async () => (script.agents ? script.agents() : []) },
    state: {
      get: async (ref: unknown) => state.get(JSON.stringify(ref)) ?? { value: undefined, version: 0 },
      set: async (ref: unknown, value: unknown) => {
        const version = (state.get(JSON.stringify(ref))?.version ?? 0) + 1;
        state.set(JSON.stringify(ref), { value: JSON.parse(JSON.stringify(value)), version });
        return { isSet: true, version };
      },
    },
    tool: { register: (spec: { name: string }) => (hangs('tool.register') ? never : script.registerError !== undefined ? Promise.reject(new Error(script.registerError)) : Promise.resolve({ tool: `mcp__forward-compaction__${spec.name}` })) },
  };

  const proxy = (target: Record<string, unknown>, path: string): any =>
    new Proxy(target, {
      get(obj, prop) {
        if (typeof prop === 'symbol' || prop === 'then') return (obj as any)[prop];
        const at = path ? `${path}.${prop}` : prop;
        const value = (obj as any)[prop];
        if (value === undefined) return (...args: unknown[]) => { unscripted.push(at); throw new Error(`unscripted $ call ${at}`); };
        return value !== null && typeof value === 'object' ? proxy(value, at) : value;
      },
    });
  const $ = proxy(base, '');

  register(((name: string, fn: Fn) => void hooks.set(name, fn)) as any, {} as any);

  /** Runs one hook with `impl` as everything beneath it; a hook the plugin does not register passes straight to `impl`. `signal` is the dispatch's abort. */
  async function dispatch(event: string, e: unknown, impl: Fn = async (x) => x, signal: AbortSignal = new AbortController().signal): Promise<any> {
    const hook = hooks.get(event);
    if (event === 'turn.step') {
      const next = Object.assign(async function* (x: unknown) { return await impl(x); }, { signal });
      if (!hook) return impl(e);
      const it = hook($, e, next);
      let step = await it.next();
      while (!step.done) step = await it.next();
      return step.value;
    }
    const next = Object.assign(async (x: unknown) => impl(x), { signal });
    return hook ? hook($, e, next) : impl(e);
  }

  return {
    $, home, vars, screen, unscripted, compactCalls, hooks, dispatch,
    advance: (ms: number) => void (now += ms),
    texts: () => screen.map((c) => c.text),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** A turn.step whose response was answered over `input` tokens and wrote `output` (left out when absent). */
export const usage = (input: number, output?: number) => ({ usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...(output !== undefined ? { output_tokens: output } : {}) } });
