import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from '../plugins/sub-agent-compact/hooks/sub-agent-compact.ts';
import { optionVars } from './option-env-old.ts';
import { HANDOFF_OPENING } from '../plugins/sub-agent-compact/src/handoff.ts';

// The handoff path end to end through the adapter: the tool stores the text,
// the next automatic ask installs it without calling the summarizer beneath,
// and each tool is registered only while its flag is on: by default the
// compact tool alone, beside the always-on look_back. Every failure on that
// path reaches the model (its next tool result) or the person (the log).

type AnyHook = (...args: any[]) => any;
const HANDOFF_ONLY = { handoffTool: true, compactTool: false };
const HANDOFF = 'Task (verbatim): "rename qty to quantity in every report". Done: a.sql, b.sql, npm test 41/41. Facts: reports/c.sql:12 reads `SELECT qty, price FROM ledger`. Next step: edit reports/c.sql:12, then npm test.';
const FIELDS = { goal: 'Rename qty to quantity in every report (person, verbatim).', next_step: 'Edit reports/c.sql:12, then run npm test.', done_verified: ['a.sql, b.sql: npm test 41/41'] };
const NEXT_STEP = '**Next step**\nEdit reports/c.sql:12, then run npm test.';
const TOOL = 'mcp__sub-agent-compact__handoff';
const MARKER = `<handoff>${HANDOFF}</handoff>`;

type Harness = {
  registerThrows?: boolean;
  /** Registering a tool waits for this, so a test holds it open and releases it. */
  registerGate?: Promise<void>;
  skipSummary?: boolean;
  /** The compaction beneath the plugin fails with this message, as Claude Code's own reactive compaction can. */
  compactFails?: string;
  compactResult?: unknown;
  files?: Record<string, string>;
  /** What `$.fs.stat` says of a path (default: a file the size of its content). */
  kinds?: Record<string, string>;
  sizes?: Record<string, number>;
  statThrows?: boolean;
  /** The engine has no `$.clock` (an older Claude Code). */
  noClock?: boolean;
  listThrows?: boolean;
  /** How many prompts the person has sent (default 1); `$.session.turns` fails when it is null. */
  turns?: number | null;
};

