/** A context size: a token count, or a percentage of the model's own window. */
export type Size = { tokens: number } | { percent: number };

/** How one party compacts: the forced point, the nudges before it, and whether automatic compaction runs at all. */
export type Policy = {
  enabled: boolean;
  /** The forced point: an automatic compaction passes here even when the model never asked. */
  autoCompact: Size;
  /** Where the first nudge to compact goes out. */
  nudgeStart: Size;
  /** The step between nudges past the start. */
  nudgeEvery: Size;
};

/** Built-in defaults: the main chat nudged from 20% every 10%, forced at 60%; a sub-agent from 20% every 10%, forced at 60%. */
export const DEFAULT_MAIN: Policy = { enabled: true, autoCompact: { percent: 60 }, nudgeStart: { percent: 20 }, nudgeEvery: { percent: 10 } };
export const DEFAULT_SUBAGENT: Policy = { enabled: true, autoCompact: { percent: 60 }, nudgeStart: { percent: 20 }, nudgeEvery: { percent: 10 } };

/** A sub-agent's brief is seated back after the summary at every compaction. */
export const DEFAULT_KEEP_BRIEF = true;

/** The `compact` tool, whose request a summarizer turns into a summary: off, so models hand off instead. */
export const DEFAULT_COMPACT_TOOL = false;

/** The `handoff` tool, whose text the plugin installs as the conversation's whole past: on. */
export const DEFAULT_HANDOFF_TOOL = true;

export type Parse<T> = { ok: true; value: T } | { ok: false; error: string };

const SIZE = /^(\d+(?:\.\d+)?|\.\d+)\s*([km%])?$/i;

/**
 * Parses a size: a positive integer, a number with a k/m suffix ("150k",
 * "0.6m"), or a percentage of the window above 0 and at most 100 ("10%").
 * Anything else is an error naming the value.
 */
export function parseSize(raw: unknown): Parse<Size> {
  if (typeof raw === 'number') {
    if (Number.isFinite(raw) && raw > 0) return { ok: true, value: { tokens: Math.round(raw) } };
    return { ok: false, error: `not a positive number: ${raw}` };
  }
  if (typeof raw !== 'string') return { ok: false, error: `not a number or string: ${JSON.stringify(raw)}` };
  const match = SIZE.exec(raw.trim().replace(/_/g, ''));
  if (!match) return { ok: false, error: `not an integer, a k/m value or a percentage: ${JSON.stringify(raw)}` };
  const number = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (unit === '%') {
    if (number > 0 && number <= 100) return { ok: true, value: { percent: number } };
    return { ok: false, error: `a percentage must be above 0 and at most 100: ${JSON.stringify(raw)}` };
  }
  const value = Math.round(number * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1));
  if (!(value > 0)) return { ok: false, error: `not positive: ${JSON.stringify(raw)}` };
  return { ok: true, value: { tokens: value } };
}

/** A size in tokens against a window. */
export function sizeTokens(size: Size, window: number): number {
  return 'tokens' in size ? size.tokens : Math.round((window * size.percent) / 100);
}

/** A size as a person writes it: "30%" or "150000". */
export function formatSize(size: Size): string {
  return 'tokens' in size ? String(size.tokens) : `${size.percent}%`;
}

/** Parses an on/off value: a boolean, or true/false, on/off, yes/no in any case. */
export function parseEnabled(raw: unknown): Parse<boolean> {
  if (typeof raw === 'boolean') return { ok: true, value: raw };
  if (typeof raw === 'string') {
    const word = raw.trim().toLowerCase();
    if (['true', 'on', 'yes'].includes(word)) return { ok: true, value: true };
    if (['false', 'off', 'no'].includes(word)) return { ok: true, value: false };
  }
  return { ok: false, error: `not true/false, on/off or yes/no: ${JSON.stringify(raw)}` };
}

/** The four keys of a policy, as the suffix after a party prefix (`mainAutoCompactNudgeStart`) or alone in frontmatter. */
export const POLICY_KEYS = { autoCompact: 'AutoCompact', nudgeStart: 'AutoCompactNudgeStart', nudgeEvery: 'AutoCompactNudgeEvery', enabled: 'AutoCompactEnabled' } as const;

