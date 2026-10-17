import { frontmatterList, parseFrontmatter } from './frontmatter.ts';
import { frontmatterKey, readPolicy, type Policy } from './limits.ts';

/** A resolver diagnostic, keyed by its path (or plugin identity before its directory is known). */
export type AgentResolveLog = (line: string, path: string) => void;

export type AgentFs = {
  exists: (path: string) => Promise<boolean>;
  read: (path: string) => Promise<string>;
  /** File names (no directory part) of the `.md` files in a directory. */
  listMarkdown: (dir: string) => Promise<string[]>;
};

export type AgentPolicy = {
  policy: Policy;
  /** The definition file that set at least one compaction key, or `default`. */
  source: string;
  /** The definition's `tools` list; absent when it lists none, so it inherits every tool. */
  tools?: string[];
  /** The definition's `disallowedTools` list. */
  disallowedTools?: string[];
};

/** One `tools` entry naming a tool: `*`, the exact name, its MCP server (`mcp__server`) or the server's wildcard (`mcp__server__*`). */
function names(pattern: string, tool: string): boolean {
  if (pattern === '*' || pattern === tool) return true;
  if (!pattern.startsWith('mcp__')) return false;
  const server = pattern.endsWith('__*') ? pattern.slice(0, -3) : pattern;
  return tool.startsWith(`${server}__`) && !server.slice('mcp__'.length).includes('__');
}

/** Whether a definition's lists leave it a tool: no `tools` list inherits every tool, and `disallowedTools` removes. */
export function hasTool(tools: readonly string[] | undefined, disallowed: readonly string[] | undefined, tool: string): boolean {
  if (tools !== undefined && !tools.some((pattern) => names(pattern, tool))) return false;
  return !(disallowed ?? []).some((pattern) => names(pattern, tool));
}