function engine(options: Record<string, unknown> = {}, harness: Harness = {}) {
  const hooks = new Map<string, AnyHook>();
  const registered: string[] = [];
  const compacts: unknown[] = [];
  const logs: string[] = [];
  const levelRows: any[] = [];
  const summarizerInputs: any[] = [];
  const files = harness.files ?? {};
  let current = 0;
  let afters = 0;
  const on = (event: string, hook: AnyHook) => void hooks.set(event, hook);
  const $ = {
    session: {
      id: async () => 'session-1',
      turns: async () => {
        if (harness.turns === null) throw new Error('turns unavailable');
        return harness.turns ?? 1;
      },
      cwd: async () => '/nowhere',
      usage: async () => ({ context: { tokens: current, window: 1_000_000 } }),
      compact: async (args: unknown) => {
        compacts.push(args);
        // A veto by a hook outside this plugin reaches the caller as a skip; the plugin's own hook never sees it.
        if (harness.compactResult !== null && typeof harness.compactResult === 'object' && 'skip' in harness.compactResult) return harness.compactResult;
        return dispatch('session.compact', { trigger: 'plugin', messages: transcript(), ...(args as object) }, async () => harness.compactResult ?? { messages: [], tokensAfter: 1 });
      },
    },
    env: { get: async (key: string) => (key === 'HOME' ? '/h/u' : optionVars(options)[key]) },
    settings: { read: async () => ({}) },
    fs: {
      exists: async (path: string) => path in files,
      read: async (path: string) => files[path] ?? '',
      write: async () => {},
      list: async () => [],
      stat: async (path: string) => {
        if (harness.statThrows) throw new Error('EACCES: permission denied');
        return { kind: harness.kinds?.[path] ?? 'file', size: harness.sizes?.[path] ?? (files[path] ?? '').length, mtimeMs: 0, isLink: false };
      },
    },
    process: { run: async (argv: string[]) => {
      if (argv[3] === 'plugin-log') for (let at = 7; at < argv.length; at += 2) levelRows.push(JSON.parse(argv[at]!));
      return { exitCode: 0, stdout: '', stderr: '' };
    } },
    clock: harness.noClock ? undefined : {
      now: async () => 1791991231123,
      after: (ms: number, fn: () => void) => {
        afters++;
        const timer = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(timer) };
      },
    },
    ui: { log: (line: string) => void logs.push(line) },
    agent: {
      list: async () => {
        if (harness.listThrows) throw new Error('agent list unavailable');
        return [];
      },
    },
    tool: {
      register: async (spec: { name: string }) => {
        await harness.registerGate;
        if (harness.registerThrows) throw new Error('session not bound');
        registered.push(spec.name);
        return { tool: `mcp__sub-agent-compact__${spec.name}` };
      },
    },
  };
  register(on as never, {} as never);
  const dispatch = (event: string, e: unknown, impl: (e: any) => any): any => {
    const next = Object.assign((input: unknown) => impl(input), { signal: new AbortController().signal });
    const hook = hooks.get(event);
    return hook ? hook($, e, next) : impl(e);
  };
  const stored = (id = 'h1', input: Record<string, unknown> = FIELDS) => [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: TOOL, input }], handle: 'm1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'Handoff stored (1k tokens). At your next ...', isError: false }], handle: 'm2' },
  ];
  const transcript = (extra: unknown[] = []) => [{ role: 'user', text: 'rename qty to quantity in every report', toolUses: [], handle: 'm0' }, ...extra, ...stored()];
  // The transcript of a chat that never stored a handoff.
  const plain = () => [{ role: 'user', text: 'rename qty to quantity in every report', toolUses: [], handle: 'm0' }];
  const step = async (tokens: number, extra: Record<string, unknown> = {}) => {
    current = tokens;
    const { answer = 'working', ...rest } = extra;
    const gen = dispatch('turn.step', { model: 'claude-opus-4-5[1m]', ...rest }, async function* () {
      return { usage: { input_tokens: tokens }, answer, toolUses: [{}] };
    });
    for (;;) if ((await gen.next()).done) break;
  };
  let summarized = 0;
  const summarizer = async (input: any) => {
    summarized++;
    summarizerInputs.push(input);
    if (harness.compactFails !== undefined) throw new Error(harness.compactFails);
    if (harness.skipSummary) return { skip: 'busy' };
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensAfter: 20_000 };
  };
  return {
    registered,
    compacts,
    logs,
    levelRows,
    end: () => dispatch('session.end', { reason: 'exit', sessionId: 'session-1' }, async () => ({})),
    summarizerInputs,
    summarized: () => summarized,
    /** How many timers the plugin asked `$.clock.after` for. */
    afters: () => afters,
    start: () => dispatch('session.start', {}, async () => ({})),
    step,
    handoff: (fields: Record<string, unknown> = FIELDS, toolUseId: string | undefined = 'h1', agentId?: string) =>
      dispatch('tool.call', { tool: TOOL, ...fields, ...(toolUseId ? { tool_use_id: toolUseId } : {}), ...(agentId ? { agentId } : {}) }, async () => ({ result: 'unreached' })),
    read: (agentId?: string) => dispatch('tool.call', { tool: 'Read', file_path: 'x', ...(agentId ? { agentId } : {}) }, async () => ({ result: 'file text' })),
    ask: (trigger: string, messages: unknown[] = transcript(), extra: Record<string, unknown> = {}) => dispatch('session.compact', { trigger, messages, ...extra }, summarizer),
    turnComplete: () => dispatch('turn.complete', {}, async () => ({})),
    subagent: (id: string) => dispatch('classic.SubagentStart', { agent_id: id, agent_type: 'worker' }, async () => ({})),
    stop: (id: string, last: string) => dispatch('classic.SubagentStop', { agent_id: id, agent_type: 'worker', last_assistant_message: last }, async () => ({})),
    transcript,
    plain,
    stored,
  };
}

