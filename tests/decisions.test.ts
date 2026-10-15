import { describe, expect, it } from 'vitest';
import { AgentPolicies, AgentTypes, type AgentFs } from '../plugins/sub-agent-compact/src/agents.ts';
import { compactionEnd, contextTokens, decide, knownTrigger, personPrompt } from '../plugins/sub-agent-compact/src/decide.ts';
import { parseFrontmatter } from '../plugins/sub-agent-compact/src/frontmatter.ts';
import { DEFAULT_KEEP_BRIEF, DEFAULT_MAIN, DEFAULT_SUBAGENT, OPTION_ENV, parseEnabled, parseSize, resolveOptions, sizeTokens } from '../plugins/sub-agent-compact/src/limits.ts';

describe('parseSize', () => {
  it.each([
    [150000, { tokens: 150000 }],
    ['150000', { tokens: 150000 }],
    ['150k', { tokens: 150000 }],
    ['150K', { tokens: 150000 }],
    ['0.6m', { tokens: 600000 }],
    ['1.5M', { tokens: 1500000 }],
    [' 200k ', { tokens: 200000 }],
    ['200_000', { tokens: 200000 }],
    ['10%', { percent: 10 }],
    ['12.5 %', { percent: 12.5 }],
    ['100%', { percent: 100 }],
  ])('%j → %j', (raw, value) => {
    expect(parseSize(raw)).toEqual({ ok: true, value });
  });

  it.each([['abc'], ['150kb'], ['-5'], ['0'], [''], [0], [-1], [Number.NaN], [true], [null], ['0%'], ['101%'], ['%']])('%j is an error', (raw) => {
    expect(parseSize(raw).ok).toBe(false);
  });
});

describe('sizeTokens', () => {
  it('keeps tokens and takes a percentage of the window', () => {
    expect(sizeTokens({ tokens: 90000 }, 1_000_000)).toBe(90000);
    expect(sizeTokens({ percent: 10 }, 1_000_000)).toBe(100000);
    expect(sizeTokens({ percent: 12.5 }, 200_000)).toBe(25000);
  });
});

describe('parseEnabled', () => {
  it.each([[true, true], [false, false], ['true', true], ['FALSE', false], ['on', true], ['off', false], ['yes', true], ['no', false]])('%j → %j', (raw, value) => {
    expect(parseEnabled(raw)).toEqual({ ok: true, value });
  });

  it.each([['maybe'], [1], [null], ['']])('%j is an error', (raw) => {
    expect(parseEnabled(raw).ok).toBe(false);
  });
});

