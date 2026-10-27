import { describe, expect, it } from 'vitest';
import { k, nudgeLevel, nudgeText, gated, gateMark, gateText, GATE_STEPS } from '../plugins/forward-compaction/src/nudge.ts';

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
      'forward-compaction: context 55k (28% of 200k). Once your current step is done — never in the middle of one — call mcp__forward-compaction__forward_compaction with objective, done, remaining and next; skip it if only your final answer is left. At 120k you are compacted mechanically. No such tool? Carry on.',
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
    expect(nudgeText({ tokens: 55_400, window: 1_000_000, ceiling: 600_000, tool: dev })).toContain(`call ${dev} with objective, done, remaining and next`);
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

describe('the compaction gate', () => {
  const at = (over: Partial<Parameters<typeof gated>[0]> = {}) => gated({ party: 'subagent', level: 2, gateLevel: 2, stored: false, ignored: false, tool: 'Read', open: ['FC', 'LB', 'ToolSearch'], ...over });

  it('closes at its gate level, one step past the first nudge, at that level\'s nudge point', () => {
    expect(GATE_STEPS).toBe(1);
    expect(gateMark(80_000, 20_000, 2)).toBe(100_000);
    expect(at()).toBe(true);
    expect(at({ level: 3 })).toBe(true);
    expect(at({ level: 1 })).toBe(false);
  });

  it('never gates main, an ignored model, a party with a frontier stored or not yet nudged, or the tools that lead to the frontier', () => {
    expect(at({ party: 'main' })).toBe(false);
    expect(at({ ignored: true })).toBe(false);
    expect(at({ stored: true })).toBe(false);
    expect(at({ gateLevel: undefined })).toBe(false);
    for (const tool of ['FC', 'LB', 'ToolSearch']) expect(at({ tool })).toBe(false);
  });

  it('says nothing ran, to compact first, and to repeat the call', () => {
    expect(gateText({ tokens: 104_000, tool: 'FC' })).toBe('forward-compaction: this call did not run — at 104k you compact first. Call FC (objective, done, remaining, next), then repeat this call. Only your result and final answer left, or no such tool? Repeat this call: it runs.');
  });

  it('is announced by the nudge before it, and not once it closed', () => {
    expect(nudgeText({ tokens: 85_000, window: 200_000, ceiling: 160_000, gateAt: 100_000 })).toContain(' From 100k your other calls wait for it. ');
    expect(nudgeText({ tokens: 105_000, window: 200_000, ceiling: 160_000, gateAt: 100_000 })).not.toContain('your other calls wait');
    expect(nudgeText({ tokens: 85_000, window: 200_000, ceiling: 160_000 })).not.toContain('your other calls wait');
  });
});

describe('the nudge and the refusal stay short', () => {
  it('make no promise about what a compaction keeps, and never say "lost"', () => {
    for (const text of [gateText({ tokens: 104_000 }), nudgeText({ tokens: 85_000, window: 200_000, ceiling: 160_000, gateAt: 100_000 })]) {
      expect(text).not.toMatch(/costs you nothing|every message after it|lost/);
      expect(text.length).toBeLessThan(400);
    }
  });
});