describe('the handoff tool through the adapter', () => {
  it('registers the compact tool and not the handoff tool by default', async () => {
    const cc = engine();
    await cc.start();
    expect(cc.registered).toEqual(['compact', 'look_back']);
  });

  it('registers the handoff tool alone when it is on and the compact tool off', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    expect(cc.registered).toEqual(['handoff', 'look_back']);
  });

  it('registers both when the compact tool is turned on, and neither nudges about compact while handoff is on', async () => {
    const cc = engine({ compactTool: true, handoffTool: true });
    await cc.start();
    expect(cc.registered.sort()).toEqual(['compact', 'handoff', 'look_back']);
    await cc.step(250_000);
    const nudged = await cc.read();
    expect(nudged.context?.[0]).toMatch(/mcp__sub-agent-compact__handoff/);
    expect(nudged.context?.[0]).not.toMatch(/__compact\b/);
  });

  it('stores the handoff, then installs it at the next automatic ask without the summarizer', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    expect(await cc.handoff()).toEqual({ result: expect.stringMatching(/^Handoff stored/) });
    const out = await cc.ask('auto');
    expect(cc.summarized()).toBe(0);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].text.startsWith(HANDOFF_OPENING)).toBe(true);
    expect(out.messages[0].text).toContain(NEXT_STEP);
    expect(out.tokensBefore).toBe(250_000);
    // Installed once: the next ask is held again at the party's limit.
    expect(await cc.ask('auto')).toEqual({ skip: expect.any(String) });
  });

  it('refuses a handoff below the first nudge point, and a thin one, storing nothing', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(120_000);
    expect(await cc.handoff()).toEqual({ result: expect.stringMatching(/^Not stored: .*120k.*200k/) });
    await cc.step(250_000);
    expect(await cc.handoff({ goal: 'c.sql' })).toEqual({ result: expect.stringMatching(/^Not stored/) });
    expect(await cc.ask('auto', cc.plain())).toEqual({ skip: expect.any(String) });
  });

  it('waits out a precompute, and leaves a person /compact to the summarizer', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    await cc.handoff();
    expect(await cc.ask('precompute')).toEqual({ skip: expect.any(String) });
    expect((await cc.ask('manual')).messages[0].text).toBe('summary');
    expect(cc.summarized()).toBe(1);
  });

  it('installs a main handoff between turns when no automatic ask came', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    await cc.handoff();
    await cc.turnComplete();
    expect(cc.compacts).toEqual([{}]);
    expect(cc.summarized()).toBe(0);
  });

  it('nudges nobody when both tools are off', async () => {
    const cc = engine({ handoffTool: false, compactTool: false });
    await cc.start();
    expect(cc.registered).toEqual(['look_back']);
    await cc.step(250_000);
    expect((await cc.read()).context).toBeUndefined();
  });
});

