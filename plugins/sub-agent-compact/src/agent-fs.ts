import type { EngineInterface } from 'claude-code';
import type { AgentFs, AgentResolveLog } from './agents.ts';

/** The engine's `$.fs.read` limit: a linked definition past it is skipped before the read. */
export const AGENT_FILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Why a listed link is no agent file, told apart: a path the listing named a link that is no longer one has changed
 * since it was listed; a link whose target does not resolve (it leads nowhere, or a hook withheld where it lands) is
 * named so; any other leads to a directory or to something not a file.
 */
export function notFileLink(target: { kind: 'file' | 'dir' | 'other'; isLink: boolean; realPath?: string }): string {
  if (!target.isLink) return `changed since it was listed: no longer a link, now ${target.kind === 'dir' ? 'a directory' : 'not a regular file'}`;
  if (target.kind === 'other' && target.realPath === undefined) return 'a link that leads nowhere or does not resolve';
  return target.kind === 'dir' ? 'a link to a directory' : 'a link to something not a regular file';
}

/**
 * The agent resolver's file access over the engine's `$.fs`: the engine lists a symbolic link as `other` with `isLink`, and a
 * linked definition is an agent like any other once `$.fs.stat` (which follows the link) shows a regular file within the limit.
 * `$.fs.read` takes a pipe or a device as it takes a file, so any other link is skipped and named through `log`, never read.
 */
export function engineAgentFs(
  fs: Pick<EngineInterface['fs'], 'exists' | 'list' | 'stat'> & { read: (path: string) => Promise<string> },
  log: AgentResolveLog,
): AgentFs {
  return {
    exists: (path) => fs.exists(path),
    // Every route reads through here: the direct `<type>.md` as the name index, so a link to a pipe, a device or a file past the limit is never read.
    read: async (path) => {
      const target = await fs.stat(path);
      if (target.kind !== 'file') throw new Error(`${path}: not a regular file`);
      if (target.size > AGENT_FILE_MAX_BYTES) throw new Error(`${path}: ${target.size} bytes, over the ${AGENT_FILE_MAX_BYTES} byte limit`);
      return fs.read(path);
    },
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
          target = await fs.stat(path, { resolve: true });
        } catch (error) {
          log(`sub-agent-compact: skipping ${path}: could not stat it: ${String(error)}`, path);
          continue;
        }
        if (target.kind !== 'file') log(`sub-agent-compact: skipping ${path}: ${notFileLink(target)}`, path);
        else if (target.size > AGENT_FILE_MAX_BYTES) log(`sub-agent-compact: skipping ${path}: a link to ${target.size} bytes, over the ${AGENT_FILE_MAX_BYTES} byte limit`, path);
        else names.push(entry.name);
      }
      return names;
    },
  };
}
