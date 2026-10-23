import { describe, expect, it } from 'vitest';
import { UNSEEN_DROP, unseenCompaction } from '../plugins/forward-compaction/src/unseen.ts';

// Claude Code can compact the main chat without dispatching session.compact to user plugins (2.1.299 on a machine
// with managed settings): the next reading is the only trace, so a sharp drop with no compaction handled becomes a row.
describe('unseenCompaction', () => {
  it('is a drop to half or less with no session.compact handled since', () => {
    expect(UNSEEN_DROP).toBe(0.5);
    expect(unseenCompaction(69_422, 12_753, false)).toBe(true);
    expect(unseenCompaction(100_000, 50_000, false)).toBe(true);
  });

  it('is not a drop it saw, a smaller fall, or a reading with nothing before it', () => {
    expect(unseenCompaction(69_422, 12_753, true)).toBe(false);
    expect(unseenCompaction(100_000, 50_001, false)).toBe(false);
    expect(unseenCompaction(undefined, 12_753, false)).toBe(false);
    expect(unseenCompaction(69_422, undefined, false)).toBe(false);
  });
});
