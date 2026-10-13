import { describe, expect, it } from 'vitest';
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

type Env = { denied?: string[]; listFails?: boolean; noHome?: boolean; noTranscript?: boolean; agentRows?: Record<string, unknown[]>; agents?: { id: string; type: string }[]; run?: (argv: string[]) => { exitCode: number; stdout: string; stderr: string } | undefined };

function engine(options: Record<string, unknown> = { forwardHandoffTool: true }, files: Record<string, string> = {}, apiRows: unknown[] = api(), git = true, refused: string[] = [], env: Env = {}) {
  const hooks = new Map<string, AnyHook>();
  const registered: string[] = [];
  const written: Record<string, string> = {};
  const logs: string[] = [];
  let current = 0;
  let summarized = 0;
  const known: Record<string, string> = { [TRANSCRIPT]: '', ...files };
  const $ = {
    session: {
      id: async () => 'session-1',
      turns: async () => 1,
      cwd: async () => '/nowhere',
      usage: async () => ({ context: { tokens: current, window: 1_000_000 } }),
      messages: async (a?: { agentId?: string }) => (a?.agentId !== undefined ? (env.agentRows?.[a.agentId] ?? []) : apiRows),
      compact: async () => ({}),
    },
    env: { get: async (key: string) => (key === 'HOME' && !env.noHome ? '/h/u' : undefined) },
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
      run: async (argv: string[]) => {
        const line = argv.join(' ');
        const scripted = env.run?.(argv);
        if (scripted !== undefined) return scripted;
        if (!git && argv[0] === 'git') return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' };
        if (line === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'main\n', stderr: '' };
        if (line === 'git rev-parse --show-toplevel') return { exitCode: 0, stdout: '/nowhere\n', stderr: '' };
        if (argv[0] === 'find') return { exitCode: 0, stdout: env.noTranscript ? '' : `${TRANSCRIPT}\n`, stderr: '' };
        if (line === 'git rev-parse --short HEAD') return { exitCode: 0, stdout: 'abc1234\n', stderr: '' };
        if (line === 'git -c core.fsmonitor=false status --porcelain') return { exitCode: 0, stdout: ' M a.txt\n', stderr: '' };
        if (argv[0] === 'grep' && argv.includes('-c')) return { exitCode: 0, stdout: '812\n', stderr: '' };
        return { exitCode: 1, stdout: '', stderr: '' };
      },
    },
    clock: { after: (ms: number, fn: () => void) => ({ cancel: () => clearTimeout(setTimeout(fn, ms)) }) },
    ui: { log: (line: string) => void logs.push(line) },
    agent: { list: async () => env.agents ?? [] },
    tool: {
      check: async (q: { tool: string; input: { file_path: string } }) =>
        env.denied?.includes(q.input.file_path) ? { decision: 'deny', reason: 'Permission to read this file has been denied.', rule: 'Read(.env)' } : { decision: 'allow' },
      register: async (spec: { name: string }) => {
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
    written,
    logs,
    summarized: () => summarized,
    start: () => dispatch('session.start', {}, async () => ({})),
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
    expect(off.registered).toEqual(['handoff']);
    const on = engine();
    await on.start();
    expect(on.registered.sort()).toEqual(['forward_handoff', 'handoff']);
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
    expect(record.blocks.map((b: { name: string }) => b.name)).toEqual(['User', 'Files', 'Git', 'Paths', 'Objective', 'Done', 'Remaining', 'Next']);
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

  it('loads the notes the party wrote outside the repo when load_files leaves them out', async () => {
    const rows = [{ role: 'user', content: [text('build it')] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/h/u/state/plan.md', content: 'x' } }, { type: 'tool_use', id: 'w2', name: 'Write', input: { file_path: 'docs/guide.md', content: 'y' } }] }];
    const cc = engine({ forwardHandoffTool: true }, { '/h/u/state/plan.md': '# Plan\nstep 2: tests first\n', '/nowhere/docs/guide.md': '# Guide\n' }, rows);
    await cc.start();
    await cc.step(250_000);
    await cc.forward();
    const wake = cc.written[`${DIR}/wake.txt`]!;
    expect(wake).toContain('Load /h/u/state/plan.md (own notes)\n# Plan\nstep 2: tests first');
    expect(wake).not.toContain('Load /nowhere/docs/guide.md');
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
    expect(cc.registered).toEqual([]);
  });
});
