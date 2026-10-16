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

/** The settings sources a leftover `pluginConfigs` entry can sit in, as `$.settings.read({ source })` names them. */
export const SETTINGS_SOURCES = ['user', 'project', 'local', 'flag', 'policy'] as const;

/**
 * The option keys of every `pluginConfigs` entry for this plugin (`sub-agent-compact@{marketplace}`) in these
 * settings, each once in first-seen order: what an install before 0.8 left behind. Claude Code hands `register`
 * only the options a manifest declares, and this one declares none, so the settings are where such an entry shows.
 */
export function leftoverOptionKeys(settings: readonly Readonly<Record<string, unknown>>[]): string[] {
  const keys = new Set<string>();
  for (const source of settings) {
    const configs = source.pluginConfigs;
    if (typeof configs !== 'object' || configs === null || Array.isArray(configs)) continue;
    for (const [id, entry] of Object.entries(configs)) {
      if (id.split('@')[0] !== 'sub-agent-compact' || typeof entry !== 'object' || entry === null) continue;
      const options = (entry as { options?: unknown }).options;
      if (typeof options === 'object' && options !== null && !Array.isArray(options)) for (const key of Object.keys(options)) keys.add(key);
    }
  }
  return [...keys];
}

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

/** A directory list as the variable writes it: comma- or newline-separated, blank items dropped. */
function dirList(raw: string): string[] {
  return raw.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

/** A nudge start at or past the forced point in the same unit: both are kept, the person is told. Across units only the window decides. */
function nudgeAfterLimit(prefix: 'main' | 'subagent', policy: Policy): string | undefined {
  const start = policy.nudgeStart;
  const limit = policy.autoCompact;
  const past = 'tokens' in start && 'tokens' in limit ? start.tokens >= limit.tokens : 'percent' in start && 'percent' in limit ? start.percent >= limit.percent : false;
  if (!past) return undefined;
  const startName = OPTION_ENV[`${prefix}${POLICY_KEYS.nudgeStart}`];
  const limitName = OPTION_ENV[`${prefix}${POLICY_KEYS.autoCompact}`];
  return `sub-agent-compact: env ${startName} ${formatSize(start)} is not below ${limitName} ${formatSize(limit)}; the forced point comes first and no nudge goes out before it`;
}

/** What the person set in the environment, read by the adapter: each variable's value by name, and the lines for any that could not be read. */
export type OptionEnvironment = {
  pluginLogDir?: string;
  vars?: Readonly<Record<string, string | undefined>>;
  readErrors?: readonly string[];
};

/**
 * Resolves the options from the environment alone, a variable over the default; a variable
 * that is unset, empty or blank is absent, and every invalid value falls back to the default and is named in `errors`.
 */
export function resolveOptions(env: OptionEnvironment = {}): ResolvedOptions {
  const errors: string[] = [...(env.readErrors ?? [])];
  // The variable of an option, or undefined when it is unset, empty or blank.
  const fromEnv = (option: OptionName): string | undefined => {
    const value = env.vars?.[OPTION_ENV[option]]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  const badEnv = (option: OptionName, error: string, fallbackText: string): void => {
    errors.push(`sub-agent-compact: env ${OPTION_ENV[option]} is invalid (${error}); using the default ${fallbackText}`);
  };
  const size = (option: OptionName, fallback: Size): Size => {
    const raw = fromEnv(option);
    if (raw === undefined) return fallback;
    const parsed = parseSize(raw);
    if (parsed.ok) return parsed.value;
    badEnv(option, parsed.error, formatSize(fallback));
    return fallback;
  };
  const flag = (option: OptionName, fallback: boolean): boolean => {
    const raw = fromEnv(option);
    if (raw === undefined) return fallback;
    const parsed = parseEnvFlag(raw);
    if (parsed.ok) return parsed.value;
    badEnv(option, parsed.error, String(fallback));
    return fallback;
  };
  const party = (prefix: 'main' | 'subagent', fallback: Policy): Policy => {
    const autoCompact = size(`${prefix}${POLICY_KEYS.autoCompact}`, fallback.autoCompact);
    const nudgeStart = size(`${prefix}${POLICY_KEYS.nudgeStart}`, fallback.nudgeStart);
    const nudgeEvery = size(`${prefix}${POLICY_KEYS.nudgeEvery}`, fallback.nudgeEvery);
    return { enabled: flag(`${prefix}${POLICY_KEYS.enabled}`, fallback.enabled), autoCompact, nudgeStart, nudgeEvery };
  };
  const main = party('main', DEFAULT_MAIN);
  const subagent = party('subagent', DEFAULT_SUBAGENT);
  for (const [prefix, policy] of [['main', main], ['subagent', subagent]] as const) {
    const line = nudgeAfterLimit(prefix, policy);
    if (line) errors.push(line);
  }
  const keepBrief = flag('subagentKeepBrief', DEFAULT_KEEP_BRIEF);
  const compactTool = flag('compactTool', DEFAULT_COMPACT_TOOL);
  const handoffTool = flag('handoffTool', DEFAULT_HANDOFF_TOOL);
  const forwardHandoffTool = flag('forwardHandoffTool', DEFAULT_FORWARD_HANDOFF_TOOL);
  const envDirs = fromEnv('agentDirs');
  const agentDirs = envDirs === undefined ? [] : dirList(envDirs);
  // Unset or invalid → the default: the plugin's decisions folder under PLUGIN_LOG_DIR, else no decision log.
  const fallbackLog = env.pluginLogDir ? `${pluginLogDir(env.pluginLogDir, undefined, 'sub-agent-compact')}/decisions/.jsonl` : undefined;
  let logFile = fallbackLog;
  const envLog = fromEnv('logFile');
  if (envLog !== undefined) {
    if (envLog.startsWith('/')) logFile = envLog;
    else badEnv('logFile', `not an absolute path: ${JSON.stringify(envLog)}`, fallbackLog ?? '(no decision log)');
  }
  return { main, subagent, keepBrief, compactTool, handoffTool, forwardHandoffTool, agentDirs, ...(logFile ? { logFile } : {}), errors };
}