describe('resolveOptions', () => {
  type Resolved = ReturnType<typeof resolveOptions>;
  const withVars = (vars: Record<string, string | undefined>, rest: { pluginLogDir?: string; readErrors?: string[] } = {}): Resolved => resolveOptions({ vars, ...rest });
  const LOG_DEFAULT = '/x/logs/sub-agent-compact/decisions/.jsonl';

  it('uses the plugin decision folder only for a blank log file with PLUGIN_LOG_DIR (R6)', () => {
    expect([
      withVars({ SUB_AGENT_COMPACT_LOG_FILE: '' }, { pluginLogDir: '/x/logs' }).logFile,
      withVars({ SUB_AGENT_COMPACT_LOG_FILE: '/tmp/a.jsonl' }, { pluginLogDir: '/x/logs' }).logFile,
      withVars({ SUB_AGENT_COMPACT_LOG_FILE: '' }).logFile,
      withVars({}, { pluginLogDir: '/x/logs/' }).logFile,
    ]).toEqual([LOG_DEFAULT, '/tmp/a.jsonl', undefined, LOG_DEFAULT]);
  });

  it('defaults when nothing is set', () => {
    expect(resolveOptions()).toEqual({ main: DEFAULT_MAIN, subagent: DEFAULT_SUBAGENT, keepBrief: true, compactTool: true, handoffTool: false, forwardHandoffTool: false, agentDirs: [], errors: [] });
    expect(resolveOptions({ vars: {} })).toEqual(resolveOptions());
    expect(DEFAULT_KEEP_BRIEF).toBe(true);
    expect(DEFAULT_MAIN).toEqual({ enabled: true, autoCompact: { percent: 60 }, nudgeStart: { percent: 20 }, nudgeEvery: { percent: 10 } });
    expect(DEFAULT_SUBAGENT).toEqual({ enabled: true, autoCompact: { percent: 60 }, nudgeStart: { percent: 20 }, nudgeEvery: { percent: 10 } });
  });

  it('reads every party variable, suffixed values, dir lists and an absolute log file', () => {
    const options = withVars({
      SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT: '0.6m',
      SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_NUDGE_START: '25%',
      SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_NUDGE_EVERY: '50k',
      SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_ENABLED: '0',
      SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT: '90k',
      SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_NUDGE_START: '40k',
      SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_NUDGE_EVERY: '5%',
      SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_ENABLED: 'true',
      SUB_AGENT_COMPACT_SUBAGENT_KEEP_BRIEF: 'false',
      SUB_AGENT_COMPACT_COMPACT_TOOL: '0',
      SUB_AGENT_COMPACT_HANDOFF_TOOL: '1',
      SUB_AGENT_COMPACT_AGENT_DIRS: 'a, /b/c ,',
      SUB_AGENT_COMPACT_LOG_FILE: '/tmp/x.jsonl',
    });
    expect(options).toEqual({
      main: { enabled: false, autoCompact: { tokens: 600000 }, nudgeStart: { percent: 25 }, nudgeEvery: { tokens: 50000 } },
      subagent: { enabled: true, autoCompact: { tokens: 90000 }, nudgeStart: { tokens: 40000 }, nudgeEvery: { percent: 5 } },
      keepBrief: false,
      compactTool: false,
      handoffTool: true,
      forwardHandoffTool: false,
      agentDirs: ['a', '/b/c'],
      logFile: '/tmp/x.jsonl',
      errors: [],
    });
  });

  it('falls back on a bad value and names its variable, never silently', () => {
    const options = withVars({
      SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT: 'lots',
      SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT: '-3',
      SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_ENABLED: 'maybe',
      SUB_AGENT_COMPACT_SUBAGENT_KEEP_BRIEF: 'sometimes',
      SUB_AGENT_COMPACT_LOG_FILE: 'relative.jsonl',
    });
    expect(options.main.autoCompact).toEqual(DEFAULT_MAIN.autoCompact);
    expect(options.subagent.autoCompact).toEqual(DEFAULT_SUBAGENT.autoCompact);
    expect(options.subagent.enabled).toBe(true);
    expect(options.keepBrief).toBe(true);
    expect(options.logFile).toBeUndefined();
    expect(options.errors).toHaveLength(5);
    expect(options.errors[0]).toMatch(/env SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT is invalid.*"lots".*60%/);
    expect(options.errors[1]).toMatch(/env SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT is invalid/);
    expect(options.errors[2]).toMatch(/env SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_ENABLED is invalid.*"maybe".*true/);
    expect(options.errors[3]).toMatch(/env SUB_AGENT_COMPACT_SUBAGENT_KEEP_BRIEF is invalid.*"sometimes".*true/);
    expect(options.errors[4]).toMatch(/env SUB_AGENT_COMPACT_LOG_FILE is invalid \(not an absolute path/);
  });

  it.each([
    ['a relative log file falls back to the PLUGIN_LOG_DIR default', 'relative.jsonl', '/x/logs', LOG_DEFAULT, /env SUB_AGENT_COMPACT_LOG_FILE is invalid \(not an absolute path: "relative.jsonl"\); using the default \/x\/logs\/sub-agent-compact\/decisions\/.jsonl/],
    ['a relative log file without PLUGIN_LOG_DIR keeps the default, no log', 'relative.jsonl', undefined, undefined, /env SUB_AGENT_COMPACT_LOG_FILE is invalid \(not an absolute path: "relative.jsonl"\); using the default \(no decision log\)/],
  ])('%s', (_name, value, pluginLogDir, logFile, error) => {
    const resolved = withVars({ SUB_AGENT_COMPACT_LOG_FILE: value }, { pluginLogDir });
    expect(resolved.logFile).toBe(logFile);
    expect(resolved.errors).toEqual([expect.stringMatching(error)]);
  });

  it('lets an environment log file win over PLUGIN_LOG_DIR, trimmed', () => {
    expect(withVars({ SUB_AGENT_COMPACT_LOG_FILE: ' /e/d.jsonl ' }, { pluginLogDir: '/x/logs' }).logFile).toBe('/e/d.jsonl');
  });

  it('splits a directory list at commas and newlines and drops blank items', () => {
    expect(withVars({ SUB_AGENT_COMPACT_AGENT_DIRS: '/x\n /y ,,/z' }).agentDirs).toEqual(['/x', '/y', '/z']);
  });

  it.each([
    ['main', { SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT: '300k', SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_NUDGE_START: '300k' }, /env SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_NUDGE_START 300000 is not below SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT 300000/],
    ['subagent', { SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT: '40%', SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_NUDGE_START: '50%' }, /env SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_NUDGE_START 50% is not below SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT 40%/],
  ])('says a %s nudge start at or past its forced point, keeping both', (_name, vars, error) => {
    const resolved = withVars(vars);
    expect(resolved.errors).toEqual([expect.stringMatching(error)]);
  });

  it('says nothing across units, where only the window decides', () => {
    expect(withVars({ SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT: '50%', SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_NUDGE_START: '600k' }).errors).toEqual([]);
  });
});

describe('resolveOptions: one variable per option', () => {
  type Resolved = ReturnType<typeof resolveOptions>;
  const withVars = (vars: Record<string, string | undefined>): Resolved => resolveOptions({ vars });
  // One row per option: the variable it reads, a value in its grammar, a value its grammar refuses, and where it lands.
  const rows: { option: string; name: string; envValue: string; bad?: string; pick: (r: Resolved) => unknown; fromEnv: unknown; fromDefault: unknown }[] = [
    { option: 'mainAutoCompact', name: 'SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT', envValue: '300k', bad: 'lots', pick: (r) => r.main.autoCompact, fromEnv: { tokens: 300000 }, fromDefault: { percent: 60 } },
    { option: 'mainAutoCompactNudgeStart', name: 'SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_NUDGE_START', envValue: '25%', bad: '0%', pick: (r) => r.main.nudgeStart, fromEnv: { percent: 25 }, fromDefault: { percent: 20 } },
    { option: 'mainAutoCompactNudgeEvery', name: 'SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_NUDGE_EVERY', envValue: '50k', bad: '-3', pick: (r) => r.main.nudgeEvery, fromEnv: { tokens: 50000 }, fromDefault: { percent: 10 } },
    { option: 'mainAutoCompactEnabled', name: 'SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_ENABLED', envValue: '0', bad: 'maybe', pick: (r) => r.main.enabled, fromEnv: false, fromDefault: true },
    { option: 'subagentAutoCompact', name: 'SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT', envValue: '90k', bad: '101%', pick: (r) => r.subagent.autoCompact, fromEnv: { tokens: 90000 }, fromDefault: { percent: 60 } },
    { option: 'subagentAutoCompactNudgeStart', name: 'SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_NUDGE_START', envValue: '40k', bad: 'soon', pick: (r) => r.subagent.nudgeStart, fromEnv: { tokens: 40000 }, fromDefault: { percent: 20 } },
    { option: 'subagentAutoCompactNudgeEvery', name: 'SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_NUDGE_EVERY', envValue: '5%', bad: '150kb', pick: (r) => r.subagent.nudgeEvery, fromEnv: { percent: 5 }, fromDefault: { percent: 10 } },
    { option: 'subagentAutoCompactEnabled', name: 'SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_ENABLED', envValue: 'FALSE', bad: 'nope', pick: (r) => r.subagent.enabled, fromEnv: false, fromDefault: true },
    { option: 'subagentKeepBrief', name: 'SUB_AGENT_COMPACT_SUBAGENT_KEEP_BRIEF', envValue: '0', bad: '2', pick: (r) => r.keepBrief, fromEnv: false, fromDefault: true },
    { option: 'handoffTool', name: 'SUB_AGENT_COMPACT_HANDOFF_TOOL', envValue: 'true', bad: 'enabled', pick: (r) => r.handoffTool, fromEnv: true, fromDefault: false },
    { option: 'forwardHandoffTool', name: 'SUB_AGENT_COMPACT_FORWARD_HANDOFF_TOOL', envValue: '1', bad: 'yes please', pick: (r) => r.forwardHandoffTool, fromEnv: true, fromDefault: false },
    { option: 'compactTool', name: 'SUB_AGENT_COMPACT_COMPACT_TOOL', envValue: 'false', bad: 'off', pick: (r) => r.compactTool, fromEnv: false, fromDefault: true },
    { option: 'agentDirs', name: 'SUB_AGENT_COMPACT_AGENT_DIRS', envValue: '/a, /b/c ,', pick: (r) => r.agentDirs, fromEnv: ['/a', '/b/c'], fromDefault: [] },
    { option: 'logFile', name: 'SUB_AGENT_COMPACT_LOG_FILE', envValue: ' /from/env.jsonl ', bad: 'relative.jsonl', pick: (r) => r.logFile, fromEnv: '/from/env.jsonl', fromDefault: undefined },
  ];

  it('has a row for every variable the plugin reads', () => {
    expect(rows.map((row) => [row.option, row.name])).toEqual(Object.entries(OPTION_ENV));
  });

  it.each(rows)('$name sets $option', ({ name, envValue, pick, fromEnv }) => {
    const result = withVars({ [name]: envValue });
    expect(pick(result)).toEqual(fromEnv);
    expect(result.errors).toEqual([]);
  });

  it.each(rows)('$option is its default while $name is unset, empty or blank', ({ name, pick, fromDefault }) => {
    for (const vars of [{}, { [name]: undefined }, { [name]: '' }, { [name]: '  \t ' }]) {
      const result = withVars(vars);
      expect(pick(result)).toEqual(fromDefault);
      expect(result.errors).toEqual([]);
    }
  });

  it.each(rows.filter((row) => row.bad !== undefined))('a bad $name is named and the default is used', ({ name, bad, pick, fromDefault }) => {
    const result = withVars({ [name]: bad });
    expect(pick(result)).toEqual(fromDefault);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(new RegExp(`^sub-agent-compact: env ${name} is invalid \\(.+\\); using the default`));
  });

  it('reads an environment boolean as 1, 0, true or false in any case, with surrounding space', () => {
    const flag = (value: string) => withVars({ SUB_AGENT_COMPACT_HANDOFF_TOOL: value });
    expect(['1', 'TRUE', ' True ', 'true'].map((value) => flag(value).handoffTool)).toEqual([true, true, true, true]);
    expect(['0', 'FALSE', ' False ', 'false'].map((value) => withVars({ SUB_AGENT_COMPACT_COMPACT_TOOL: value }).compactTool)).toEqual([false, false, false, false]);
    expect(['on', 'yes', 'off', '01'].map((value) => flag(value).errors.length)).toEqual([1, 1, 1, 1]);
  });

  it('reports a variable that could not be read by name and uses its default', () => {
    const line = 'sub-agent-compact: reading SUB_AGENT_COMPACT_FORWARD_HANDOFF_TOOL failed: denied; using the default';
    const result = resolveOptions({ vars: {}, readErrors: [line] });
    expect(result.forwardHandoffTool).toBe(false);
    expect(result.errors).toEqual([line]);
  });
});

describe('parseFrontmatter', () => {
  it('reads top-level scalars', () => {
    const text = '---\nname: big-reader\ndescription: "reads: files"\nautoCompact: 130k # tokens\ntools:\n  - Read\n---\nbody autoCompact: 1\n';
    expect(parseFrontmatter(text)).toEqual({ name: 'big-reader', description: 'reads: files', autoCompact: '130k', tools: '' });
  });

  it('is empty without a leading or closing fence', () => {
    expect(parseFrontmatter('name: x\n')).toEqual({});
    expect(parseFrontmatter('---\nname: x\n')).toEqual({});
  });

  it('reads one level of nesting as parent.child', () => {
    const text = '---\nname: x\nautoCompact:\n  enabled: false\n  forceAt: 60% # forced\n  nudgeFrom: "10%"\ntools: Read\n---\n';
    expect(parseFrontmatter(text)).toEqual({ name: 'x', autoCompact: '', 'autoCompact.enabled': 'false', 'autoCompact.forceAt': '60%', 'autoCompact.nudgeFrom': '10%', tools: 'Read' });
  });

  it('handles CRLF and a BOM', () => {
    expect(parseFrontmatter('﻿---\r\nautoCompact: 2m\r\n---\r\n')).toEqual({ autoCompact: '2m' });
  });
});

describe('decide', () => {
  it('always passes manual and plugin triggers', () => {
    expect(decide({ trigger: 'manual', label: 'main', limit: 100, tokens: 1 })).toEqual({ action: 'pass', why: 'requested' });
    expect(decide({ trigger: 'plugin', label: 'x', limit: 100, tokens: undefined })).toEqual({ action: 'pass', why: 'requested' });
  });

  it('holds auto and precompute below the limit, with the reason', () => {
    expect(decide({ trigger: 'auto', label: 'big-reader', limit: 130000, tokens: 101000 })).toEqual({
      action: 'skip',
      reason: 'big-reader 101k/130k',
    });
    expect(decide({ trigger: 'precompute', label: 'main', limit: 10, tokens: 9 }).action).toBe('skip');
  });

  it('passes at and above the limit', () => {
    expect(decide({ trigger: 'auto', label: 'main', limit: 150000, tokens: 150000 })).toEqual({ action: 'pass', why: 'at-limit' });
    expect(decide({ trigger: 'precompute', label: 'main', limit: 150000, tokens: 200000 }).action).toBe('pass');
  });

  it('passes an armed self-compaction below the limit, before any other rule', () => {
    expect(decide({ trigger: 'auto', label: 'big-reader', limit: 130000, tokens: 70000, armed: 'the plan in plan.md' })).toEqual({ action: 'pass', why: 'self' });
    expect(decide({ trigger: 'precompute', label: 'main', limit: 130000, tokens: 70000, armed: 'x' })).toEqual({ action: 'pass', why: 'self' });
    expect(decide({ trigger: 'auto', label: 'quiet', limit: 130000, tokens: 70000, enabled: false, armed: 'x' })).toEqual({ action: 'pass', why: 'self' });
  });

  it('holds every automatic compaction of a disabled party, even past its limit or without a reading', () => {
    expect(decide({ trigger: 'auto', label: 'quiet', limit: 100, tokens: 500, enabled: false })).toEqual({ action: 'skip', reason: 'quiet: auto-compact off' });
    expect(decide({ trigger: 'precompute', label: 'quiet', limit: 100, tokens: undefined, enabled: false }).action).toBe('skip');
    expect(decide({ trigger: 'manual', label: 'quiet', limit: 100, tokens: 1, enabled: false })).toEqual({ action: 'pass', why: 'requested' });
  });

  it('never holds without a reading', () => {
    expect(decide({ trigger: 'auto', label: 'x', limit: 100, tokens: undefined })).toEqual({ action: 'pass', why: 'no-reading' });
    expect(decide({ trigger: 'auto', label: 'x', limit: 100, tokens: Number.NaN })).toEqual({ action: 'pass', why: 'no-reading' });
  });
});

describe('contextTokens', () => {
  it('sums input, cache read and cache creation', () => {
    expect(contextTokens({ input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 })).toBe(125);
    expect(contextTokens(null)).toBeUndefined();
    expect(contextTokens({})).toBeUndefined();
  });
});

function memoryFs(files: Record<string, string>, failing: string[] = []): AgentFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    exists: async (path) => path in files || Object.keys(files).some((file) => file.startsWith(`${path}/`)),
    read: async (path) => {
      reads.push(path);
      if (failing.includes(path)) throw new Error('EACCES');
      const text = files[path];
      if (text === undefined) throw new Error('ENOENT');
      return text;
    },
    listMarkdown: async (dir) =>
      Object.keys(files)
        .filter((file) => file.startsWith(`${dir}/`) && !file.slice(dir.length + 1).includes('/') && file.endsWith('.md'))
        .map((file) => file.slice(dir.length + 1)),
  };
}

