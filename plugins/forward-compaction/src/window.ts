import { k } from './nudge.ts';
import { sizeTokens, type PartySizes, type Size } from './options.ts';

/** `$.session.usage({ breakdown: 'summary' })`'s breakdown, the fields the ask point is read from. */
export type UsageBreakdown = { autoCompactThreshold?: number; rawMaxTokens?: number; autocompactSource?: string };

/** Where the ask point came from, and what Claude Code left out when it is not its auto-compact threshold. */
export type AskPoint = { tokens: number; source: 'autoCompactThreshold' | 'rawMaxTokens' | 'window'; missing?: 'breakdown' | 'autoCompactThreshold' };

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * The context at which Claude Code asks to compact a loop: the breakdown's `autoCompactThreshold`. Absent (auto-compaction
 * off) or with no breakdown at all, the compaction window `rawMaxTokens`, else main's `context.window`; `missing` names what was absent.
 * Undefined while not even a window was reported.
 */
export function askPointOf(breakdown: UsageBreakdown | undefined, window: number | undefined): AskPoint | undefined {
  if (breakdown !== undefined && positive(breakdown.autoCompactThreshold)) return { tokens: breakdown.autoCompactThreshold, source: 'autoCompactThreshold' };
  const missing = breakdown === undefined ? 'breakdown' : 'autoCompactThreshold';
  if (breakdown !== undefined && positive(breakdown.rawMaxTokens)) return { tokens: breakdown.rawMaxTokens, source: 'rawMaxTokens', missing };
  return positive(window) ? { tokens: window, source: 'window', missing } : undefined;
}

/** The ignore-list entry a model id matches, case-insensitive substring; undefined when none does or the model is not known. */
export function ignoredBy(model: string | undefined, list: readonly string[]): string | undefined {
  if (model === undefined) return undefined;
  const id = model.toLowerCase();
  return list.find((entry) => entry !== '' && id.includes(entry.toLowerCase()));
}

/**
 * The context at which a party with no handoff stored is compacted mechanically: the size against the party's max context.
 * A party past it is still asked to compact before every request, so the ceiling is where the plugin gives up waiting for a handoff.
 */
export function ceilingTokens(size: Size, maxContext: number): number {
  return sizeTokens(size, maxContext);
}

/** A party's token marks: its max context, Claude Code's ask point (held at or below the max context), the ceiling, the nudge start and step. */
export type Marks = { maxContext: number; askPoint: number; ceiling: number; start: number; every: number };

/** The marks of a party with these sizes against its max context; undefined while that is not known (main's, before Claude Code reports its window). */
export function partyMarks(sizes: PartySizes, maxContext: number | undefined, apiAsk: number | undefined): Marks | undefined {
  if (maxContext === undefined) return undefined;
  return { maxContext, askPoint: Math.min(apiAsk ?? maxContext, maxContext), ceiling: ceilingTokens(sizes.ceiling, maxContext), start: sizeTokens(sizes.nudgeStart, maxContext), every: sizeTokens(sizes.nudgeEvery, maxContext) };
}

/** A live window as `$.session.messages({ as: 'api' })` answers it: each message's content blocks. */
export type ApiWindow = readonly { role?: string; content: readonly { type: string; [field: string]: unknown }[] }[];

/** One block's characters: its text and thinking, a tool_use's input as JSON, a tool_result's content text; media counts none (its tokens are no characters). */
function blockChars(block: { type: string; [field: string]: unknown }): number {
  const str = (value: unknown): number => (typeof value === 'string' ? value.length : 0);
  if (block.type === 'tool_use') return JSON.stringify(block.input ?? {}).length;
  if (block.type === 'tool_result') return typeof block.content === 'string' ? block.content.length : Array.isArray(block.content) ? block.content.reduce((n: number, inner) => n + (inner !== null && typeof inner === 'object' ? blockChars(inner) : 0), 0) : 0;
  return str(block.text) + str(block.thinking);
}

/** A live window's characters: every block's text, thinking, tool inputs and tool results, the text whose tokens the reading counts. */
export function apiChars(window: ApiWindow): number {
  return window.reduce((n, message) => n + message.content.reduce((m, block) => m + blockChars(block), 0), 0);
}

/** A party's ratio base: its live window's characters (`apiChars`) and its reading at its first reading in its live window (first ever, or first after a compaction). */
export type RatioBase = { chars: number; tokens: number };

