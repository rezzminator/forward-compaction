import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { register } from '../plugins/sub-agent-compact/hooks/sub-agent-compact.ts';
import { optionVars } from './option-env.ts';

// The forward handoff through the adapter: the tool collects what code carries, stores the text and
// persists the call's files; the next automatic ask installs the stored text verbatim and checks it landed.

type AnyHook = (...args: any[]) => any;
const TOOL = 'mcp__sub-agent-compact__forward_handoff';
const DIR = '/h/u/.local/state/sub-agent-compact/forward-handoff/session-1/1';
/** Where records were kept before: under the Claude config directory, so a CLAUDE_CONFIG_DIR switch lost them. */
const LEGACY_DIR = '/h/u/.claude/sub-agent-compact/forward-handoff/session-1/1';
// Claude Code hashes a project path over 200 characters: the directory is not the cwd with dashes.
const TRANSCRIPT = '/h/u/.claude/projects/-nowhere-aaaa-0f3c9d/session-1.jsonl';
const AGENT_DIR = '/h/u/.local/state/sub-agent-compact/forward-handoff/session-1/agent-agent-1/1';
const FIELDS = { objective: 'Rename qty to quantity in every report', done: ['a.sql, b.sql: npm test 41/41'], remaining: ['c.sql'], next: 'Edit reports/c.sql:12, then run npm test.' };

const text = (t: string) => ({ type: 'text', text: t });
const api = (extra: unknown[] = []) => [
  { role: 'user', content: [text('rename qty to quantity in every report')] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/nowhere/reports/a.sql' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'SELECT qty' }] },
  ...extra,
  { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'mcp__sub-agent-compact__forward_handoff', input: FIELDS }] },
];

type Env = { registerOptions?: Record<string, unknown>; settings?: Record<string, Record<string, unknown>>; settingsReadFails?: string[]; homeGate?: Promise<void>; timers?: (() => void)[]; cwdFails?: boolean; vars?: Record<string, string>; envReadFails?: string[]; window?: number; decisionSessionFailsOnce?: boolean; decisionWriteFails?: boolean; uiFailsOnce?: boolean; home?: string; pluginLogDir?: string; pluginRunFails?: boolean; readFails?: string[]; denied?: string[]; listFails?: boolean; noHome?: boolean; noTranscript?: boolean; cwd?: string; agentRows?: Record<string, unknown[]>; agents?: { id: string; type: string }[]; run?: (argv: string[], init?: { cwd?: string }) => { exitCode: number; stdout: string; stderr: string } | undefined; appendWaits?: Promise<void>; decisionWriteAbortsOnce?: boolean; retentionFails?: string; retentionWaits?: Promise<void>; messagesFail?: boolean; pluginWaits?: Promise<void>; timersFire?: boolean; noClock?: boolean; claimFails?: boolean;
  agentEntries?: Record<string, { name: string; kind: 'file' | 'dir' | 'other'; size: number; isLink: boolean }[]>;
  agentStats?: Record<string, { kind: 'file' | 'dir' | 'other'; size: number }>;
  statFails?: string[];
  existsFails?: string[];
  writeFails?: string[];
  agentListFails?: boolean;
};
const pluginExec = promisify(execFile);

function engine(options: Record<string, unknown> = { forwardHandoffTool: true }, files: Record<string, string> = {}, apiRows: unknown[] = api(), git = true, refused: string[] = [], env: Env = {}) {
  const hooks = new Map<string, AnyHook>();
  const registered: string[] = [];
  const specs: Record<string, any> = {};
  const runCalls: string[][] = [];
  const fsWrites: string[] = [];
  const nextInputs: unknown[] = [];
  const written: Record<string, string> = {};
  const logs: string[] = [];
  let current = 0;
  let summarized = 0;
  let compactCalls = 0;
  let usageCalls = 0;
  const known: Record<string, string> = { [TRANSCRIPT]: '', ...files };
  const made = new Set<string>();
  // The options are set the only way the plugin reads them: as variables of the environment, which a test's own `vars` override.
  const vars: Record<string, string> = { ...optionVars(options), ...env.vars };
  const $ = {
    session: {
      id: async () => {
        if (env.decisionSessionFailsOnce) { env.decisionSessionFailsOnce = false; throw new Error('session lookup unavailable'); }
        return 'session-1';
      },
      turns: async () => 1,
      cwd: async () => {
        if (env.cwdFails) throw new Error('cwd unavailable');
        return env.cwd ?? '/nowhere';
      },
      usage: async () => { usageCalls++; return { context: { tokens: current, window: env.window ?? 1_000_000 } }; },
      messages: async (a?: { agentId?: string }) => {
        if (env.messagesFail) throw new Error('transcript gone');
        return a?.agentId !== undefined ? (env.agentRows?.[a.agentId] ?? []) : apiRows;
      },
      compact: async () => { compactCalls++; return {}; },
    },
    env: {
      get: async (key: string) => {
        if (env.envReadFails?.includes(key)) throw new Error('environment unavailable');
        if (key === 'HOME') await env.homeGate;
        return vars[key] ?? (key === 'PLUGIN_LOG_DIR' ? env.pluginLogDir : key === 'HOME' && !env.noHome ? env.home ?? '/h/u' : undefined);
      },
    },
    settings: {
      read: async (a?: { source?: string }) => {
        const source = a?.source ?? 'merged';
        if (env.settingsReadFails?.includes(source)) throw new Error(`the ${source} settings are unreadable`);
        return env.settings?.[source] ?? {};
      },
    },
    fs: {
      exists: async (path: string) => {
        if (env.existsFails?.includes(path)) throw new Error('EACCES');
        return path in known || path in written || Object.keys(written).some((p) => p.startsWith(`${path}/`));
      },
      read: async (path: string) => {
        if (env.readFails?.includes(path)) throw new Error('EACCES');
        return known[path] ?? written[path] ?? '';
      },
      write: async (path: string, content: string) => { if (env.writeFails?.includes(path)) throw new Error('write unavailable'); fsWrites.push(path); written[path] = content; },
      list: async (dir: string) => {
        if (env.listFails) throw new Error(`EACCES: permission denied, scandir '${dir}'`);
        if (env.agentEntries?.[dir]) return env.agentEntries[dir];
        const names = Object.keys(written).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1).split('/')[0]!);
        return [...new Set(names)].map((name) => ({ name, kind: 'dir' }));
      },
      stat: async (path: string) => {
        if (env.statFails?.includes(path)) throw new Error('EACCES');
        return { kind: 'file', size: (known[path] ?? '').length, mtimeMs: 0, isLink: false, ...env.agentStats?.[path] };
      },
    },
    process: {
      run: async (argv: string[], init?: { cwd?: string; stdin?: string }) => {
        runCalls.push(argv);
        // The decision log's append script, as its contract says: the rows on stdin are appended to the path after the script name.
        if (argv[0] === '/bin/sh' && argv[3] === 'decision-log') {
          const path = argv[4]!;
          await env.appendWaits;
          if (env.decisionWriteAbortsOnce) { env.decisionWriteAbortsOnce = false; throw new Error('sub-agent-compact: $.process.run(/bin/sh) aborted'); }
          if (env.decisionWriteFails) throw new Error('decision write unavailable');
          written[path] = (written[path] ?? '') + (init?.stdin ?? '');
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // The claim of a call number, as its script's contract says: the first number from $2 free in both session directories is made in the first.
        if (argv[0] === '/bin/sh' && argv[3] === 'forward-claim') {
          if (env.claimFails) return { exitCode: 1, stdout: '', stderr: 'mkdir: Permission denied' };
          const [dir, start, other] = [argv[4]!, Number(argv[5]), argv[6] ?? ''];
          const taken = (path: string) => made.has(path) || [...Object.keys(known), ...Object.keys(written)].some((p) => p.startsWith(`${path}/`));
          let n = start;
          while ((other !== '' && taken(`${other}/${n}`)) || taken(`${dir}/${n}`)) n++;
          made.add(`${dir}/${n}`);
          return { exitCode: 0, stdout: String(n), stderr: '' };
        }
        if (argv[0] === '/bin/sh' && argv[3] === 'decision-retention') {
          await env.retentionWaits;
          if (env.retentionFails !== undefined) throw new Error(env.retentionFails);
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (argv[0] === '/bin/sh' && argv[3] === 'plugin-log') {
          if (env.pluginRunFails) throw new Error('plugin process unavailable');
          await env.pluginWaits;
          const out = await pluginExec('/bin/sh', argv.slice(1), { encoding: 'utf8' });
          return { exitCode: 0, ...out };
        }
        const line = argv.join(' ');
        const scripted = env.run?.(argv, init);
        if (scripted !== undefined) return scripted;
        if (!git && argv[0] === 'git') return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' };
        if (line === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'main\n', stderr: '' };
        if (argv[0] === 'git' && argv[1] === '-C' && argv.slice(3).join(' ') === 'rev-parse --show-toplevel') {
          return argv[2] === '/nowhere' || argv[2]!.startsWith('/nowhere/') ? { exitCode: 0, stdout: '/nowhere\n', stderr: '' } : { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' };
        }
        if (argv[0] === 'find') return { exitCode: 0, stdout: env.noTranscript ? '' : `${TRANSCRIPT}\n`, stderr: '' };
        if (line === 'git rev-parse --short HEAD') return { exitCode: 0, stdout: 'abc1234\n', stderr: '' };
        if (line === 'git -c core.fsmonitor=false status --porcelain') return { exitCode: 0, stdout: ' M a.txt\n', stderr: '' };
        if (argv[0] === 'grep' && argv.includes('-c')) return { exitCode: 0, stdout: '812\n', stderr: '' };
        return { exitCode: 1, stdout: '', stderr: '' };
      },
    },
    clock: { now: async () => Date.parse('2026-10-14T15:20:31.123Z'), after: (ms: number, fn: () => void) => {
      if (env.noClock) throw new Error('no timers here');
      if (env.timers) {
        env.timers.push(fn);
        return { cancel: () => {} };
      }
      if (!env.timersFire) return { cancel: () => clearTimeout(setTimeout(fn, ms)) };
      const timer = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(timer) };
    } },
    ui: { log: (line: string) => {
      if (env.uiFailsOnce) { env.uiFailsOnce = false; throw new Error('screen unavailable'); }
      logs.push(line);
    } },
    agent: { list: async () => { if (env.agentListFails) throw new Error('agent list unavailable'); return env.agents ?? []; } },
    tool: {
      check: async (q: { tool: string; input: { file_path: string } }) =>
        env.denied?.includes(q.input.file_path) ? { decision: 'deny', reason: 'Permission to read this file has been denied.', rule: 'Read(.env)' } : { decision: 'allow' },
      register: async (spec: { name: string }) => {
        specs[spec.name] = spec;
        if (refused.includes(spec.name)) throw new Error(`${spec.name} refused`);
        registered.push(spec.name);
        return { tool: `mcp__sub-agent-compact__${spec.name}` };
      },
    },
  };
  const on = (event: string, hook: AnyHook) => void hooks.set(event, hook);
  register(on as never, (env.registerOptions ?? {}) as never);
  const dispatch = (event: string, e: unknown, impl: (e: any) => any, budgetMs?: number): any => {
    const next = Object.assign((input: unknown) => impl(input), { signal: new AbortController().signal }, budgetMs === undefined ? {} : { budget: { ms: budgetMs, remainingMs: budgetMs } });
    const hook = hooks.get(event);
    return hook ? hook($, e, next) : impl(e);
  };
  const rows = [
    { role: 'user', text: 'rename qty to quantity in every report', toolUses: [], handle: 'm0' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'f1', tool: TOOL, input: FIELDS }], handle: 'm1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'f1', text: 'Forward handoff stored', isError: false }], handle: 'm2' },
  ];
  return {
    rows: apiRows,
    registered,
    specs,
    runCalls,
    fsWrites,
    nextInputs,
    call: (e: Record<string, unknown>) => dispatch('tool.call', e, async (input) => { nextInputs.push(input); return { result: 'original result' }; }),
    decisions: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return Object.entries(written).filter(([path]) => path.endsWith('.jsonl')).flatMap(([, body]) => body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    },
    written,
    logs,
    summarized: () => summarized,
    compacts: () => compactCalls,
    usageCalls: () => usageCalls,
    turnComplete: (input: Record<string, unknown> = {}, next: () => Promise<unknown> = async () => ({})) => dispatch('turn.complete', input, next),
    start: () => dispatch('session.start', {}, async () => ({})),
    end: (reason = 'exit', budgetMs?: number) => dispatch('session.end', { reason, sessionId: 'session-1' }, async () => ({ sessionId: 'session-1' }), budgetMs),
    step: async (tokens: number, model = 'claude-opus-4-5[1m]', agentId?: string) => {
      current = tokens;
      const gen = dispatch('turn.step', { model, ...(agentId ? { agentId } : {}) }, async function* () {
        return { usage: { input_tokens: tokens }, answer: 'working', toolUses: [{}] };
      });
      for (;;) if ((await gen.next()).done) break;
    },
    stepAs: async (agentId: string, answer: string, tokens: number) => {
      current = tokens;
      const gen = dispatch('turn.step', { model: 'claude-opus-4-5[1m]', agentId }, async function* () {
        return { usage: { input_tokens: tokens }, answer, toolUses: [{}] };
      });
      for (;;) if ((await gen.next()).done) break;
    },
    /** A step that brought no usage: a hook answered it without a request, or the request failed (a prompt too long). */
    stepNoUsage: async (toolUses: number, model = 'claude-opus-4-5[1m]') => {
      const gen = dispatch('turn.step', { model }, async function* () {
        return { usage: null, answer: '', toolUses: Array.from({ length: toolUses }, () => ({})) };
      });
      for (;;) if ((await gen.next()).done) break;
    },
    forward: (fields: Record<string, unknown> = FIELDS, agentId?: string) =>
      dispatch('tool.call', { tool: TOOL, ...fields, tool_use_id: 'f1', ...(agentId ? { agentId } : {}) }, async () => ({ result: 'unreached' })),
    subagentStop: (e: Record<string, unknown>) => dispatch('classic.SubagentStop', e, async () => ({})),
    stop: (e: Record<string, unknown>) => dispatch('classic.Stop', e, async () => ({})),
    spawn: (e: Record<string, unknown>, agentId: string) => dispatch('agent.spawn', { tool_use_id: 't1', prompt: 'go', ...e }, async () => ({ model: 'claude-opus-4-5', agentId })),
    read: (agentId?: string) => dispatch('tool.call', { tool: 'Read', file_path: 'x', ...(agentId ? { agentId } : {}) }, async () => ({ result: 'file text' })),
    /** A compaction Claude Code itself left unfinished: its summary was skipped beneath the plugin. */
    askUnfinished: (trigger: string) => dispatch('session.compact', { trigger, messages: rows }, async () => ({ skip: 'prompt is too long' })),
    ask: (trigger: string, messages: unknown[] = rows, extra: Record<string, unknown> = {}) =>
      dispatch('session.compact', { trigger, messages, ...extra }, async () => {
        summarized++;
        return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensAfter: 20_000 };
      }),
  };
}

