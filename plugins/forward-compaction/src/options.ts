import { pluginLogDir } from './plugin-log.ts';

/** A context size: a token count, or a percentage of the party's max context. */
export type Size = { tokens: number } | { percent: number };

/** Each party's sizes: the ceiling (with no frontier stored, the context at which a mechanical wake is installed), where the first nudge goes out and the growth between nudges, each a token count or a percentage of the party's max context. */
export type PartySizes = { ceiling: Size; nudgeStart: Size; nudgeEvery: Size };
export const DEFAULT_MAIN: PartySizes = { ceiling: { percent: 60 }, nudgeStart: { percent: 15 }, nudgeEvery: { percent: 5 } };
/** The ceiling is a share of the sub-agent's max context (160k on 200k, 800k on 1m); the nudges are token counts, the same on every max context. */
export const DEFAULT_SUBAGENT: PartySizes = { ceiling: { percent: 80 }, nudgeStart: { tokens: 165_000 }, nudgeEvery: { tokens: 65_000 } };
/** The fallback: a sub-agent's max context while its model's window is not known. The smallest window the Models API lists, and the one Claude Code itself takes for a model it does not know: a ceiling reached early costs a mechanical wake, one set too high a request too long. Main's max context defaults to the window `$.session.usage()` reports. */
/** Main's finish start: the context from which main is told to compact at the end of its whole work, before the final report. A token count: what a compaction leaves behind does not grow with the max context. */
export const DEFAULT_MAIN_FINISH_START: Size = { tokens: 100_000 };
export const DEFAULT_SUBAGENT_MAX_CONTEXT = 200_000;
/** A sub-agent's max context when its model id carries the API's own `[1m]` context marker. */
export const MARKED_SUBAGENT_MAX_CONTEXT = 1_000_000;

/** Main's model as its last step named it, with the window Claude Code reports for main. */
export type MainWindow = { model?: string; window?: number };

/** Where a sub-agent's max context comes from: the set variable, its model id's `[1m]` marker, main's reported window, the Models API's `max_input_tokens`, or the fallback while none of them knows. */
export type WindowSource = 'option' | 'marker' | 'main' | 'models-api' | 'fallback';
/** A sub-agent's max context with its source; `unknown` says why its model's window is not known, whenever the fallback stands in for it. */
export type SubagentWindow = { maxContext: number; source: WindowSource; unknown?: string };

/**
 * A sub-agent's max context, the first of these that knows: the set variable, for every sub-agent; 1m for a model id
 * carrying `[1m]`; main's reported window for a sub-agent on main's own model id; the window the Models API states for
 * its model (`looked`, model-window.ts); else the fallback, with why the window is unknown.
 */
export function subagentWindow(set: number | undefined, model: string | undefined, main: MainWindow = {}, looked?: { window: number } | { unknown: string }): SubagentWindow {
  if (set !== undefined) return { maxContext: set, source: 'option' };
  if (model === undefined) return { maxContext: DEFAULT_SUBAGENT_MAX_CONTEXT, source: 'fallback', unknown: 'no step has named its model yet' };
  if (model.includes('[1m]')) return { maxContext: MARKED_SUBAGENT_MAX_CONTEXT, source: 'marker' };
  if (model === main.model && main.window !== undefined) return { maxContext: main.window, source: 'main' };
  if (looked !== undefined && 'window' in looked) return { maxContext: looked.window, source: 'models-api' };
  return { maxContext: DEFAULT_SUBAGENT_MAX_CONTEXT, source: 'fallback', unknown: looked?.unknown ?? 'its model was not looked up yet' };
}
/** Mechanical wakes, not native summaries, at the ceiling. */
export const DEFAULT_CEILING_NATIVE = false;
/** Models the plugin leaves to Claude Code's own compaction, matched as case-insensitive substrings of the model id a step reports. */
export const DEFAULT_IGNORE_MODELS: readonly string[] = ['haiku'];
/** Skills and commands pinned in every wake by name, as frontmatter's forward-compaction-keep pins one by its file: none. */
export const DEFAULT_KEEP_SKILLS: readonly string[] = [];
/** The debug log (`debug.jsonl`): a row at every step. */
export const DEFAULT_DEBUG = true;

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
  mainMaxContext: 'FORWARD_COMPACTION_MAIN_MAX_CONTEXT',
  mainCeiling: 'FORWARD_COMPACTION_MAIN_CEILING',
  mainNudgeStart: 'FORWARD_COMPACTION_MAIN_NUDGE_START',
  mainNudgeEvery: 'FORWARD_COMPACTION_MAIN_NUDGE_EVERY',
  mainFinishStart: 'FORWARD_COMPACTION_MAIN_FINISH_START',
  subagentMaxContext: 'FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT',
  subagentCeiling: 'FORWARD_COMPACTION_SUBAGENT_CEILING',
  subagentNudgeStart: 'FORWARD_COMPACTION_SUBAGENT_NUDGE_START',
  subagentNudgeEvery: 'FORWARD_COMPACTION_SUBAGENT_NUDGE_EVERY',
  ceilingNative: 'FORWARD_COMPACTION_CEILING_NATIVE',
  ignoreModels: 'FORWARD_COMPACTION_IGNORE_MODELS',
  keepSkills: 'FORWARD_COMPACTION_KEEP_SKILLS',
  debug: 'FORWARD_COMPACTION_DEBUG',
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
  /** Main's sizes, finish start and max context; no max context set means the window `$.session.usage()` reports. */
  main: PartySizes & { finishStart: Size; maxContext?: number };
  /** No max context set means each sub-agent's own, its model's (`subagentWindow`). */
  subagent: PartySizes & { maxContext?: number };
  /** At the ceiling with no frontier, Claude Code's own summary runs instead of the mechanical wake. */
  ceilingNative: boolean;
  /** The decision log's name template, `{plugin log dir}/decisions/.jsonl`: no option moves it. Unset when there is no plugin log directory. */
  logFile?: string;
  /** Lower-cased ignore-list entries; empty when the variable is set empty. */
  ignoreModels: string[];
  /** Skill and command names never dropped from a wake, as given, trimmed. */
  keepSkills: string[];
  debug: boolean;
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

