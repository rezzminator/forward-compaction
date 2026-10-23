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
  window?: number;
  files?: Record<string, FileEntry>;
  agents?: () => unknown;
  compact?: (args?: unknown) => unknown;
  now?: number;
};

export function fakeEngine(script: Script = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fc-engine-'));
  const vars: Record<string, string> = { HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), ...script.env };
  const screen: ScreenCall[] = [];
  const unscripted: string[] = [];
  const compactCalls: unknown[][] = [];
  const hooks = new Map<string, Fn>();
  let now = script.now ?? Date.UTC(2026, 9, 23, 12, 0, 0);

  const enoent = (path: string) => Object.assign(new Error(`ENOENT: no such file, ${path}`), { code: 'ENOENT' });
  const base = {
    session: {
      id: async () => 'session-1',
      cwd: async () => home,
      usage: async () => ({ context: { tokens: 0, window: script.window ?? 200_000 } }),
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
        const out = spawnSync(argv[0]!, argv.slice(1), { input: init?.stdin, cwd: init?.cwd, encoding: 'utf8' });
        return { exitCode: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
      },
    },
    clock: { now: async () => now, after: (ms: number, fn: () => void) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; } },
    ui: { log: (text: string, opts?: unknown) => void screen.push(opts === undefined ? { text } : { text, opts }) },
    agent: { list: async () => (script.agents ? script.agents() : []) },
    tool: { register: async (spec: { name: string }) => ({ tool: `mcp__forward-compaction__${spec.name}` }) },
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

  const signal = new AbortController().signal;
  /** Runs one hook with `impl` as everything beneath it; a hook the plugin does not register passes straight to `impl`. */
  async function dispatch(event: string, e: unknown, impl: Fn = async (x) => x): Promise<any> {
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

/** A turn.step whose response was answered over `input` tokens. */
export const usage = (input: number) => ({ usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