describe('the forward handoff tool through the adapter', () => {
  it('is not registered unless forwardHandoffTool is on', async () => {
    const off = engine({});
    await off.start();
    expect(off.registered).toEqual(['compact', 'look_back']);
    const on = engine();
    await on.start();
    expect(on.registered.sort()).toEqual(['forward_handoff', 'look_back']);
  });

  const FORWARD = 'SUB_AGENT_COMPACT_FORWARD_HANDOFF_TOOL';

  // R5: with no pluginConfigs entry (an empty options object), the variable alone offers the tool.
  it.each(['1', 'true', ' TRUE '])('registers forward_handoff from the environment alone: %j, options {}', async (value) => {
    const cc = engine({}, {}, api(), true, [], { vars: { [FORWARD]: value }, registerOptions: {} });
    await cc.start();
    expect(cc.registered.sort()).toEqual(['forward_handoff', 'look_back']);
    expect(cc.logs.filter((line) => line.includes(FORWARD))).toEqual([]);
  });

  it('lets the environment turn the forward handoff off', async () => {
    const cc = engine({ forwardHandoffTool: true }, {}, api(), true, [], { vars: { [FORWARD]: 'false' } });
    await cc.start();
    expect(cc.registered.sort()).toEqual(['compact', 'look_back']);
  });

  it('names a bad environment value on the screen and registers by the default', async () => {
    const cc = engine({}, {}, api(), true, [], { vars: { [FORWARD]: 'sure' } });
    await cc.start();
    expect(cc.registered.sort()).toEqual(['compact', 'look_back']);
    expect(cc.logs.filter((line) => line.includes(FORWARD))).toEqual([expect.stringMatching(/env SUB_AGENT_COMPACT_FORWARD_HANDOFF_TOOL is invalid.*"sure".*using the default false/)]);
  });

  it('names a variable that could not be read and registers by the default', async () => {
    const cc = engine({ forwardHandoffTool: true }, {}, api(), true, [], { envReadFails: [FORWARD] });
    await cc.start();
    expect(cc.registered.sort()).toEqual(['compact', 'look_back']);
    expect(cc.logs.filter((line) => line.includes(FORWARD))).toEqual([expect.stringMatching(/reading SUB_AGENT_COMPACT_FORWARD_HANDOFF_TOOL failed: environment unavailable.*using the default/)]);
  });

  describe('a leftover pluginConfigs entry', () => {
    const left = { forwardHandoffTool: true, mainAutoCompact: '300k', logFile: '/logs/decisions.jsonl' };
    it('found in the settings, register handed none: applies none of its options and names their keys once; a source that cannot be read is said', async () => {
      const settings = {
        user: { pluginConfigs: { 'sub-agent-compact@sub-agent-compact': { options: { forwardHandoffTool: true } }, 'other@x': { options: { colour: 'red' } } } },
        local: { pluginConfigs: { 'sub-agent-compact@inline': { options: { mainAutoCompact: '300k', forwardHandoffTool: true } } } },
      };
      const cc = engine({}, {}, api(), true, [], { registerOptions: {}, settings, settingsReadFails: ['policy'] });
      await cc.start();
      await cc.start();
      expect(cc.registered.sort()).toEqual(['compact', 'look_back']);
      expect(cc.logs.filter((line) => line.includes('SUB_AGENT_COMPACT_*'))).toEqual([expect.stringMatching(/^options forwardHandoffTool, mainAutoCompact are not read; set SUB_AGENT_COMPACT_\* environment variables instead.*not applied/)]);
      expect(cc.logs.filter((line) => line.includes('policy settings'))).toEqual([]);
    });
    it('handed to register: applies none of them and says so once, naming the keys', async () => {
      const cc = engine({}, {}, api(), true, [], { registerOptions: left });
      await cc.start();
      await cc.start();
      expect(cc.registered.sort()).toEqual(['compact', 'look_back']);
      const said = cc.logs.filter((line) => line.includes('SUB_AGENT_COMPACT_'));
      expect(said).toEqual([expect.stringMatching(/^options forwardHandoffTool, mainAutoCompact, logFile are not read; set SUB_AGENT_COMPACT_\* environment variables instead.*not applied/)]);
      expect(said[0]).not.toContain('300k');
      expect(said[0]).not.toContain('/logs/decisions.jsonl');
    });
    it('lets the environment decide beside them', async () => {
      const cc = engine({}, {}, api(), true, [], { registerOptions: left, vars: { [FORWARD]: '1' } });
      await cc.start();
      expect(cc.registered.sort()).toEqual(['forward_handoff', 'look_back']);
    });
    it('says nothing for an empty options object', async () => {
      const cc = engine({}, {}, api(), true, [], { registerOptions: {} });
      await cc.start();
      expect(cc.logs.filter((line) => line.includes('SUB_AGENT_COMPACT_'))).toEqual([]);
    });
  });

  const MARKER = 'Parts 1-2 done.\n<compact-now>next: part 3</compact-now>';
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('arms a sub-agent on its marker (control)', async () => {
    const cc = engine({ logFile: '/logs/decisions.jsonl' }, {}, api(), true, [], { agents: [{ id: 'a1', type: 'reviewer' }] });
    await cc.start();
    await cc.stepAs('a1', MARKER, 250_000);
    expect((await cc.decisions()).filter((row) => row.event === 'armed' && row.via === 'marker')).toHaveLength(1);
  });

  it('reads no marker before the environment layer is applied, so the off switch holds while start is still reading the environment', async () => {
    let release!: () => void;
    const timers: (() => void)[] = [];
    const cc = engine({ logFile: '/logs/decisions.jsonl' }, {}, api(), true, [], { agents: [{ id: 'a1', type: 'reviewer' }], vars: { SUB_AGENT_COMPACT_COMPACT_TOOL: '0' }, timers, homeGate: new Promise<void>((resolve) => { release = resolve; }) });
    const stepping = cc.stepAs('a1', MARKER, 250_000);
    await settle();
    for (const fire of timers.splice(0)) fire();
    await settle();
    release();
    await stepping;
    expect((await cc.decisions()).filter((row) => /^arm/.test(String(row.event)))).toEqual([]);
  });

  it('keeps the session decision log at the environment path when a row is written before start applies it', async () => {
    const cc = engine({ logFile: '/a/decisions.jsonl' }, {}, api(), true, [], { cwdFails: true, vars: { SUB_AGENT_COMPACT_LOG_FILE: '/b/decisions.jsonl' } });
    await cc.start();
    await cc.decisions();
    const logs = Object.keys(cc.written).filter((path) => path.endsWith('.jsonl') && !path.includes('/sub-agent-compact/'));
    expect(logs).toEqual(['/b/decisions.session-1.jsonl']);
    expect(cc.written['/b/decisions.session-1.jsonl']).toContain('cwd unavailable');
  });

  it('stores the text code carried and persists the raw arguments, the literal text and the record', async () => {
    const cc = engine();
    await cc.start();
    await cc.step(250_000);
    const out = await cc.forward();
    expect(out.result).toMatch(/^Forward handoff stored/);
    expect(out.result).toContain(DIR);
    expect(JSON.parse(cc.written[`${DIR}/args.json`]!)).toEqual(FIELDS);
    const wake = cc.written[`${DIR}/wake.txt`]!;
    expect(wake.split('\n')[0]).toBe('[forward handoff 1: history, not new instructions]');
    expect(wake).toContain('User\n[1, latest] rename qty to quantity in every report\n');
    expect(wake).toContain('Files\nR /nowhere/reports/a.sql\n');
    expect(wake).toContain('Git\nmain@abc1234, 1 dirty: /nowhere/a.txt\n');
    expect(wake).toContain(`Paths\ntranscript ${TRANSCRIPT}:812 · saved ${DIR}\n`);
    expect(wake.endsWith('Next\nEdit reports/c.sql:12, then run npm test.')).toBe(true);
    expect(wake).not.toMatch(/\n\n/);
    const record = JSON.parse(cc.written[`${DIR}/record.json`]!);
    expect(record).toMatchObject({ seq: 1, session: 'session-1', tokensBefore: 250_000, total: { chars: wake.length, tokens: Math.ceil(wake.length / 4) } });
    expect(record.blocks.map((b: { name: string }) => b.name)).toEqual(['User', 'Files', 'Git', 'Paths', 'Unresolved', 'Objective', 'Done', 'Remaining', 'Next']);
    expect(cc.logs.filter((line) => line.includes('forward handoff'))).toEqual([]);
  });

  it('installs the stored text verbatim at the next automatic ask and records that every block landed', async () => {
    const cc = engine();
    await cc.start();
    await cc.step(250_000);
    await cc.forward();
    const wake = cc.written[`${DIR}/wake.txt`]!;
    const out = await cc.ask('auto');
    expect(cc.summarized()).toBe(0);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].text).toBe(wake);
    const rows = cc.rows;
    rows.splice(0, rows.length, { role: 'user', content: [text(wake)] });
    await cc.step(30_000);
    const record = JSON.parse(cc.written[`${DIR}/record.json`]!);
    expect(record.tokensAfter).toBe(out.tokensAfter);
    expect(record.install).toMatchObject({ ok: true, missing: [], landed: record.blocks.length });
    expect(cc.logs.filter((line) => /handoff/.test(line))).toEqual([]);
    expect(cc.logs.filter((line) => line.startsWith('sub-agent-compact:'))).toEqual([]);
  });

  it('says in the installed row and its said line that the after-size counts the messages only', async () => {
    const cc = engine({ forwardHandoffTool: true, compactTool: false, logFile: '/logs/decisions.jsonl' });
    await cc.start();
    await cc.step(250_000);
    await cc.forward();
    const wake = cc.written[`${DIR}/wake.txt`]!;
    await cc.ask('auto');
    cc.rows.splice(0, cc.rows.length, { role: 'user', content: [text(wake)] });
    await cc.step(30_000);
    const rows = await cc.decisions();
    expect(rows.filter((r: any) => r.event === 'forward-installed').map((r: any) => r.tokensAfterScope)).toEqual(['messages']);
    expect(rows.filter((r: any) => r.event === 'session.compact' && r.decision === 'handoff').map((r: any) => r.tokensAfterScope)).toEqual(['messages']);
    expect(rows.filter((r: any) => r.event === 'said' && /^forward handoff 1/.test(r.line)).map((r: any) => r.line)).toEqual([expect.stringMatching(/^forward handoff 1 of main: 250k -> \S+ tokens in messages \(system prompt and tools not counted\), /)]);
  });

  it('leaves a Haiku main chat to Claude Code: no nudge, no forced point, no hold, and its forward handoff refused unstored', async () => {
    const cc = engine({ forwardHandoffTool: true, compactTool: false, logFile: '/logs/decisions.jsonl' });
    await cc.start();
    await cc.step(170_000, 'claude-haiku-4-5');
    expect((await cc.read()).context ?? []).toEqual([]);
    await cc.turnComplete();
    expect(cc.compacts()).toBe(0);
    const out = await cc.forward();
    expect(out.result).toMatch(/^Not stored: .*Haiku/);
    expect(cc.written[`${DIR}/wake.txt`]).toBeUndefined();
    await cc.ask('auto');
    expect(cc.summarized()).toBe(1);
    const rows = await cc.decisions();
    expect(rows.filter((r: any) => ['nudge', 'forward-stored', 'turn.complete', 'handoff'].includes(r.event) || r.decision === 'skip')).toEqual([]);
    expect(rows.find((r: any) => r.event === 'forward-refused')).toMatchObject({ party: 'main', why: 'haiku' });
    expect(rows.find((r: any) => r.event === 'session.compact')).toMatchObject({ decision: 'pass', why: 'haiku' });
  });

  it('checks the install against what the session holds at the next step, and names a block that did not land', async () => {
    const cc = engine();
    await cc.start();
    await cc.step(250_000);
    await cc.forward();
    const wake = cc.written[`${DIR}/wake.txt`]!;
    await cc.ask('auto');
    expect(JSON.parse(cc.written[`${DIR}/record.json`]!).install).toBeUndefined();
    cc.rows.splice(0, cc.rows.length, { role: 'user', content: [text(wake.replace(/\nGit\n[^\n]*/, ''))] });
    await cc.step(30_000);
    expect(JSON.parse(cc.written[`${DIR}/record.json`]!).install).toMatchObject({ ok: false, missing: ['Git'] });
    expect((await cc.read()).context?.join('\n')).toContain('did not land: Git');
  });

  it('refuses a load_files path the Read tool may not read, and a load_files that is not a list, naming each in the text', async () => {
    const cc = engine({ forwardHandoffTool: true }, { '/nowhere/.env': 'SECRET=1', '/nowhere/ok.ts': 'fine' }, api(), true, [], { denied: ['/nowhere/.env'] });
    await cc.start();
    await cc.step(250_000);
    await cc.forward({ ...FIELDS, load_files: [{ path: '.env', why: 'x' }, { path: 'ok.ts', why: 'y' }] });
    const wake = cc.written[`${DIR}/wake.txt`]!;
    expect(wake).not.toContain('SECRET');
    expect(wake).toContain('Load /nowhere/ok.ts\nfine\n');
    expect(wake).toContain('load /nowhere/.env: Read deny: Permission to read this file has been denied.');
    const bad = engine();
    await bad.start();
    await bad.forward({ ...FIELDS, load_files: 'ok.ts' });
    expect(bad.written[`${DIR}/wake.txt`]).toContain('load_files: not a list');
  });

  it('numbers two calls apart even when both list the directory before either writes', async () => {
    const cc = engine();
    await cc.start();
    await Promise.all([cc.forward(), cc.forward()]);
    expect(Object.keys(cc.written).filter((p) => p.endsWith('/wake.txt')).sort()).toEqual([`${DIR}/wake.txt`, DIR.replace(/1$/, '2/wake.txt')]);
  });

  it('saves nothing over an earlier call when listing the directory fails, and says so', async () => {
    const cc = engine({ forwardHandoffTool: true }, { [DIR.replace(/\/1$/, '')]: '' }, api(), true, [], { listFails: true });
    await cc.start();
    const out = await cc.forward();
    expect(Object.keys(cc.written)).toEqual([]);
    expect(out.result).toMatch(/Not saved to disk: listing .* failed: EACCES/);
    expect(cc.logs.some((line) => line.includes('EACCES'))).toBe(true);
    // Claiming the number fails: nothing written, and the person reads why.
    const claim = engine({ forwardHandoffTool: true }, {}, api(), true, [], { claimFails: true });
    await claim.start();
    const refused = await claim.forward();
    expect(Object.keys(claim.written)).toEqual([]);
    expect(refused.result).toMatch(/Not saved to disk: claiming a call number in \S+ failed: exit 1: mkdir: Permission denied\./);
  });

  it('saves nothing into the project when neither HOME nor a Claude config directory is known, and says so', async () => {
    const cc = engine({ forwardHandoffTool: true }, {}, api(), true, [], { noHome: true });
    await cc.start();
    const out = await cc.forward();
    expect(Object.keys(cc.written)).toEqual([]);
    expect(out.result).toMatch(/Not saved to disk: neither HOME nor CLAUDE_CONFIG_DIR is set/);
  });

  it('returns one nudge for a missing required field and stores nothing', async () => {
    const cc = engine();
    await cc.start();
    await cc.step(250_000);
    const out = await cc.forward({ objective: 'x', done: [], remaining: [] });
    expect(out.result).toMatch(/^Not stored: required field missing: next/);
    expect(Object.keys(cc.written)).toEqual([]);
    expect(await cc.ask('auto')).toEqual({ skip: expect.any(String) });
  });

  it('reads load_files from disk honouring the range, and reports a missing path and an unknown drop_skills in the text', async () => {
    const cc = engine({ forwardHandoffTool: true }, { '/nowhere/src/z.ts': 'a\nb\nc\nd' });
    await cc.start();
    await cc.step(250_000);
    await cc.forward({
      ...FIELDS,
      load_files: [{ path: 'src/z.ts', lines: '2-3', why: 'edit here' }, { path: 'nope.ts', why: 'x' }],
      drop_skills: ['zzz'],
    });
    const wake = cc.written[`${DIR}/wake.txt`]!;
    expect(wake).toContain('Load /nowhere/src/z.ts:2-3\nb\nc\n');
    expect(wake).toContain('Unresolved\nload /nowhere/nope.ts: not found\ndrop_skills zzz: not invoked since the last compaction (any earlier invocation was compacted away), so there is nothing to drop; leave it out of drop_skills\n');
    // An unreadable transcript checks nothing: the name is unchecked, never called not invoked.
    const env: Env = {};
    const blind = engine({ forwardHandoffTool: true }, {}, api(), true, [], env);
    await blind.start();
    await blind.step(250_000);
    env.messagesFail = true;
    await blind.forward({ ...FIELDS, drop_skills: ['zzz'] });
    expect(blind.written[`${DIR}/wake.txt`]).toContain('drop_skills zzz: unchecked, the transcript is unreadable\n');
  });

  it('reloads an invoked skill from the directory the harness printed, minus drop_skills', async () => {
    const rows = api([
      { role: 'user', content: [text('<command-message>design</command-message>\n<command-name>/design</command-name>\n<command-args>a page</command-args>')] },
      { role: 'user', content: [text('Base directory for this skill: /plug/skills/design\n\nold body')] },
      { role: 'user', content: [text('<command-message>gone</command-message>\n<command-name>/gone</command-name>\n<command-args></command-args>')] },
    ]);
    const cc = engine({ forwardHandoffTool: true }, { '/plug/skills/design/SKILL.md': '---\nname: design\n---\n# Design\nfresh body' }, rows);
    await cc.start();
    await cc.step(250_000);
    await cc.forward();
    const wake = cc.written[`${DIR}/wake.txt`]!;
    expect(wake).toContain('Skill design\n# Design\nfresh body\n');
    expect(wake).not.toContain('name: design');
    expect(wake).toMatch(/Unresolved\nskill gone: [^\n]+/);
    expect(wake).toContain('[2] /design a page');
    cc.written[`${DIR}/wake.txt`] = '';
    const dropped = engine({ forwardHandoffTool: true }, { '/plug/skills/design/SKILL.md': 'body' }, rows);
    await dropped.start();
    await dropped.step(250_000);
    await dropped.forward({ ...FIELDS, drop_skills: ['design', 'gone'] });
    expect(dropped.written[`${DIR}/wake.txt`]).not.toContain('Skill design');
    expect(dropped.written[`${DIR}/wake.txt`]).not.toContain('skill gone');
  });

  it('says why git is missing instead of leaving it out silently', async () => {
    const cc = engine({ forwardHandoffTool: true }, {}, api(), false);
    await cc.start();
    await cc.step(250_000);
    await cc.forward();
    const wake = cc.written[`${DIR}/wake.txt`]!;
    expect(wake).not.toContain('\nGit\n');
    expect(wake).toContain('Unresolved\ngit: fatal: not a git repository\n');
  });

  it('serves a sub-agent: its own prompts from its own messages, its own directory, its own armed handoff', async () => {
    const agentRows = { 'agent-1': [{ role: 'user', content: [text('Review the diff of branch x and report findings.')] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'mcp__sub-agent-compact__forward_handoff', input: FIELDS }] }] };
    const cc = engine({ forwardHandoffTool: true }, {}, api(), true, [], { agentRows, agents: [{ id: 'agent-1', type: 'reviewer' }] });
    await cc.start();
    const out = await cc.forward(FIELDS, 'agent-1');
    expect(out.result).toMatch(/^Forward handoff stored/);
    expect(out.result).toContain(AGENT_DIR);
    const wake = cc.written[`${AGENT_DIR}/wake.txt`]!;
    expect(wake).toContain('User\n[1, latest, handed off in reply] Review the diff of branch x and report findings.\n');
    expect(wake).not.toContain('rename qty');
    expect(JSON.parse(cc.written[`${AGENT_DIR}/record.json`]!)).toMatchObject({ agentId: 'agent-1', users: ['Review the diff of branch x and report findings.'] });
    expect(Object.keys(cc.written).filter((p) => p.startsWith(DIR))).toEqual([]);
  });

  it.each([
    ['in the directory its spawn named', { cwd: '/work/other' }, '/work/other/tmp/notes.md'],
    ["in the parent's directory at its spawn", {}, '/nowhere/tmp/notes.md'],
  ])("places a sub-agent's relative shell write %s, never under a later session directory", async (_name, spawn, path) => {
    const write = { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: "cat >> tmp/notes.md <<'EOF'\nx\nEOF" } }] };
    const agentRows = { 'agent-1': [{ role: 'user', content: [text('Write the notes.')] }, write, { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'mcp__sub-agent-compact__forward_handoff', input: FIELDS }] }] };
    const env: Env = { agentRows, agents: [{ id: 'agent-1', type: 'reviewer' }] };
    const cc = engine({ forwardHandoffTool: true }, {}, api(), true, [], env);
    await cc.start();
    await cc.spawn(spawn, 'agent-1');
    // The main chat's shell moved on after the spawn: the sub-agent still runs where it started.
    env.cwd = '/elsewhere';
    await cc.forward(FIELDS, 'agent-1');
    const files = cc.written[`${AGENT_DIR}/wake.txt`]!.split('\nFiles\n')[1]!.split('\n')[0];
    expect(files).toBe(`E ${path}`);
  });

  it('chains the prompts: the second handoff carries the first one from its record, then those since, and records them', async () => {
    const cc = engine();
    await cc.start();
    await cc.step(250_000);
    await cc.forward();
    const wake1 = cc.written[`${DIR}/wake.txt`]!;
    await cc.ask('auto');
    cc.rows.splice(0, cc.rows.length, { role: 'user', content: [text(wake1)] }, { role: 'user', content: [text('second ask')] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'mcp__sub-agent-compact__forward_handoff', input: FIELDS }] });
    await cc.step(250_000);
    await cc.forward();
    const dir2 = DIR.replace(/1$/, '2');
    const wake2 = cc.written[`${dir2}/wake.txt`]!;
    expect(wake2).toContain('User\n[1] rename qty to quantity in every report\n[2, latest, handed off in reply] second ask\n');
    expect(wake2).toContain(`previous ${DIR}`);
    expect(JSON.parse(cc.written[`${dir2}/record.json`]!)).toMatchObject({ users: ['rename qty to quantity in every report', 'second ask'], usersDropped: 0 });
  });

  it('installs a forward handoff stored before a plugin reload, from its saved files', async () => {
    const first = engine();
    await first.start();
    await first.step(250_000);
    const out = await first.forward();
    // A new plugin process: nothing held, the saved files on disk, the stored call standing in the transcript.
    const cc = engine({ forwardHandoffTool: true, logFile: '/logs/decisions.jsonl' }, { [`${DIR}/wake.txt`]: first.written[`${DIR}/wake.txt`]!, [`${DIR}/record.json`]: first.written[`${DIR}/record.json`]! });
    await cc.start();
    await cc.step(250_000);
    const rows = [
      { role: 'user', text: 'rename qty to quantity in every report', toolUses: [], handle: 'm0' },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'f1', tool: TOOL, input: FIELDS }], handle: 'm1' },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'f1', text: out.result, isError: false }], handle: 'm2' },
    ];
    const result = await cc.ask('auto', rows);
    expect(cc.summarized()).toBe(0);
    expect(JSON.stringify(result)).toContain('rename qty to quantity in every report');
    expect((await cc.decisions()).find((r: any) => r.decision === 'handoff')).toMatchObject({ recovered: true });
  });

  it('chains from a record kept under the config directory before, numbering past it, under the HOME root', async () => {
    const cc = engine();
    await cc.start();
    await cc.step(250_000);
    await cc.forward();
    const wake1 = cc.written[`${DIR}/wake.txt`]!;
    await cc.ask('auto');
    cc.rows.splice(0, cc.rows.length, { role: 'user', content: [text(wake1)] }, { role: 'user', content: [text('second ask')] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'mcp__sub-agent-compact__forward_handoff', input: FIELDS }] });
    await cc.step(250_000);
    // The first call's files as an earlier version left them: under the config directory only.
    for (const path of Object.keys(cc.written).filter((p) => p.startsWith(`${DIR}/`))) {
      cc.written[`${LEGACY_DIR}/${path.slice(DIR.length + 1)}`] = cc.written[path]!;
      delete cc.written[path];
    }
    await cc.forward();
    const wake2 = cc.written[DIR.replace(/1$/, '2') + '/wake.txt']!;
    expect(wake2).toContain('User\n[1] rename qty to quantity in every report\n[2, latest, handed off in reply] second ask\n');
    expect(wake2).toMatch(new RegExp(`previous ${LEGACY_DIR}( ·|\n)`));
    expect(wake2).not.toContain(`previous ${DIR}`);
  });

  it('chains the file trail: the second handoff lists the files touched since, then those the first one carried', async () => {
    const cc = engine();
    await cc.start();
    await cc.step(250_000);
    await cc.forward();
    const wake1 = cc.written[`${DIR}/wake.txt`]!;
    await cc.ask('auto');
    cc.rows.splice(0, cc.rows.length, { role: 'user', content: [text(wake1)] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'reports/c.sql' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'mcp__sub-agent-compact__forward_handoff', input: FIELDS }] });
    await cc.step(250_000);
    await cc.forward();
    const dir2 = DIR.replace(/1$/, '2');
    expect(cc.written[`${dir2}/wake.txt`]).toContain('Files\nE /nowhere/reports/c.sql\nR /nowhere/reports/a.sql\n');
    expect(JSON.parse(cc.written[`${dir2}/record.json`]!).trail).toEqual([{ tag: 'E', path: '/nowhere/reports/c.sql' }, { tag: 'R', path: '/nowhere/reports/a.sql' }]);
  });

  it('outlines current file content and diagnoses missing paths in every supported form', async () => {
    for (const [path, resolved, unreadable = false] of [
      ['src/gone.ts', '/nowhere/src/gone.ts'],
      ['/nowhere/src/gone.ts', '/nowhere/src/gone.ts'],
      ['file:///nowhere/src/gone.ts', '/nowhere/src/gone.ts'],
      ['~/src/gone.ts', '/h/u/src/gone.ts'],
      ['src/private.ts', '/nowhere/src/private.ts', true],
    ] as [string, string, boolean?][]) {
      const rows = [{ role: 'user', content: [text('build it')] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'src/levels.ts', content: 'x' } }, { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: path } }] }];
      const cc = engine({ forwardHandoffTool: true }, { '/nowhere/src/levels.ts': 'export const LEVELS = [1];\nexport function rank() {}\n', ...(unreadable ? { [resolved]: 'private' } : {}) }, rows, true, [], { readFails: unreadable ? [resolved] : [] });
      await cc.start();
      await cc.step(250_000);
      expect((await cc.forward()).result).toContain('Forward handoff stored');
      const wake = cc.written[`${DIR}/wake.txt`]!;
      if (path === 'src/gone.ts') expect(wake).toContain('C /nowhere/src/levels.ts — 2 lines: LEVELS, rank\n');
      expect(wake).toContain(`E ${resolved}\n`);
      expect.soft(wake).toContain(unreadable
        ? `outline ${resolved}: unreadable: EACCES\n`
        : `outline ${resolved}: not found; check the prior file-tool path (absolute or relative to session cwd /nowhere); the file may have moved or been deleted\n`);
    }
  });

  it("lists the files touched before Claude Code's own compaction, read from the transcript", async () => {
    const entry = (n: number, o: Record<string, unknown>) => `${n}:${JSON.stringify(o)}`;
    const run = (argv: string[]) => {
      if (argv[0] === 'grep' && argv.includes('"subtype":"compact_boundary"')) return { exitCode: 0, stdout: '40:{"type":"system","subtype":"compact_boundary"}\n', stderr: '' };
      if (argv[0] === 'sh' && argv[2]!.includes('"type":"assistant"')) {
        expect(argv.slice(4)).toEqual([TRANSCRIPT, '40']);
        return { exitCode: 0, stdout: `${entry(12, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r0', name: 'Read', input: { file_path: '/nowhere/team/roster.md' } }] } })}\n`, stderr: '' };
      }
      return undefined;
    };
    const rows = [
      { role: 'user', content: [text('<system-reminder>\nAs you answer the user, you can use this context.\n</system-reminder>'), text('This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. Primary Request and Intent:\n   Rename qty.\n\n5. Problem Solving:\n   - b.sql uses qty only in views.\n\n7. Pending Tasks:\n   - c.sql')] },
      ...api().slice(1),
    ];
    const cc = engine({ forwardHandoffTool: true }, {}, rows, true, [], { run });
    await cc.start();
    await cc.step(250_000);
    await cc.forward();
    expect(cc.written[`${DIR}/wake.txt`]).toContain('Files\nR /nowhere/reports/a.sql\nR /nowhere/team/roster.md\n');
    expect(cc.written[`${DIR}/wake.txt`]).toContain('Earlier summary\nProblem Solving:\n- b.sql uses qty only in views.\nFiles\n');
    expect(JSON.parse(cc.written[`${DIR}/record.json`]!).summary).toBe('Problem Solving:\n- b.sql uses qty only in views.');
  });

  it('sends back once a next that opens by re-reading a loaded file, then stores the same call', async () => {
    const cc = engine({ forwardHandoffTool: true }, { '/nowhere/reports/c.sql': 'select 1;' });
    await cc.start();
    await cc.step(250_000);
    const fields = { ...FIELDS, next: 'Read reports/c.sql, then edit line 12', load_files: [{ path: 'reports/c.sql', why: 'the last report' }] };
    expect((await cc.forward(fields)).result).toMatch(/^Not stored: `next` opens by reading reports\/c\.sql, which load_files/);
    expect(cc.written[`${DIR}/wake.txt`]).toBeUndefined();
    expect((await cc.forward(fields)).result).toMatch(/^Forward handoff stored/);
  });

  it('refuses a second handoff from a party that woke from one while its context is below its first nudge point', async () => {
    const cc = engine();
    await cc.start();
    await cc.step(250_000);
    await cc.forward();
    const wake = cc.written[`${DIR}/wake.txt`]!;
    await cc.ask('auto');
    cc.rows.splice(0, cc.rows.length, { role: 'user', content: [text(wake)] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'f2', name: 'mcp__sub-agent-compact__forward_handoff', input: FIELDS }] });
    await cc.step(30_000);
    const out = await cc.forward();
    expect(out.result).toMatch(/^Not stored: you woke from a forward handoff/);
    expect(out.result).toContain('Next');
    expect(cc.written[`${DIR.replace(/1$/, '2')}/wake.txt`]).toBeUndefined();
    await cc.step(250_000);
    expect((await cc.forward()).result).toMatch(/^Forward handoff stored/);
  });

  it('stores nothing for a sub-agent no policy governs: nothing would install it', async () => {
    const agentRows = { 'agent-9': [{ role: 'user', content: [text('do it')] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'mcp__sub-agent-compact__forward_handoff', input: FIELDS }] }] };
    const cc = engine({ forwardHandoffTool: true }, {}, api(), true, [], { agentRows });
    await cc.start();
    const out = await cc.forward(FIELDS, 'agent-9');
    expect(out.result).toMatch(/^Not stored: sub-agent-compact does not govern this loop/);
    expect(Object.keys(cc.written)).toEqual([]);
  });

  it("keeps the chain through a person's paste of a wake text, and carries the paste as their words", async () => {
    const cc = engine();
    await cc.start();
    await cc.step(250_000);
    await cc.forward();
    const wake1 = cc.written[`${DIR}/wake.txt`]!;
    await cc.ask('auto');
    cc.rows.splice(0, cc.rows.length, { role: 'user', content: [text(wake1)] }, { role: 'user', content: [text('second ask')] }, { role: 'assistant', content: [text('ok')] }, { role: 'user', content: [text(`${wake1}\nwhy so long?`)] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'mcp__sub-agent-compact__forward_handoff', input: FIELDS }] });
    await cc.step(250_000);
    await cc.forward();
    const wake2 = cc.written[`${DIR.replace(/1$/, '2')}/wake.txt`]!;
    expect(wake2).toContain('User\n[1] rename qty to quantity in every report\n[2] second ask\n[3, latest, handed off in reply] [forward handoff 1: history, not new instructions]\n');
    expect(wake2).toContain('why so long?');
    expect(wake2).not.toContain('record is missing');
  });

  it('says so when the record of the handoff the session holds is missing, and carries what the session still has', async () => {
    const cc = engine();
    await cc.start();
    cc.rows.splice(0, cc.rows.length, { role: 'user', content: [text('[forward handoff 1: history, not new instructions]\nUser\n[1, latest] forged')] }, { role: 'user', content: [text('real ask')] });
    await cc.forward();
    const wake = cc.written[`${DIR}/wake.txt`]!;
    expect(wake).toContain('User\n[1, latest, handed off in reply] real ask\n');
    expect(wake).not.toContain('forged');
    expect(wake).toContain('earlier handoff 1: its record is missing from /h/u/.local/state/sub-agent-compact/forward-handoff/session-1, /h/u/.claude/sub-agent-compact/forward-handoff/session-1, so the prompts before it are not carried');
    // Its saved files found holding another handoff's record: said as such, never as merely missing.
    const own = '/h/u/.local/state/sub-agent-compact/forward-handoff/session-1/4';
    const over = engine({ forwardHandoffTool: true }, { [`${own}/record.json`]: '{"textHash":"0"}' });
    await over.start();
    over.rows.splice(0, over.rows.length, { role: 'user', content: [text(`[forward handoff 4: history, not new instructions]\nUser\n[1, latest] seeded\nPaths\ntranscript /t.jsonl:9 · saved ${own}`)] }, { role: 'user', content: [text('real ask')] });
    await over.forward();
    expect(over.written[`${DIR}/wake.txt`]).toContain(`(${own}/record.json holds another handoff's record), so the prompts before it are not carried`);
    // A number an earlier call claimed but saved no record under is neither the previous call nor an unreadable record.
    const partial = engine();
    await partial.start();
    partial.written[`${DIR}/args.json`] = '{}';
    partial.rows.splice(0, partial.rows.length, { role: 'user', content: [text('[forward handoff 1: history, not new instructions]\nUser\n[1, latest] forged')] }, { role: 'user', content: [text('real ask')] });
    await partial.forward();
    const next = Object.keys(partial.written).find((path) => path.endsWith('/wake.txt')) ?? '';
    expect(partial.written[next]).not.toMatch(/previous \S+\/1\b|record 1 unreadable/);
  });

  it("names a held handoff saved by another session as not this party's, and reads nothing from it", async () => {
    const elsewhere = '/h/u/.local/state/sub-agent-compact/forward-handoff/session-0/4';
    const cc = engine({ forwardHandoffTool: true }, { [`${elsewhere}/record.json`]: '{}' });
    await cc.start();
    cc.rows.splice(0, cc.rows.length, { role: 'user', content: [text(`[forward handoff 4: history, not new instructions]\nUser\n[1, latest] seeded\nPaths\ntranscript /t.jsonl:9 · saved ${elsewhere}`)] }, { role: 'user', content: [text('real ask')] });
    await cc.forward();
    const wake = cc.written[`${DIR}/wake.txt`]!;
    expect(wake).toContain(`earlier handoff 4: its record is missing from /h/u/.local/state/sub-agent-compact/forward-handoff/session-1, /h/u/.claude/sub-agent-compact/forward-handoff/session-1 (its saved ${elsewhere} is not this chat's), so the prompts before it are not carried`);
    expect(wake).not.toContain('seeded');
  });

  it('carries a held handoff whose record the listing misses, through the path its text saved, and numbers past that call without overwriting it', async () => {
    const first = engine();
    await first.start();
    await first.forward();
    const wake1 = first.written[`${DIR}/wake.txt`]!;
    expect(wake1).toContain(`saved ${DIR}`);
    // A reloaded plugin, its own count back at 0, on an engine whose listing shows nothing of the earlier call.
    const earlier = Object.fromEntries(Object.entries(first.written).filter(([path]) => path.startsWith(`${DIR}/`)));
    const cc = engine({ forwardHandoffTool: true }, earlier, [{ role: 'user', content: [text(wake1)] }, { role: 'user', content: [text('second ask')] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: TOOL, input: FIELDS }] }]);
    await cc.start();
    await cc.forward();
    expect(Object.keys(cc.written).filter((path) => path.startsWith(`${DIR}/`))).toEqual([]);
    const wake2 = cc.written[`${DIR.replace(/1$/, '2')}/wake.txt`]!;
    expect(wake2).toContain('[1] rename qty to quantity in every report\n');
    expect(wake2).toContain('second ask');
    expect(wake2).not.toContain('record is missing');
  });

  it("lists running work from the engine's list at the last turn's end, not the shells the transcript once started", async () => {
    const rows = api([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'old1', name: 'Bash', input: { command: 'serve --old', run_in_background: true } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old1', content: 'Command running in background with ID: bg_old.' }] },
    ]);
    const cc = engine({ forwardHandoffTool: true }, {}, rows);
    await cc.start();
    const at = (ms: number) => {
      const d = new Date(Date.now() + ms);
      return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
    };
    const ahead = at(3_600_000);
    // a one-shot wakeup still ahead is armed; one whose time passed since the list was taken has fired
    await cc.stop({ background_tasks: [{ id: 'sh9', type: 'shell', status: 'running', description: 'dev', command: 'npm run dev' }], session_crons: [{ id: 'k1', schedule: ahead, recurring: false, prompt: 'continue' }, { id: 'k0', schedule: at(-3_600_000), recurring: false, prompt: 'fired' }] });
    await cc.forward();
    const wake = cc.written[`${DIR}/wake.txt`]!;
    expect(wake).toContain(`Running\nshell sh9: npm run dev\ncron k1 once: ${ahead} continue\n`);
    expect(wake).not.toContain('k0');
    expect(wake).not.toContain('bg_old');
  });

  it('names the transcript the find printed, and says when none exists for the session', async () => {
    const found = engine();
    await found.start();
    await found.forward();
    expect(found.written[`${DIR}/wake.txt`]).toContain(`transcript ${TRANSCRIPT}:812`);
    const none = engine({ forwardHandoffTool: true }, {}, api(), true, [], { noTranscript: true });
    await none.start();
    await none.forward();
    expect(none.written[`${DIR}/wake.txt`]).toContain('Unresolved\ntranscript: no file for session session-1');
    expect(none.written[`${DIR}/wake.txt`]).not.toContain('transcript /');
  });

  it('nudges the main chat to the forward tool by name once it is on', async () => {
    const cc = engine();
    await cc.start();
    await cc.step(250_000);
    const nudged = await cc.read();
    expect(nudged.context?.[0]).toContain('mcp__sub-agent-compact__forward_handoff');
  });

  it.each([
    ['a tools list without it', 'tools: WebSearch, WebFetch', false],
    ['a block tools list naming it', 'tools:\n  - Read\n  - mcp__sub-agent-compact__forward_handoff', true],
    ['no tools list', 'model: opus', true],
    ['it disallowed', 'disallowedTools: [mcp__sub-agent-compact]', false],
  ])('nudges a sub-agent toward the forward tool only when it has it: %s', async (_name, body, nudged) => {
    const cc = engine({ forwardHandoffTool: true, logFile: '/logs/decisions.jsonl' }, { '/nowhere/.claude/agents/rr.md': `---\nname: rr\n${body}\n---\n` }, api(), true, [], { agents: [{ id: 'a1', type: 'rr' }] });
    await cc.start();
    await cc.step(250_000, 'claude-opus-4-5[1m]', 'a1');
    const out = await cc.read('a1');
    const nudges = (await cc.decisions()).filter((r: any) => r.event === 'nudge');
    if (nudged) {
      expect(out.context?.[0]).toContain('mcp__sub-agent-compact__forward_handoff');
      expect(nudges).toMatchObject([{ party: 'a1', type: 'rr', tool: 'forward_handoff' }]);
    } else {
      expect(out.context ?? []).toEqual([]);
      expect(nudges).toEqual([]);
    }
  });

  it.each([
    ['a tools list without it', 'tools: WebSearch, WebFetch', false],
    ['no tools list', 'model: opus', true],
  ])('nudges a sub-agent toward the compact tool only when it has it: %s', async (_name, body, nudged) => {
    const cc = engine({ forwardHandoffTool: false, handoffTool: false, compactTool: true }, { '/nowhere/.claude/agents/rr.md': `---\nname: rr\n${body}\n---\n` }, api(), true, [], { agents: [{ id: 'a1', type: 'rr' }] });
    await cc.start();
    await cc.step(250_000, 'claude-opus-4-5[1m]', 'a1');
    const out = await cc.read('a1');
    if (nudged) expect(out.context?.[0]).toContain('mcp__sub-agent-compact__compact');
    else expect(out.context ?? []).toEqual([]);
  });

  it('nudges nobody to a tool that is not there when the forward tool is the only one on and did not register', async () => {
    const cc = engine({ forwardHandoffTool: true, handoffTool: false, compactTool: false }, {}, api(), true, ['forward_handoff']);
    await cc.start();
    await cc.step(250_000);
    const nudged = await cc.read();
    expect(nudged.context ?? []).toEqual([]);
    expect(cc.registered).toEqual(['look_back']);
  });
});