describe('AgentPolicies', () => {
  const agent = (name: string, autoCompact?: string) => `---\nname: ${name}\n${autoCompact ? `autoCompact: ${autoCompact}\n` : ''}---\nbody\n`;
  const withCeiling = (tokens: number) => ({ ...DEFAULT_SUBAGENT, autoCompact: { tokens } });

  it('finds <type>.md in directory order, project first', async () => {
    const fs = memoryFs({ '/p/.claude/agents/big-reader.md': agent('big-reader', '130k'), '/h/.claude/agents/big-reader.md': agent('big-reader', '50k') });
    const policies = new AgentPolicies(['/p/.claude/agents', '/h/.claude/agents'], DEFAULT_SUBAGENT, fs, () => {});
    expect(await policies.resolve('big-reader')).toEqual({ policy: withCeiling(130000), source: '/p/.claude/agents/big-reader.md' });
  });

  it('matches by frontmatter name when the filename differs, and caches', async () => {
    const fs = memoryFs({ '/extra/reader-v2.md': agent('big-reader', '0.2m'), '/extra/other.md': agent('other') });
    const policies = new AgentPolicies(['/p/.claude/agents', '/extra'], DEFAULT_SUBAGENT, fs, () => {});
    expect(await policies.resolve('big-reader')).toEqual({ policy: withCeiling(200000), source: '/extra/reader-v2.md' });
    const readsAfterFirst = fs.reads.length;
    await policies.resolve('big-reader');
    expect(fs.reads.length).toBe(readsAfterFirst);
  });

  it('skips a <type>.md whose name: names another agent', async () => {
    const fs = memoryFs({ '/d/reader.md': agent('writer', '10k'), '/d/x.md': agent('reader', '20k') });
    const policies = new AgentPolicies(['/d'], DEFAULT_SUBAGENT, fs, () => {});
    expect(await policies.resolve('reader')).toEqual({ policy: withCeiling(20000), source: '/d/x.md' });
  });

  it('gives built-ins and definitions without a compaction key the default', async () => {
    const fs = memoryFs({ '/d/plain.md': agent('plain') });
    const policies = new AgentPolicies(['/d'], DEFAULT_SUBAGENT, fs, () => {});
    expect(await policies.resolve('general-purpose')).toEqual({ policy: DEFAULT_SUBAGENT, source: 'default' });
    expect(await policies.resolve('plain')).toEqual({ policy: DEFAULT_SUBAGENT, source: 'default' });
  });

  it('reads autoCompact.forceAt, and a bare autoCompact value as its shorthand', async () => {
    const fs = memoryFs({ '/d/nested.md': '---\nname: nested\nautoCompact:\n  forceAt: 40%\n---\n' });
    const policies = new AgentPolicies(['/d'], DEFAULT_SUBAGENT, fs, () => {});
    expect(await policies.resolve('nested')).toEqual({ policy: { ...DEFAULT_SUBAGENT, autoCompact: { percent: 40 } }, source: '/d/nested.md' });
  });

  it('reads the nudge and enabled keys, each over the default field by field', async () => {
    const fs = memoryFs({ '/d/quiet.md': '---\nname: quiet\nautoCompact:\n  enabled: false\n  nudgeFrom: 25%\n  nudgeEvery: 50k\n---\n' });
    const policies = new AgentPolicies(['/d'], DEFAULT_SUBAGENT, fs, () => {});
    expect(await policies.resolve('quiet')).toEqual({
      policy: { enabled: false, autoCompact: DEFAULT_SUBAGENT.autoCompact, nudgeStart: { percent: 25 }, nudgeEvery: { tokens: 50000 } },
      source: '/d/quiet.md',
    });
  });

  it('logs a bad value or an unreadable file and falls back', async () => {
    const lines: string[] = [];
    const fs = memoryFs(
      { '/d/bad.md': agent('bad', 'huge'), '/d/locked.md': agent('locked', '10k'), '/d/odd.md': '---\nname: odd\nautoCompact:\n  enabled: sometimes\n  nudgeEvery: 20k\n---\n' },
      ['/d/locked.md'],
    );
    const policies = new AgentPolicies(['/d'], DEFAULT_SUBAGENT, fs, (line) => lines.push(line));
    expect(await policies.resolve('bad')).toEqual({ policy: DEFAULT_SUBAGENT, source: 'default' });
    expect(await policies.resolve('locked')).toEqual({ policy: DEFAULT_SUBAGENT, source: 'default' });
    expect(await policies.resolve('odd')).toEqual({ policy: { ...DEFAULT_SUBAGENT, nudgeEvery: { tokens: 20000 } }, source: '/d/odd.md' });
    expect(lines.some((line) => /\/d\/bad\.md autoCompact for bad is invalid/.test(line))).toBe(true);
    expect(lines.some((line) => /\/d\/odd\.md autoCompact\.enabled for odd is invalid/.test(line))).toBe(true);
    expect(lines.some((line) => /reading \/d\/locked\.md failed: Error: EACCES/.test(line))).toBe(true);
  });
});

