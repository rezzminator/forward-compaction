import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { register } from '../../plugins/sub-agent-compact/hooks/sub-agent-compact.ts';
import { optionVars } from '../option-env.ts';

type AnyHook = (...args: any[]) => any;
export const TOOL = 'mcp__sub-agent-compact__forward_handoff';
export const DIR = '/h/u/.local/state/sub-agent-compact/forward-handoff/session-1/1';
/** Where records were kept before: under the Claude config directory, so a CLAUDE_CONFIG_DIR switch lost them. */
export const LEGACY_DIR = '/h/u/.claude/sub-agent-compact/forward-handoff/session-1/1';
// Claude Code hashes a project path over 200 characters: the directory is not the cwd with dashes.
export const TRANSCRIPT = '/h/u/.claude/projects/-nowhere-aaaa-0f3c9d/session-1.jsonl';
export const AGENT_DIR = '/h/u/.local/state/sub-agent-compact/forward-handoff/session-1/agent-agent-1/1';
export const FIELDS = { objective: 'Rename qty to quantity in every report', done: ['a.sql, b.sql: npm test 41/41'], remaining: ['c.sql'], next: 'Edit reports/c.sql:12, then run npm test.' };

export const text = (t: string) => ({ type: 'text', text: t });
export const api = (extra: unknown[] = []) => [
  { role: 'user', content: [text('rename qty to quantity in every report')] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/nowhere/reports/a.sql' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'SELECT qty' }] },
  ...extra,
  { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'mcp__sub-agent-compact__forward_handoff', input: FIELDS }] },
];

export type Env = { registerOptions?: Record<string, unknown>; settings?: Record<string, Record<string, unknown>>; settingsReadFails?: string[]; homeGate?: Promise<void>; timers?: (() => void)[]; cwdFails?: boolean; vars?: Record<string, string>; envReadFails?: string[]; window?: number; decisionSessionFailsOnce?: boolean; decisionWriteFails?: boolean; uiFailsOnce?: boolean; home?: string; pluginLogDir?: string; pluginRunFails?: boolean; readFails?: string[]; denied?: string[]; listFails?: boolean; noHome?: boolean; noTranscript?: boolean; cwd?: string; agentRows?: Record<string, unknown[]>; agents?: { id: string; type: string; parentId?: string; name?: string }[]; run?: (argv: string[], init?: { cwd?: string }) => { exitCode: number; stdout: string; stderr: string } | undefined; appendWaits?: Promise<void>; decisionWriteAbortsOnce?: boolean; retentionFails?: string; retentionWaits?: Promise<void>; messagesFail?: boolean; pluginWaits?: Promise<void>; timersFire?: boolean; noClock?: boolean; claimFails?: boolean; spawnProbe?: (argv: string[], init?: { cwd?: string }) => void;
  agentEntries?: Record<string, { name: string; kind: 'file' | 'dir' | 'other'; size: number; isLink: boolean }[]>;
  agentStats?: Record<string, { kind: 'file' | 'dir' | 'other'; size: number; isLink?: boolean; realPath?: string }>;
  statFails?: string[];
  existsFails?: string[];
  writeFails?: string[];
  agentListFails?: boolean;
};
const pluginExec = promisify(execFile);

export function engine(options: Record<string, unknown> = { forwardHandoffTool: true }, files: Record<string, string> = {}, apiRows: unknown[] = api(), git = true, refused: string[] = [], env: Env = {}) {
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
        env.spawnProbe?.(argv, init);
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
        // A paged scan (runPaged) as Claude Code returns it: the scan, run as scripted, from line PAGE_START, one page
        // of at most 3,000,000 bytes and its marker, cut at the engine's 4,194,304-character output limit.
        const paged = argv[0] === 'sh' ? /^\{ ([\s\S]*); \} \| tail -n \+"\$PAGE_START" \| /.exec(argv[2] ?? '') : null;
        if (paged !== null) {
          const inner = env.run?.(['sh', '-c', paged[1]!, ...argv.slice(3)], init) ?? { exitCode: 0, stdout: '', stderr: '' };
          const all = inner.stdout.split('\n');
          if (all.at(-1) === '') all.pop();
          const page: string[] = [];
          let bytes = 0;
          let more = false;
          for (const l of all.slice(Number((init as { env?: Record<string, string> } | undefined)?.env?.PAGE_START ?? 1) - 1)) {
            bytes += Buffer.byteLength(l) + 1;
            if (page.length > 0 && bytes > 3_000_000) { more = true; continue; }
            page.push(l);
          }
          return { exitCode: 0, stdout: [...page, more ? '[page-more]' : '[page-end]', ''].join('\n').slice(0, 4_194_304), stderr: inner.stderr };
        }
        const line = argv.join(' ');
        const scripted = env.run?.(argv, init);
        // Claude Code keeps 4,194,304 characters of a child's output and cuts the rest.
        if (scripted !== undefined) return { ...scripted, stdout: scripted.stdout.slice(0, 4_194_304) };
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