describe('registering the tools is bounded', () => {
  afterEach(() => void vi.useRealTimers());
  const deferred = () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return { gate, release };
  };

  it('lets a turn go on after 5s when registering never finishes, says so once, and does not wait again on later turns', async () => {
    vi.useFakeTimers();
    const { gate } = deferred();
    const cc = engine(HANDOFF_ONLY, { registerGate: gate });
    let done = 0;
    void cc.step(1_000).then(() => done++);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(1);
    expect(cc.logs.filter((line) => /registering the tools did not finish within 5s/.test(line))).toHaveLength(0);
    void cc.step(2_000).then(() => done++);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(2);
    expect(cc.logs.filter((line) => /registering the tools did not finish/.test(line))).toHaveLength(0);
  });

  it('bounds session.start the same way', async () => {
    vi.useFakeTimers();
    const { gate } = deferred();
    const cc = engine(HANDOFF_ONLY, { registerGate: gate });
    let started = false;
    void cc.start().then(() => (started = true));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(started).toBe(true);
    expect(cc.logs.join('\n')).not.toMatch(/registering the tools did not finish within 5s/);
  });

  it('goes on, unbounded, with one error when the engine has no clock to bound it with', async () => {
    const cc = engine(HANDOFF_ONLY, { noClock: true });
    await cc.start();
    await cc.step(1_000);
    await cc.step(2_000);
    expect(cc.registered).toEqual(['handoff', 'look_back']);
    expect(cc.logs.filter((line) => /\$\.clock\.after is unavailable/.test(line))).toHaveLength(1);
  });

  it('still names the tool in the nudge when the registration finishes after the timeout', async () => {
    vi.useFakeTimers();
    const { gate, release } = deferred();
    const cc = engine(HANDOFF_ONLY, { registerGate: gate });
    let went = false;
    void cc.step(1_000).then(() => (went = true));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(went).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await cc.step(250_000);
    expect((await cc.read()).context?.[0]).toContain(TOOL);
  });

  it('logs the registration timeout and routine completion without screen noise', async () => {
    vi.useFakeTimers();
    const { gate, release } = deferred();
    const cc = engine(HANDOFF_ONLY, { registerGate: gate });
    void cc.step(1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cc.logs.filter((line) => /did not finish within 5s/.test(line))).toEqual([]);
    await cc.end();
    expect(cc.levelRows.filter((row) => row.level === 'warning' && row.msg.includes('did not finish within 5s'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(cc.registered).toEqual(['handoff', 'look_back']);
    expect(cc.logs.filter((line) => /finished after/.test(line))).toEqual([]);
  });

  it('spends the tries left on a later turn once a registration that outlived the limit has failed', async () => {
    vi.useFakeTimers();
    const { gate, release } = deferred();
    const harness: Harness = { registerGate: gate, registerThrows: true };
    const cc = engine(HANDOFF_ONLY, harness);
    void cc.step(1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(cc.registered).toEqual([]);
    harness.registerThrows = false;
    await cc.step(2_000);
    expect(cc.registered).toEqual(['handoff', 'look_back']);
  });

  it('sets no timer on later turns once every tool is registered', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(1_000);
    expect(cc.registered).toEqual(['handoff', 'look_back']);
    const afters = cc.afters();
    await cc.step(2_000);
    await cc.step(3_000);
    expect(cc.afters()).toBe(afters);
  });
});

describe('the size of the cut in the nudge', () => {
  it('is stated only from a reading taken on the session\'s first request, so a plugin reloaded mid-session leaves it out', async () => {
    const reloaded = engine(HANDOFF_ONLY);
    await reloaded.start();
    await reloaded.step(208_000, { index: 0, messageCount: 140 });
    await reloaded.step(250_000, { index: 3, messageCount: 150 });
    const line = (await reloaded.read()).context?.[0];
    expect(line).toMatch(/your context is 250k/);
    expect(line).not.toMatch(/cutting each later request/);
    const fresh = engine(HANDOFF_ONLY);
    await fresh.start();
    await fresh.step(40_000, { index: 0, messageCount: 1 });
    await fresh.step(250_000, { index: 3, messageCount: 30 });
    expect((await fresh.read()).context?.[0]).toMatch(/cutting each later request to about 40k plus your handoff/);
  });

  it('is left out when a reloaded plugin first sees the step after a CLI compaction (a summary and the prompt, two messages) of a session with many prompts', async () => {
    const cc = engine(HANDOFF_ONLY, { turns: 5 });
    await cc.start();
    await cc.step(40_000, { index: 0, messageCount: 2 });
    await cc.step(250_000, { index: 3, messageCount: 30 });
    const line = (await cc.read()).context?.[0];
    expect(line).toMatch(/your context is 250k/);
    expect(line).not.toMatch(/cutting each later request/);
  });

  it('is left out, with a warning once, when the prompt count cannot be read', async () => {
    const cc = engine(HANDOFF_ONLY, { turns: null });
    await cc.start();
    await cc.step(40_000, { index: 0, messageCount: 1 });
    await cc.step(41_000, { index: 0, messageCount: 1 });
    await cc.step(250_000, { index: 3, messageCount: 30 });
    expect((await cc.read()).context?.[0]).not.toMatch(/cutting each later request/);
    expect(cc.logs.filter((line) => /could not read how many prompts/.test(line))).toHaveLength(0);
  });
});

describe('a handoff the plugin no longer holds', () => {
  it('is found in the transcript, where the tool call and its stored reply stand, and installed; the model is told while the plugin log keeps the routine notice', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    const out = await cc.ask('auto');
    expect(cc.summarized()).toBe(0);
    expect(out.messages[0].text).toContain(NEXT_STEP);
    expect(cc.logs.join('\n')).not.toMatch(/recovered the handoff of main from its transcript/);
    expect((await cc.read()).context?.join('\n')).toMatch(/recovered from your transcript/);
  });

  it('is not installed when the person spoke after it, which cancelled it: the ask is held like any other', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    const person = { role: 'user', text: 'stop, do something else', toolUses: [], handle: 'm3' };
    const out = await cc.ask('auto', [...cc.transcript(), person]);
    // Nothing is installed: the ask is held at the party's limit like any other.
    expect(out).toEqual({ skip: expect.any(String) });
    expect(cc.summarized()).toBe(0);
  });

  it('is waited for by a precompute like a stored one', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    expect(await cc.ask('precompute')).toEqual({ skip: 'handoff waits for the compaction' });
  });
});