describe('AgentTypes', () => {
  it("takes the list's type over an announcement for an id the list names: a teammate's announcement carries its name", async () => {
    const types = new AgentTypes();
    types.learn('tm1', 'scout-2');
    expect(await types.of('tm1', async () => [{ id: 'tm1', type: 'general-purpose' }])).toBe('general-purpose');
  });

  it('takes the announced type for an id no list row names, as a Workflow run\'s agent has', async () => {
    const types = new AgentTypes();
    types.learn('wf1', 'Explore');
    expect(await types.of('wf1', async () => [])).toBe('Explore');
    expect(await types.of('fork1', async () => [])).toBeUndefined();
  });

  it('lists again for an id the list missed only after 60 s', async () => {
    let now = 0;
    let lists = 0;
    const types = new AgentTypes(() => now);
    const list = async () => { lists++; return now > 60_000 ? [{ id: 'late', type: 'scout' }] : []; };
    expect(await types.of('late', list)).toBeUndefined();
    now = 30_000;
    expect(await types.of('late', list)).toBeUndefined();
    expect(lists).toBe(1);
    now = 61_000;
    expect(await types.of('late', list)).toBe('scout');
    expect(lists).toBe(2);
  });
});

describe('decide for a loop the session does not list', () => {
  it('passes an engine loop missing from $.agent.list(), since no policy governs it', () => {
    expect(decide({ trigger: 'auto', label: 'unlisted', limit: 600_000, tokens: 70_000, unlisted: true })).toEqual({ action: 'pass', why: 'unlisted' });
  });
});

