import { describe, expect, it } from 'vitest';
import { contextTokens, readingTokens, decide, knownTrigger, turnEndDoor, type DecideInput } from '../plugins/forward-compaction/src/decide.ts';

const base: DecideInput = { trigger: 'auto', party: 'main', stored: false, tokens: 80_000, ceiling: 100_000, reactive: false, ceilingNative: false, label: 'main' };
const ask = (patch: Partial<DecideInput>) => decide({ ...base, ...patch });

describe('decide: manual and precompute (C1, C2, R25)', () => {
  it('C1 leaves a manual /compact to Claude Code and drops the stored frontier, for every party and state', () => {
    for (const party of ['main', 'subagent', 'foreign'] as const) {
      for (const stored of [true, false]) {
        expect(ask({ trigger: 'manual', party, stored })).toMatchObject({ action: 'next', decision: 'native', why: 'manual', dropStored: true });
      }
    }
  });

  it('C2 skips a precompute for every party', () => {
    for (const party of ['main', 'subagent', 'foreign'] as const) {
      const action = ask({ trigger: 'precompute', party, stored: true });
      expect(action).toMatchObject({ action: 'skip', decision: 'skip', why: 'precompute', reason: 'forward-compaction: precompute is never used' });
    }
  });
});

describe('decide: plugin trigger (C3-C5, R28)', () => {
  it('C3 installs a stored frontier for main', () => {
    expect(ask({ trigger: 'plugin', party: 'main', stored: true })).toMatchObject({ action: 'install', decision: 'install' });
  });

  it('C4 leaves another plugin\'s request for main with nothing stored to Claude Code', () => {
    expect(ask({ trigger: 'plugin', party: 'main', stored: false })).toMatchObject({ action: 'next', decision: 'pass' });
  });

  it('C4 drops a stored frontier whose call left the transcript', () => {
    expect(ask({ trigger: 'plugin', party: 'main', stored: false, storedMissing: true })).toMatchObject({ action: 'next', decision: 'pass', dropStored: true });
  });

  it('C5 passes a plugin request for a sub-agent or a foreign party, whatever it holds', () => {
    for (const party of ['subagent', 'foreign'] as const) {
      expect(ask({ trigger: 'plugin', party, stored: true })).toMatchObject({ action: 'next', decision: 'pass' });
    }
  });
});

