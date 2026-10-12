import { describe, expect, it } from 'vitest';
import { AgentPolicies, AgentTypes, type AgentFs } from '../plugins/sub-agent-compact/src/agents.ts';
import { compactionEnd, contextTokens, decide, personPrompt } from '../plugins/sub-agent-compact/src/decide.ts';
import { parseFrontmatter } from '../plugins/sub-agent-compact/src/frontmatter.ts';
import { DEFAULT_KEEP_BRIEF, DEFAULT_MAIN, DEFAULT_SUBAGENT, parseEnabled, parseSize, resolveOptions, sizeTokens } from '../plugins/sub-agent-compact/src/limits.ts';

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
  it('defaults when nothing is set', () => {
    expect(resolveOptions({})).toEqual({ main: DEFAULT_MAIN, subagent: DEFAULT_SUBAGENT, keepBrief: true, compactTool: false, handoffTool: true, agentDirs: [], errors: [] });
    expect(DEFAULT_KEEP_BRIEF).toBe(true);
    expect(DEFAULT_MAIN).toEqual({ enabled: true, autoCompact: { percent: 60 }, nudgeStart: { percent: 20 }, nudgeEvery: { percent: 10 } });
    expect(DEFAULT_SUBAGENT).toEqual({ enabled: true, autoCompact: { percent: 60 }, nudgeStart: { percent: 20 }, nudgeEvery: { percent: 10 } });
  });

  it('reads every party key, suffixed values, dir lists and an absolute log file', () => {
    const options = resolveOptions({
      mainAutoCompact: '0.6m',
      mainAutoCompactNudgeStart: '25%',
      mainAutoCompactNudgeEvery: '50k',
      mainAutoCompactEnabled: 'off',
      subagentAutoCompact: '90k',
      subagentAutoCompactNudgeStart: '40k',
      subagentAutoCompactNudgeEvery: '5%',
      subagentAutoCompactEnabled: true,
      subagentKeepBrief: 'off',
      agentDirs: 'a, /b/c ,',
      logFile: '/tmp/x.jsonl',
    });
    expect(options).toEqual({
      main: { enabled: false, autoCompact: { tokens: 600000 }, nudgeStart: { percent: 25 }, nudgeEvery: { tokens: 50000 } },
      subagent: { enabled: true, autoCompact: { tokens: 90000 }, nudgeStart: { tokens: 40000 }, nudgeEvery: { percent: 5 } },
      keepBrief: false,
      compactTool: false,
      handoffTool: true,
      agentDirs: ['a', '/b/c'],
      logFile: '/tmp/x.jsonl',
      errors: [],
    });
    expect(resolveOptions({ agentDirs: ['/x', ' /y '] }).agentDirs).toEqual(['/x', '/y']);
  });

  it('falls back on a bad value and names it, never silently', () => {
    const options = resolveOptions({ mainAutoCompact: 'lots', subagentAutoCompact: '-3', subagentAutoCompactEnabled: 'maybe', subagentKeepBrief: 'sometimes', logFile: 'relative.jsonl' });
    expect(options.main.autoCompact).toEqual(DEFAULT_MAIN.autoCompact);
    expect(options.subagent.autoCompact).toEqual(DEFAULT_SUBAGENT.autoCompact);
    expect(options.subagent.enabled).toBe(true);
    expect(options.keepBrief).toBe(true);
    expect(options.logFile).toBeUndefined();
    expect(options.errors).toHaveLength(5);
    expect(options.errors[0]).toMatch(/mainAutoCompact is invalid.*"lots".*60%/);
    expect(options.errors[1]).toMatch(/subagentAutoCompact is invalid/);
    expect(options.errors[2]).toMatch(/subagentAutoCompactEnabled is invalid.*"maybe".*true/);
    expect(options.errors[3]).toMatch(/subagentKeepBrief is invalid.*"sometimes".*true/);
    expect(options.errors[4]).toMatch(/logFile must be an absolute path/);
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
