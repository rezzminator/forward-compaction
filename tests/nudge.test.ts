import { describe, expect, it } from 'vitest';
import { k, nudgeLevel, nudgeText } from '../plugins/forward-compaction/src/nudge.ts';

describe('nudgeLevel (R29)', () => {
  it('is 0 below the start, 1 at it, and one more per step of growth', () => {
    expect(nudgeLevel(0, 50_000, 10_000)).toBe(0);
    expect(nudgeLevel(49_000, 50_000, 10_000)).toBe(0);
    expect(nudgeLevel(50_000, 50_000, 10_000)).toBe(1);
    expect(nudgeLevel(59_999, 50_000, 10_000)).toBe(1);
    expect(nudgeLevel(60_000, 50_000, 10_000)).toBe(2);
    expect(nudgeLevel(71_000, 50_000, 10_000)).toBe(3);
  });

  it('never divides by a step below 1', () => {
    expect(nudgeLevel(50_005, 50_000, 0)).toBe(6);
  });
});

describe('nudgeText (R29)', () => {
  it('asks to compact once the current step is done, never in the middle of one, with the exact text', () => {
    expect(nudgeText({ tokens: 55_400, window: 200_000, ceiling: 120_000 })).toBe(
      'forward-compaction: context 55k (28% of 200k). Once your current step is done — never in the middle of one — call mcp__forward-compaction__forward_compaction with objective, decisions, done, remaining and next; skip it if only your final answer is left. At 120k you are compacted mechanically. No such tool? Carry on.',
    );
  });

  it('never says "now" or "soon", whatever the reading', () => {
    for (const tokens of [30_000, 67_000, 90_000, 119_000]) {
      const text = nudgeText({ tokens, window: 200_000, ceiling: 120_000 });
      expect(text).not.toMatch(/\bnow\b|\bsoon\b|asking to compact/);
      expect(text).toContain(`context ${Math.round(tokens / 1000)}k (${Math.round((tokens / 200_000) * 100)}% of 200k)`);
    }
  });
});

describe('nudgeText names the tool as registered', () => {
  it('uses the registered name, so a -dev copy is called by its own name', () => {
    const dev = 'mcp__forward-compaction-dev__forward_compaction';
    expect(nudgeText({ tokens: 55_400, window: 1_000_000, ceiling: 600_000, tool: dev })).toContain(`call ${dev} with objective, decisions, done, remaining and next`);
  });
});

describe('k', () => {
  it('prints thousands as k and a million or more as M with at most one decimal', () => {
    expect([0, 999, 51_400, 999_499].map(k)).toEqual(['0k', '1k', '51k', '999k']);
    expect([999_500, 1_000_000, 1_049_999, 1_500_000, 2_000_000].map(k)).toEqual(['1M', '1M', '1M', '1.5M', '2M']);
  });

  it('names a 1M window "1M" in the nudge, never "1000k"', () => {
    expect(nudgeText({ tokens: 213_000, window: 1_000_000, ceiling: 600_000 })).toContain('(21% of 1M)');
  });
});

describe('the nudge stays short', () => {
  it('make no promise about what a compaction keeps, and never say "lost"', () => {
    for (const text of [nudgeText({ tokens: 85_000, window: 200_000, ceiling: 160_000 })]) {
      expect(text).not.toMatch(/costs you nothing|every message after it|lost/);
      expect(text.length).toBeLessThan(400);
    }
  });
});