/** The token growth past the base a ratio is measured over, a design budget: below it one tool result's tokenization dominates the ratio. */
export const RATIO_MIN_GROWTH = 5_000;
/** The characters per token a measured ratio must fall in, a design budget: text tokenizes inside it, so a ratio outside is a stale base or a cut transcript, never text. */
export const RATIO_RANGE = { min: 1, max: 8 } as const;

/** Why a party's ratio is unmeasured; `delta` is the growth ratio that fell outside RATIO_RANGE. */
export type Unmeasured = { ratio?: undefined; why: 'no-base' | 'no-reading' | 'no-chars' | 'below-min-growth' | 'out-of-range'; delta?: number };

/**
 * A party's measured characters per token, on its growth since its base: `(chars - base.chars) / (reading - base.tokens)`,
 * so the system prompt, tools and skills in every reading, never in the transcript, cancel. Unmeasured with no base, no
 * reading, no characters, growth under RATIO_MIN_GROWTH or a ratio outside RATIO_RANGE: then nothing is converted.
 */
export function charsPerToken(base: RatioBase | undefined, chars: number | undefined, reading: number | undefined): { ratio: number } | Unmeasured {
  if (base === undefined) return { why: 'no-base' };
  if (reading === undefined) return { why: 'no-reading' };
  if (chars === undefined) return { why: 'no-chars' };
  if (reading - base.tokens < RATIO_MIN_GROWTH) return { why: 'below-min-growth' };
  const delta = (chars - base.chars) / (reading - base.tokens);
  return delta >= RATIO_RANGE.min && delta <= RATIO_RANGE.max ? { ratio: delta } : { why: 'out-of-range', delta };
}

/** The share of a party's max context its carried load files may take, a design budget the owner reads, never a measured size: a twentieth leaves the wake budget to the facts and the kept messages. */
export const LOAD_FILES_SHARE = 0.05;

/** The characters of load-file content a party's wake carries, at its measured ratio; unbounded with no ratio. */
export function loadFilesRoom(maxContext: number, ratio: number | undefined): number {
  return ratio === undefined ? Number.POSITIVE_INFINITY : Math.floor(maxContext * LOAD_FILES_SHARE * ratio);
}

/**
 * The `CLAUDE_CODE_AUTO_COMPACT_WINDOW` the README asks for: Claude Code then asks about every request from about 63k, early
 * enough for a stored handoff to install (CLAUDE.md, Spine). A recommendation named to the owner, never a measured size.
 */
export const RECOMMENDED_COMPACT_WINDOW = 100_000;

export type StartWarning = { key: string; line: string; row: Record<string, unknown> };

/**
 * What session.start names once, from Claude Code's own numbers: a compaction window (`rawMaxTokens`) past
 * RECOMMENDED_COMPACT_WINDOW, which holds every handoff back to Claude Code's late ask, and a party whose ceiling is below
 * its ask point. Nothing it cannot read is named.
 */
export function startWarnings(breakdown: UsageBreakdown | undefined, apiAsk: AskPoint | undefined, main: Marks | undefined, subagent: Marks): StartWarning[] {
  const out: StartWarning[] = [];
  const raw = breakdown?.rawMaxTokens;
  if (raw !== undefined && raw > RECOMMENDED_COMPACT_WINDOW && apiAsk !== undefined) {
    const source = breakdown?.autocompactSource ?? 'unknown';
    out.push({
      key: 'compact-window',
      line: `forward-compaction: Claude Code compacts against a ${k(raw)} window (${source}) and asks to compact from about ${k(apiAsk.tokens)}, so a handoff installs no earlier. Set CLAUDE_CODE_AUTO_COMPACT_WINDOW to ${RECOMMENDED_COMPACT_WINDOW} in your settings env.`,
      row: { event: 'warning', key: 'compact-window', rawMaxTokens: raw, autocompactSource: source, askPoint: apiAsk.tokens },
    });
  }
  for (const [kind, key, m] of [['main', 'ceiling-below-ask', main], ['sub-agent', 'ceiling-below-ask:subagent', subagent]] as const) {
    if (m === undefined || m.ceiling >= m.askPoint) continue;
    out.push({
      key,
      line: `forward-compaction: the ${kind} ceiling ${k(m.ceiling)} is below Claude Code's ask point ${k(m.askPoint)}; a ${kind} with no handoff is compacted mechanically at its first ask.`,
      row: { event: 'warning', key, ceiling: m.ceiling, askPoint: m.askPoint },
    });
  }
  return out;
}