describe('when the handoff installs', () => {
  it('tells the main chat the truth in the tool result: at the end of its turn', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    expect((await cc.handoff()).result).toMatch(/this turn ends/);
  });

  it('tells the model and logs when the compaction between turns was skipped, without screen noise', async () => {
    const cc = engine(HANDOFF_ONLY, { compactResult: { skip: 'a tool is running' } });
    await cc.start();
    await cc.step(250_000);
    await cc.handoff();
    await cc.turnComplete();
    expect(cc.logs.join('\n')).not.toMatch(/skipped.*a tool is running/);
    expect((await cc.read()).context?.join('\n')).toMatch(/a tool is running[\s\S]*still stored|still stored[\s\S]*a tool is running/);
    expect(await cc.ask('auto')).toMatchObject({ messages: [{ text: expect.stringContaining(NEXT_STEP) }] });
  });

  it('keeps a successful install off screen while the plugin log is active', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    await cc.handoff();
    expect(await cc.ask('auto')).toMatchObject({ messages: [{ text: expect.stringContaining(NEXT_STEP) }] });
    expect(cc.logs.join('\n')).not.toMatch(/installed the handoff of main: 250k/);
  });
});

describe('a handoff the install cannot place', () => {
  it('stays stored when the summary that keeps it is skipped, and installs at the next ask', async () => {
    const cc = engine(HANDOFF_ONLY, { skipSummary: true });
    await cc.start();
    await cc.step(250_000);
    await cc.handoff(FIELDS, 'zzz');
    // 'zzz' is not in the transcript: no anchor, so a summary that keeps the handoff runs instead, and is skipped.
    const first = await cc.ask('auto');
    expect(first).toEqual({ skip: 'busy' });
    expect(cc.summarizerInputs[0].instructions).toContain('Edit reports/c.sql:12');
    expect((await cc.read()).context?.join('\n')).toMatch(/could not be installed verbatim/);
    const second = await cc.ask('auto', cc.transcript().map((m: any) => (m.toolUses[0]?.tool_use_id === 'h1' ? { ...m, toolUses: [{ ...m.toolUses[0], tool_use_id: 'zzz' }] } : m)));
    expect(cc.summarized()).toBe(1);
    expect(second.messages[0].text).toContain(NEXT_STEP);
  });

  it('falls back to the summary, with the handoff as its instructions and a notice, when the transcript is not in the shape installs read', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    await cc.handoff();
    await cc.ask('auto', [{ role: 'assistant', text: 'x' }] as never);
    expect(cc.summarized()).toBe(1);
    expect(cc.logs.join('\n')).toMatch(/transcript.*message 0.*toolUses/);
    expect((await cc.read()).context?.join('\n')).toMatch(/could not be installed verbatim/);
  });

  it('falls back to the summary when the transcript is not a list at all, without crashing', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    await cc.handoff();
    await cc.ask('auto', null as never);
    expect(cc.summarized()).toBe(1);
    expect(cc.summarizerInputs[0].instructions).toContain('Edit reports/c.sql:12');
  });

  it('treats a trigger it does not know as an automatic ask, and says so once', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    await cc.handoff();
    const out = await cc.ask('recompute');
    expect(cc.summarized()).toBe(0);
    expect(out.messages[0].text).toContain(NEXT_STEP);
    expect(cc.logs.filter((l) => /unknown trigger "recompute"/.test(l))).toHaveLength(0);
  });
});

