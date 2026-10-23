import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { register } from '../plugins/forward-compaction/hooks/forward-compaction.ts';
import { FORWARD_INPUT_SCHEMA, FORWARD_TOOL_DESCRIPTION } from '../plugins/forward-compaction/src/handoff.ts';
import { LOOK_BACK_DESCRIPTION, LOOK_BACK_INPUT_SCHEMA } from '../plugins/forward-compaction/src/look-back.ts';
import { OPTION_ENV } from '../plugins/forward-compaction/src/options.ts';
import { toolsToRegister } from '../plugins/forward-compaction/src/register.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const none = { forward_compaction: false, look_back: false };
const nothing = { forward_compaction: 0, look_back: 0 };

describe('toolsToRegister', () => {
  it('names each enabled tool that is not registered yet and has tries left', () => {
    const both = { forward_compaction: true, look_back: true };
    expect(toolsToRegister(both, none, { forward_compaction: 2, look_back: 0 }, 3)).toEqual(['forward_compaction', 'look_back']);
    expect(toolsToRegister({ ...none, look_back: true }, none, nothing, 3)).toEqual(['look_back']);
  });

  it('leaves out a registered tool and one whose tries are spent, so nothing is left to wait on', () => {
    const both = { forward_compaction: true, look_back: true };
    expect(toolsToRegister(both, { forward_compaction: true, look_back: false }, { forward_compaction: 1, look_back: 3 }, 3)).toEqual([]);
    expect(toolsToRegister(none, none, nothing, 3)).toEqual([]);
  });
});

describe('the environment reads in the hooks module', () => {
  it('spells each variable of OPTION_ENV as its own string literal, once, the name Claude Code lists', () => {
    const source = readFileSync(join(root, 'plugins/forward-compaction/hooks/forward-compaction.ts'), 'utf8');
    const spelled = [...source.matchAll(/readOptionVar\('([A-Z_]+)', \(\) => \$\.env\.get\('([A-Z_]+)'\)\)/g)].map((match) => [match[1], match[2]]);
    expect(spelled).toEqual(Object.values(OPTION_ENV).map((name) => [name, name]));
  });
});

