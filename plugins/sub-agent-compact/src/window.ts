/**
 * What Claude Code keeps free below a window before it asks to compact: the
 * 13k auto-compact margin plus the 20k reserved for the summary's output.
 * The native ask point of a 1M window is therefore 967k, and of 200k, 167k.
 * Measured against the callmeter store: Claude Code asks a non-Haiku sub-agent
 * at 67k with `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` (p10 59.5k, p50 65.2k,
 * p90 67.0k, n=255), so this 33k holds there. It asks a Haiku loop near 51k
 * (p10 49.2k, p50 51.4k, n=102) and a main chat on a 1M window at 51-54k; the
 * plugin leaves a Haiku party to Claude Code and never holds its ask (`decide` `haiku`).
 */
export const ENGINE_COMPACT_BUFFER = 33_000;

import { sizeTokens, type Size } from './limits.ts';

/** The context at which Claude Code asks to compact a loop, given the window it compacts against. */
export function engineAskPoint(window: number): number {
  return Math.max(0, window - ENGINE_COMPACT_BUFFER);
}

/**
 * A party's forced point: its set size in tokens, clamped to Claude Code's ask
 * point for its window. A limit past the window would hold the ask Claude Code
 * makes there, and the next request would then be too long for the model.
 */
export function forcedPoint(size: Size, window: number): { limit: number; set: number; clamped: boolean } {
  const set = sizeTokens(size, window);
  const ask = engineAskPoint(window);
  return set > ask ? { limit: ask, set, clamped: true } : { limit: set, set, clamped: false };
}

export function isHaiku(model: string | undefined): boolean {
  return model !== undefined && /haiku/i.test(model);
}

/** The window Claude Code gives a model id it does not know, and enforces on its requests. */
export const ENGINE_DEFAULT_WINDOW = 200_000;

/** A Claude model: a Claude id in any provider's spelling, or a bare Claude Code alias. */
export function isClaude(model: string): boolean {
  return /claude/i.test(model) || /^(opus|sonnet|haiku|fable|default|best)(\[1m\])?$/i.test(model);
}

/**
 * A model's context window. The plugin API reports the main chat's window
 * only, so a sub-agent's comes from its model id: Haiku 4.5 and older 200k,
 * Haiku 5 and later, a `[1m]` id and Sonnet 5 1M (the windows Claude Code
 * 2.1.282 reported in `modelUsage`; Haiku 5.5's `window:1e6` in 2.1.300's model table).
 * A model that is not Claude, such as a GPT model behind a gateway, gets
 * Claude Code's 200k default: the client refuses a request past it as
 * "Prompt is too long", whatever the model upstream holds.
 * Any other Claude model gets `fallback`, the main chat's window.
 */
export function modelWindow(model: string | undefined, fallback: number): number {
  if (model === undefined) return fallback;
  if (/\[1m\]/i.test(model) || /^claude-sonnet-5/i.test(model) || /(^|\.)claude-haiku-([5-9]|\d\d)/i.test(model)) return 1_000_000;
  if (isHaiku(model)) return 200_000;
  if (!isClaude(model)) return ENGINE_DEFAULT_WINDOW;
  return fallback;
}
