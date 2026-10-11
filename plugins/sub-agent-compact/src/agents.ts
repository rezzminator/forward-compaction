import { parseFrontmatter } from './frontmatter.ts';
import { frontmatterKey, readPolicy, type Policy } from './limits.ts';

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
};

function join(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

/**
 * Resolves an agent type to its compaction policy: `<dir>/<type>.md` in each
 * directory in order, then any file whose frontmatter `name:` is the type
 * (the directories scanned once), else the default. The frontmatter keys
 * under `autoCompact` (`forceAt`, `nudgeFrom`, `nudgeEvery`, `enabled`) each
 * override the default's field. Every failure is
 * logged and falls back to the default; results are cached per type.
 */
export class AgentPolicies {
  private readonly byType = new Map<string, Promise<AgentPolicy>>();
  private nameIndex: Promise<Map<string, string>> | undefined;

  constructor(
    private readonly dirs: readonly string[],
    private readonly fallback: Policy,
    private readonly fs: AgentFs,
    private readonly log: (line: string) => void,
  ) {}

  resolve(type: string): Promise<AgentPolicy> {
    let hit = this.byType.get(type);
    if (!hit) {
      hit = this.lookup(type);
      this.byType.set(type, hit);
    }
    return hit;
  }

  private async lookup(type: string): Promise<AgentPolicy> {
    for (const dir of this.dirs) {
      const path = join(dir, `${type}.md`);
      let found = false;
      try {
        found = await this.fs.exists(path);
      } catch (error) {
        this.log(`sub-agent-compact: checking ${path} failed: ${String(error)}`);
      }
      if (found) {
        const fields = await this.fields(path);
        if (fields && (!fields.name || fields.name === type)) return this.fromFields(type, path, fields);
      }
    }
    const byName = (await this.index()).get(type);
    if (byName) {
      const fields = await this.fields(byName);
      if (fields) return this.fromFields(type, byName, fields);
    }
    return { policy: this.fallback, source: 'default' };
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
        this.log(`sub-agent-compact: ${path} ${written(field)} for ${type} is invalid (${error}); using the default ${fallbackText}`),
    );
    return set ? { policy, source: path } : { policy: this.fallback, source: 'default' };
  }

  private async fields(path: string): Promise<Record<string, string> | undefined> {
    try {
      return parseFrontmatter(await this.fs.read(path));
    } catch (error) {
      this.log(`sub-agent-compact: reading ${path} failed: ${String(error)}`);
      return undefined;
    }
  }

  private index(): Promise<Map<string, string>> {
    this.nameIndex ??= (async () => {
      const names = new Map<string, string>();
      for (const dir of this.dirs) {
        let files: string[] = [];
        try {
          if (!(await this.fs.exists(dir))) continue;
          files = await this.fs.listMarkdown(dir);
        } catch (error) {
          this.log(`sub-agent-compact: listing ${dir} failed: ${String(error)}`);
          continue;
        }
        for (const file of files) {
          const path = join(dir, file);
          const name = (await this.fields(path))?.name;
          if (name && !names.has(name)) names.set(name, path);
        }
      }
      return names;
    })();
    return this.nameIndex;
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

  learn(id: string, type: string): void {
    if (id && type) this.announced.set(id, type);
  }

  async of(id: string, list: () => Promise<readonly { id: string; type: string }[]>): Promise<string | undefined> {
    const known = this.listed.get(id);
    if (known) return known;
    const agent = (await list()).find((info) => info.id === id);
    if (agent?.type) {
      this.listed.set(id, agent.type);
      return agent.type;
    }
    return this.announced.get(id) ?? agent?.type;
  }
}
