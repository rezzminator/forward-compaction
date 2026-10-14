import { describe, expect, it } from 'vitest';
import { engineAgentFs } from '../plugins/sub-agent-compact/src/agent-fs.ts';
import { AgentPolicies } from '../plugins/sub-agent-compact/src/agents.ts';
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