describe('the plugin as loaded', () => {
  const dirs: string[] = [];
  afterEach(() => void dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  // A minimal `$`: tools register under the plugin's server name; processes really run, so look_back's shell protocol is exercised.
  function load(env: Record<string, string> = {}) {
    const home = mkdtempSync(join(tmpdir(), 'fc-register-'));
    dirs.push(home);
    const screen: string[] = [];
    const registered: { name: string; description: string; inputSchema: unknown; isDeferred?: boolean }[] = [];
    const hooks = new Map<string, (...args: any[]) => any>();
    const vars: Record<string, string> = { HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), ...env };
    const $ = {
      session: { id: async () => 'session-1', cwd: async () => home, usage: async () => ({ context: { tokens: 0, window: 200_000 } }) },
      env: { get: async (name: string) => vars[name] },
      fs: {},
      process: {
        run: async (argv: string[], init?: { stdin?: string; cwd?: string }) => {
          const out = spawnSync(argv[0]!, argv.slice(1), { input: init?.stdin, cwd: init?.cwd, encoding: 'utf8' });
          return { exitCode: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
        },
      },
      clock: { now: async () => Date.now(), after: (ms: number, fn: () => void) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; } },
      ui: { log: (text: string) => void screen.push(text) },
      agent: { list: async () => [] },
      tool: { register: async (spec: { name: string; description: string; inputSchema: unknown; isDeferred?: boolean }) => (registered.push(spec), { tool: `mcp__forward-compaction__${spec.name}` }) },
    };
    register(((event: string, hook: (...args: any[]) => any) => void hooks.set(event, hook)) as never, {} as never);
    const dispatch = (event: string, e: unknown, impl: (e: any) => any = async () => ({})) => hooks.get(event)!($, e, Object.assign((input: unknown) => impl(input), { signal: new AbortController().signal }));
    return { home, registered, screen, dispatch };
  }

  it('registers look_back and forward_compaction at session.start, the forward tool in the prompt rather than behind ToolSearch (R5)', async () => {
    const { registered, dispatch } = load();
    await dispatch('session.start', { reason: 'startup' });
    expect(registered.map((spec) => spec.name).sort()).toEqual(['forward_compaction', 'look_back']);
    expect(registered.find((spec) => spec.name === 'forward_compaction')).toMatchObject({ description: FORWARD_TOOL_DESCRIPTION, inputSchema: FORWARD_INPUT_SCHEMA, isDeferred: false });
    expect(registered.find((spec) => spec.name === 'look_back')).toMatchObject({ description: LOOK_BACK_DESCRIPTION, inputSchema: LOOK_BACK_INPUT_SCHEMA });
  });

  it('registers each tool once however many hooks ask', async () => {
    const { registered, dispatch } = load();
    await dispatch('session.start', { reason: 'startup' });
    await dispatch('session.start', { reason: 'startup' });
    expect(registered).toHaveLength(2);
  });

  it('answers mcp__forward-compaction__look_back from the transcript before the latest compaction (R5)', async () => {
    const { home, dispatch } = load();
    const transcripts = join(home, '.claude', 'projects', '-work');
    mkdirSync(transcripts, { recursive: true });
    const line = (type: string, text: string, extra = {}) => JSON.stringify({ type, timestamp: '2026-01-02T03:04:05Z', message: { role: type, content: text }, ...extra });
    writeFileSync(join(transcripts, 'session-1.jsonl'), [line('user', 'earlier: connection refused on port 5432'), line('assistant', 'unrelated'), JSON.stringify({ type: 'system', subtype: 'compact_boundary' }), line('user', 'after')].join('\n') + '\n');
    await dispatch('session.start', { reason: 'startup' });
    const found = await dispatch('tool.call', { tool: 'mcp__forward-compaction__look_back', tool_use_id: 't1', query: 'connection refused' });
    expect(found.result).toContain('#1');
    expect(found.result).toContain('connection refused on port 5432');
    expect(found.result).not.toContain('after');
    const nothing = await dispatch('tool.call', { tool: 'mcp__forward-compaction__look_back', tool_use_id: 't2', query: 'absent words' });
    expect(nothing.result).toContain('No entry before the compaction at line 3 matches: absent, words');
    const refused = await dispatch('tool.call', { tool: 'mcp__forward-compaction__look_back', tool_use_id: 't3' });
    expect(refused.result).toBe('Look back failed: query or entry is required');
  });

  it('says nothing was compacted when the transcript holds no boundary, and passes any other tool call on', async () => {
    const { home, dispatch } = load();
    const transcripts = join(home, '.claude', 'projects', '-work');
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, 'session-1.jsonl'), JSON.stringify({ type: 'user', message: { content: 'x' } }) + '\n');
    await dispatch('session.start', { reason: 'startup' });
    expect((await dispatch('tool.call', { tool: 'mcp__forward-compaction__look_back', tool_use_id: 't1', query: 'x' })).result).toBe('Nothing has been compacted yet, so everything is still in context.');
    expect(await dispatch('tool.call', { tool: 'Read', tool_use_id: 't2', file_path: '/etc/hosts' }, async () => ({ result: 'passed' }))).toEqual({ result: 'passed' });
  });

  it('writes decision rows to the session file under HOME and flushes them at session.end', async () => {
    const { home, dispatch } = load();
    await dispatch('session.start', { reason: 'startup' });
    await dispatch('session.end', { reason: 'other' });
    const rows = readFileSync(join(home, '.local/state/forward-compaction/logs/decisions/session-1.jsonl'), 'utf8').trim().split('\n').map((row) => JSON.parse(row));
    expect(rows.map((row) => row.event)).toEqual(expect.arrayContaining(['start', 'tool-registered']));
  });

  it('names an invalid option on the screen, without the plugin name Claude Code already prints', async () => {
    const { screen, dispatch } = load({ FORWARD_COMPACTION_CEILING: 'abc' });
    await dispatch('session.start', { reason: 'startup' });
    expect(screen).toContain('env FORWARD_COMPACTION_CEILING is invalid (not an integer, a k/m value or a percentage: "abc"); using the default 60%');
  });
});