describe('personPrompt', () => {
  it('counts the person at the terminal, over Remote Control, or through the SDK', () => {
    for (const kind of ['composer', 'bridge', 'sdk']) expect(personPrompt({ kind })).toBe(true);
  });

  it('never counts a notification, a peer, a schedule, a plugin or an unattested channel', () => {
    for (const kind of ['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'coordinator', 'auto-continuation', 'unclassified']) {
      expect(personPrompt({ kind })).toBe(false);
    }
    expect(personPrompt(undefined)).toBe(false);
  });
});

describe('compactionEnd', () => {
  it('reads a compaction that ran as compacted', () => {
    expect(compactionEnd({ trigger: 'auto', skipped: false, aborted: false })).toBe('compacted');
  });

  it('reads a skipped, interrupted or failed one as unfinished, so an armed focus is dropped', () => {
    expect(compactionEnd({ trigger: 'auto', skipped: true, aborted: false })).toBe('unfinished');
    expect(compactionEnd({ trigger: 'plugin', skipped: false, aborted: true })).toBe('unfinished');
  });

  it('leaves a precompute alone: it installs nothing, and the compaction it prepares is still to come', () => {
    expect(compactionEnd({ trigger: 'precompute', skipped: false, aborted: false })).toBe('precompute');
    expect(compactionEnd({ trigger: 'precompute', skipped: true, aborted: true })).toBe('precompute');
  });
});

describe('a Haiku loop and the triggers Claude Code may send', () => {
  it('passes every Haiku ask, which Claude Code made at its own point (the logs show Haiku asked at 49.6k against a 167k limit)', () => {
    expect(decide({ trigger: 'auto', label: 'worker', limit: 167_000, tokens: 49_600, haiku: true })).toEqual({ action: 'pass', why: 'haiku' });
    expect(decide({ trigger: 'auto', label: 'worker', limit: 167_000, tokens: 49_600, haiku: true, enabled: false })).toEqual({ action: 'pass', why: 'haiku' });
    expect(decide({ trigger: 'auto', label: 'worker', limit: 167_000, tokens: 49_600 })).toEqual({ action: 'skip', reason: 'worker 50k/167k' });
  });

  it('knows the four triggers and nothing else', () => {
    for (const t of ['auto', 'manual', 'plugin', 'precompute']) expect(knownTrigger(t)).toBe(t);
    for (const t of ['recompute', undefined, 42, '']) expect(knownTrigger(t)).toBeUndefined();
  });
});

describe('an automatic ask no response answered since the last one was held', () => {
  it('passes below the limit: the request after the held ask got no answer, as a prompt too long gets none', () => {
    expect(decide({ trigger: 'auto', label: 'main', limit: 600_000, tokens: 150_000, unanswered: true } as any)).toEqual({ action: 'pass', why: 'unanswered' });
  });
  it('still holds a party with automatic compaction off', () => {
    expect(decide({ trigger: 'auto', label: 'main', limit: 600_000, tokens: 150_000, unanswered: true, enabled: false } as any)).toEqual({ action: 'skip', reason: 'main: auto-compact off' });
  });
});