describe('decide: automatic ask (C6-C10, R26-R28)', () => {
  it('C6 passes a foreign party to Claude Code', () => {
    expect(decide({ trigger: 'auto', party: 'foreign' })).toMatchObject({ action: 'next', decision: 'foreign', why: 'foreign' });
    expect(ask({ party: 'foreign', stored: true, tokens: 500_000 })).toMatchObject({ action: 'next', why: 'foreign' });
  });

  it('C7 installs a stored frontier for main and a sub-agent, at any size', () => {
    for (const party of ['main', 'subagent'] as const) {
      for (const tokens of [10_000, 80_000, 150_000]) expect(ask({ party, stored: true, tokens })).toMatchObject({ action: 'install', decision: 'install', why: 'stored' });
    }
  });

  it('C7 installs when reactive too', () => {
    expect(ask({ stored: true, reactive: true })).toMatchObject({ action: 'install' });
  });

  it('C8 drops a stored frontier whose call is not in the messages, then goes on as if none were stored (skip)', () => {
    expect(ask({ stored: false, storedMissing: true, tokens: 80_000 })).toMatchObject({ action: 'skip', dropStored: true });
  });

  it('C8 drops it and goes on to a mechanical wake at the ceiling', () => {
    expect(ask({ stored: false, storedMissing: true, tokens: 100_000 })).toMatchObject({ action: 'mechanical', dropStored: true });
  });

  it('C9 skips below the ceiling with nothing stored, names the party, and asks for no nudge of its own', () => {
    const skip = ask({ stored: false, tokens: 80_000, ceiling: 100_000, reactive: false });
    expect(skip).toMatchObject({
      action: 'skip',
      decision: 'skip',
      why: 'waiting',
      reason: "forward-compaction: holding Claude Code's compaction for main until its frontier is stored or the ceiling is reached",
    });
    expect(skip).not.toHaveProperty('nudge');
    expect(ask({ party: 'subagent', label: 'general-purpose a1b2c3', tokens: 70_000 })).toMatchObject({ reason: "forward-compaction: holding Claude Code's compaction for general-purpose a1b2c3 until its frontier is stored or the ceiling is reached" });
    expect(ask({ tokens: 99_999 }).action).toBe('skip');
  });

  it('C9 drops nothing when no frontier was stored', () => {
    expect(ask({ tokens: 80_000 })).not.toHaveProperty('dropStored');
  });

  it('C9 skips when the party has no reading at all and is not reactive', () => {
    expect(ask({ tokens: undefined })).toMatchObject({ action: 'skip', why: 'no-reading' });
  });

  it('C10 installs a mechanical wake at the ceiling and above it', () => {
    expect(ask({ tokens: 100_000 })).toMatchObject({ action: 'mechanical', decision: 'mechanical', why: 'ceiling' });
    expect(ask({ tokens: 130_000, party: 'subagent' })).toMatchObject({ action: 'mechanical', why: 'ceiling' });
  });

  it('C9 holds a sub-agent whose window is not known past the ceiling, as waiting; a request too long stays mechanical', () => {
    expect(ask({ party: 'subagent', tokens: 189_000, ceiling: 120_000, windowUnknown: true, label: 'flights-foreman-sonnet a55986' })).toEqual({
      action: 'skip', decision: 'skip', why: 'waiting', reason: "forward-compaction: holding Claude Code's compaction for flights-foreman-sonnet a55986 until its frontier is stored or the ceiling is reached",
    });
    expect(ask({ party: 'subagent', tokens: 189_000, ceiling: 120_000, windowUnknown: true, reactive: true })).toMatchObject({ action: 'mechanical', why: 'reactive' });
    expect(ask({ party: 'subagent', tokens: 189_000, ceiling: 120_000, windowUnknown: true, stored: true })).toMatchObject({ action: 'install' });
  });

  it('C10 leaves it to Claude Code at the ceiling when FORWARD_COMPACTION_CEILING_NATIVE is on', () => {
    expect(ask({ tokens: 100_000, ceilingNative: true })).toMatchObject({ action: 'next', decision: 'native', why: 'ceiling' });
  });

  it('C10 treats an ask after a skip with no step between as a request too long (D8, R27)', () => {
    expect(ask({ reactive: true, tokens: 70_000, stored: false })).toMatchObject({ action: 'mechanical', decision: 'mechanical', why: 'reactive' });
    expect(ask({ reactive: true, tokens: undefined })).toMatchObject({ action: 'mechanical', why: 'reactive' });
    expect(ask({ reactive: true, tokens: 70_000, ceilingNative: true })).toMatchObject({ action: 'next', decision: 'native', why: 'reactive' });
  });

  it('names the ceiling as the reason when both ceiling and reactive hold', () => {
    expect(ask({ reactive: true, tokens: 120_000 })).toMatchObject({ action: 'mechanical', why: 'ceiling' });
  });

  it('a ceiling left out never reaches, so only a reactive ask goes mechanical', () => {
    expect(decide({ trigger: 'auto', party: 'main', tokens: 900_000 })).toMatchObject({ action: 'skip' });
    expect(decide({ trigger: 'auto', party: 'main', tokens: 900_000, reactive: true })).toMatchObject({ action: 'mechanical', why: 'reactive' });
  });
});

describe('turnEndDoor (P1)', () => {
  const door = { main: true, reason: 'answer', stored: true, installedThisTurn: false } as const;

  it('compacts main at the end of an answered turn with a frontier stored and no install yet this turn', () => {
    expect(turnEndDoor(door)).toEqual({ compact: true });
  });

  it('keeps the frontier, with the reason, for a sub-agent, a turn that did not answer, nothing stored, or an install already made', () => {
    expect(turnEndDoor({ ...door, main: false })).toEqual({ compact: false, why: 'not-main' });
    for (const reason of ['aborted', 'refusal', 'error'] as const) expect(turnEndDoor({ ...door, reason })).toEqual({ compact: false, why: 'not-answered' });
    expect(turnEndDoor({ ...door, stored: false })).toEqual({ compact: false, why: 'nothing-stored' });
    expect(turnEndDoor({ ...door, installedThisTurn: true })).toEqual({ compact: false, why: 'installed-this-turn' });
  });
});

describe('knownTrigger', () => {
  it('knows the four and nothing else', () => {
    for (const trigger of ['auto', 'manual', 'plugin', 'precompute']) expect(knownTrigger(trigger)).toBe(trigger);
    expect(knownTrigger('reactive')).toBeUndefined();
    expect(knownTrigger(undefined)).toBeUndefined();
  });
});