/** A nudge start at or past the ceiling in the same unit: both are kept, the person is told. Across units only the max context decides. */
function nudgeAfterCeiling(party: 'main' | 'subagent', { nudgeStart: start, ceiling }: PartySizes): string | undefined {
  const past = 'tokens' in start && 'tokens' in ceiling ? start.tokens >= ceiling.tokens : 'percent' in start && 'percent' in ceiling ? start.percent >= ceiling.percent : false;
  if (!past) return undefined;
  return `forward-compaction: env ${OPTION_ENV[`${party}NudgeStart`]} ${formatSize(start)} is not below ${OPTION_ENV[`${party}Ceiling`]} ${formatSize(ceiling)}; no nudge goes out before the ceiling`;
}

/**
 * Resolves the options from the environment alone; a variable that is unset, empty or blank is absent (but an empty
 * ignore list, which ignores no model), and every
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
  // A max context is a token count: a percentage has no window to be of.
  const maxContext = (option: 'mainMaxContext' | 'subagentMaxContext', fallback: string): number | undefined => {
    const raw = fromEnv(option);
    if (raw === undefined) return undefined;
    const parsed = parseSize(raw);
    if (parsed.ok && 'tokens' in parsed.value) return parsed.value.tokens;
    badEnv(option, parsed.ok ? `a max context is a token count, not a percentage: ${JSON.stringify(raw)}` : parsed.error, fallback);
    return undefined;
  };
  const sizes = (party: 'main' | 'subagent', fallback: PartySizes): PartySizes => ({
    ceiling: size(`${party}Ceiling`, fallback.ceiling),
    nudgeStart: size(`${party}NudgeStart`, fallback.nudgeStart),
    nudgeEvery: size(`${party}NudgeEvery`, fallback.nudgeEvery),
  });
  const mainMax = maxContext('mainMaxContext', "main's window");
  const main = { ...sizes('main', DEFAULT_MAIN), finishStart: size('mainFinishStart', DEFAULT_MAIN_FINISH_START), ...(mainMax !== undefined ? { maxContext: mainMax } : {}) };
  const subagentMax = maxContext('subagentMaxContext', "each sub-agent's model's max context");
  const subagent = { ...sizes('subagent', DEFAULT_SUBAGENT), ...(subagentMax !== undefined ? { maxContext: subagentMax } : {}) };
  const ceilingNative = flag('ceilingNative', DEFAULT_CEILING_NATIVE);
  const debug = flag('debug', DEFAULT_DEBUG);
  // Unset is the default; set empty (or only commas) is a list of none: the one option whose empty value is a value.
  const rawIgnore = env.vars?.[OPTION_ENV.ignoreModels];
  const ignoreModels = rawIgnore === undefined ? [...DEFAULT_IGNORE_MODELS] : rawIgnore.split(',').map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== '');
  const keepSkills = (env.vars?.[OPTION_ENV.keepSkills] ?? DEFAULT_KEEP_SKILLS.join(',')).split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  for (const late of [nudgeAfterCeiling('main', main), nudgeAfterCeiling('subagent', subagent)]) if (late !== undefined) errors.push(late);
  // The decision log lives in the plugin's log directory (PLUGIN_LOG_DIR, else under HOME); with neither, there is none.
  const base = pluginLogDir(env.pluginLogDir, env.home, 'forward-compaction');
  const logFile = base === undefined ? undefined : `${base}/decisions/.jsonl`;
  return { main, subagent, ceilingNative, ...(logFile ? { logFile } : {}), ignoreModels, keepSkills, debug, errors };
}
