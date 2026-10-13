import { describe, expect, it } from 'vitest';
import { isFirstRequest, Parties } from '../plugins/sub-agent-compact/src/parties.ts';

describe('Parties', () => {
  it('owes each nudge level once, and none while armed', () => {
    const parties = new Parties();
    parties.read('a', 105_000);
    expect(parties.nudgeDue('a', 100_000, 100_000)).toBe(0);
    expect(parties.nudgeDue('a', 100_000, 100_000)).toBeUndefined();
    parties.read('a', 210_000);
    parties.arm('a', 'next: file 9');
    expect(parties.nudgeDue('a', 100_000, 100_000)).toBeUndefined();
  });

  it('starts a compacted party over from its size after the compaction, so a stale reading sends no nudge', () => {
    const parties = new Parties();
    parties.read('a', 104_000);
    expect(parties.nudgeDue('a', 100_000, 100_000)).toBe(0);
    parties.arm('a', 'next: file 9');
    parties.markContinued('a');
    parties.compacted('a', 10_000);
    expect(parties.reading('a')).toBe(10_000);
    expect(parties.armed('a')).toBeUndefined();
    expect(parties.continued('a')).toBe(false);
    expect(parties.nudgeDue('a', 100_000, 100_000)).toBeUndefined();
    parties.read('a', 101_000);
    expect(parties.nudgeDue('a', 100_000, 100_000)).toBe(0);
  });

  it('reads 0 after a compaction that reported no size, never the stale figure', () => {
    const parties = new Parties();
    parties.read('a', 104_000);
    parties.compacted('a', undefined);
    expect(parties.reading('a')).toBe(0);
  });

  it('disarms a party without a compaction, keeping the nudges already sent so none repeats at once', () => {
    const parties = new Parties();
    parties.read('main', 301_000);
    expect(parties.nudgeDue('main', 200_000, 100_000)).toBe(1);
    parties.arm('main', 'next: dry run');
    expect(parties.disarm('main')).toBe(true);
    expect(parties.armed('main')).toBeUndefined();
    expect(parties.reading('main')).toBe(301_000);
    expect(parties.nudgeDue('main', 200_000, 100_000)).toBeUndefined();
    parties.read('main', 401_000);
    expect(parties.nudgeDue('main', 200_000, 100_000)).toBe(2);
  });

  it('reports nothing to disarm for a party that never armed', () => {
    expect(new Parties().disarm('main')).toBe(false);
  });
});

describe('the first reading as a base for the size of a cut', () => {
  it('is set only by a reading taken on the session\'s first request', () => {
    const parties = new Parties();
    parties.read('main', 208_000, false);
    expect(parties.firstReading('main')).toBeUndefined();
    parties.read('main', 40_000, true);
    expect(parties.firstReading('main')).toBe(40_000);
    parties.read('main', 90_000, true);
    expect(parties.firstReading('main')).toBe(40_000);
  });
});

describe('notices to a party\'s model', () => {
  it('queue in order, are taken once, and survive a compaction', () => {
    const parties = new Parties();
    parties.notify('a1', 'first');
    parties.notify('a1', 'second');
    parties.notify('main', 'other');
    parties.compacted('a1', 5_000);
    expect(parties.takeNotices('a1')).toEqual(['first', 'second']);
    expect(parties.takeNotices('a1')).toEqual([]);
    expect(parties.takeNotices('main')).toEqual(['other']);
  });

  it('queue a line once while it waits unread, so two layers reporting the same skip show it once', () => {
    const parties = new Parties();
    parties.notify('main', 'skipped: busy');
    parties.notify('main', 'skipped: busy');
    expect(parties.takeNotices('main')).toEqual(['skipped: busy']);
    parties.notify('main', 'skipped: busy');
    expect(parties.takeNotices('main')).toEqual(['skipped: busy']);
  });
});

describe('isFirstRequest', () => {
  it('takes a sub-agent\'s step 0 of a turn that carries at most the prompt and its context lines', () => {
    expect(isFirstRequest({ index: 0, messageCount: 1, main: false })).toBe(true);
    expect(isFirstRequest({ index: 0, messageCount: 3, main: false })).toBe(true);
    expect(isFirstRequest({ index: 0, messageCount: 4, main: false })).toBe(false);
    expect(isFirstRequest({ index: 1, messageCount: 1, main: false })).toBe(false);
    expect(isFirstRequest({ index: 0, main: false })).toBe(false);
  });

  it('takes the main chat\'s only when it is also the session\'s first prompt: after a reload, the step after a CLI compaction (summary and prompt, 2 messages) is not', () => {
    expect(isFirstRequest({ index: 0, messageCount: 1, main: true, turns: 1 })).toBe(true);
    expect(isFirstRequest({ index: 0, messageCount: 2, main: true, turns: 5 })).toBe(false);
    expect(isFirstRequest({ index: 0, messageCount: 1, main: true, turns: 2 })).toBe(false);
    expect(isFirstRequest({ index: 0, messageCount: 1, main: true, turns: 0 })).toBe(false);
  });

  it('is not first for the main chat when the prompt count is unknown, rather than guessing', () => {
    expect(isFirstRequest({ index: 0, messageCount: 1, main: true })).toBe(false);
    expect(isFirstRequest({ index: 0, messageCount: 1, main: true, turns: Number.NaN })).toBe(false);
  });
});