function join(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

/** How long a resolved type, a name index or a list miss is trusted before it is read again: a definition edited mid-session takes effect. */
export const AGENT_CACHE_MS = 60_000;

type Definition = { fields: Record<string, string>; text: string };
type Lookup = { resolved: AgentPolicy; failed: boolean };
type NameIndex = { names: Map<string, string>; failed: boolean };

/**
 * Resolves an agent type to its compaction policy: `<dir>/<type>.md` in each
 * directory in order, then any file whose frontmatter `name:` is the type
 * (the directories scanned once), else the default. A plugin's agent type
 * (`plugin:agent`) is looked up the same way in that plugin's agents folders
 * only. The frontmatter keys under `autoCompact` (`forceAt`, `nudgeFrom`,
 * `nudgeEvery`, `enabled`) each override the default's field. Every failure is
 * logged and falls back to the default; results are cached per type for
 * AGENT_CACHE_MS, and a result or index that met a failure is not cached.
 */
export class AgentPolicies {
  private readonly byType = new Map<string, { at: number; hit: Promise<AgentPolicy> }>();
  private readonly indexes = new Map<string, { at: number; index: Promise<NameIndex> }>();
  private readonly pluginDirs: (plugin: string) => Promise<string[]>;
  private readonly now: () => number;

  constructor(
    private readonly dirs: readonly string[],
    private readonly fallback: Policy,
    private readonly fs: AgentFs,
    private readonly log: AgentResolveLog,
    options: { pluginDirs?: (plugin: string) => Promise<string[]>; now?: () => number } = {},
  ) {
    this.pluginDirs = options.pluginDirs ?? (async () => []);
    this.now = options.now ?? (() => Date.now());
  }

  resolve(type: string): Promise<AgentPolicy> {
    const now = this.now();
    const cached = this.byType.get(type);
    if (cached && now - cached.at < AGENT_CACHE_MS) return cached.hit;
    const lookup = this.lookup(type);
    const hit = lookup.then((found) => found.resolved);
    this.byType.set(type, { at: now, hit });
    void lookup.then((found) => {
      if (found.failed && this.byType.get(type)?.hit === hit) this.byType.delete(type);
    });
    return hit;
  }

  private async lookup(type: string): Promise<Lookup> {
    const colon = type.indexOf(':');
    if (colon <= 0) return this.lookupIn(this.dirs, type, type, '');
    const plugin = type.slice(0, colon);
    let dirs: string[] = [];
    try {
      dirs = await this.pluginDirs(plugin);
    } catch (error) {
      this.log(`sub-agent-compact: finding the agents folder of plugin ${plugin} failed: ${String(error)}`, `plugin:${plugin}`);
      return { resolved: { policy: this.fallback, source: 'default' }, failed: true };
    }
    return this.lookupIn(dirs, type.slice(colon + 1), type, `plugin:${plugin}`);
  }

  private async lookupIn(dirs: readonly string[], name: string, type: string, indexKey: string): Promise<Lookup> {
    let failed = false;
    for (const dir of dirs) {
      const path = join(dir, `${name}.md`);
      let found = false;
      try {
        found = await this.fs.exists(path);
      } catch (error) {
        failed = true;
        this.log(`sub-agent-compact: checking ${path} failed: ${String(error)}`, path);
      }
      if (found) {
        const definition = await this.definition(path);
        if (!definition) failed = true;
        else if (!definition.fields.name || definition.fields.name === name) return { resolved: this.fromDefinition(type, path, definition), failed };
      }
    }
    const index = await this.index(dirs, indexKey);
    failed ||= index.failed;
    const byName = index.names.get(name);
    if (byName) {
      const definition = await this.definition(byName);
      if (definition) return { resolved: this.fromDefinition(type, byName, definition), failed };
      failed = true;
    }
    return { resolved: { policy: this.fallback, source: 'default' }, failed };
  }

  private fromDefinition(type: string, path: string, { fields, text }: Definition): AgentPolicy {
    const tools = frontmatterList(text, 'tools');
    const disallowedTools = frontmatterList(text, 'disallowedTools');
    return { ...this.fromFields(type, path, fields), ...(tools ? { tools } : {}), ...(disallowedTools ? { disallowedTools } : {}) };
  }

  private fromFields(type: string, path: string, fields: Record<string, string>): AgentPolicy {
    // The key as the author wrote it: the bare shorthand, or the nested one.
    const written = (field: keyof Policy): string =>
      field === 'autoCompact' && fields[frontmatterKey(field)] === undefined ? 'autoCompact' : frontmatterKey(field);
    const { policy, set } = readPolicy(
      // A bare `autoCompact: 200k` is shorthand for `autoCompact.forceAt`.
      (field) => fields[frontmatterKey(field)] ?? (field === 'autoCompact' ? fields.autoCompact : undefined),
      this.fallback,
      (field, error, fallbackText) =>
        this.log(`sub-agent-compact: ${path} ${written(field)} for ${type} is invalid (${error}); using the default ${fallbackText}`, path),
    );
    return set ? { policy, source: path } : { policy: this.fallback, source: 'default' };
  }

  private async definition(path: string): Promise<Definition | undefined> {
    try {
      const text = await this.fs.read(path);
      return { fields: parseFrontmatter(text), text };
    } catch (error) {
      this.log(`sub-agent-compact: reading ${path} failed: ${String(error)}`, path);
      return undefined;
    }
  }

  /** The `name:` index of a set of folders, cached like a type; an index whose listing or reading failed is built again at the next ask. */
  private index(dirs: readonly string[], key: string): Promise<NameIndex> {
    const now = this.now();
    const cached = this.indexes.get(key);
    if (cached && now - cached.at < AGENT_CACHE_MS) return cached.index;
    const index = (async (): Promise<NameIndex> => {
      const names = new Map<string, string>();
      let failed = false;
      for (const dir of dirs) {
        let files: string[] = [];
        try {
          if (!(await this.fs.exists(dir))) continue;
          files = await this.fs.listMarkdown(dir);
        } catch (error) {
          failed = true;
          this.log(`sub-agent-compact: listing ${dir} failed: ${String(error)}`, dir);
          continue;
        }
        for (const file of files) {
          const path = join(dir, file);
          const definition = await this.definition(path);
          if (!definition) failed = true;
          const name = definition?.fields.name;
          if (name && !names.has(name)) names.set(name, path);
        }
      }
      return { names, failed };
    })();
    this.indexes.set(key, { at: now, index });
    void index.then((built) => {
      if (built.failed && this.indexes.get(key)?.index === index) this.indexes.delete(key);
    });
    return index;
  }
}

/**
 * Each sub-agent's type by id. The session's agent list comes first, once per
 * id it names: a teammate's SubagentStart and SubagentStop carry its name as
 * `agent_type`, not its type. An id no list row names takes the type the
 * engine announced (SubagentStart, SubagentStop): a Workflow run's agents are
 * never in `$.agent.list()`, so the announcement is their only source. An id
 * neither names is an engine loop.
 */
export class AgentTypes {
  private readonly listed = new Map<string, string>();
  private readonly announced = new Map<string, string>();
  /** When the list last missed each id: within AGENT_CACHE_MS the list is not taken again for it. */
  private readonly missed = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  learn(id: string, type: string): void {
    if (id && type) this.announced.set(id, type);
  }

  async of(id: string, list: () => Promise<readonly { id: string; type: string }[]>): Promise<string | undefined> {
    const known = this.listed.get(id);
    if (known) return known;
    const missedAt = this.missed.get(id);
    if (missedAt !== undefined && this.now() - missedAt < AGENT_CACHE_MS) return this.announced.get(id);
    const agent = (await list()).find((info) => info.id === id);
    if (agent?.type) {
      this.listed.set(id, agent.type);
      this.missed.delete(id);
      return agent.type;
    }
    this.missed.set(id, this.now());
    return this.announced.get(id) ?? agent?.type;
  }
}
