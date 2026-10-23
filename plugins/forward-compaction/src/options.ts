import { pluginLogDir } from './log.ts';

/** A context size: a token count, or a percentage of the model's own window. */
export type Size = { tokens: number } | { percent: number };

/** With no handoff stored, the context at which a mechanical wake is installed: 60% of the model's own window, never clamped to CLAUDE_CODE_AUTO_COMPACT_WINDOW. */
export const DEFAULT_CEILING: Size = { percent: 60 };
/** Mechanical wakes, not native summaries, at the ceiling. */
export const DEFAULT_CEILING_NATIVE = false;
/** Where the first nudge to hand off goes out, and the growth between nudges after it. */
export const DEFAULT_NUDGE_START: Size = { tokens: 50_000 };
export const DEFAULT_NUDGE_EVERY: Size = { tokens: 10_000 };

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

/** A size as a person writes it: "60%" or "150000". */
export function formatSize(size: Size): string {
  return 'tokens' in size ? String(size.tokens) : `${size.percent}%`;
}

/**
 * The environment variable of each option, `FORWARD_COMPACTION_` plus the option in upper snake case.
 * The hooks module spells each name as a literal of its own: Claude Code reads only literal names.
 */
export const OPTION_ENV = {
  ceiling: 'FORWARD_COMPACTION_CEILING',
  ceilingNative: 'FORWARD_COMPACTION_CEILING_NATIVE',
  nudgeStart: 'FORWARD_COMPACTION_NUDGE_START',
  nudgeEvery: 'FORWARD_COMPACTION_NUDGE_EVERY',
  logFile: 'FORWARD_COMPACTION_LOG_FILE',
} as const;

export type OptionName = keyof typeof OPTION_ENV;

/** Parses an environment on/off value: 1, 0, true or false in any case. */
export function parseEnvFlag(raw: string): Parse<boolean> {
  const word = raw.trim().toLowerCase();
  if (word === '1' || word === 'true') return { ok: true, value: true };
  if (word === '0' || word === 'false') return { ok: true, value: false };
  return { ok: false, error: `not 1, 0, true or false: ${JSON.stringify(raw)}` };
}

export type ResolvedOptions = {
  /** With no handoff stored, the size at which a mechanical wake is installed. */
  ceiling: Size;
  /** At the ceiling with no handoff, Claude Code's own summary runs instead of the mechanical wake. */
  ceilingNative: boolean;
  nudgeStart: Size;
  nudgeEvery: Size;
  logFile?: string;
  /** One line per option that was invalid and fell back; empty when all were valid. */
  errors: string[];
};

/** What the person set in the environment, read by the adapter: each variable's value by name, and the lines for any that could not be read. */
export type OptionEnvironment = {
  pluginLogDir?: string;
  home?: string;
  vars?: Readonly<Record<string, string | undefined>>;
  readErrors?: readonly string[];
};

/** A nudge start at or past the ceiling in the same unit: both are kept, the person is told. Across units only the window decides. */
function nudgeAfterCeiling(start: Size, ceiling: Size): string | undefined {
  const past = 'tokens' in start && 'tokens' in ceiling ? start.tokens >= ceiling.tokens : 'percent' in start && 'percent' in ceiling ? start.percent >= ceiling.percent : false;
  if (!past) return undefined;
  return `forward-compaction: env ${OPTION_ENV.nudgeStart} ${formatSize(start)} is not below ${OPTION_ENV.ceiling} ${formatSize(ceiling)}; no nudge goes out before the ceiling`;
}

/**
 * Resolves the options from the environment alone; a variable that is unset, empty or blank is absent, and every
 * invalid value falls back to the default and is named in `errors`.
 */
export function resolveOptions(env: OptionEnvironment = {}): ResolvedOptions {
  const errors: string[] = [...(env.readErrors ?? [])];
  // The variable of an option, or undefined when it is unset, empty or blank.
  const fromEnv = (option: OptionName): string | undefined => {
    const value = env.vars?.[OPTION_ENV[option]]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  const badEnv = (option: OptionName, error: string, fallbackText: string): void => {
    errors.push(`forward-compaction: env ${OPTION_ENV[option]} is invalid (${error}); using the default ${fallbackText}`);
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
  const ceiling = size('ceiling', DEFAULT_CEILING);
  const ceilingNative = flag('ceilingNative', DEFAULT_CEILING_NATIVE);
  const nudgeStart = size('nudgeStart', DEFAULT_NUDGE_START);
  const nudgeEvery = size('nudgeEvery', DEFAULT_NUDGE_EVERY);
  const late = nudgeAfterCeiling(nudgeStart, ceiling);
  if (late !== undefined) errors.push(late);
  // Unset or invalid → the default: the plugin's decisions folder under PLUGIN_LOG_DIR, else under HOME, else no decision log.
  const base = pluginLogDir(env.pluginLogDir, env.home, 'forward-compaction');
  const fallbackLog = base === undefined ? undefined : `${base}/decisions/.jsonl`;
  let logFile = fallbackLog;
  const envLog = fromEnv('logFile');
  if (envLog !== undefined) {
    if (envLog.startsWith('/')) logFile = envLog;
    else badEnv('logFile', `not an absolute path: ${JSON.stringify(envLog)}`, fallbackLog ?? '(no decision log)');
  }
  return { ceiling, ceilingNative, nudgeStart, nudgeEvery, ...(logFile ? { logFile } : {}), errors };
}
