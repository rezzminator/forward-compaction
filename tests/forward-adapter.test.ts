import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { URL } from 'node:url';
import { register } from '../plugins/sub-agent-compact/hooks/sub-agent-compact.ts';

// The forward handoff through the adapter: the tool collects what code carries, stores the text and
// persists the call's files; the next automatic ask installs the stored text verbatim and checks it landed.

type AnyHook = (...args: any[]) => any;
const TOOL = 'mcp__sub-agent-compact__forward_handoff';
const DIR = '/h/u/.claude/sub-agent-compact/forward-handoff/session-1/1';
// Claude Code hashes a project path over 200 characters: the directory is not the cwd with dashes.
const TRANSCRIPT = '/h/u/.claude/projects/-nowhere-aaaa-0f3c9d/session-1.jsonl';
const AGENT_DIR = '/h/u/.claude/sub-agent-compact/forward-handoff/session-1/agent-agent-1/1';
const FIELDS = { objective: 'Rename qty to quantity in every report', done: ['a.sql, b.sql: npm test 41/41'], remaining: ['c.sql'], next: 'Edit reports/c.sql:12, then run npm test.' };

const text = (t: string) => ({ type: 'text', text: t });
const api = (extra: unknown[] = []) => [
  { role: 'user', content: [text('rename qty to quantity in every report')] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/nowhere/reports/a.sql' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'SELECT qty' }] },
  ...extra,
  { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'mcp__sub-agent-compact__forward_handoff', input: FIELDS }] },
];

type Env = { home?: string; pluginLogDir?: string; pluginUser?: { uid: number; gid: number }; pluginRunFails?: boolean; denied?: string[]; listFails?: boolean; noHome?: boolean; noTranscript?: boolean; cwd?: string; agentRows?: Record<string, unknown[]>; agents?: { id: string; type: string }[]; run?: (argv: string[], init?: { cwd?: string }) => { exitCode: number; stdout: string; stderr: string } | undefined };
const pluginExec = promisify(execFile);

