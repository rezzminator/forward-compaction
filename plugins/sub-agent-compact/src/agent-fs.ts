import type { EngineInterface } from 'claude-code';
import type { AgentFs } from './agents.ts';

/** The engine's `$.fs.read` limit: a linked definition past it is skipped before the read. */
export const AGENT_FILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The agent resolver's file access over the engine's `$.fs`: the engine lists a symbolic link as `other` with `isLink`, and a
 * linked definition is an agent like any other once `$.fs.stat` (which follows the link) shows a regular file within the limit.
 * `$.fs.read` takes a pipe or a device as it takes a file, so any other link is skipped and named through `log`, never read.
 */
export function engineAgentFs(
  fs: Pick<EngineInterface['fs'], 'exists' | 'list' | 'stat'> & { read: (path: string) => Promise<string> },
  log: (line: string) => void,
): AgentFs {
  return {
    exists: (path) => fs.exists(path),
    read: (path) => fs.read(path),
    listMarkdown: async (dir) => {
      const names: string[] = [];
      for (const entry of await fs.list(dir)) {
        if (!entry.name.endsWith('.md')) continue;
        if (entry.kind === 'file') {
          names.push(entry.name);
          continue;
        }
        if (!entry.isLink) continue;
        const path = `${dir}/${entry.name}`;
        let target;
        try {
          target = await fs.stat(path);
        } catch (error) {
          log(`sub-agent-compact: skipping ${path}: could not stat it: ${String(error)}`);
          continue;
        }
        if (target.kind !== 'file') log(`sub-agent-compact: skipping ${path}: a link to something not a regular file`);
        else if (target.size > AGENT_FILE_MAX_BYTES) log(`sub-agent-compact: skipping ${path}: a link to ${target.size} bytes, over the ${AGENT_FILE_MAX_BYTES} byte limit`);
        else names.push(entry.name);
      }
      return names;
    },
  };
}