const LOOK_BACK = 'mcp__sub-agent-compact__look_back';
const COMPLETE = '\n[look-back-complete]\n';
const numbered = (n: number, content: unknown, type = 'user') => `${n}:${JSON.stringify({ type, timestamp: '2026-01-02T03:04:05Z', message: { role: type, content } })}\n`;
const okProcess = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
const lookRun = (search: string): Env => ({ run: (argv) => {
  if (argv[0] === 'sh' && argv[2]!.includes('compact_boundary')) return okProcess('4:{"subtype":"compact_boundary"}\n10:{"subtype":"compact_boundary"}\n' + COMPLETE);
  if (argv[0] === 'sh') return okProcess(search + COMPLETE);
  return undefined;
} });
const lookEngineRun = lookRun(numbered(8, 'Alpha beta error text'));
const lookEngine = (over: Env = {}, search = numbered(8, 'Alpha beta error text')) => engine(
  { logFile: '/logs/decisions.jsonl', handoffTool: false, forwardHandoffTool: false, compactTool: false }, {}, api(), true, [],
  { ...lookRun(search), ...over },
);
const lookRows = async (cc: ReturnType<typeof engine>, event = 'look-back') => (await cc.decisions()).filter((r: any) => r.event === event);
const lookLines = (cc: ReturnType<typeof engine>) => cc.logs.filter((line) => line.startsWith('look back'));
/** Every look back line said, on the screen or not: the decision log's `said` rows. */
const saidLines = async (cc: ReturnType<typeof engine>) => (await cc.decisions()).filter((r: any) => r.event === 'said' && r.line.startsWith('look back')).map((r: any) => r.line);

