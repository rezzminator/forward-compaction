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
  it('names the size and asks to compact at the first milestone, with the exact text', () => {
    expect(nudgeText({ tokens: 55_400 })).toBe(
      'forward-compaction: context 55k and increasing. Try to wrap up and get yourself at the first milestone and call mcp__forward-compaction__forward_compaction with objective, decisions, done, remaining and next, and in load_files the files you will read again; skip if you can finish all of it soon, if you REALLY need larger context and your context has to keep large tokens for work, continue and do it at the first milestone. No such tool? Carry on.',
    );
  });

  it('names the registered tool, so a -dev copy is called by its own name', () => {
    const dev = 'mcp__forward-compaction-dev__forward_compaction';
    expect(nudgeText({ tokens: 213_000, tool: dev })).toBe(
      'forward-compaction: context 213k and increasing. Try to wrap up and get yourself at the first milestone and call mcp__forward-compaction-dev__forward_compaction with objective, decisions, done, remaining and next, and in load_files the files you will read again; skip if you can finish all of it soon, if you REALLY need larger context and your context has to keep large tokens for work, continue and do it at the first milestone. No such tool? Carry on.',
    );
  });
});

describe('k', () => {
  it('prints thousands as k and a million or more as M with at most one decimal', () => {
    expect([0, 999, 51_400, 999_499].map(k)).toEqual(['0k', '1k', '51k', '999k']);
    expect([999_500, 1_000_000, 1_049_999, 1_500_000, 2_000_000].map(k)).toEqual(['1M', '1M', '1M', '1.5M', '2M']);
  });
});
