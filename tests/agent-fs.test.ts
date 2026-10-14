import { describe, expect, it } from 'vitest';
import { engineAgentFs } from '../plugins/sub-agent-compact/src/agent-fs.ts';
import { AgentPolicies } from '../plugins/sub-agent-compact/src/agents.ts';
import { DEFAULT_SUBAGENT } from '../plugins/sub-agent-compact/src/limits.ts';

type Entry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; isLink: boolean };

/** `$.fs.list` as the engine answers it: a symbolic link is `other` with `isLink`. */
function engineFs(entries: Entry[], files: Record<string, string> = {}) {
  return {
    exists: async (path: string) => path in files,
    read: async (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error('ENOENT');
      return text;
    },
    list: async () => entries,
  } as unknown as Parameters<typeof engineAgentFs>[0];
}

const entry = (name: string, kind: Entry['kind'], isLink = false): Entry => ({ name, kind, size: 0, isLink });

describe('engineAgentFs listMarkdown', () => {
  it('lists a regular .md file and a symbolic link to one, and nothing else', async () => {
    const fs = engineAgentFs(
      engineFs([
        entry('plain.md', 'file'),
        entry('linked.md', 'other', true),
        entry('notes.txt', 'file'),
        entry('linked.txt', 'other', true),
        entry('folder.md', 'dir'),
        entry('socket.md', 'other'),
      ]),
    );
    expect(await fs.listMarkdown('/agents')).toEqual(['plain.md', 'linked.md']);
  });

  it('finds an agent whose definition is a symbolic link by its frontmatter name', async () => {
    const definition = '---\nname: big-reader\nautoCompact: 130k\n---\nbody\n';
    const fs = engineAgentFs(engineFs([entry('reader-v2.md', 'other', true)], { '/agents': '', '/agents/reader-v2.md': definition }));
    const policies = new AgentPolicies(['/agents'], DEFAULT_SUBAGENT, fs, () => {});
    expect(await policies.resolve('big-reader')).toEqual({ policy: { ...DEFAULT_SUBAGENT, autoCompact: { tokens: 130000 } }, source: '/agents/reader-v2.md' });
  });

  it('falls back to the default, naming the file, when a linked definition cannot be read', async () => {
    const logged: string[] = [];
    const fs = engineAgentFs(engineFs([entry('dangling.md', 'other', true)], { '/agents': '' }));
    const policies = new AgentPolicies(['/agents'], DEFAULT_SUBAGENT, fs, (line) => logged.push(line));
    expect(await policies.resolve('anything')).toEqual({ policy: DEFAULT_SUBAGENT, source: 'default' });
    expect(logged).toEqual(['sub-agent-compact: reading /agents/dangling.md failed: Error: ENOENT']);
  });
});