describe('a person\'s /compact over a stored handoff', () => {
  it('leaves the handoff stored when the summary is skipped, and says so instead of claiming a summary ran', async () => {
    const cc = engine(HANDOFF_ONLY, { skipSummary: true });
    await cc.start();
    await cc.step(250_000);
    await cc.handoff();
    expect(await cc.ask('manual')).toEqual({ skip: 'busy' });
    expect(cc.logs.join('\n')).not.toMatch(/\/compact.*skipped \(busy\).*stays stored/);
    expect((await cc.read()).context?.join('\n')).toMatch(/busy/);
    const out = await cc.ask('auto');
    expect(cc.summarized()).toBe(1);
    expect(out.messages[0].text).toContain(NEXT_STEP);
  });

  it('is told to the model: the handoff was dropped and a summary ran', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    await cc.handoff();
    await cc.ask('manual');
    expect(cc.logs.join('\n')).not.toMatch(/\/compact.*dropped|dropped.*\/compact/);
    expect((await cc.read()).context?.join('\n')).toMatch(/\/compact/);
  });
});

describe('a handoff written between <handoff> tags', () => {
  it('is checked like the tool\'s: a stop on a thin marker is refused with the reason, so the agent can write it out', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.subagent('a1');
    await cc.step(250_000, { agentId: 'a1' });
    const out = await cc.stop('a1', '<handoff>next: c.sql</handoff>');
    expect(out).toEqual({ block: expect.stringMatching(/^Not stored: .*characters/) });
  });

  it('tells the agent on its next tool result that the marker was stored', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.subagent('a1');
    await cc.step(250_000, { agentId: 'a1', answer: MARKER });
    expect((await cc.read('a1')).context?.join('\n')).toMatch(/handoff.*stored/);
  });

  it('still delivers the notice when working out the nudge fails', async () => {
    const harness: Harness = {};
    const cc = engine(HANDOFF_ONLY, harness);
    await cc.start();
    await cc.subagent('a1');
    await cc.step(250_000, { agentId: 'a1', answer: MARKER });
    harness.listThrows = true;
    // The list missed a1 at its first lookup: it is asked again only once that miss is 60 s old.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      expect((await cc.read('a1')).context?.join('\n')).toMatch(/handoff.*stored/);
    } finally {
      vi.useRealTimers();
    }
    expect(cc.logs.join('\n')).toMatch(/nudging a1 failed: agent list unavailable/);
  });

  it('tells the agent when the marker was refused, with the reason', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.subagent('a1');
    await cc.step(250_000, { agentId: 'a1', answer: '<handoff>next: c.sql</handoff>' });
    expect((await cc.read('a1')).context?.join('\n')).toMatch(/not stored.*characters/i);
  });
});

describe('a tool that is not registered', () => {
  it('leaves the main chat un-nudged to call a tool that is not there, and tells the person once', async () => {
    const cc = engine(HANDOFF_ONLY, { registerThrows: true });
    await cc.start();
    await cc.step(250_000);
    expect((await cc.read()).context).toBeUndefined();
    expect(cc.logs.join('\n')).toMatch(/not registered, so it is not nudged/);
  });

  it('nudges a sub-agent to the <handoff> marker alone, never to the missing tool', async () => {
    const cc = engine(HANDOFF_ONLY, { registerThrows: true });
    await cc.start();
    await cc.subagent('a1');
    await cc.step(250_000, { agentId: 'a1' });
    const line = (await cc.read('a1')).context?.[0] as string;
    expect(line).toMatch(/<handoff>/);
    expect(line).not.toMatch(/mcp__|undefined/);
  });

  it('registers on the first hook when session.start never fired (a plugin loaded mid-session)', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.step(250_000);
    expect(cc.registered).toEqual(['handoff', 'look_back']);
    expect(await cc.handoff()).toEqual({ result: expect.stringMatching(/^Handoff stored/) });
  });

  it('says in the log when both tools are off', async () => {
    const cc = engine({ handoffTool: false, compactTool: false });
    await cc.start();
    await cc.step(1_000);
    await cc.end();
    expect(cc.logs.join('\n')).not.toMatch(/no self-compaction tool is on/);
    expect(cc.levelRows.filter((row) => row.level === 'warning' && row.msg.includes('no self-compaction tool is on'))).toHaveLength(1);
  });
});

