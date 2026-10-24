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
  it('asks for a handoff at the next clean milestone, leaving the model the moment and not the choice, with the exact text', () => {
    expect(nudgeText({ tokens: 55_400, window: 200_000, ceiling: 120_000 })).toBe(
      'forward-compaction: your context is 55k tokens (28% of your 200k max context), and every call re-sends all of it. Hand off at your next clean milestone: once the step in hand is finished and its results are written down, and before you start the next step, call mcp__forward-compaction__forward_compaction with objective, done, remaining and next. You pick the milestone, not whether: skip it only if nothing is left but writing your result and your final answer. At 120k the plugin compacts you mechanically, with no frontier from you. If this tool is not in your tool list, carry on.',
    );
  });

  it('never says "now" or "soon", whatever the reading', () => {
    for (const tokens of [30_000, 67_000, 90_000, 119_000]) {
      const text = nudgeText({ tokens, window: 200_000, ceiling: 120_000 });
      expect(text).not.toMatch(/\bnow\b|\bsoon\b|asking to compact/);
      expect(text).toContain(`your context is ${Math.round(tokens / 1000)}k tokens (${Math.round((tokens / 200_000) * 100)}% of your 200k max context)`);
    }
  });
});

describe('nudgeText names the tool as registered', () => {
  it('uses the registered name, so a -dev copy is called by its own name', () => {
    const dev = 'mcp__forward-compaction-dev__forward_compaction';
    expect(nudgeText({ tokens: 55_400, window: 1_000_000, ceiling: 600_000, tool: dev })).toContain(`call ${dev} with objective, done, remaining and next`);
  });
});

describe('k', () => {
  it('prints thousands as k and a million or more as M with at most one decimal', () => {
    expect([0, 999, 51_400, 999_499].map(k)).toEqual(['0k', '1k', '51k', '999k']);
    expect([999_500, 1_000_000, 1_049_999, 1_500_000, 2_000_000].map(k)).toEqual(['1M', '1M', '1M', '1.5M', '2M']);
  });

  it('names a 1M window "1M" in the nudge, never "1000k"', () => {
    expect(nudgeText({ tokens: 213_000, window: 1_000_000, ceiling: 600_000 })).toContain('(21% of your 1M max context)');
  });
});
