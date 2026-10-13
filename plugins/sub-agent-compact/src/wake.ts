// What the woken model asked to have loaded: skills and commands named in the handoff's `load_on_wake`,
// resolved from the files Claude Code itself reads them from and inlined into the installed handoff.
import { WAKE_NAME } from './handoff.ts';

export type WakeRoots = { projectRoot: string; userRoot: string; plugins: Record<string, string> };

export type WakeEntry = { name: string; path?: string; content?: string; problem?: string; invoked?: boolean };

export const WAKE_MAX_ENTRIES = 8;
export const WAKE_ENTRY_MAX_CHARS = 16_000;
export const WAKE_TOTAL_MAX_CHARS = 40_000;
/** A skill or command file past this is refused before it is read: the inlined text is cut far below it, so only a file that is not a skill reaches it. */
export const WAKE_FILE_MAX_BYTES = 256 * 1024;

/** The files a name may be read from, in the order Claude Code prefers them, or why the name is refused. */
export function wakeCandidates(name: string, roots: WakeRoots): { paths: string[] } | { problem: string } {
  const bare = name.startsWith('/') ? name.slice(1) : name;
  if (!WAKE_NAME.test(bare)) return { problem: `${JSON.stringify(name)} is not a skill or command name` };
  const command = bare.replaceAll(':', '/');
  const paths: string[] = [];
  for (const root of [roots.projectRoot, roots.userRoot]) {
    paths.push(`${root}/skills/${bare}/SKILL.md`, `${root}/commands/${command}.md`);
  }
  const colon = bare.indexOf(':');
  if (colon > 0) {
    const plugin = roots.plugins[bare.slice(0, colon)];
    const rest = bare.slice(colon + 1);
    if (plugin !== undefined) paths.push(`${plugin}/skills/${rest}/SKILL.md`, `${plugin}/commands/${rest}.md`);
  }
  return { paths };
}

/** The text without its leading frontmatter block; text whose block never closes is returned unchanged. */
export function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** The skills and commands a transcript's Skill tool calls invoked: not inlined again, the model is told it invoked them. */
export function invokedSkills(messages: readonly { toolUses: readonly { tool?: string; input?: unknown }[] }[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages) {
    for (const use of message.toolUses ?? []) {
      if (use.tool !== 'Skill') continue;
      const skill = (use.input as { skill?: unknown } | null | undefined)?.skill;
      if (typeof skill === 'string') names.add(skill.startsWith('/') ? skill.slice(1) : skill);
    }
  }
  return names;
}

/** The plugin install paths in `installed_plugins.json`, by plugin name. */
export function pluginPaths(json: string): { paths: Record<string, string> } | { problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return { problem: `installed_plugins.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return { problem: 'installed_plugins.json has no `plugins` object' };
  const paths: Record<string, string> = {};
  for (const [key, entries] of Object.entries(plugins)) {
    if (!Array.isArray(entries)) continue;
    const installs = entries.filter((entry): entry is { scope?: unknown; installPath: string } => typeof entry?.installPath === 'string');
    const chosen = installs.find((entry) => entry.scope === 'user') ?? installs[0];
    const name = key.split('@')[0] ?? '';
    if (chosen && name) paths[name] = chosen.installPath;
  }
  return { paths };
}

/** The inlined text for the resolved entries; every entry that is not inlined says why in the text and is named in `failed` or `cut`. */
export function renderWake(entries: readonly WakeEntry[]): { text: string; failed: string[]; cut: string[] } {
  const failed: string[] = [];
  const cut: string[] = [];
  const blocks: string[] = [];
  let total = 0;
  for (const entry of entries) {
    if (entry.invoked) {
      blocks.push(`${entry.name}: not inlined because you invoked it earlier in this session; if its text is not in your context after this wake, invoke it again`);
      continue;
    }
    if (entry.problem !== undefined || entry.content === undefined) {
      blocks.push(`NOT LOADED: ${entry.name}: ${entry.problem ?? 'no content'}`);
      failed.push(entry.name);
      continue;
    }
    let content = entry.content;
    if (content.length > WAKE_ENTRY_MAX_CHARS) {
      content = `${content.slice(0, WAKE_ENTRY_MAX_CHARS)}\n[sub-agent-compact: cut at ${WAKE_ENTRY_MAX_CHARS} of ${entry.content.length} characters]`;
      cut.push(entry.name);
    }
    if (total + content.length > WAKE_TOTAL_MAX_CHARS) {
      blocks.push(`NOT LOADED: ${entry.name}: the total of ${WAKE_TOTAL_MAX_CHARS} characters was reached`);
      failed.push(entry.name);
      if (cut.at(-1) === entry.name) cut.pop();
      continue;
    }
    total += content.length;
    blocks.push(`=== loaded: ${entry.name} (${entry.path ?? 'unknown path'}) ===\n${content}\n=== end loaded: ${entry.name} ===`);
  }
  return { text: blocks.join('\n\n'), failed, cut };
}

/** Why a path's stat rules it out as a skill or command file, or undefined: only a regular file within the byte cap is read. */
export function wakeFileProblem(stat: { kind: string; size: number }): string | undefined {
  if (stat.kind !== 'file') return `is not a regular file (it is a ${stat.kind})`;
  if (stat.size > WAKE_FILE_MAX_BYTES) return `is ${stat.size} bytes, past the ${WAKE_FILE_MAX_BYTES} bytes a skill or command may be`;
  return undefined;
}
