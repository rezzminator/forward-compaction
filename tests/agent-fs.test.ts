import { describe, expect, it } from 'vitest';
import { engineAgentFs } from '../plugins/sub-agent-compact/src/agent-fs.ts';
import { AgentPolicies, hasTool } from '../plugins/sub-agent-compact/src/agents.ts';
import { frontmatterList } from '../plugins/sub-agent-compact/src/frontmatter.ts';
import { DEFAULT_SUBAGENT } from '../plugins/sub-agent-compact/src/limits.ts';

type Entry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; isLink: boolean };

/** `$.fs.list` as the engine answers it: a symbolic link is `other` with `isLink`. */
function engineFs(entries: Entry[], files: Record<string, string> = {}, stats: Record<string, { kind: Entry['kind']; size: number }> = {}) {
  return {
    exists: async (path: string) => path in files,
    read: async (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error('ENOENT');
      return text;
    },
    list: async () => entries,
    stat: async (path: string) => stats[path] ?? (path in files ? { kind: 'file', size: (files[path] ?? '').length } : { kind: 'other', size: 0 }),
  } as unknown as Parameters<typeof engineAgentFs>[0];
}

const entry = (name: string, kind: Entry['kind'], isLink = false): Entry => ({ name, kind, size: 0, isLink });

describe('engineAgentFs listMarkdown', () => {
  it('lists a regular .md file and a symbolic link to one, and nothing else', async () => {
    const fs = engineAgentFs(
      engineFs(
        [
          entry('plain.md', 'file'),
          entry('linked.md', 'other', true),
          entry('notes.txt', 'file'),
          entry('linked.txt', 'other', true),
          entry('folder.md', 'dir'),
          entry('socket.md', 'other'),
        ],
        { '/agents/linked.md': 'x' },
      ),
      () => {},
    );
    expect(await fs.listMarkdown('/agents')).toEqual(['plain.md', 'linked.md']);
  });

  it('never lists a link to a pipe, a device, a directory, nowhere or an oversized file, and names each', async () => {
    const logged: string[] = [];
    const fs = engineAgentFs(
      engineFs(
        [entry('fifo.md', 'other', true), entry('dir.md', 'other', true), entry('dangling.md', 'other', true), entry('huge.md', 'other', true)],
        {},
        { '/agents/dir.md': { kind: 'dir', size: 0 }, '/agents/huge.md': { kind: 'file', size: 5 * 1024 * 1024 } },
      ),
      (line) => logged.push(line),
    );
    expect(await fs.listMarkdown('/agents')).toEqual([]);
    expect(logged).toEqual([
      'sub-agent-compact: skipping /agents/fifo.md: a link to something not a regular file',
      'sub-agent-compact: skipping /agents/dir.md: a link to something not a regular file',
      'sub-agent-compact: skipping /agents/dangling.md: a link to something not a regular file',
      'sub-agent-compact: skipping /agents/huge.md: a link to 5242880 bytes, over the 4194304 byte limit',
    ]);
  });

  it('finds an agent whose definition is a symbolic link by its frontmatter name', async () => {
    const definition = '---\nname: big-reader\nautoCompact: 130k\n---\nbody\n';
    const fs = engineAgentFs(engineFs([entry('reader-v2.md', 'other', true)], { '/agents': '', '/agents/reader-v2.md': definition }), () => {});
    const policies = new AgentPolicies(['/agents'], DEFAULT_SUBAGENT, fs, () => {});
    expect(await policies.resolve('big-reader')).toEqual({ policy: { ...DEFAULT_SUBAGENT, autoCompact: { tokens: 130000 } }, source: '/agents/reader-v2.md' });
  });

  it('falls back to the default, naming the file, when a linked definition cannot be read', async () => {
    const logged: string[] = [];
    const log = (line: string) => logged.push(line);
    const fs = engineAgentFs(engineFs([entry('unreadable.md', 'other', true)], { '/agents': '' }, { '/agents/unreadable.md': { kind: 'file', size: 10 } }), log);
    const policies = new AgentPolicies(['/agents'], DEFAULT_SUBAGENT, fs, log);
    expect(await policies.resolve('anything')).toEqual({ policy: DEFAULT_SUBAGENT, source: 'default' });
    expect(logged).toEqual(['sub-agent-compact: reading /agents/unreadable.md failed: Error: ENOENT']);
  });
});

const FORWARD = 'mcp__sub-agent-compact__forward_handoff';
const doc = (body: string) => `---\nname: rr\n${body}\n---\n# body\n`;

describe('frontmatterList', () => {
  it.each([
    ['a comma scalar', 'tools: WebSearch, WebFetch', ['WebSearch', 'WebFetch']],
    ['a flow list with quotes', `tools: [Read, "${FORWARD}"]`, ['Read', FORWARD]],
    ['a block list', `tools:\n  - Read\n  - '${FORWARD}'\nmodel: opus`, ['Read', FORWARD]],
    ['an absent key', 'model: opus', undefined],
    ['an empty value', 'tools:\nmodel: opus', undefined],
  ])('reads %s', (_name, body, expected) => {
    expect(frontmatterList(doc(body), 'tools')).toEqual(expected);
  });
});