describe('Haiku', () => {
  it('is let through at the point Claude Code asked it, well below the plugin\'s own limit', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(49_600, { model: 'claude-haiku-4-5' });
    await cc.ask('auto');
    expect(cc.summarized()).toBe(1);
  });

  it('leaves a Haiku sub-agent to Claude Code: its marker is not read and its brief is not seated back', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.subagent('a1');
    await cc.step(150_000, { agentId: 'a1', model: 'claude-haiku-4-5', answer: MARKER });
    expect((await cc.read('a1')).context ?? []).toEqual([]);
    const out = await cc.ask('auto', cc.plain(), { agentId: 'a1' });
    expect(out.messages).toEqual([{ role: 'user', text: 'summary', toolUses: [] }]);
  });
});

describe('the typed handoff through the tool', () => {
  it('returns every problem at once as a tool result the agent reads, storing nothing', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    const out = await cc.handoff({ done_verified: 5 });
    expect(out.result).toMatch(/^Not stored/);
    for (const field of ['goal', 'next_step', 'done_verified']) expect(out.result).toContain(`\`${field}\``);
    expect(await cc.ask('auto', cc.plain())).toEqual({ skip: expect.any(String) });
  });

  it('names a field it does not know instead of storing the handoff without it', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    expect((await cc.handoff({ ...FIELDS, dead_end: ['retrying the cache'] })).result).toMatch(/^Not stored: .*`dead_end` is not a field/);
  });

  it('still takes the free text of the earlier tool', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    expect(await cc.handoff({ handoff: HANDOFF })).toEqual({ result: expect.stringMatching(/^Handoff stored/) });
  });

  it('reads its fields from the event\'s input when they are not at the top', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    const out = await cc.handoff({ input: FIELDS });
    expect(out.result).toMatch(/^Handoff stored/);
  });
});

describe('a handoff the plugin no longer holds, after the harness spoke', () => {
  it('is still installed when only a task notification followed it, which no person wrote', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    const notice = { role: 'user', text: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>', toolUses: [], handle: 'm3' };
    const out = await cc.ask('auto', [...cc.transcript(), notice]);
    expect(cc.summarized()).toBe(0);
    expect(out.messages[0].text).toContain(NEXT_STEP);
  });
});