describe('look_back through the adapter (R1–R7, R9)', () => {
  it('registers on load with all compaction options off, retries a failure three times, and records attempts', async () => {
    const refused = ['look_back'];
    const cc = engine({ handoffTool: false, forwardHandoffTool: false, compactTool: false, logFile: '/logs/decisions.jsonl' }, {}, api(), true, refused);
    await cc.start();
    expect(cc.specs.look_back).toMatchObject({ name: 'look_back', inputSchema: { additionalProperties: false, required: ['why'] } });
    await cc.start(); await cc.start(); await cc.start();
    const rows = (await cc.decisions()).filter((r: any) => r.event === 'tool-register-failed' && r.tool === 'look_back');
    expect(rows.map((r: any) => r.tries)).toEqual([1, 2, 3]);
    expect(cc.logs.filter((line) => line.includes('registering the look_back tool failed'))).toHaveLength(1);
    const successful = lookEngine(); await successful.start();
    expect(successful.registered).toEqual(['look_back']);
  });
  it('searches only before the latest boundary with positional terms and records one main-party miss and notice', async () => {
    const cc = lookEngine(); await cc.start();
    const out = await cc.call({ tool: LOOK_BACK, why: ' lost error ', query: 'alpha beta' });
    expect(out.result).toContain('#8  2026-01-02 03:04  user\nAlpha beta error text');
    const scan = cc.runCalls.find((argv) => argv[0] === 'sh' && argv.includes('alpha'))!;
    expect(scan.slice(4)).toEqual([TRANSCRIPT, '10', 'alpha', 'beta']);
    expect(scan[2]).toContain('1,$(($2 - 1))p');
    expect(scan[2]).toContain('tail -n 200');
    expect(cc.runCalls.find((a) => a[0] === 'find')).toEqual(['find', '-H', '/h/u/.claude/projects', '-maxdepth', '2', '-type', 'f', '-name', 'session-1.jsonl']);
    expect(await saidLines(cc)).toEqual(['look back (main): lost error — 1 hits']);
    expect(await lookRows(cc)).toEqual([expect.objectContaining({ event: 'look-back', party: 'main', why: 'lost error', query: 'alpha beta', hits: 1, boundary: 10 })]);
    expect(cc.nextInputs).toEqual([]);
  });
  it.each([true, false])('never treats a nested tool input as a boundary, real boundary=%s', async (compacted) => {
    const fake = numbered(20, [{ type: 'tool_use', name: 'Example', input: { subtype: 'compact_boundary' } }], 'assistant');
    const cc = lookEngine({ run: (argv) => {
      if (argv[0] === 'sh' && argv[2]!.includes('compact_boundary')) return okProcess((compacted ? '10:{"subtype":"compact_boundary"}\n' : '') + fake + COMPLETE);
      return undefined;
    } }); await cc.start();
    const out = await cc.call({ tool: LOOK_BACK, why: 'exact value', entry: 15 });
    expect(out.result).toContain(compacted ? 'already in context' : 'Nothing has been compacted yet');
    expect(cc.runCalls.filter((a) => a[0] === 'sh')).toHaveLength(1);
    expect((await lookRows(cc))[0]).toMatchObject({ boundary: compacted ? 10 : null });
    expect(await saidLines(cc)).toHaveLength(1);
  });
  it.each([[{}], [{ why: 'x' }], [{ why: 'x', entry: 0 }]])('answers no boundary before any argument check: %j', async (args) => {
    const cc = lookEngine({ run: (argv) => argv[0] === 'sh' ? okProcess(COMPLETE) : undefined }); await cc.start();
    const out = await cc.call({ tool: LOOK_BACK, ...args });
    expect(out.result).toMatch(/Nothing has been compacted yet.*still in context/);
    expect((await lookRows(cc))[0]).toMatchObject({ boundary: null, hits: 0 });
    expect((await lookRows(cc))[0].error).toBeUndefined();
  });

  it('answers no boundary without searching and still counts the call', async () => {
    const cc = lookEngine({ run: (argv) => argv[0] === 'sh' ? okProcess(COMPLETE) : undefined }); await cc.start();
    const out = await cc.call({ tool: LOOK_BACK, why: 'exact value', query: 'value' });
    expect(out.result).toMatch(/Nothing has been compacted yet.*still in context/);
    expect(cc.runCalls.filter((a) => a[0] === 'sh')).toHaveLength(1);
    expect(await saidLines(cc)).toEqual(['look back (main): exact value — 0 hits']);
    expect(await lookRows(cc)).toEqual([expect.objectContaining({ boundary: null, hits: 0 })]);
  });
  it.each([
    ['missing file', { noTranscript: true }, 'no transcript file for session session-1'],
    ['no config directory', { noHome: true }, 'no Claude config directory'],
    ['find error', { run: (argv: string[]) => argv[0] === 'find' ? { exitCode: 1, stdout: TRANSCRIPT, stderr: 'find: permission denied' } : undefined }, 'permission denied'],
    ['boundary error', { run: (argv: string[]) => argv[0] === 'sh' ? { exitCode: 0, stdout: COMPLETE, stderr: 'grep: permission denied' } : undefined }, 'permission denied'],
    ['truncated output', { run: (argv: string[]) => argv[0] === 'sh' ? okProcess('8:partial') : undefined }, 'completion marker'],
  ])('reports %s as failure rather than zero matches', async (_, env, reason) => {
    const cc = lookEngine(env); await cc.start();
    const out = await cc.call({ tool: LOOK_BACK, why: 'lost text', query: 'needle' });
    expect(out.result).toContain(reason);
    expect(out.result).not.toContain('No entry before');
    expect(lookLines(cc)).toHaveLength(1);
    expect(lookLines(cc)[0]).toContain(' — failed:');
    expect((await lookRows(cc))[0]).toMatchObject({ party: 'main', why: 'lost text', boundary: null, error: expect.stringContaining(reason) });
  });
  it.each([
    ['bad caller input', { why: 'lost text', query: '"unclosed' }, {}, 'warnings.jsonl', 'errors.jsonl'],
    ['an entry already in context', { why: 'lost text', entry: 12 }, {}, 'warnings.jsonl', 'errors.jsonl'],
    ['a plugin fault', { why: 'lost text', query: 'needle' }, { noTranscript: true }, 'errors.jsonl', 'warnings.jsonl'],
  ])('logs a look back failure from %s at the right level', async (_, args, over, file, other) => {
    const temp = mkdtempSync(join(tmpdir(), 'look-back-level-'));
    const dir = join(temp, 'logs/sub-agent-compact');
    const lines = (name: string) => existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').trim().split('\n').map((row) => JSON.parse(row)).filter((row) => row.event === 'said' && String(row.msg).startsWith('look back')) : [];
    try {
      const cc = lookEngine({ home: temp, pluginLogDir: join(temp, 'logs'), ...over }); await cc.start();
      await cc.call({ tool: LOOK_BACK, ...args }); await cc.end();
      expect(lines(file)).toEqual([expect.objectContaining({ msg: expect.stringContaining(' — failed:') })]);
      expect(lines(other)).toEqual([]);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it('returns a useful zero-match answer and logs zero hits', async () => {
    const cc = lookEngine({}, numbered(8, 'alpha other')); await cc.start();
    const out = await cc.call({ tool: LOOK_BACK, why: 'lost text', query: 'alpha beta' });
    expect(out.result).toContain('No entry before the compaction at line 10 matches: alpha, beta');
    expect(out.result).toContain('fewer or other words');
    expect((await lookRows(cc))[0]).toMatchObject({ boundary: 10, hits: 0 });
    expect(await saidLines(cc)).toEqual(['look back (main): lost text — 0 hits']);
  });
  it('chooses the calling sub-agent transcript by agentId, including an unlisted party', async () => {
    for (const [agents, label] of [[[{ id: 'a1', type: 'reviewer' }], 'reviewer'], [[], 'unlisted']] as const) {
      const agentFile = '/h/u/.claude/projects/-nowhere/session-1/subagents/agent-a1.jsonl';
      const cc = lookEngine({ agents: [...agents], run: (argv) => {
        if (argv[0] === 'find') return okProcess(agentFile + '\n');
        if (argv[0] === 'sh' && argv[2]!.includes('compact_boundary')) return okProcess('10:{"subtype":"compact_boundary"}\n' + COMPLETE);
        if (argv[0] === 'sh') return okProcess(numbered(3, 'agent detail') + COMPLETE);
        return undefined;
      } }); await cc.start();
      const out = await cc.call({ tool: LOOK_BACK, agentId: 'a1', why: 'lost detail', query: 'detail' });
      expect(out.result).toContain('agent detail');
      expect(cc.runCalls.find((a) => a[0] === 'find')!.slice(-2)).toEqual(['-path', '*/session-1/subagents/agent-a1.jsonl']);
      expect(cc.runCalls.filter((a) => a[0] === 'sh').every((a) => a[4] === agentFile)).toBe(true);
      expect(await saidLines(cc)).toEqual([`look back (${label}): lost detail — 1 hits`]);
      expect((await lookRows(cc))[0]).toMatchObject({ party: 'a1', hits: 1 });
    }
  });
  it('fetches one whole entry, correlates tool results with tool-use names, and refuses a current-context entry without fetching', async () => {
    let namesFail = false;
    const cc = lookEngine({ run: (argv) => {
      if (argv[0] === 'sh' && argv[2]!.includes('compact_boundary')) return okProcess('10:{"subtype":"compact_boundary"}\n' + COMPLETE);
      if (argv[0] === 'sh' && argv[2]!.includes('"tool_use"')) return namesFail ? { exitCode: 0, stdout: COMPLETE, stderr: 'grep: transcript unavailable' } : okProcess(numbered(2, [{ type: 'tool_use', id: 'r1', name: 'Bash', input: { command: 'run' } }], 'assistant') + COMPLETE);
      if (argv[0] === 'sh') return okProcess(numbered(8, [{ type: 'tool_result', tool_use_id: 'r1', content: 'full output' }]) + COMPLETE);
      return undefined;
    } }); await cc.start();
    const fetched = await cc.call({ tool: LOOK_BACK, why: 'lost output', entry: 8 });
    expect(fetched.result).toBe('#8  2026-01-02 03:04  result of Bash\nfull output');
    expect(await saidLines(cc)).toEqual(['look back (main): lost output — entry 8']);
    expect((await lookRows(cc))[0]).toMatchObject({ entry: 8, boundary: 10 });
    const before = cc.runCalls.length;
    const held = await cc.call({ tool: LOOK_BACK, why: 'lost output', entry: 10 });
    expect(held.result).toContain('already in context');
    expect(cc.runCalls.slice(before).filter((a) => a[0] === 'sh')).toHaveLength(1);
    expect((await lookRows(cc))[1]).toMatchObject({ entry: 10, boundary: 10, error: expect.stringContaining('already in context') });
    namesFail = true;
    const failed = await cc.call({ tool: LOOK_BACK, why: 'lost output', entry: 8 });
    expect(failed.result).toBe('Look back failed: tool name lookup: grep: transcript unavailable');
    expect(await saidLines(cc)).toHaveLength(3);
    expect(lookLines(cc)).toHaveLength(1);
    expect((await saidLines(cc))[2]).toBe('look back (main): lost output — failed: tool name lookup: grep: transcript unavailable');
    expect(await lookRows(cc)).toHaveLength(3);
    expect((await lookRows(cc))[2]).toMatchObject({ entry: 8, boundary: 10, error: 'tool name lookup: grep: transcript unavailable' });
  });
  it('counts an invalid call after a compaction with a log-only warning and row, finding the boundary but never searching', async () => {
    const cc = lookEngine(); await cc.start();
    const out = await cc.call({ tool: LOOK_BACK, why: 'lost detail' });
    expect(out.result).toContain('query or entry');
    const transcriptRuns = cc.runCalls.filter((argv) => !['plugin-log', 'decision-log', 'decision-retention'].includes(argv[3]!));
    expect(transcriptRuns.map((argv) => argv[0] === 'sh' && argv[2]!.includes('compact_boundary') ? 'boundary' : argv[0])).toEqual(['find', 'boundary']);
    expect(lookLines(cc)).toEqual([]);
    expect((await lookRows(cc))[0]).toMatchObject({ why: 'lost detail', boundary: 10, error: 'query or entry is required' });
  });
  it.each([
    [{ tool: 'Read', file_path: '/any/session-1.jsonl' }, 'main', 'main'],
    [{ tool: 'Grep', path: '/any/session-1.jsonl', pattern: 'error' }, 'main', 'main'],
    [{ tool: 'Bash', command: 'tail -n 10 /any/session-1.jsonl' }, 'main', 'main'],
    [{ tool: 'Read', file_path: '/any/agent-a1.jsonl', agentId: 'a1' }, 'a1', 'reviewer'],
  ])('observes manual %s without running a process or changing next()', async (input, party, label) => {
    const cc = lookEngine({ agents: [{ id: 'a1', type: 'reviewer' }] }); await cc.start();
    const out = await cc.call(input);
    expect(out.result).toBe('original result');
    expect(cc.nextInputs).toEqual([input]);
    expect(cc.runCalls.filter((argv) => !['plugin-log', 'decision-log', 'decision-retention'].includes(argv[3]!))).toEqual([]);
    expect(await saidLines(cc)).toEqual([`look back by hand (${label}): ${input.tool} on the transcript`]);
    expect(lookLines(cc)).toEqual([]);
    expect(await lookRows(cc, 'look-back-manual')).toEqual([expect.objectContaining({ event: 'look-back-manual', party, tool: input.tool })]);
  });
  it('does not count another party file, a similarly named file, or Write', async () => {
    const cc = lookEngine(); await cc.start();
    expect(cc.registered).toEqual(['look_back']);
    for (const input of [{ tool: 'Read', file_path: '/any/agent-a2.jsonl', agentId: 'a1' }, { tool: 'Read', file_path: '/any/old-session-1.jsonl.bak' }, { tool: 'Write', file_path: '/any/session-1.jsonl' }]) expect((await cc.call(input)).result).toBe('original result');
    expect(await saidLines(cc)).toEqual([]);
    expect(await lookRows(cc, 'look-back-manual')).toEqual([]);
    expect(cc.runCalls.filter((argv) => !['plugin-log', 'decision-log', 'decision-retention'].includes(argv[3]!))).toEqual([]);
  });
});

// Every line the plugin says lands in the decision log as a 'said' row; a routine success stays off the screen while a log takes it.
describe('diagnostic screen policy', () => {
  const disk = (dir: string, file: string): any[] => existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').trim().split('\n').map((row) => JSON.parse(row)) : [];
  it.each([
    ['plugin log', {}, {}, false],
    ['decision log', { logFile: '/logs/decisions.jsonl' }, { noHome: true }, false],
    ['no log', {}, { noHome: true }, true],
    ['plugin log failing', {}, { pluginRunFails: true }, true],
    ['decision log failing', { logFile: '/logs/decisions.jsonl' }, { noHome: true, decisionWriteFails: true }, true],
    ['decision log off', { logFile: '/logs/decisions.jsonl' }, { decisionSessionFailsOnce: true }, true],
  ] as [string, Record<string, unknown>, Env, boolean][])('routes warnings by log availability: %s', async (_, options, env, shown) => {
    const temp = mkdtempSync(join(tmpdir(), 'compact-screen-policy-'));
    try {
      const cc = engine(options, {}, api(), true, [], { home: temp, ...env });
      await cc.start();
      // Ensure a failing plugin writer has settled before the next diagnostic.
      await cc.call({ tool: LOOK_BACK, why: 'bad input' });
      await cc.end();
      await cc.ask('recompute', []);
      await cc.end();
      expect(cc.logs.filter((line) => line.includes('unknown trigger "recompute"'))).toHaveLength(shown ? 1 : 0);
      if (!env.noHome && !env.pluginRunFails) expect(disk(join(temp, '.local/state/sub-agent-compact/logs'), 'warnings.jsonl').filter((row) => row.msg.includes('unknown trigger "recompute"'))).toHaveLength(1);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('falls back to the screen for skipped links when no log can keep the warning', async () => {
    const dir = '/nowhere/.claude/agents';
    const cc = engine({}, { [dir]: '' }, api(), true, [], {
      noHome: true, agents: [{ id: 'a1', type: 'reader' }],
      agentEntries: { [dir]: [{ name: 'dangling.md', kind: 'other', size: 0, isLink: true }] },
      agentStats: { [`${dir}/dangling.md`]: { kind: 'other', size: 0 } },
    });
    await cc.start(); await cc.read('a1');
    expect(cc.logs.filter((line) => line.includes('dangling.md'))).toEqual([`skipping ${dir}/dangling.md: a link to something not a regular file`]);
  });

  it('keeps startup fallback warnings off screen once the log destination is known', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'compact-startup-policy-'));
    try {
      const cc = engine({}, {}, api(), true, [], { home: temp, cwdFails: true, envReadFails: ['PLUGIN_LOG_DIR'] });
      await cc.start(); await cc.end();
      expect(cc.logs.filter((line) => /cwd failed|reading PLUGIN_LOG_DIR failed/.test(line))).toEqual([]);
      expect(disk(join(temp, '.local/state/sub-agent-compact/logs'), 'warnings.jsonl').filter((row) => /cwd failed|reading PLUGIN_LOG_DIR failed/.test(row.msg))).toHaveLength(2);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it.each([
    ['main tool unavailable', 'not registered, so it is not nudged'],
    ['transcript shape', 'has an unexpected shape'],
    ['handoff fallback', 'could not be installed verbatim'],
    ['brief seating', 'seating the brief of sub-agent'],
    ['wake load', 'could not load example'],
    ['plugin discovery', 'load_on_wake finds no plugin skill'],
    ['forward recovery', 'recovering the forward handoff'],
    ['forward verification', 'its install is unchecked'],
    ['forward record', 'writing the install check'],
    ['missing block', 'blocks missing: Git'],
    ['native window', 'lower the window to hold this limit'],
    ['no reading', 'no token reading for main'],
    ['HOME unavailable', 'reading HOME failed'],
    ['subagent stop', "reading a1's stop failed"],
  ])('shows and error-logs a failed feature: %s', async (failure, line) => {
    const temp = mkdtempSync(join(tmpdir(), 'compact-error-policy-'));
    try {
      const root = '/h/u/.claude';
      const skill = '/nowhere/.claude/skills/example/SKILL.md';
      const files = { [skill]: 'Example instructions', ...(failure === 'plugin discovery' ? { [`${root}/plugins/installed_plugins.json`]: 'not json' } : {}) };
      const env: Env = { home: '/h/u', vars: { CLAUDE_CONFIG_DIR: root }, readFails: [], writeFails: [], agents: [{ id: 'a1', type: 'worker' }] };
      if (failure === 'HOME unavailable') env.envReadFails = ['HOME'];
      // Keep a plugin log even when HOME itself cannot be read.
      env.pluginLogDir = join(temp, 'logs');
      if (failure === 'native window') env.vars!.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '1000000';
      const options = { handoffTool: true, forwardHandoffTool: true, compactTool: false, subagentKeepBrief: true };
      const cc = engine(options, files, api(), true, failure === 'main tool unavailable' ? ['handoff', 'forward_handoff'] : [], env);
      await cc.start(); await cc.step(250_000);
      const handoff = async (loads?: string[]) => cc.call({ tool: 'mcp__sub-agent-compact__handoff', tool_use_id: 'h1', goal: 'Rename quantity in every report', next_step: 'Edit the next report, then test', done_verified: ['First report tested'], ...(loads ? { load_on_wake: loads } : {}) });
      if (failure === 'main tool unavailable') await cc.read();
      if (failure === 'subagent stop') { env.agentListFails = true; await cc.subagentStop({ agent_id: 'a1', agent_type: 'worker', last_assistant_message: '<handoff>Next: continue the task</handoff>' }); }
      if (failure === 'transcript shape') await cc.ask('auto', [{ role: 'assistant', text: 'bad shape' }]);
      if (failure === 'handoff fallback') { await handoff(); await cc.ask('auto', []); }
      if (failure === 'brief seating') await cc.ask('manual', [{ role: 'user', text: 'brief without toolUses' }], { agentId: 'a1' });
      if (failure === 'wake load') {
        expect((await handoff(['example'])).result).toMatch(/^Handoff stored/);
        env.readFails!.push(skill);
        await cc.ask('auto', [
          { role: 'user', text: 'task', toolUses: [], handle: 'm0' },
          { role: 'assistant', text: '', toolUses: [{ tool: 'mcp__sub-agent-compact__handoff', tool_use_id: 'h1', input: {} }], handle: 'm1' },
        ]);
      }
      if (failure === 'plugin discovery') await cc.forward();
      if (failure === 'forward recovery') await cc.ask('auto', [
        { role: 'assistant', text: '', toolUses: [{ tool: TOOL, tool_use_id: 'f1', input: FIELDS }], handle: 'm1' },
        { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'f1', text: `Forward handoff stored (1k tokens). Saved to ${DIR}. It installs when this turn ends.`, isError: false }], handle: 'm2' },
      ]);
      if (['forward verification', 'forward record', 'missing block'].includes(failure)) {
        await cc.forward(); await cc.ask('auto');
        const wake = cc.written[`${DIR}/wake.txt`]!;
        cc.rows.splice(0, cc.rows.length, { role: 'user', content: [text(failure === 'missing block' ? wake.replace(/\nGit\n[^\n]*/, '') : wake)] });
        if (failure === 'forward verification') env.messagesFail = true;
        if (failure === 'forward record') env.writeFails!.push(`${DIR}/record.json`);
        await cc.step(30_000);
      }
      if (failure === 'native window') await cc.ask('auto', [], { agentId: 'a1' });
      if (failure === 'no reading') { await cc.step(NaN); await cc.ask('auto', []); }
      await cc.end();
      expect(cc.logs.some((msg) => msg.includes(line))).toBe(true);
      expect(disk(join(temp, 'logs/sub-agent-compact'), 'errors.jsonl').some((row) => row.msg.includes(line))).toBe(true);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it.each(['compact', 'look_back', 'handoff', 'forward_handoff'])('shows and error-logs a failed %s registration', async (tool) => {
    const temp = mkdtempSync(join(tmpdir(), 'compact-register-policy-'));
    try {
      const cc = engine({ compactTool: true, handoffTool: tool !== 'compact', forwardHandoffTool: tool !== 'compact' }, {}, api(), true, [tool], { home: temp });
      await cc.start(); await cc.end();
      const line = `registering the ${tool} tool failed`;
      expect(cc.logs.filter((msg) => msg.includes(line))).toHaveLength(1);
      expect(disk(join(temp, '.local/state/sub-agent-compact/logs'), 'errors.jsonl').filter((row) => row.msg.includes(line))).toHaveLength(1);
      expect(disk(join(temp, '.local/state/sub-agent-compact/logs'), 'warnings.jsonl').filter((row) => row.msg.includes(line))).toEqual([]);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it.each([
    ['plugin log session lookup', { mainAutoCompact: 'bad' }, { decisionSessionFailsOnce: true }, 'reading the plugin log session id failed'],
    ['invalid setting', { forwardHandoffTool: 'broken' }, {}, 'SUB_AGENT_COMPACT_FORWARD_HANDOFF_TOOL is invalid'],
    ['ignored setting', {}, { registerOptions: { forwardHandoffTool: true } }, 'options forwardHandoffTool are not read'],
    ['clock unavailable', {}, { noClock: true }, '$.clock.after is unavailable'],
    ['decision log disabled', { logFile: '/logs/decisions.jsonl' }, { decisionSessionFailsOnce: true }, 'reading the session id failed'],
  ] as [string, Record<string, unknown>, Env, string][])('shows and error-logs a broken feature: %s', async (_, options, env, line) => {
    const temp = mkdtempSync(join(tmpdir(), 'compact-feature-policy-'));
    try {
      const cc = engine(options, {}, api(), true, [], { home: temp, ...env });
      await cc.start(); await cc.end();
      expect(cc.logs.some((msg) => msg.includes(line))).toBe(true);
      expect(disk(join(temp, '.local/state/sub-agent-compact/logs'), 'errors.jsonl').some((row) => row.msg.includes(line))).toBe(true);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});

describe('the lines the plugin says, on the screen and in the decision log', () => {
  const said = async (cc: ReturnType<typeof engine>) => (await cc.decisions()).filter((r: any) => r.event === 'said');
  it('logs a look back notice as a said row and keeps it off the screen', async () => {
    const cc = lookEngine(); await cc.start();
    await cc.call({ tool: LOOK_BACK, why: 'lost error', query: 'alpha beta' });
    expect((await said(cc)).filter((r: any) => r.line.startsWith('look back'))).toEqual([expect.objectContaining({ event: 'said', line: 'look back (main): lost error — 1 hits', shown: false })]);
    expect(lookLines(cc)).toEqual([]);
  });
  it('keeps a caller-input warning off screen and logs it as a said row', async () => {
    const cc = lookEngine(); await cc.start();
    await cc.call({ tool: LOOK_BACK, why: 'lost detail' });
    const line = 'look back (main): lost detail — failed: query or entry is required';
    expect(lookLines(cc)).toEqual([]);
    expect((await said(cc)).filter((r: any) => r.line === line)).toEqual([expect.objectContaining({ shown: false })]);
  });
  it('shows a failure the old code left off the log, by its screen text', async () => {
    const cc = engine({ forwardHandoffTool: true, logFile: '/logs/decisions.jsonl' }, { [DIR.replace(/\/1$/, '')]: '' }, api(), true, [], { listFails: true });
    await cc.start();
    await cc.forward();
    const line = cc.logs.find((l) => l.includes('EACCES'))!;
    expect(line).toMatch(/^listing .* failed: EACCES/);
    expect((await said(cc)).filter((r: any) => r.line === line)).toEqual([expect.objectContaining({ shown: true })]);
  });
  it.each([
    ['HOME plugin log only', {}, {}, false],
    ['override plugin log only', {}, { noHome: true, pluginLogDir: '/logs' }, false],
    ['decision log only', { logFile: '/logs/decisions.jsonl' }, { noHome: true }, false],
    ['neither log', {}, { noHome: true }, true],
    ['decision logging off with plugin log', { logFile: '/logs/decisions.jsonl' }, { decisionSessionFailsOnce: true }, true],
  ] as [string, Record<string, unknown>, Env, boolean][])('shows routine notices only without a keeping log: %s', async (_, options, env, shown) => {
    const temp = mkdtempSync(join(tmpdir(), 'compact-routine-'));
    try {
      const cc = engine({ handoffTool: false, forwardHandoffTool: false, compactTool: false, ...options }, {}, api(), true, [], {
        ...lookEngineRun, home: temp, ...env, ...(env.pluginLogDir ? { pluginLogDir: join(temp, 'logs') } : {}), vars: { CLAUDE_CONFIG_DIR: '/h/u/.claude' },
      });
      await cc.start();
      await cc.decisions();
      await cc.call({ tool: LOOK_BACK, why: 'lost error', query: 'alpha beta' });
      await cc.call({ tool: 'Read', file_path: TRANSCRIPT });
      expect(lookLines(cc)).toEqual(shown ? ['look back (main): lost error — 1 hits', 'look back by hand (main): Read on the transcript'] : []);
      await cc.end();
      if (!env.noHome || env.pluginLogDir) {
        const dir = env.pluginLogDir ? join(temp, 'logs/sub-agent-compact') : join(temp, '.local/state/sub-agent-compact/logs');
        const info = readFileSync(join(dir, 'info.jsonl'), 'utf8').trim().split('\n').map((row) => JSON.parse(row));
        expect(info.filter((row) => row.event === 'said' && row.msg.startsWith('look back'))).toHaveLength(2);
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});

describe('the Git block describes the repositories the work touched', () => {
  // Repository A's main checkout, a linked worktree of A inside it, and a repository B elsewhere:
  // git answers from the directory it runs in (`-C dir`, else the run's cwd), as the real one does.
  const REPOS: Record<string, { branch: string; head: string; porcelain: string }> = {
    '/a': { branch: 'develop', head: 'aaa1111', porcelain: ' M main-only.txt\n' },
    '/a/.worktrees/fix': { branch: 'flight/fix', head: 'bbb2222', porcelain: ' M src/x.ts\n' },
    '/b': { branch: 'main', head: 'ccc3333', porcelain: '?? new.ts\n' },
  };
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
  const gitAt = (argv: string[], init?: { cwd?: string }) => {
    if (argv[0] !== 'git') return undefined;
    const dashC = argv[1] === '-C';
    const dir = dashC ? argv[2]! : (init?.cwd ?? '');
    const rest = (dashC ? argv.slice(3) : argv.slice(1)).join(' ');
    const root = Object.keys(REPOS).filter((r) => dir === r || dir.startsWith(`${r}/`)).sort((x, y) => y.length - x.length)[0];
    if (root === undefined) return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' };
    const repo = REPOS[root]!;
    if (rest === 'rev-parse --show-toplevel') return ok(`${root}\n`);
    if (rest === 'rev-parse --abbrev-ref HEAD') return ok(`${repo.branch}\n`);
    if (rest === 'rev-parse --short HEAD') return ok(`${repo.head}\n`);
    if (rest === '-c core.fsmonitor=false status --porcelain') return ok(repo.porcelain);
    return { exitCode: 1, stdout: '', stderr: `unscripted: git ${rest}` };
  };
  const use = (id: string, name: string, input: Record<string, unknown>) => [
    { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  ];
  const rows = (calls: unknown[][]) => [
    { role: 'user', content: [text('fix the bug')] },
    ...calls.flat(),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: TOOL, input: FIELDS }] },
  ];
  const wakeOf = async (calls: unknown[][], run = gitAt) => {
    const cc = engine({ forwardHandoffTool: true }, {}, rows(calls), true, [], { cwd: '/a', run });
    await cc.start();
    await cc.forward();
    return cc.written[`${DIR}/wake.txt`]!;
  };
  const gitBlockOf = (wake: string) => /\nGit\n((?:(?!Paths\n|Unresolved\n)[^\n]*\n)*)/.exec(wake)?.[1];

  it("names a linked worktree's branch and dirty files when the session started in the main checkout", async () => {
    const wake = await wakeOf([use('r1', 'Read', { file_path: '/a/README.md' }), use('e1', 'Edit', { file_path: '/a/.worktrees/fix/src/x.ts' })]);
    expect(gitBlockOf(wake)).toBe('/a/.worktrees/fix: flight/fix@bbb2222, 1 dirty: /a/.worktrees/fix/src/x.ts\n');
    expect(wake).not.toContain('develop@aaa1111');
    expect(wake).not.toContain('main-only.txt');
  });

  it('names a different repository the files were made in', async () => {
    const wake = await wakeOf([use('w1', 'Write', { file_path: '/b/new.ts', content: 'x' })]);
    expect(gitBlockOf(wake)).toBe('/b: main@ccc3333, 1 dirty: /b/new.ts\n');
    expect(wake).not.toContain('develop@aaa1111');
  });

  it('names each repository touched, newest first', async () => {
    const wake = await wakeOf([use('e1', 'Edit', { file_path: '/a/.worktrees/fix/src/x.ts' }), use('w1', 'Write', { file_path: '/b/new.ts', content: 'x' })]);
    expect(gitBlockOf(wake)).toBe('/b: main@ccc3333, 1 dirty: /b/new.ts\n/a/.worktrees/fix: flight/fix@bbb2222, 1 dirty: /a/.worktrees/fix/src/x.ts\n');
  });

  it('falls back to the files read when none was made or edited', async () => {
    const wake = await wakeOf([use('r1', 'Read', { file_path: '/b/src/old.ts' })]);
    expect(gitBlockOf(wake)).toBe('/b: main@ccc3333, 1 dirty: /b/new.ts\n');
  });

  it("keeps the session directory's repository, unnamed, when no file was touched", async () => {
    const wake = await wakeOf([]);
    expect(gitBlockOf(wake)).toBe('develop@aaa1111, 1 dirty: /a/main-only.txt\n');
  });

  it("keeps the session directory's repository when the files touched are in none", async () => {
    const wake = await wakeOf([use('w1', 'Write', { file_path: '/tmp/scratch/notes.txt', content: 'x' })]);
    expect(gitBlockOf(wake)).toBe('develop@aaa1111, 1 dirty: /a/main-only.txt\n');
    expect(wake).not.toMatch(/Unresolved\n(?:.*\n)*git /);
  });

  it('names a directory git failed to look in, instead of dropping it silently', async () => {
    const run = (argv: string[], init?: { cwd?: string }) =>
      argv[0] === 'git' && argv[2] === '/b/src' ? { exitCode: 128, stdout: '', stderr: "fatal: detected dubious ownership in repository at '/b'" } : gitAt(argv, init);
    const wake = await wakeOf([use('e1', 'Edit', { file_path: '/a/.worktrees/fix/src/x.ts' }), use('e2', 'Edit', { file_path: '/b/src/y.ts' })], run);
    expect(gitBlockOf(wake)).toBe('/a/.worktrees/fix: flight/fix@bbb2222, 1 dirty: /a/.worktrees/fix/src/x.ts\n');
    expect(wake).toMatch(/Unresolved\n(?:.*\n)*git \/b\/src: fatal: detected dubious ownership in repository at '\/b'\n/);
  });
});

describe('agent resolver diagnostics through the adapter', () => {
  const dir = '/nowhere/.claude/agents';
  const link = (name: string) => ({ name, kind: 'other' as const, size: 0, isLink: true });
  const warnings = (temp: string): any[] => readFileSync(join(temp, 'logs/sub-agent-compact/warnings.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.event === 'resolve-error');

  it('keeps non-regular and dangling listed links in the warning log, never on screen', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'compact-resolver-quiet-'));
    try {
      const paths = ['dangling', 'directory', 'pipe'].map((name) => `${dir}/${name}.md`);
      const cc = engine({}, { [dir]: '' }, api(), true, [], {
        pluginLogDir: join(temp, 'logs'), agents: [{ id: 'a1', type: 'reader' }],
        agentEntries: { [dir]: ['dangling', 'directory', 'pipe'].map((name) => link(`${name}.md`)) },
        agentStats: Object.fromEntries(paths.map((path) => [path, { kind: path.includes('directory') ? 'dir' : 'other', size: 0 }])),
      });
      await cc.start();
      expect(await cc.read('a1')).toEqual({ result: 'file text' });
      await cc.end();
      expect(warnings(temp).map((row) => [row.level, row.msg])).toEqual(paths.map((path) => ['warning', `sub-agent-compact: skipping ${path}: a link to something not a regular file`]));
      expect(cc.logs.filter((line) => paths.some((path) => line.includes(path)))).toEqual([]);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it.each(['non-regular', 'stat', 'oversized', 'checking', 'reading', 'invalid', 'listing'])('emits resolver %s diagnostics once per path per plugin session, beyond cache expiry', async (failure) => {
    const temp = mkdtempSync(join(tmpdir(), 'compact-resolver-once-'));
    const now = vi.spyOn(Date, 'now');
    try {
      const paths = ['reader', 'other'].map((name) => `${dir}/${name}.md`);
      const files: Record<string, string> = { [dir]: '', '/h/u/.claude/agents': '' };
      const env: Env = {
        pluginLogDir: join(temp, 'logs'), agents: [{ id: 'a1', type: 'reader' }, { id: 'a2', type: 'other' }],
        agentEntries: { [dir]: ['reader.md', 'other.md'].map(link) },
      };
      if (failure === 'non-regular') env.agentStats = Object.fromEntries(paths.map((path) => [path, { kind: 'other', size: 0 }]));
      if (failure === 'stat') env.statFails = paths;
      if (failure === 'oversized') env.agentStats = Object.fromEntries(paths.map((path) => [path, { kind: 'file', size: 5 * 1024 * 1024 }]));
      if (failure === 'checking') { env.existsFails = paths; env.agentEntries = {}; }
      if (failure === 'reading' || failure === 'invalid') {
        paths.forEach((path, i) => { files[path] = `---\nname: ${i === 0 ? 'reader' : 'other'}\nautoCompact:\n  forceAt: bad\n  nudgeFrom: also-bad\n---\n`; });
        if (failure === 'reading') env.readFails = paths;
      }
      if (failure === 'listing') env.listFails = true;
      for (let session = 0; session < 2; session++) {
        const cc = engine({}, files, api(), true, [], env);
        await cc.start();
        for (let attempt = 0; attempt < 3; attempt++) {
          now.mockReturnValue(attempt * 61_000);
          expect(await cc.read('a1')).toEqual({ result: 'file text' });
          expect(await cc.read('a2')).toEqual({ result: 'file text' });
        }
        await cc.end();
        const subjects = failure === 'listing' ? [dir, '/h/u/.claude/agents'] : paths;
        expect(warnings(temp)).toHaveLength(subjects.length * (session + 1));
        for (const path of subjects) expect(cc.logs.filter((line) => line.includes(path))).toHaveLength(0);
      }
    } finally { now.mockRestore(); rmSync(temp, { recursive: true, force: true }); }
  });
});

describe('plugin log through the forward adapter', () => {
  const diskRows = (dir: string, file: string): any[] => existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').trim().split('\n').map((row) => JSON.parse(row)) : [];
  it.each([true, false])('writes forced errors, warnings and the session at override=%s', async (override) => {
    const temp = mkdtempSync(join(tmpdir(), 'compact-plugin-adapter-'));
    const dir = override ? join(temp, 'logs/sub-agent-compact') : join(temp, '.local/state/sub-agent-compact/logs');
    try {
      const cc = engine({ forwardHandoffTool: true, compactTool: false, mainAutoCompact: 'bad', logFile: '/logs/decisions.jsonl' }, {}, api(), true, ['look_back'], { home: temp, ...(override ? { pluginLogDir: join(temp, 'logs') } : {}) });
      expect(await cc.start()).toEqual({});
      await cc.start();
      expect(await cc.end()).toEqual({ sessionId: 'session-1' });
      const errors = diskRows(dir, 'errors.jsonl'); const warnings = diskRows(dir, 'warnings.jsonl');
      expect(errors.filter((row) => row.event === 'tool-register-failed').map((row) => [row.level, row.where, row.session, row.detail.tool])).toEqual([['error', 'hooks/sub-agent-compact.ts#record', 'session-1', 'look_back'], ['error', 'hooks/sub-agent-compact.ts#record', 'session-1', 'look_back']]);
      expect(errors.filter((row) => row.event === 'option-error').map((row) => [row.level, row.where, row.session])).toEqual([['error', 'hooks/sub-agent-compact.ts#record', 'session-1']]);
      // Each diagnostic is one level row: the said line and its diagnostic row are one entry, not two.
      expect(errors.filter((row) => JSON.stringify(row).includes('SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT')).map((row) => row.event)).toEqual(['option-error']);
      expect(errors.filter((row) => JSON.stringify(row).includes('registering the look_back tool failed')).map((row) => row.event)).toEqual(['error']);
      // The first row on disk is a real diagnostic, never a startup row.
      expect(errors[0]).toMatchObject({ level: 'error', event: 'option-error', session: 'session-1' });
      expect(diskRows(dir, 'info.jsonl').filter((row) => row.event === 'logger-ready')).toEqual([]);
      const said = (await cc.decisions()).find((row: any) => row.event === 'said');
      expect(Object.keys(said)).toEqual(['ts', 'event', 'line', 'shown']);
      expect(cc.runCalls.filter((argv) => argv[0] === '/bin/sh' && argv[3] === 'plugin-log').every((argv) => argv[4] === dir)).toBe(true);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it.each([
    ['lookup', 'error', 'errors.jsonl', 'decision-log-session-error', 'session lookup unavailable'],
    ['write', 'error', 'errors.jsonl', 'decision-log-write-error', 'decision write unavailable'],
  ])('logs decision %s failure at %s level without changing the hook result', async (failure, level, file, event, error) => {
    const temp = mkdtempSync(join(tmpdir(), 'compact-decision-failure-'));
    try {
      const cc = engine({ compactTool: false, mainAutoCompact: 'bad', logFile: '/logs/decisions.jsonl' }, {}, api(), true, [], {
        home: temp, pluginLogDir: join(temp, 'logs'), decisionSessionFailsOnce: failure === 'lookup', decisionWriteFails: failure === 'write',
      });
      expect(await cc.start()).toEqual({});
      await cc.decisions();
      expect(await cc.end()).toEqual({ sessionId: 'session-1' });
      expect(diskRows(join(temp, 'logs/sub-agent-compact'), file!).filter((row) => row.event === event)).toEqual([{
        ts: '2026-10-14T15:20:31.123Z', plugin: 'sub-agent-compact', level, event,
        msg: failure === 'lookup' ? 'reading the session id failed: session lookup unavailable; the decision log is off for this session' : 'writing the decision log for /logs/decisions.jsonl failed: decision write unavailable; its 2 rows are kept and written with the next',
        where: 'hooks/sub-agent-compact.ts#record', session: 'session-1', detail: { error },
      }]);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it('queues the said line\'s level row before a throwing screen call', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'compact-screen-failure-'));
    try {
      const cc = engine({ compactTool: false, mainAutoCompact: 'bad' }, {}, api(), true, [], { home: temp, pluginLogDir: join(temp, 'logs'), uiFailsOnce: true });
      await expect(cc.start()).rejects.toThrow('screen unavailable');
      await cc.end();
      // The option error is said with its diagnostic row: one level row, the row's, at the level said.
      expect(diskRows(join(temp, 'logs/sub-agent-compact'), 'errors.jsonl').filter((row) => JSON.stringify(row).includes('SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT'))).toEqual([expect.objectContaining({
        level: 'error', event: 'option-error', where: 'hooks/sub-agent-compact.ts#record', session: 'session-1', msg: expect.stringContaining('SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT'),
      })]);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it('records gathered problems as warnings while still storing the partial handoff', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'compact-plugin-partial-'));
    try {
      const cc = engine({ forwardHandoffTool: true, compactTool: false }, {}, api(), true, [], { home: temp, pluginLogDir: join(temp, 'logs'), noTranscript: true });
      await cc.start(); await cc.step(250_000);
      expect((await cc.forward()).result).toContain('Forward handoff stored');
      await cc.end();
      const warnings = diskRows(join(temp, 'logs/sub-agent-compact'), 'warnings.jsonl');
      expect(warnings.filter((row) => row.detail?.problem === 'transcript: no file for session session-1').map((row) => [row.level, row.event, row.where])).toEqual([['warning', 'forward-invalid', 'hooks/sub-agent-compact.ts#record']]);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it('reports the directory once per failure streak and rearms after recovery, without changing work', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'compact-plugin-failure-'));
    const env: Env = { home: temp, pluginLogDir: join(temp, 'logs'), pluginRunFails: true };
    const cc = engine({ forwardHandoffTool: true, compactTool: false }, {}, api(), true, [], env);
    try {
      expect(await cc.start()).toEqual({}); await cc.end();
      const first = await cc.forward({ objective: '' }); await cc.end();
      expect(first.result).toContain('Not stored');
      const notices = () => cc.logs.filter((line) => line.includes('plugin log ') && line.includes('failed:'));
      expect(notices()).toEqual([expect.stringContaining(`${temp}/logs/sub-agent-compact failed: plugin process unavailable`)]);
      env.pluginRunFails = false;
      expect(await cc.forward({ objective: '' })).toEqual(first); await cc.end();
      expect(diskRows(join(temp, 'logs/sub-agent-compact'), 'warnings.jsonl').map((row) => row.event)).toEqual(['forward-invalid']);
      env.pluginRunFails = true;
      expect(await cc.forward({ objective: '' })).toEqual(first); await cc.end();
      expect(notices()).toEqual([expect.stringContaining('plugin process unavailable'), expect.stringContaining('plugin process unavailable')]);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it('names missing env instead of silently treating logging as absent', async () => {
    const cc = engine({ forwardHandoffTool: true, compactTool: false }, {}, api(), true, [], { noHome: true });
    await cc.start(); await cc.start(); await cc.end();
    expect(cc.logs.filter((line) => line.startsWith('plugin log off:'))).toEqual(['plugin log off: no PLUGIN_LOG_DIR and no HOME']);
    expect(await cc.read()).toEqual({ result: 'file text' });
  });
});

describe('the forced point against the real window, through the adapter', () => {
  const LOG = { forwardHandoffTool: true, compactTool: false, logFile: '/logs/decisions.jsonl' };
  it('clamps a token limit above the window to Claude Code\'s ask point, and the row shows both', async () => {
    const cc = engine({ ...LOG, mainAutoCompact: '600k' }, {}, api(), true, [], { window: 200_000 });
    await cc.start();
    await cc.step(170_000, 'claude-opus-4-5');
    expect(await cc.ask('auto')).toHaveProperty('messages');
    const rows = await cc.decisions();
    expect(rows.find((r: any) => r.event === 'session.compact')).toMatchObject({ limit: 167_000, limitSet: 600_000, decision: 'pass', why: 'at-limit' });
    expect(rows.filter((r: any) => r.event === 'warning' && r.key === 'clamped:main')).toHaveLength(1);
  });
  it('re-reads the main window when the model changes', async () => {
    const env: Env = {};
    const cc = engine(LOG, {}, api(), true, [], env);
    await cc.start();
    await cc.step(100_000, 'claude-opus-4-5[1m]');
    env.window = 200_000;
    await cc.step(130_000, 'claude-opus-4-5');
    expect(await cc.ask('auto')).toHaveProperty('messages');
    const rows = await cc.decisions();
    expect(rows.find((r: any) => r.event === 'window-changed')).toMatchObject({ party: 'main', model: 'claude-opus-4-5', from: 1_000_000, to: 200_000 });
    expect(rows.find((r: any) => r.event === 'session.compact')).toMatchObject({ limit: 120_000, decision: 'pass', why: 'at-limit' });
  });
  it('reads each model\'s window once when a router alternates the main chat\'s model per request', async () => {
    const cc = engine(LOG);
    await cc.start();
    for (let i = 0; i < 3; i++) { await cc.step(100_000, 'claude-opus-4-5[1m]'); await cc.step(100_000, 'claude-opus-4-5'); }
    expect(cc.usageCalls()).toBeLessThanOrEqual(3);
  });
  it('passes a second automatic ask that no response answered since the first was held (a prompt too long)', async () => {
    const cc = engine(LOG);
    await cc.start();
    await cc.step(150_000);
    expect(await cc.ask('auto')).toEqual({ skip: expect.any(String) });
    expect(await cc.ask('auto')).toHaveProperty('messages');
    expect((await cc.decisions()).filter((r: any) => r.event === 'session.compact').map((r: any) => [r.decision, r.why ?? null])).toEqual([['skip', null], ['pass', 'unanswered']]);
  });
  it('holds the next ask again after an interrupt or an API error ended the turn the held ask let through', async () => {
    for (const reason of ['aborted', 'error']) {
      const cc = engine(LOG);
      await cc.start();
      await cc.step(150_000);
      expect(await cc.ask('auto')).toEqual({ skip: expect.any(String) });
      await cc.turnComplete({ reason });
      expect(await cc.ask('auto')).toEqual({ skip: expect.any(String) });
    }
  });

  it('holds the next ask again after a step with no usage that asks for tools answered the held ask within the turn', async () => {
    const cc = engine(LOG);
    await cc.start();
    await cc.step(150_000);
    expect(await cc.ask('auto')).toEqual({ skip: expect.any(String) });
    await cc.stepNoUsage(1);
    expect(await cc.ask('auto')).toEqual({ skip: expect.any(String) });
  });

  it('passes the ask after a step with no usage and no tool uses (the failed request) as unanswered', async () => {
    const cc = engine(LOG);
    await cc.start();
    await cc.step(150_000);
    expect(await cc.ask('auto')).toEqual({ skip: expect.any(String) });
    await cc.stepNoUsage(0);
    expect(await cc.ask('auto')).toHaveProperty('messages');
    expect((await cc.decisions()).filter((r: any) => r.event === 'session.compact').map((r: any) => [r.decision, r.why ?? null])).toEqual([['skip', null], ['pass', 'unanswered']]);
  });

  it('holds the next ask again after the chain beneath turn.complete rejected', async () => {
    const cc = engine(LOG);
    await cc.start();
    await cc.step(150_000);
    expect(await cc.ask('auto')).toEqual({ skip: expect.any(String) });
    await expect(cc.turnComplete({}, async () => { throw new Error('turn failed below'); })).rejects.toThrow('turn failed below');
    expect(await cc.ask('auto')).toEqual({ skip: expect.any(String) });
  });
});

describe('a failing plugin log reaches the decision log', () => {
  it('records plugin-log-failed once per failure streak', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'compact-plugin-failed-row-'));
    const env: Env = { home: temp, pluginLogDir: join(temp, 'logs'), pluginRunFails: true };
    const cc = engine({ forwardHandoffTool: true, compactTool: false, logFile: '/logs/decisions.jsonl' }, {}, api(), true, [], env);
    try {
      await cc.start(); await cc.end();
      await cc.forward({ objective: '' }); await cc.end();
      const failed = (await cc.decisions()).filter((r: any) => r.event === 'plugin-log-failed');
      expect(failed).toEqual([expect.objectContaining({ dir: join(temp, 'logs/sub-agent-compact'), error: 'plugin process unavailable' })]);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});

describe('the decision log through the adapter', () => {
  it('appends through the append script, cleans up old sessions once, and closes the open skip streak at session end', async () => {
    const cc = engine({ forwardHandoffTool: true, compactTool: false, logFile: '/logs/decisions.jsonl' });
    await cc.start();
    for (let i = 0; i < 3; i++) { await cc.step(10_000 + i); await cc.ask('auto'); }
    await cc.end();
    const rows = (await cc.decisions()).filter((r: any) => r.event === 'session.compact' || r.event === 'skips');
    expect(rows.map((r: any) => [r.event, r.decision ?? null, r.count ?? null])).toEqual([['session.compact', 'skip', null], ['skips', null, 2]]);
    expect(cc.fsWrites.filter((path) => path.startsWith('/logs/'))).toEqual([]);
    const retention = cc.runCalls.filter((argv) => argv[3] === 'decision-retention');
    expect(retention.map((argv) => argv.slice(4))).toEqual([['/logs', 'decisions.', '.jsonl', '14', '200', 'decisions.session-1.jsonl']]);
    expect(cc.runCalls.filter((argv) => argv[3] === 'decision-log').every((argv) => argv[4] === '/logs/decisions.session-1.jsonl')).toBe(true);
  });
});

describe('a decision append that fails keeps its rows', () => {
  const LOG = { forwardHandoffTool: true, compactTool: false, logFile: '/logs/decisions.jsonl' };
  it('writes the rows of an aborted append once, in order, at the next flush, and says they were kept', async () => {
    const cc = engine(LOG, {}, api(), true, [], { decisionWriteAbortsOnce: true });
    await cc.start();
    await cc.decisions();
    await cc.step(10_000); await cc.ask('auto');
    await cc.end();
    const rows = await cc.decisions();
    expect(rows.filter((r: any) => r.event === 'start')).toHaveLength(1);
    expect(rows[0].event).toBe('start');
    expect(rows.filter((r: any) => r.event === 'tool-registered').map((r: any) => r.tool)).toEqual(['mcp__sub-agent-compact__forward_handoff', 'mcp__sub-agent-compact__look_back']);
    expect(rows.filter((r: any) => r.event === 'session.compact')).toHaveLength(1);
    expect(cc.logs.filter((line) => line.startsWith('writing the decision log'))).toEqual([expect.stringMatching(/aborted; its \d+ rows? (is|are) kept and written with the next/)]);
  });

  it('tells the person how many rows the session-end flush could not write, and ends only once its error row is written', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'rows-lost-'));
    // A slow level log: the session end must wait for the rows-lost row, not return before it lands.
    const env: Env = { home: temp, pluginLogDir: join(temp, 'logs'), decisionWriteFails: true, pluginWaits: new Promise<void>((resolve) => setTimeout(resolve, 50)) };
    try {
      const cc = engine(LOG, {}, api(), true, [], env);
      await cc.start();
      await cc.step(10_000); await cc.ask('auto');
      await cc.end();
      expect(cc.logs.filter((line) => /^\d+ decision rows? (was|were) not written/.test(line))).toEqual([expect.stringMatching(/^\d+ decision rows were not written to \/logs\/decisions\.session-1\.jsonl: decision write unavailable$/)]);
      const errors = join(temp, 'logs/sub-agent-compact/errors.jsonl');
      const lost = existsSync(errors) ? readFileSync(errors, 'utf8').trim().split('\n').map((row) => JSON.parse(row)).filter((row) => row.event === 'decision-log-rows-lost') : [];
      expect(lost).toEqual([expect.objectContaining({ level: 'error', where: 'hooks/sub-agent-compact.ts#session.end', msg: expect.stringMatching(/^\d+ decision rows were not written to /), detail: expect.objectContaining({ dropped: 0, error: 'decision write unavailable' }) })]);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('counts only the rows not yet written when the end bound cuts the first cleanup', async () => {
    let release = () => {};
    const env: Env = { timersFire: true, retentionWaits: new Promise<void>((resolve) => { release = resolve; }) };
    const cc = engine(LOG, {}, api(), true, [], env);
    await cc.start();
    await cc.step(10_000); await cc.ask('auto');
    expect(await cc.end('exit', 400)).toEqual({ sessionId: 'session-1' });
    const line = cc.logs.find((l: string) => l.includes('session-end bound (400 ms) ran out')) ?? '';
    const written = (await cc.decisions()).length;
    release();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const unwritten = (await cc.decisions()).length - written;
    expect(written).toBeGreaterThan(0);
    expect(unwritten).toBeGreaterThan(0);
    expect(line).toMatch(new RegExp(`; ${unwritten} decision rows? may be lost$`));
  });

  it('writes a retention warning to the decision log without screen noise', async () => {
    const cc = engine(LOG, {}, api(), true, [], { retentionFails: 'sub-agent-compact: $.process.run(/bin/sh) aborted: still running after 15000ms' });
    await cc.start();
    await cc.step(10_000); await cc.ask('auto');
    await cc.end();
    const rows = await cc.decisions();
    expect(rows.filter((r: any) => r.event === 'decision-retention-failed')).toEqual([expect.objectContaining({ file: '/logs/decisions.jsonl', error: 'sub-agent-compact: $.process.run(/bin/sh) aborted: still running after 15000ms' })]);
    expect(cc.logs.filter((line) => line.startsWith('cleaning up old decision logs'))).toHaveLength(0);
  });

  it('runs retention after the session\'s first append, not before it', async () => {
    const cc = engine(LOG);
    await cc.start();
    await cc.step(10_000); await cc.ask('auto');
    await cc.end();
    const kinds = cc.runCalls.map((argv) => argv[3]).filter((k) => k === 'decision-log' || k === 'decision-retention');
    expect(kinds.slice(0, 2)).toEqual(['decision-log', 'decision-retention']);
  });
});

describe('main state after a compaction the plugin did not handle, through the adapter', () => {
  const LOG = { forwardHandoffTool: true, compactTool: false, logFile: '/logs/decisions.jsonl' };
  it('drops the stored handoff and re-arms the nudges after an unseen compaction', async () => {
    const cc = engine(LOG);
    await cc.start();
    await cc.step(250_000);
    expect((await cc.read()).context?.[0]).toContain('mcp__sub-agent-compact__forward_handoff');
    expect((await cc.forward()).result).toMatch(/^Forward handoff stored/);
    await cc.step(40_000);
    await cc.step(250_000);
    expect((await cc.read()).context?.join('\n') ?? '').toContain('mcp__sub-agent-compact__forward_handoff');
    await cc.ask('auto');
    const rows = await cc.decisions();
    expect(rows.filter((r: any) => r.event === 'compact-unseen')).toEqual([expect.objectContaining({ party: 'main', before: 250_000, after: 40_000, handoffDropped: true })]);
    expect(rows.filter((r: any) => r.decision === 'handoff')).toEqual([]);
  });

  it('starts main over at a /clear: a cleared row, no unseen row and no stale handoff', async () => {
    const cc = engine(LOG);
    await cc.start();
    await cc.step(250_000);
    await cc.forward();
    await cc.end('clear');
    await cc.step(5_000);
    await cc.step(250_000);
    await cc.ask('auto');
    const rows = await cc.decisions();
    expect(rows.filter((r: any) => r.event === 'cleared')).toEqual([expect.objectContaining({ party: 'main', reason: 'clear' })]);
    expect(rows.filter((r: any) => r.event === 'compact-unseen')).toEqual([]);
    expect(rows.filter((r: any) => r.decision === 'handoff')).toEqual([]);
  });

  it('starts main over within the end bound while the log append hangs, and the ending session keeps its rows', async () => {
    let release = () => {};
    const env: Env = { timersFire: true, appendWaits: new Promise<void>((resolve) => { release = resolve; }) };
    const cc = engine(LOG, {}, api(), true, [], env);
    await cc.start();
    await cc.step(250_000);
    await cc.forward();
    expect(await cc.end('clear', 400)).toEqual({ sessionId: 'session-1' });
    expect(cc.logs.some((line: string) => line.includes('session-end bound (400 ms) ran out'))).toBe(true);
    await cc.step(5_000);
    await cc.step(250_000);
    release();
    await cc.end();
    const rows = await cc.decisions();
    expect(rows.filter((r: any) => r.event === 'cleared')).toEqual([expect.objectContaining({ party: 'main', reason: 'clear', handoffDropped: true })]);
    expect(rows.filter((r: any) => r.event === 'compact-unseen')).toEqual([]);
  });

  it('counts the level rows a cut end flush may lose, not only decision rows', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'compact-end-level-'));
    let release = () => {};
    const env: Env = { home: temp, pluginLogDir: join(temp, 'logs'), timersFire: true, pluginWaits: new Promise<void>((resolve) => { release = resolve; }) };
    // A real level row in flight: the option error's warning, held by the stalled level-log writer.
    const cc = engine({ ...LOG, mainAutoCompact: 'bad' }, {}, api(), true, [], env);
    try {
      await cc.start();
      expect(await cc.end('clear', 400)).toEqual({ sessionId: 'session-1' });
      const line = cc.logs.find((l: string) => l.includes('session-end bound (400 ms) ran out')) ?? '';
      expect(line).toMatch(/\d+ level rows? may be lost$/);
      expect(line).not.toContain('0 decision');
    } finally { release(); rmSync(temp, { recursive: true, force: true }); }
  });

  it('names the session-end flush as unbounded when the clock is unavailable', async () => {
    const cc = engine(LOG, {}, api(), true, [], { noClock: true });
    await cc.start();
    expect(await cc.end('clear', 400)).toEqual({ sessionId: 'session-1' });
    expect(cc.logs.some((l: string) => l.includes('the session-end log flush is not time-bounded'))).toBe(true);
  });

  it('is not masked by a precompute that installed nothing', async () => {
    const cc = engine(LOG);
    await cc.start();
    await cc.step(250_000);
    await cc.ask('precompute');
    await cc.step(20_000);
    expect((await cc.decisions()).filter((r: any) => r.event === 'compact-unseen')).toEqual([expect.objectContaining({ before: 250_000, after: 20_000 })]);
  });

  it('forces the compaction between turns when the native one did not finish', async () => {
    const cc = engine({ ...LOG, mainAutoCompact: '100k' });
    await cc.start();
    await cc.step(150_000);
    expect(await cc.askUnfinished('auto')).toEqual({ skip: 'prompt is too long' });
    await cc.turnComplete();
    expect(cc.compacts()).toBe(1);
  });
});
