import { pluginLogDir } from './log.ts';

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

/** The `compact` tool, whose request a summarizer turns into a summary: on. */
export const DEFAULT_COMPACT_TOOL = true;

/** The `handoff` tool, whose text the plugin installs as the conversation's whole past: off. */
export const DEFAULT_HANDOFF_TOOL = false;

/** The `forward_handoff` tool, whose wake text code mostly carries and the model only closes with its frontier: off. */
export const DEFAULT_FORWARD_HANDOFF_TOOL = false;

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

/**
 * The environment variable of each option, `SUB_AGENT_COMPACT_` plus the option in upper snake case.
 * The hooks module spells each name as a literal of its own: Claude Code reads only literal names.
 */
export const OPTION_ENV = {
  mainAutoCompact: 'SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT',
  mainAutoCompactNudgeStart: 'SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_NUDGE_START',
  mainAutoCompactNudgeEvery: 'SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_NUDGE_EVERY',
  mainAutoCompactEnabled: 'SUB_AGENT_COMPACT_MAIN_AUTO_COMPACT_ENABLED',
  subagentAutoCompact: 'SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT',
  subagentAutoCompactNudgeStart: 'SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_NUDGE_START',
  subagentAutoCompactNudgeEvery: 'SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_NUDGE_EVERY',
  subagentAutoCompactEnabled: 'SUB_AGENT_COMPACT_SUBAGENT_AUTO_COMPACT_ENABLED',
  subagentKeepBrief: 'SUB_AGENT_COMPACT_SUBAGENT_KEEP_BRIEF',
  handoffTool: 'SUB_AGENT_COMPACT_HANDOFF_TOOL',
  forwardHandoffTool: 'SUB_AGENT_COMPACT_FORWARD_HANDOFF_TOOL',
  compactTool: 'SUB_AGENT_COMPACT_COMPACT_TOOL',
  agentDirs: 'SUB_AGENT_COMPACT_AGENT_DIRS',
  logFile: 'SUB_AGENT_COMPACT_LOG_FILE',
} as const;

export type OptionName = keyof typeof OPTION_ENV;

/** Parses an environment on/off value: 1, 0, true or false in any case. */
export function parseEnvFlag(raw: string): Parse<boolean> {
  const word = raw.trim().toLowerCase();
  if (word === '1' || word === 'true') return { ok: true, value: true };
  if (word === '0' || word === 'false') return { ok: true, value: false };
  return { ok: false, error: `not 1, 0, true or false: ${JSON.stringify(raw)}` };
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
  /** Register the `forward_handoff` tool. */
  forwardHandoffTool: boolean;
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

/** What the person set in the environment, read by the adapter: each variable's value by name, and the lines for any that could not be read. */
export type OptionEnvironment = {
  pluginLogDir?: string;
  vars?: Readonly<Record<string, string | undefined>>;
  readErrors?: readonly string[];
};

/**
 * Validates the plugin options, a variable of the environment over an option over the default;
 * every invalid value falls back to the default and is named in `errors`.
 */
export function resolveOptions(options: Record<string, unknown>, env: OptionEnvironment = {}): ResolvedOptions {
  const errors: string[] = [...(env.readErrors ?? [])];
  // The variable of an option, or undefined when it is unset, empty or blank: the option layer then decides.
  const fromEnv = (option: OptionName): string | undefined => {
    const value = env.vars?.[OPTION_ENV[option]]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  const badEnv = (option: OptionName, error: string, fallbackText: string): void => {
    errors.push(`sub-agent-compact: env ${OPTION_ENV[option]} is invalid (${error}); using the default ${fallbackText}`);
  };
  const party = (prefix: 'main' | 'subagent', fallback: Policy): Policy => {
    const policy = readPolicy(
      (field) => options[prefix + POLICY_KEYS[field]],
      fallback,
      (field, error, fallbackText) => errors.push(`sub-agent-compact: option ${prefix}${POLICY_KEYS[field]} is invalid (${error}); using the default ${fallbackText}`),
    ).policy;
    for (const field of ['autoCompact', 'nudgeStart', 'nudgeEvery'] as const) {
      const option = (prefix + POLICY_KEYS[field]) as OptionName;
      const raw = fromEnv(option);
      if (raw === undefined) continue;
      const parsed = parseSize(raw);
      if (parsed.ok) policy[field] = parsed.value;
      else {
        policy[field] = fallback[field];
        badEnv(option, parsed.error, formatSize(fallback[field]));
      }
    }
    const option = (prefix + POLICY_KEYS.enabled) as OptionName;
    const raw = fromEnv(option);
    if (raw !== undefined) {
      const parsed = parseEnvFlag(raw);
      if (parsed.ok) policy.enabled = parsed.value;
      else {
        policy.enabled = fallback.enabled;
        badEnv(option, parsed.error, String(fallback.enabled));
      }
    }
    return policy;
  };
  const main = party('main', DEFAULT_MAIN);
  const subagent = party('subagent', DEFAULT_SUBAGENT);
  const flag = (name: OptionName, fallback: boolean): boolean => {
    let value = fallback;
    const raw = options[name];
    if (raw !== undefined && raw !== '') {
      const parsed = parseEnabled(raw);
      if (parsed.ok) value = parsed.value;
      else errors.push(`sub-agent-compact: option ${name} is invalid (${parsed.error}); using the default ${fallback}`);
    }
    const envRaw = fromEnv(name);
    if (envRaw === undefined) return value;
    const parsed = parseEnvFlag(envRaw);
    if (parsed.ok) return parsed.value;
    badEnv(name, parsed.error, String(fallback));
    return fallback;
  };
  const keepBrief = flag('subagentKeepBrief', DEFAULT_KEEP_BRIEF);
  const compactTool = flag('compactTool', DEFAULT_COMPACT_TOOL);
  const handoffTool = flag('handoffTool', DEFAULT_HANDOFF_TOOL);
  const forwardHandoffTool = flag('forwardHandoffTool', DEFAULT_FORWARD_HANDOFF_TOOL);
  const optionDirs = dirList(options.agentDirs, errors);
  const envDirs = fromEnv('agentDirs');
  const agentDirs = envDirs === undefined ? optionDirs : dirList(envDirs, errors);
  const rawLog = options.logFile;
  const optionBlank = rawLog === undefined || (typeof rawLog === 'string' && rawLog.trim() === '');
  const defaultLog = env.pluginLogDir ? `${pluginLogDir(env.pluginLogDir, undefined, 'sub-agent-compact')}/decisions/.jsonl` : undefined;
  let logFile: string | undefined;
  if (typeof rawLog === 'string' && !optionBlank) {
    if (rawLog.trim().startsWith('/')) logFile = rawLog.trim();
    else errors.push(`sub-agent-compact: option logFile must be an absolute path (got ${JSON.stringify(rawLog)}); logging off`);
  } else if (optionBlank) logFile = defaultLog;
  const envLog = fromEnv('logFile');
  if (envLog !== undefined) {
    if (envLog.startsWith('/')) logFile = envLog;
    else {
      badEnv('logFile', `not an absolute path: ${JSON.stringify(envLog)}`, 'empty (the decision log follows PLUGIN_LOG_DIR when set, otherwise it is off)');
      logFile = defaultLog;
    }
  }
  return { main, subagent, keepBrief, compactTool, handoffTool, forwardHandoffTool, agentDirs, ...(logFile ? { logFile } : {}), errors };
}