/** The frontmatter spelling of a policy key, nested under `autoCompact`: `autoCompact.nudgeFrom`. */
export const FRONTMATTER_KEYS = { autoCompact: 'autoCompact.forceAt', nudgeStart: 'autoCompact.nudgeFrom', nudgeEvery: 'autoCompact.nudgeEvery', enabled: 'autoCompact.enabled' } as const;

export function frontmatterKey(field: keyof Policy): string {
  return FRONTMATTER_KEYS[field];
}

/**
 * Reads a policy from `get(field)`, field by field over `fallback`: a value
 * left out keeps the fallback's, a bad one keeps it and reports through
 * `invalid(field, error, fallbackText)`. `set` is true when any value was read.
 */
export function readPolicy(
  get: (field: keyof Policy) => unknown,
  fallback: Policy,
  invalid: (field: keyof Policy, error: string, fallbackText: string) => void,
): { policy: Policy; set: boolean } {
  const policy: Policy = { ...fallback };
  let set = false;
  for (const field of ['autoCompact', 'nudgeStart', 'nudgeEvery'] as const) {
    const raw = get(field);
    if (raw === undefined || raw === '') continue;
    const parsed = parseSize(raw);
    if (parsed.ok) {
      policy[field] = parsed.value;
      set = true;
    } else invalid(field, parsed.error, formatSize(fallback[field]));
  }
  const raw = get('enabled');
  if (raw !== undefined && raw !== '') {
    const parsed = parseEnabled(raw);
    if (parsed.ok) {
      policy.enabled = parsed.value;
      set = true;
    } else invalid('enabled', parsed.error, String(fallback.enabled));
  }
  return { policy, set };
}

export type ResolvedOptions = {
  main: Policy;
  subagent: Policy;
  /** Seat a sub-agent's brief back after the summary at each of its compactions. */
  keepBrief: boolean;
  /** Register the `compact` tool and read `<compact-now>` markers. */
  compactTool: boolean;
  /** Register the `handoff` tool and read `<handoff>` markers. */
  handoffTool: boolean;
  agentDirs: string[];
  logFile?: string;
  /** One line per option that was invalid and fell back; empty when all were valid. */
  errors: string[];
};

function dirList(raw: unknown, errors: string[]): string[] {
  if (raw === undefined || raw === '') return [];
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\n]/) : null;
  if (!items) {
    errors.push(`sub-agent-compact: option agentDirs is invalid (not a string or list: ${JSON.stringify(raw)}); ignoring it`);
    return [];
  }
  return items.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

/** Validates the plugin options; every invalid value falls back and is named in `errors`. */
export function resolveOptions(options: Record<string, unknown>): ResolvedOptions {
  const errors: string[] = [];
  const party = (prefix: 'main' | 'subagent', fallback: Policy): Policy =>
    readPolicy(
      (field) => options[prefix + POLICY_KEYS[field]],
      fallback,
      (field, error, fallbackText) => errors.push(`sub-agent-compact: option ${prefix}${POLICY_KEYS[field]} is invalid (${error}); using the default ${fallbackText}`),
    ).policy;
  const main = party('main', DEFAULT_MAIN);
  const subagent = party('subagent', DEFAULT_SUBAGENT);
  const flag = (name: string, fallback: boolean): boolean => {
    const raw = options[name];
    if (raw === undefined || raw === '') return fallback;
    const parsed = parseEnabled(raw);
    if (parsed.ok) return parsed.value;
    errors.push(`sub-agent-compact: option ${name} is invalid (${parsed.error}); using the default ${fallback}`);
    return fallback;
  };
  const keepBrief = flag('subagentKeepBrief', DEFAULT_KEEP_BRIEF);
  const compactTool = flag('compactTool', DEFAULT_COMPACT_TOOL);
  const handoffTool = flag('handoffTool', DEFAULT_HANDOFF_TOOL);
  const agentDirs = dirList(options.agentDirs, errors);
  let logFile: string | undefined;
  const rawLog = options.logFile;
  if (typeof rawLog === 'string' && rawLog.trim() !== '') {
    if (rawLog.trim().startsWith('/')) logFile = rawLog.trim();
    else errors.push(`sub-agent-compact: option logFile must be an absolute path (got ${JSON.stringify(rawLog)}); logging off`);
  }
  return { main, subagent, keepBrief, compactTool, handoffTool, agentDirs, ...(logFile ? { logFile } : {}), errors };
}