describe('load_on_wake', () => {
  const SKILL = '/nowhere/.claude/commands/pfm-testing-manual.md';

  it('inlines the named command or skill into the installed handoff', async () => {
    const cc = engine(HANDOFF_ONLY, { files: { [SKILL]: '---\nname: x\n---\nRUN TESTS IN THE FENCE' } });
    await cc.start();
    await cc.step(250_000);
    expect((await cc.handoff({ ...FIELDS, load_on_wake: ['pfm-testing-manual'] })).result).toMatch(/^Handoff stored/);
    const out = await cc.ask('auto');
    expect(out.messages[0].text).toContain('=== loaded: pfm-testing-manual');
    expect(out.messages[0].text).toContain('RUN TESTS IN THE FENCE');
    expect(out.messages[0].text).not.toContain('name: x');
  });

  it('refuses at the call a name that resolves nowhere, naming it and where it looked, storing nothing', async () => {
    const cc = engine(HANDOFF_ONLY);
    await cc.start();
    await cc.step(250_000);
    const out = await cc.handoff({ ...FIELDS, load_on_wake: ['no-such-thing'] });
    expect(out.result).toMatch(/^Not stored: .*`load_on_wake`.*no-such-thing.*\/nowhere\/\.claude\/commands\/no-such-thing\.md/);
    expect(await cc.ask('auto', cc.plain())).toEqual({ skip: expect.any(String) });
  });

  it('says in the installed text, the log and a notice what could no longer be loaded', async () => {
    const files: Record<string, string> = { [SKILL]: 'BODY' };
    const cc = engine(HANDOFF_ONLY, { files });
    await cc.start();
    await cc.step(250_000);
    await cc.handoff({ ...FIELDS, load_on_wake: ['pfm-testing-manual'] });
    delete files[SKILL];
    const out = await cc.ask('auto');
    expect(out.messages[0].text).toContain('NOT LOADED: pfm-testing-manual');
    expect(cc.logs.join('\n')).toMatch(/could not load pfm-testing-manual/);
    expect((await cc.read()).context?.join('\n')).toMatch(/not loaded: pfm-testing-manual/i);
  });

  it('leaves out what the model invoked, and says it only invoked it', async () => {
    const cc = engine(HANDOFF_ONLY, { files: { [SKILL]: 'BODY' } });
    await cc.start();
    await cc.step(250_000);
    await cc.handoff({ ...FIELDS, load_on_wake: ['pfm-testing-manual'] });
    const invoked = { role: 'assistant', text: '', toolUses: [{ tool_use_id: 's1', tool: 'Skill', input: { skill: 'pfm-testing-manual' } }], handle: 'm0b' };
    const out = await cc.ask('auto', cc.transcript([invoked]));
    expect(out.messages[0].text).toContain('not inlined because you invoked it earlier in this session');
    expect(out.messages[0].text).not.toContain('BODY');
  });

  it('refuses at the call a name whose file is a directory, a pipe or any other path that is not a regular file, reading nothing', async () => {
    const cc = engine(HANDOFF_ONLY, { files: { [SKILL]: 'BODY' }, kinds: { [SKILL]: 'other' } });
    await cc.start();
    await cc.step(250_000);
    const out = await cc.handoff({ ...FIELDS, load_on_wake: ['pfm-testing-manual'] });
    expect(out.result).toMatch(/^Not stored: .*pfm-testing-manual.*is not a regular file \(kind: other\)/);
    expect(await cc.ask('auto', cc.plain())).toEqual({ skip: expect.any(String) });
  });

  it('refuses at the call a file past the byte cap, before it is read', async () => {
    const cc = engine(HANDOFF_ONLY, { files: { [SKILL]: 'BODY' }, sizes: { [SKILL]: 4 * 1024 * 1024 } });
    await cc.start();
    await cc.step(250_000);
    expect((await cc.handoff({ ...FIELDS, load_on_wake: ['pfm-testing-manual'] })).result).toMatch(/^Not stored: .*pfm-testing-manual.*is 4194304 bytes, past the 262144 bytes/);
  });

  it('refuses at the call a file it cannot stat, and says NOT LOADED when the path stopped being a file by the install', async () => {
    const unreadable = engine(HANDOFF_ONLY, { files: { [SKILL]: 'BODY' }, statThrows: true });
    await unreadable.start();
    await unreadable.step(250_000);
    expect((await unreadable.handoff({ ...FIELDS, load_on_wake: ['pfm-testing-manual'] })).result).toMatch(/^Not stored: .*pfm-testing-manual.*could not stat .*EACCES/);
    const kinds: Record<string, string> = {};
    const cc = engine(HANDOFF_ONLY, { files: { [SKILL]: 'BODY' }, kinds });
    await cc.start();
    await cc.step(250_000);
    await cc.handoff({ ...FIELDS, load_on_wake: ['pfm-testing-manual'] });
    kinds[SKILL] = 'dir';
    const out = await cc.ask('auto');
    expect(out.messages[0].text).toContain('NOT LOADED: pfm-testing-manual');
    expect(out.messages[0].text).toContain('is not a regular file (kind: dir)');
    expect(out.messages[0].text).not.toContain('BODY');
  });
});

describe('a compaction that fails beneath the plugin', () => {
  it('is logged as a warning of the compaction, never as an error of this hook, and passes on unchanged', async () => {
    const cc = engine({}, { compactFails: 'reactive compaction did not settle ok' });
    await cc.start();
    await cc.step(650_000);
    await expect(cc.ask('auto', cc.plain())).rejects.toThrow('reactive compaction did not settle ok');
    await cc.end();
    const rows = cc.levelRows.filter((row) => /reactive compaction did not settle ok/.test(row.msg ?? ''));
    expect(rows.map((row) => [row.level, row.event])).toEqual([['warning', 'compaction-failed']]);
  });
});
