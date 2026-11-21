import { afterEach, describe, expect, it } from 'vitest';
import { UNSEEN_DROP, unseenCompaction } from '../plugins/forward-compaction/src/unseen.ts';
import { begin, cleanup, logged, spawn, step, transcript, A1 } from './fakes/session.ts';

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

// The hook files the drop as a warning row and keeps it off the screen.
describe('an unseen compaction (R39)', () => {
  afterEach(cleanup);

  it('files a warning naming the party, off the screen, when its reading falls from 120,000 to 30,000 with no install', async () => {
    const f = await begin();
    await spawn(f);
    await step(f, 120_000, A1);
    await step(f, 30_000, A1);
    expect(f.texts().filter((t) => t.includes('context fell from'))).toEqual([]);
    expect(await logged(f, 'warnings', 'unseen-compaction')).toEqual([expect.stringMatching(/^general-purpose a1b2c3's context fell from 120k to 30k/)]);
  });

  it('does not call a compaction it passed to Claude Code unseen: the fall after a /compact draws no warning', async () => {
    const f = await begin();
    await step(f, 120_000);
    await f.dispatch('session.compact', { trigger: 'manual', messages: transcript() }, async () => ({ skip: 'native ran' }));
    await step(f, 30_000);
    expect(f.texts().filter((t) => t.includes('context fell from'))).toEqual([]);
  });
});
