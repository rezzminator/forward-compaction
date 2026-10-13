import { describe, expect, it } from 'vitest';
import { register } from '../plugins/sub-agent-compact/hooks/sub-agent-compact.ts';

// The forward handoff through the adapter: the tool collects what code carries, stores the text and
// persists the call's files; the next automatic ask installs the stored text verbatim and checks it landed.

type AnyHook = (...args: any[]) => any;
const TOOL = 'mcp__sub-agent-compact__forward_handoff';
const DIR = '/h/u/.claude/sub-agent-compact/forward-handoff/session-1/1';
const TRANSCRIPT = '/h/u/.claude/projects/-nowhere/session-1.jsonl';
const FIELDS = { objective: 'Rename qty to quantity in every report', done: ['a.sql, b.sql: npm test 41/41'], remaining: ['c.sql'], next: 'Edit reports/c.sql:12, then run npm test.' };

const text = (t: string) => ({ type: 'text', text: t });
const api = (extra: unknown[] = []) => [
  { role: 'user', content: [text('rename qty to quantity in every report')] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/nowhere/reports/a.sql' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'SELECT qty' }] },
  ...extra,
  { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'mcp__sub-agent-compact__forward_handoff', input: FIELDS }] },
];

type Env = { denied?: string[]; listFails?: boolean; noHome?: boolean };

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
      messages: async () => apiRows,
      compact: async () => ({}),
    },
    env: { get: async (key: string) => (key === 'HOME' && !env.noHome ? '/h/u' : undefined) },
    fs: {
      exists: async (path: string) => path in known || path in written,
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
        if (!git && argv[0] === 'git') return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' };
        if (line === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'main\n', stderr: '' };
        if (line === 'git rev-parse --short HEAD') return { exitCode: 0, stdout: 'abc1234\n', stderr: '' };
        if (line === 'git -c core.fsmonitor=false status --porcelain') return { exitCode: 0, stdout: ' M a.txt\n', stderr: '' };
        if (argv[0] === 'grep' && argv.includes('-c')) return { exitCode: 0, stdout: '812\n', stderr: '' };
        return { exitCode: 1, stdout: '', stderr: '' };
      },
    },
    clock: { after: (ms: number, fn: () => void) => ({ cancel: () => clearTimeout(setTimeout(fn, ms)) }) },
    ui: { log: (line: string) => void logs.push(line) },
    agent: { list: async () => [] },
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
    step: async (tokens: number) => {
      current = tokens;
      const gen = dispatch('turn.step', { model: 'claude-opus-4-5[1m]' }, async function* () {
        return { usage: { input_tokens: tokens }, answer: 'working', toolUses: [{}] };
      });
      for (;;) if ((await gen.next()).done) break;
    },
    forward: (fields: Record<string, unknown> = FIELDS, agentId?: string) =>
      dispatch('tool.call', { tool: TOOL, ...fields, tool_use_id: 'f1', ...(agentId ? { agentId } : {}) }, async () => ({ result: 'unreached' })),
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
    expect(wake).toContain('Files\nR reports/a.sql\n');
    expect(wake).toContain('Git\nmain@abc1234, 1 dirty: a.txt\n');
    expect(wake).toContain(`Paths\ntranscript ${TRANSCRIPT}:812 · saved ${DIR}\n`);
    expect(wake.endsWith('Next\nEdit reports/c.sql:12, then run npm test.')).toBe(true);
    expect(wake).not.toMatch(/\n\n/);
    const record = JSON.parse(cc.written[`${DIR}/record.json`]!);
    expect(record).toMatchObject({ seq: 1, session: 'session-1', tokensBefore: 250_000, total: { chars: wake.length, tokens: Math.ceil(wake.length / 4) } });
    expect(record.blocks.map((b: { name: string }) => b.name)).toEqual(['User', 'Files', 'Git', 'Paths', 'Objective', 'Done', 'Remaining', 'Next']);
    expect(cc.logs.some((line) => line.includes(DIR))).toBe(true);
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
    expect(wake).toContain('Load ok.ts\nfine\n');
    expect(wake).toContain('load .env: Read deny: Permission to read this file has been denied.');
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
    expect(wake).toContain('Load src/z.ts:2-3\nb\nc\n');
    expect(wake).toContain('Unresolved\nload nope.ts: not found\ndrop_skills zzz: not invoked\n');
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

  it('refuses a sub-agent: the tool is the main chat', async () => {
    const cc = engine();
    await cc.start();
    const out = await cc.forward(FIELDS, 'agent-1');
    expect(out.result).toMatch(/^Not stored: .*main chat/);
    expect(Object.keys(cc.written)).toEqual([]);
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