describe('hasTool', () => {
  it.each([
    ['no tools list inherits every tool', undefined, undefined, true],
    ['a list without it', ['WebSearch', 'WebFetch'], undefined, false],
    ['the exact name', ['Read', FORWARD], undefined, true],
    ['the server name', ['mcp__sub-agent-compact'], undefined, true],
    ['the server wildcard', ['mcp__sub-agent-compact__*'], undefined, true],
    ['another server', ['mcp__sub-agent-compactor'], undefined, false],
    ['the exact name disallowed', undefined, [FORWARD], false],
    ['the server disallowed', ['*'], ['mcp__sub-agent-compact'], false],
  ])('%s', (_name, tools, disallowed, expected) => {
    expect(hasTool(tools, disallowed, FORWARD)).toBe(expected);
  });
});

describe('AgentPolicies tools', () => {
  it('reads tools and disallowedTools from a definition that sets no compaction key', async () => {
    const files = { '/a/rr.md': doc('tools: WebSearch, WebFetch\ndisallowedTools:\n  - Bash') };
    const policies = new AgentPolicies(['/a'], DEFAULT_SUBAGENT, engineAgentFs(engineFs([], files), () => {}), () => {});
    const resolved = await policies.resolve('rr');
    expect(resolved).toMatchObject({ source: 'default', tools: ['WebSearch', 'WebFetch'], disallowedTools: ['Bash'] });
    expect(resolved.policy).toBe(DEFAULT_SUBAGENT);
  });
});

describe('AgentPolicies resolving every route alike', () => {
  const policyDoc = (name: string) => `---\nname: ${name}\nautoCompact: 100k\n---\n`;
  it.each([
    ['a link to something not a regular file', { kind: 'other' as const, size: 0 }, /\/a\/rr\.md: not a regular file/],
    ['a link past the size limit', { kind: 'file' as const, size: 5 * 1024 * 1024 }, /\/a\/rr\.md: 5242880 bytes, over the 4194304 byte limit/],
  ])('never reads the direct <type>.md when it is %s', async (_name, stat, line) => {
    const lines: string[] = [];
    const files = { '/a/rr.md': policyDoc('rr') };
    const policies = new AgentPolicies(['/a'], DEFAULT_SUBAGENT, engineAgentFs(engineFs([], files, { '/a/rr.md': stat }), () => {}), (l) => lines.push(l));
    expect((await policies.resolve('rr')).source).toBe('default');
    expect(lines).toEqual([expect.stringMatching(line)]);
  });

  it('resolves a plugin agent type in its plugin\'s agents folder, by file name and by name', async () => {
    const files = { '/plug/tools/agents/scout.md': policyDoc('scout'), '/plug/tools/agents/other.md': policyDoc('finder') };
    const engineFiles = engineAgentFs(engineFs([{ name: 'scout.md', kind: 'file', size: 0, isLink: false }, { name: 'other.md', kind: 'file', size: 0, isLink: false }], files), () => {});
    const fs = { ...engineFiles, exists: async (path: string) => path === '/plug/tools/agents' || (await engineFiles.exists(path)) };
    const asked: string[] = [];
    const policies = new AgentPolicies(['/a'], DEFAULT_SUBAGENT, fs, () => {}, { pluginDirs: async (plugin) => { asked.push(plugin); return plugin === 'tools' ? ['/plug/tools/agents'] : []; } });
    expect(await policies.resolve('tools:scout')).toMatchObject({ source: '/plug/tools/agents/scout.md', policy: { autoCompact: { tokens: 100_000 } } });
    expect((await policies.resolve('tools:finder')).source).toBe('/plug/tools/agents/other.md');
    expect((await policies.resolve('elsewhere:scout')).source).toBe('default');
    expect(asked).toEqual(['tools', 'tools', 'elsewhere']);
  });

  it('reads a definition again after 60 s, and never keeps an index whose listing failed', async () => {
    let now = 0;
    let reads = 0;
    let listFails = true;
    const files: Record<string, string> = { '/a/x.md': policyDoc('rr') };
    const fs = {
      exists: async (path: string) => path === '/a' || path in files,
      read: async (path: string) => { reads++; return files[path]!; },
      listMarkdown: async () => { if (listFails) throw new Error('EACCES'); return ['x.md']; },
    };
    const policies = new AgentPolicies(['/a'], DEFAULT_SUBAGENT, fs, () => {}, { now: () => now });
    expect((await policies.resolve('rr')).source).toBe('default');
    listFails = false;
    expect((await policies.resolve('rr')).source).toBe('/a/x.md');
    const read = reads;
    now = 59_000;
    await policies.resolve('rr');
    expect(reads).toBe(read);
    now = 61_000;
    await policies.resolve('rr');
    expect(reads).toBeGreaterThan(read);
  });
});
