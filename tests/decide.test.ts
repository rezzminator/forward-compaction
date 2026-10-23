import { describe, expect, it } from 'vitest';
import { contextTokens, currentTokens, decide, estimateTokens, knownTrigger, turnEndDoor, type DecideInput } from '../plugins/forward-compaction/src/decide.ts';

const base: DecideInput = { trigger: 'auto', party: 'main', stored: false, tokens: 80_000, ceiling: 100_000, reactive: false, ceilingNative: false, label: 'main' };
const ask = (patch: Partial<DecideInput>) => decide({ ...base, ...patch });

describe('decide: manual and precompute (C1, C2, R25)', () => {
  it('C1 leaves a manual /compact to Claude Code and drops the stored handoff, for every party and state', () => {
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
  it('C3 installs a stored handoff for main', () => {
    expect(ask({ trigger: 'plugin', party: 'main', stored: true })).toMatchObject({ action: 'install', decision: 'install' });
  });

  it('C4 leaves another plugin\'s request for main with nothing stored to Claude Code', () => {
    expect(ask({ trigger: 'plugin', party: 'main', stored: false })).toMatchObject({ action: 'next', decision: 'pass' });
  });

  it('C4 drops a stored handoff whose call left the transcript', () => {
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

  it('C7 installs a stored handoff for main and a sub-agent, at any size', () => {
    for (const party of ['main', 'subagent'] as const) {
      for (const tokens of [10_000, 80_000, 150_000]) expect(ask({ party, stored: true, tokens })).toMatchObject({ action: 'install', decision: 'install', why: 'stored' });
    }
  });

  it('C7 installs when reactive too', () => {
    expect(ask({ stored: true, reactive: true })).toMatchObject({ action: 'install' });
  });

  it('C8 drops a stored handoff whose call is not in the messages, then goes on as if none were stored (skip)', () => {
    expect(ask({ stored: false, storedMissing: true, tokens: 80_000 })).toMatchObject({ action: 'skip', dropStored: true, nudge: 'now' });
  });

  it('C8 drops it and goes on to a mechanical wake at the ceiling', () => {
    expect(ask({ stored: false, storedMissing: true, tokens: 100_000 })).toMatchObject({ action: 'mechanical', dropStored: true });
  });

  it('C9 skips below the ceiling with nothing stored, asks for a "now" nudge and names the party', () => {
    expect(ask({ stored: false, tokens: 80_000, ceiling: 100_000, reactive: false })).toMatchObject({
      action: 'skip',
      decision: 'skip',
      why: 'waiting',
      nudge: 'now',
      reason: "forward-compaction: waiting for main's handoff",
    });
    expect(ask({ party: 'subagent', label: 'general-purpose a1b2c3', tokens: 70_000 })).toMatchObject({ reason: "forward-compaction: waiting for general-purpose a1b2c3's handoff" });
    expect(ask({ tokens: 99_999 }).action).toBe('skip');
  });

  it('C9 drops nothing when no handoff was stored', () => {
    expect(ask({ tokens: 80_000 })).not.toHaveProperty('dropStored');
  });

  it('C9 skips when the party has no reading at all and is not reactive', () => {
    expect(ask({ tokens: undefined })).toMatchObject({ action: 'skip', why: 'waiting' });
  });

  it('C10 installs a mechanical wake at the ceiling and above it', () => {
    expect(ask({ tokens: 100_000 })).toMatchObject({ action: 'mechanical', decision: 'mechanical', why: 'ceiling' });
    expect(ask({ tokens: 130_000, party: 'subagent' })).toMatchObject({ action: 'mechanical', why: 'ceiling' });
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

  it('compacts main at the end of an answered turn with a handoff stored and no install yet this turn', () => {
    expect(turnEndDoor(door)).toEqual({ compact: true });
  });

  it('keeps the handoff, with the reason, for a sub-agent, a turn that did not answer, nothing stored, or an install already made', () => {
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

describe('estimateTokens', () => {
  const file = 'x'.repeat(35_000);
  const transcript = [
    { text: 'read the files', toolUses: [], toolResults: [] },
    { text: '', toolUses: [{ tool_use_id: 't1', input: { file_path: 'a.go' }, text: file }, { tool_use_id: 't2', input: { file_path: 'b.go' }, text: file }] },
    { text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: file }, { tool_use_id: 't2', text: file }] },
  ];

  it('is characters over 3.5, rounded up', () => {
    expect(estimateTokens(7)).toBe(2);
    expect(estimateTokens(8)).toBe(3);
    expect(estimateTokens(0)).toBe(0);
  });

  it('counts a transcript\'s text, tool inputs and each tool result once', () => {
    const tokens = estimateTokens(transcript);
    expect(tokens).toBeGreaterThan(20_000);
    expect(tokens).toBeLessThan(20_100);
  });

  it('counts a call whose answer is missing by its own text', () => {
    expect(estimateTokens([transcript[1]!])).toBeGreaterThan(20_000);
  });
});

describe('currentTokens', () => {
  const transcript = [{ text: 'x'.repeat(35_000) }];

  it('takes the larger of the last reading and the transcript estimate (the one-step lag)', () => {
    expect(currentTokens(5_000, transcript)).toBe(estimateTokens(transcript));
    expect(currentTokens(90_000, transcript)).toBe(90_000);
  });

  it('adds what came back after the last response to the reading: a jump smaller than the estimate shortfall still counts', () => {
    // the reading holds the system prompt and tools the transcript leaves out, so the estimate of the whole runs low
    const before = [{ role: 'user' as const, text: 'x'.repeat(35_000) }, { role: 'assistant' as const, text: 'reading', toolUses: [{ tool_use_id: 'r1', input: {} }] }];
    const jump = [...before, { role: 'user' as const, toolResults: [{ tool_use_id: 'r1', text: 'y'.repeat(350_000) }] }];
    expect(currentTokens(590_000, jump)).toBe(590_000 + estimateTokens([jump[2]!]));
    expect(currentTokens(590_000, before)).toBe(590_000);
  });

  it('uses the estimate alone before the party has a reading, and has none for an empty transcript', () => {
    expect(currentTokens(undefined, transcript)).toBe(estimateTokens(transcript));
    expect(currentTokens(undefined, [])).toBeUndefined();
  });
});
