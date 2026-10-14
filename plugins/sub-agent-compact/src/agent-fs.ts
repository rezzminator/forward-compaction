import type { EngineInterface } from 'claude-code';
import type { AgentFs } from './agents.ts';

/** The agent resolver's file access over the engine's `$.fs`: the engine lists a symbolic link as `other` with `isLink`, and a linked definition is an agent like any other. */
export function engineAgentFs(fs: Pick<EngineInterface['fs'], 'exists' | 'list'> & { read: (path: string) => Promise<string> }): AgentFs {
  return {
    exists: (path) => fs.exists(path),
    read: (path) => fs.read(path),
    listMarkdown: async (dir) => (await fs.list(dir)).filter((entry) => (entry.kind === 'file' || entry.isLink) && entry.name.endsWith('.md')).map((entry) => entry.name),
  };
}
