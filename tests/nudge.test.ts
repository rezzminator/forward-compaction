import { describe, expect, it } from 'vitest';
import { nudgeLevel, nudgeText } from '../plugins/forward-compaction/src/nudge.ts';

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
  it('says "soon" below the ask point when no ask was held yet, with the exact wording', () => {
    expect(nudgeText({ tokens: 55_400, askPoint: 67_000, ceiling: 120_000, asked: false })).toBe(
      'forward-compaction: your context is 55k tokens. At your next milestone, at a clean point and never mid-edit, call mcp__forward-compaction__forward_compaction with your handoff (## Objective, ## Done, ## Remaining, ## Next). The plugin keeps the person\'s messages or your brief, your skills, and every message after the call; you write the frontier. If only your final answer is left, give it instead. If this tool is not in your tool list, carry on: a mechanical compaction at 120k keeps your brief, skills and newest messages.',
    );
  });

  it('says "now" once the reading is at the ask point, with the exact wording', () => {
    expect(nudgeText({ tokens: 71_000, askPoint: 67_000, ceiling: 100_000, asked: false })).toBe(
      'forward-compaction: Claude Code is asking to compact you (71k tokens) and no handoff is stored. Call mcp__forward-compaction__forward_compaction now, at a clean point. At 100k the plugin compacts you mechanically, with no frontier from you. If this tool is not in your tool list, carry on.',
    );
    expect(nudgeText({ tokens: 67_000, askPoint: 67_000, ceiling: 100_000, asked: false })).toContain('Claude Code is asking to compact you (67k tokens)');
  });

  it('says "now" below the ask point when an ask was held', () => {
    expect(nudgeText({ tokens: 60_000, askPoint: 67_000, ceiling: 100_000, asked: true })).toMatch(/^forward-compaction: Claude Code is asking to compact you \(60k tokens\)/);
  });

  it('starts as R29 gives it', () => {
    expect(nudgeText({ tokens: 71_000, askPoint: 67_000, ceiling: 100_000, asked: true }).startsWith('forward-compaction: Claude Code is asking to compact you (71k tokens)')).toBe(true);
  });
});

describe('nudgeText names the tool as registered', () => {
  it('uses the registered name, so a -dev copy is called by its own name', () => {
    const dev = 'mcp__forward-compaction-dev__forward_compaction';
    expect(nudgeText({ tokens: 55_400, askPoint: 67_000, ceiling: 120_000, asked: false, tool: dev })).toContain(`call ${dev} with your handoff`);
    expect(nudgeText({ tokens: 71_000, askPoint: 67_000, ceiling: 120_000, asked: true, tool: dev })).toContain(`Call ${dev} now`);
  });
});