describe('contextTokens', () => {
  it('adds uncached input, cache reads and cache writes', () => {
    expect(contextTokens({ input_tokens: 10, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 500 })).toBe(20_510);
    expect(contextTokens({ input_tokens: 7 })).toBe(7);
  });

  it('is undefined without a usage or its input count', () => {
    expect(contextTokens(undefined)).toBeUndefined();
    expect(contextTokens(null)).toBeUndefined();
    expect(contextTokens({ cache_read_input_tokens: 5 })).toBeUndefined();
  });
});


describe('readingTokens', () => {
  it("adds the response's own output to the context it was answered over", () => {
    expect(readingTokens({ input_tokens: 100_000, output_tokens: 10_000 })).toBe(110_000);
    expect(readingTokens({ input_tokens: 10, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 500, output_tokens: 90 })).toBe(20_600);
  });

  it('counts an absent output as 0 and has no reading without the input count', () => {
    expect(readingTokens({ input_tokens: 10, cache_read_input_tokens: 20_000 })).toBe(20_010);
    expect(readingTokens({ output_tokens: 5 })).toBeUndefined();
    expect(readingTokens(undefined)).toBeUndefined();
  });
});

describe('decide: ignored model (Ignored models)', () => {
  it("holds an ignored party's automatic ask as ignored-model, a Haiku sub-agent asked at 64k included, never passing it to Claude Code", () => {
    for (const party of ['main', 'subagent'] as const) {
      for (const state of [{}, { tokens: 64_000, ceiling: 160_000 }, { tokens: undefined, ceiling: 160_000 }]) {
        expect(decide({ trigger: 'auto', party, ignored: true, label: 'x', ...state })).toEqual({ action: 'skip', decision: 'skip', why: 'ignored-model', reason: "forward-compaction: holding Claude Code's compaction for x: its model is on the ignore list, so it is compacted mechanically at its ceiling" });
      }
    }
  });

  it("installs an ignored party's stored frontier at an automatic ask, like any other party's", () => {
    for (const party of ['main', 'subagent'] as const) expect(decide({ trigger: 'auto', party, ignored: true, stored: true })).toEqual({ action: 'install', decision: 'install', why: 'stored' });
  });

  it('gives an ignored party the mechanical wake at its ceiling or a reactive ask, and the native summary with the native flag', () => {
    expect(decide({ trigger: 'auto', party: 'subagent', ignored: true, tokens: 160_000, ceiling: 160_000 })).toEqual({ action: 'mechanical', decision: 'mechanical', why: 'ceiling' });
    expect(decide({ trigger: 'auto', party: 'subagent', ignored: true, tokens: 64_000, ceiling: 160_000, reactive: true })).toMatchObject({ action: 'mechanical', why: 'reactive' });
    expect(decide({ trigger: 'auto', party: 'subagent', ignored: true, tokens: 170_000, ceiling: 160_000, ceilingNative: true })).toMatchObject({ action: 'next', decision: 'native', why: 'ceiling' });
  });

  it('keeps a manual ask native and a precompute skipped', () => {
    expect(decide({ trigger: 'manual', party: 'main', ignored: true })).toMatchObject({ action: 'next', decision: 'native', why: 'manual' });
    expect(decide({ trigger: 'precompute', party: 'subagent', ignored: true })).toMatchObject({ action: 'skip', why: 'precompute' });
  });
});

describe('decide: no reading', () => {
  it('holds an automatic ask from a party with no reading and nothing stored as no-reading, the next reading deciding', () => {
    for (const party of ['main', 'subagent'] as const) {
      expect(decide({ trigger: 'auto', party, ceiling: 120_000, label: 'x' })).toEqual({ action: 'skip', decision: 'skip', why: 'no-reading', reason: "forward-compaction: holding Claude Code's compaction for x: it has no reading yet, and its next reading decides" });
    }
  });

  it('still installs a stored frontier and still goes mechanical on a reactive ask with no reading', () => {
    expect(decide({ trigger: 'auto', party: 'subagent', stored: true })).toMatchObject({ action: 'install' });
    expect(decide({ trigger: 'auto', party: 'main', ceiling: 120_000, reactive: true })).toMatchObject({ action: 'mechanical', why: 'reactive' });
    expect(decide({ trigger: 'auto', party: 'main', ceiling: 120_000, storedMissing: true })).toMatchObject({ why: 'no-reading', dropStored: true });
  });
});
