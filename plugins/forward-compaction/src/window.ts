import { sizeTokens, type Size } from './options.ts';

/**
 * What Claude Code keeps free below a window before it asks to compact: the
 * 13k auto-compact margin plus the 20k reserved for the summary's output.
 * With the 4k the live probe adds (below), the native ask point of a 1M window is 963k, and of 200k, 163k.
 * Measured against the callmeter store: Claude Code asks a non-Haiku sub-agent
 * at 67k with `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` (p10 59.5k, p50 65.2k,
 * p90 67.0k, n=255); the live 2.1.309 probe's first automatic ask came at
 * 63,827 on that window, so 37k, the earlier of the two, is held. It asks a Haiku loop near 51k
 * and a main chat on a 1M window at 51-54k: those parties are asked earlier than this point says.
 */
export const ENGINE_COMPACT_BUFFER = 37_000;

/** The context at which Claude Code asks to compact a loop, given the window it compacts against. */
export function engineAskPoint(window: number): number {
  return Math.max(0, window - ENGINE_COMPACT_BUFFER);
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
  if (/haiku/i.test(model)) return 200_000;
  if (!isClaude(model)) return ENGINE_DEFAULT_WINDOW;
  return fallback;
}

/**
 * The window a party is compacted against: the model's, held at or below `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
 * (`compactWindow`) when that is set, the window Claude Code compacts against (D7).
 */
export function partyWindow(modelWin: number, compactWindow?: number): number {
  return compactWindow === undefined ? modelWin : Math.min(compactWindow, modelWin);
}

/**
 * The context at which a party with no handoff stored is compacted mechanically: the size against the model's
 * window, not held to the window Claude Code compacts against (D7 flipped, Addendum A3). A party past that window
 * is still asked to compact before every request, so the ceiling is where the plugin gives up waiting for a handoff.
 */
export function ceilingTokens(size: Size, modelWin: number): number {
  return sizeTokens(size, modelWin);
}