function engine(options: Record<string, unknown> = { forwardHandoffTool: true }, files: Record<string, string> = {}, apiRows: unknown[] = api(), git = true, refused: string[] = [], env: Env = {}) {
  const hooks = new Map<string, AnyHook>();
  const registered: string[] = [];
  const specs: Record<string, any> = {};
  const runCalls: string[][] = [];
  const nextInputs: unknown[] = [];
  const written: Record<string, string> = {};
  const logs: string[] = [];
  let current = 0;
  let summarized = 0;
  const known: Record<string, string> = { [TRANSCRIPT]: '', ...files };
  const $ = {
    session: {
      id: async () => 'session-1',
      turns: async () => 1,
      cwd: async () => env.cwd ?? '/nowhere',
      usage: async () => ({ context: { tokens: current, window: 1_000_000 } }),
      messages: async (a?: { agentId?: string }) => (a?.agentId !== undefined ? (env.agentRows?.[a.agentId] ?? []) : apiRows),
      compact: async () => ({}),
    },
    env: { get: async (key: string) => key === 'PLUGIN_LOG_DIR' ? env.pluginLogDir : key === 'HOME' && !env.noHome ? env.home ?? '/h/u' : undefined },
    fs: {
      exists: async (path: string) => path in known || path in written || Object.keys(written).some((p) => p.startsWith(`${path}/`)),
      read: async (path: string) => known[path] ?? written[path] ?? '',
      write: async (path: string, content: string) => void (written[path] = content),
      list: async (dir: string) => {
        if (env.listFails) throw new Error(`EACCES: permission denied, scandir '${dir}'`);
        const names = Object.keys(written).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1).split('/')[0]!);
        return [...new Set(names)].map((name) => ({ name, kind: 'dir' }));
      },
      stat: async (path: string) => ({ kind: 'file', size: (known[path] ?? '').length, mtimeMs: 0, isLink: false }),
    },
    process: {
      run: async (argv: string[], init?: { cwd?: string }) => {
        runCalls.push(argv);
        if (argv[0] === '/bin/sh' && argv[3] === 'plugin-log') {
          if (env.pluginRunFails) throw new Error('plugin process unavailable');
          const out = await pluginExec('/bin/sh', argv.slice(1), { encoding: 'utf8', ...env.pluginUser });
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
    clock: { now: async () => Date.parse('2026-10-14T15:20:31.123Z'), after: (ms: number, fn: () => void) => ({ cancel: () => clearTimeout(setTimeout(fn, ms)) }) },
    ui: { log: (line: string) => void logs.push(line) },
    agent: { list: async () => env.agents ?? [] },
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
  register(on as never, options as never);
  const dispatch = (event: string, e: unknown, impl: (e: any) => any): any => {
    const next = Object.assign((input: unknown) => impl(input), { signal: new AbortController().signal });
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
    nextInputs,
    call: (e: Record<string, unknown>) => dispatch('tool.call', e, async (input) => { nextInputs.push(input); return { result: 'original result' }; }),
    decisions: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return Object.values(written).flatMap((body) => body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    },
    written,
    logs,
    summarized: () => summarized,
    start: () => dispatch('session.start', {}, async () => ({})),
    end: () => dispatch('session.end', { reason: 'exit' }, async () => ({ sessionId: 'session-1' })),
    step: async (tokens: number, model = 'claude-opus-4-5[1m]') => {
      current = tokens;
      const gen = dispatch('turn.step', { model }, async function* () {
        return { usage: { input_tokens: tokens }, answer: 'working', toolUses: [{}] };
      });
      for (;;) if ((await gen.next()).done) break;
    },
    forward: (fields: Record<string, unknown> = FIELDS, agentId?: string) =>
      dispatch('tool.call', { tool: TOOL, ...fields, tool_use_id: 'f1', ...(agentId ? { agentId } : {}) }, async () => ({ result: 'unreached' })),
    stop: (e: Record<string, unknown>) => dispatch('classic.Stop', e, async () => ({})),
    read: () => dispatch('tool.call', { tool: 'Read', file_path: 'x' }, async () => ({ result: 'file text' })),
    ask: (trigger: string, messages: unknown[] = rows) =>
      dispatch('session.compact', { trigger, messages }, async () => {
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
    const after = out.tokensAfter < 1000 ? String(out.tokensAfter) : `${Math.round(out.tokensAfter / 1000)}k`;
    expect(cc.logs.filter((line) => /handoff/.test(line))).toEqual([`forward handoff 1 of main: 250k -> ${after} tokens, all ${record.blocks.length} blocks landed, files in ${DIR}`]);
    expect(cc.logs.filter((line) => line.startsWith('sub-agent-compact:'))).toEqual([]);
  });

  it('holds Claude Code\'s automatic ask of a Haiku main chat until its forward handoff is stored, telling it once', async () => {
    const cc = engine();
    await cc.start();
    await cc.step(60_000, 'claude-haiku-4-5');
    expect(await cc.ask('auto')).toEqual({ skip: expect.stringContaining('held for its forward handoff (1/3)') });
    const told = await cc.read();
    expect((told.context ?? []).filter((line: string) => line.includes('very next step'))).toHaveLength(1);
    expect(await cc.ask('auto')).toEqual({ skip: expect.stringContaining('(2/3)') });
    expect(((await cc.read()).context ?? []).some((line: string) => line.includes('very next step'))).toBe(false);
    expect((await cc.forward()).result).toMatch(/^Forward handoff stored/);
    const out = await cc.ask('auto');
    expect(cc.summarized()).toBe(0);
    expect(out.messages[0].text).toBe(cc.written[`${DIR}/wake.txt`]);
  });

  it('lets a Haiku main chat\'s ask through to Claude Code\'s own summary after three holds without a forward handoff', async () => {
    const cc = engine();
    await cc.start();
    await cc.step(60_000, 'claude-haiku-4-5');
    for (let i = 1; i <= 3; i++) expect(await cc.ask('auto')).toEqual({ skip: expect.stringContaining(`(${i}/3)`) });
    await cc.ask('auto');
    expect(cc.summarized()).toBe(1);
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
  });

  it('saves nothing into the project when there is no Claude config directory, and says so', async () => {
    const cc = engine({ forwardHandoffTool: true }, {}, api(), true, [], { noHome: true });
    await cc.start();
    const out = await cc.forward();
    expect(Object.keys(cc.written)).toEqual([]);
    expect(out.result).toMatch(/Not saved to disk: no Claude config directory/);
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
    expect(wake).toContain('Unresolved\nload /nowhere/nope.ts: not found\ndrop_skills zzz: not invoked\n');
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

  it('outlines each file the party made or edited from its content now, and names one it cannot read', async () => {
    const rows = [{ role: 'user', content: [text('build it')] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'src/levels.ts', content: 'x' } }, { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'src/gone.ts' } }] }];
    const cc = engine({ forwardHandoffTool: true }, { '/nowhere/src/levels.ts': 'export const LEVELS = [1];\nexport function rank() {}\n' }, rows);
    await cc.start();
    await cc.step(250_000);
    await cc.forward();
    const wake = cc.written[`${DIR}/wake.txt`]!;
    expect(wake).toContain('C /nowhere/src/levels.ts — 2 lines: LEVELS, rank\n');
    expect(wake).toContain('E /nowhere/src/gone.ts\n');
    expect(wake).toMatch(/Unresolved\n(?:.*\n)*outline \/nowhere\/src\/gone\.ts: not found\n/);
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
    expect(wake).toContain('earlier handoff: its record is missing');
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
    expect(lookLines(cc)).toHaveLength(2);
    expect((await saidLines(cc))[2]).toBe('look back (main): lost output — failed: tool name lookup: grep: transcript unavailable');
    expect(await lookRows(cc)).toHaveLength(3);
    expect((await lookRows(cc))[2]).toMatchObject({ entry: 8, boundary: 10, error: 'tool name lookup: grep: transcript unavailable' });
  });
  it('counts an invalid call with one failed notice and row, with no transcript process', async () => {
    const cc = lookEngine(); await cc.start();
    const out = await cc.call({ tool: LOOK_BACK, why: 'lost detail' });
    expect(out.result).toContain('query or entry');
    expect(cc.runCalls.filter((argv) => argv[3] !== 'plugin-log')).toEqual([]);
    expect(lookLines(cc)).toEqual(['look back (main): lost detail — failed: query or entry is required']);
    expect((await lookRows(cc))[0]).toMatchObject({ why: 'lost detail', boundary: null, error: 'query or entry is required' });
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
    expect(cc.runCalls.filter((argv) => argv[3] !== 'plugin-log')).toEqual([]);
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
    expect(cc.runCalls.filter((argv) => argv[3] !== 'plugin-log')).toEqual([]);
  });
});

