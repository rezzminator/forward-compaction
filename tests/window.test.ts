import { describe, expect, it } from 'vitest';
import { ceilingTokens, ENGINE_COMPACT_BUFFER, ENGINE_DEFAULT_WINDOW, engineAskPoint, isClaude, modelWindow, partyWindow } from '../plugins/forward-compaction/src/window.ts';

describe('engineAskPoint', () => {
  it('is the window less the engine buffer (R2)', () => {
    expect(ENGINE_COMPACT_BUFFER).toBe(33_000);
    expect(engineAskPoint(100_000)).toBe(67_000);
    expect(engineAskPoint(200_000)).toBe(167_000);
    expect(engineAskPoint(20_000)).toBe(0);
  });
});

describe('modelWindow', () => {
  it('knows Haiku 4.5 at 200k, a [1m] id, Sonnet 5 and Haiku 5 at 1M', () => {
    expect(modelWindow('claude-haiku-4-5-20251001', 1_000_000)).toBe(200_000);
    expect(modelWindow('claude-haiku-5-5', 200_000)).toBe(1_000_000);
    expect(modelWindow('us.anthropic.claude-haiku-5-5', 200_000)).toBe(1_000_000);
    expect(modelWindow('claude-opus-5-5[1m]', 200_000)).toBe(1_000_000);
    expect(modelWindow('claude-sonnet-5', 200_000)).toBe(1_000_000);
  });

  it('falls back to the given window for a Claude model it does not know, or none', () => {
    expect(modelWindow('claude-opus-5-5', 400_000)).toBe(400_000);
    expect(modelWindow('opus', 400_000)).toBe(400_000);
    expect(modelWindow(undefined, 400_000)).toBe(400_000);
  });

  it("gives a model that is not Claude Claude Code's default 200k", () => {
    expect(ENGINE_DEFAULT_WINDOW).toBe(200_000);
    expect(modelWindow('gpt-6-sol', 1_000_000)).toBe(200_000);
    expect(isClaude('gpt-6-sol')).toBe(false);
    expect(isClaude('sonnet[1m]')).toBe(true);
  });
});

describe('partyWindow (D7)', () => {
  it('is the model window held at or below the window Claude Code compacts against (R2)', () => {
    expect(partyWindow(1_000_000, 100_000)).toBe(100_000);
    expect(partyWindow(200_000, 100_000)).toBe(100_000);
    expect(partyWindow(200_000, undefined)).toBe(200_000);
    expect(partyWindow(200_000, 300_000)).toBe(200_000);
  });
});

describe('ceilingTokens (D7 flipped, Addendum A3)', () => {
  it('is the size against the model window, never clamped to the party window', () => {
    expect(ceilingTokens({ percent: 60 }, 200_000)).toBe(120_000);
    expect(ceilingTokens({ percent: 60 }, 1_000_000)).toBe(600_000);
    expect(ceilingTokens({ tokens: 40_000 }, 200_000)).toBe(40_000);
    expect(ceilingTokens({ tokens: 150_000 }, 1_000_000)).toBe(150_000);
  });

  it('ignores a compact window passed as a third argument', () => {
    expect((ceilingTokens as (...args: unknown[]) => number)({ percent: 60 }, 1_000_000, 100_000)).toBe(600_000);
  });
});