// Every line the plugin says lands in the decision log as a 'said' row; a routine success stays off the screen while a log takes it.
describe('the lines the plugin says, on the screen and in the decision log', () => {
  const said = async (cc: ReturnType<typeof engine>) => (await cc.decisions()).filter((r: any) => r.event === 'said');
  it('logs a look back notice as a said row and keeps it off the screen', async () => {
    const cc = lookEngine(); await cc.start();
    await cc.call({ tool: LOOK_BACK, why: 'lost error', query: 'alpha beta' });
    expect((await said(cc)).filter((r: any) => r.line.startsWith('look back'))).toEqual([expect.objectContaining({ event: 'said', line: 'look back (main): lost error — 1 hits', shown: false })]);
    expect(lookLines(cc)).toEqual([]);
  });
  it('shows a failure line on the screen and logs it as a said row', async () => {
    const cc = lookEngine(); await cc.start();
    await cc.call({ tool: LOOK_BACK, why: 'lost detail' });
    const line = 'look back (main): lost detail — failed: query or entry is required';
    expect(lookLines(cc)).toEqual([line]);
    expect((await said(cc)).filter((r: any) => r.line === line)).toEqual([expect.objectContaining({ shown: true })]);
  });
  it('shows a failure the old code left off the log, by its screen text', async () => {
    const cc = engine({ forwardHandoffTool: true, logFile: '/logs/decisions.jsonl' }, { [DIR.replace(/\/1$/, '')]: '' }, api(), true, [], { listFails: true });
    await cc.start();
    await cc.forward();
    const line = cc.logs.find((l) => l.includes('EACCES'))!;
    expect(line).toMatch(/^listing .* failed: EACCES/);
    expect((await said(cc)).filter((r: any) => r.line === line)).toEqual([expect.objectContaining({ shown: true })]);
  });
  it('shows a routine line on the screen when no decision log is configured', async () => {
    const cc = engine({ handoffTool: false, forwardHandoffTool: false, compactTool: false }, {}, api(), true, [], lookEngineRun);
    await cc.start();
    await cc.call({ tool: LOOK_BACK, why: 'lost error', query: 'alpha beta' });
    expect(lookLines(cc)).toEqual(['look back (main): lost error — 1 hits']);
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

describe('plugin log through the forward adapter', () => {
  const diskRows = (dir: string, file: string): any[] => existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').trim().split('\n').map((row) => JSON.parse(row)) : [];
  it.each([true, false])('writes forced levels, one heartbeat and the session at override=%s', async (override) => {
    const temp = mkdtempSync(join(tmpdir(), 'compact-plugin-adapter-'));
    const dir = override ? join(temp, 'logs/sub-agent-compact') : join(temp, '.local/state/sub-agent-compact/logs');
    try {
      const cc = engine({ forwardHandoffTool: true, compactTool: false, mainAutoCompact: 'bad', logFile: '/logs/decisions.jsonl' }, {}, api(), true, ['look_back'], { home: temp, ...(override ? { pluginLogDir: join(temp, 'logs') } : {}) });
      expect(await cc.start()).toEqual({});
      await cc.start();
      expect(await cc.end()).toEqual({ sessionId: 'session-1' });
      const errors = diskRows(dir, 'errors.jsonl'); const warnings = diskRows(dir, 'warnings.jsonl'); const info = diskRows(dir, 'info.jsonl');
      expect(errors.filter((row) => row.event === 'tool-register-failed').map((row) => [row.level, row.where, row.session, row.detail.tool])).toEqual([['error', 'hooks/sub-agent-compact.ts#record', 'session-1', 'look_back'], ['error', 'hooks/sub-agent-compact.ts#record', 'session-1', 'look_back']]);
      expect(warnings.filter((row) => row.event === 'option-error').map((row) => [row.level, row.where, row.session])).toEqual([['warning', 'hooks/sub-agent-compact.ts#record', 'session-1']]);
      expect(info).toEqual([{ ts: '2026-10-14T15:20:31.123Z', plugin: 'sub-agent-compact', level: 'info', event: 'logger-ready', msg: 'plugin logger ready', where: 'hooks/sub-agent-compact.ts#start', session: 'session-1', detail: { version: JSON.parse(readFileSync(new URL('../plugins/sub-agent-compact/.claude-plugin/plugin.json', import.meta.url), 'utf8')).version, dir_source: override ? 'PLUGIN_LOG_DIR' : 'fallback' } }]);
      const said = (await cc.decisions()).find((row: any) => row.event === 'said');
      expect(Object.keys(said)).toEqual(['ts', 'event', 'line', 'shown']);
      expect(cc.runCalls.filter((argv) => argv[0] === '/bin/sh' && argv[3] === 'plugin-log').every((argv) => argv[4] === dir)).toBe(true);
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
  it.skipIf(process.getuid?.() !== 0)('skip-because:needs-root-fixture: nonroot chmod EPERM reports once and keeps tool results', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'compact-plugin-eperm-')); const dir = join(temp, 'sub-agent-compact');
    chmodSync(temp, 0o777); mkdirSync(dir, { mode: 0o777 }); chmodSync(dir, 0o777);
    const cc = engine({ forwardHandoffTool: true, compactTool: false }, {}, api(), true, [], { home: temp, pluginLogDir: temp, pluginUser: { uid: 65534, gid: 65534 } });
    try {
      expect(await cc.start()).toEqual({}); await cc.end();
      expect((await cc.forward({ objective: '' })).result).toContain('Not stored'); await cc.end();
      expect(cc.logs.filter((line) => line.includes('plugin log ') && line.includes('failed:'))).toEqual([expect.stringMatching(new RegExp(`${dir} failed:[\\s\\S]*Operation not permitted`))]);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it('names missing env instead of silently treating logging as absent', async () => {
    const cc = engine({ forwardHandoffTool: true, compactTool: false }, {}, api(), true, [], { noHome: true });
    await cc.start(); await cc.start(); await cc.end();
    expect(cc.logs.filter((line) => line.startsWith('plugin log off:'))).toEqual(['plugin log off: no PLUGIN_LOG_DIR and no HOME']);
    expect(await cc.read()).toEqual({ result: 'file text' });
  });
});
