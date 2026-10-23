import { describe, expect, it } from 'vitest';
import { Parties, type StoredHandoff } from '../plugins/forward-compaction/src/parties.ts';

const handoff = (toolUseId: string, storedAtTokens = 41_200): Omit<StoredHandoff, 'seq'> => ({
  text: '## Objective\nx\n## Done\ny\n## Remaining\nz\n## Next\nw',
  loadFiles: [],
  toolUseId,
  storedAtTokens,
});

describe('Parties state', () => {
  it('creates a party on first touch with the defaults', () => {
    const parties = new Parties(200_000);
    expect(parties.get('main')).toMatchObject({ key: 'main', label: 'main', modelWin: 200_000, nudgeLevel: 0, nudgedNow: false, askHeld: false, installs: 0, installedThisTurn: false });
    expect(parties.get('main').stored).toBeUndefined();
    expect(parties.get('main').reading).toBeUndefined();
    expect(parties.get('agent:a1').label).toBe('agent:a1');
  });

  it('describe sets the label, model and model window, leaving the rest', () => {
    const parties = new Parties();
    parties.read('agent:a1', 12_000);
    parties.describe('agent:a1', { label: 'general-purpose a1b2c3', model: 'sonnet', modelWin: 1_000_000 });
    expect(parties.get('agent:a1')).toMatchObject({ label: 'general-purpose a1b2c3', model: 'sonnet', modelWin: 1_000_000, reading: 12_000 });
  });

  it('keeps each party separate', () => {
    const parties = new Parties();
    parties.read('main', 60_000);
    parties.read('agent:a1', 10_000);
    expect(parties.get('main').reading).toBe(60_000);
    expect(parties.get('agent:a1').reading).toBe(10_000);
  });
});

describe('store and takeStored', () => {
  it('stores a handoff with a rising seq and returns the one it replaced', () => {
    const parties = new Parties();
    expect(parties.store('main', handoff('t1', 30_500))).toBeUndefined();
    expect(parties.get('main').stored).toMatchObject({ toolUseId: 't1', storedAtTokens: 30_500, seq: 1 });
    const replaced = parties.store('main', handoff('t2'));
    expect(replaced).toMatchObject({ toolUseId: 't1', storedAtTokens: 30_500 });
    expect(parties.get('main').stored).toMatchObject({ toolUseId: 't2', seq: 2 });
  });

  it('takeStored hands it back once and clears it', () => {
    const parties = new Parties();
    parties.store('agent:a1', handoff('t1'));
    expect(parties.takeStored('agent:a1')?.toolUseId).toBe('t1');
    expect(parties.takeStored('agent:a1')).toBeUndefined();
    expect(parties.get('agent:a1').stored).toBeUndefined();
  });

  it('takeStored on a party never seen is undefined and creates none', () => {
    const parties = new Parties();
    expect(parties.takeStored('agent:nope')).toBeUndefined();
  });
});

describe('nudgeDue (R30)', () => {
  it('is true once per level, false on the second call at the same level', () => {
    const parties = new Parties();
    expect(parties.nudgeDue('main', 2)).toBe(true);
    expect(parties.nudgeDue('main', 2)).toBe(false);
  });

  it('is true again at a higher level, false at a lower one', () => {
    const parties = new Parties();
    expect(parties.nudgeDue('main', 1)).toBe(true);
    expect(parties.nudgeDue('main', 2)).toBe(true);
    expect(parties.nudgeDue('main', 1)).toBe(false);
  });

  it('owes nothing at level 0 and nothing while a handoff is stored', () => {
    const parties = new Parties();
    expect(parties.nudgeDue('main', 0)).toBe(false);
    parties.store('main', handoff('t1'));
    expect(parties.nudgeDue('main', 5)).toBe(false);
  });

  it('keeps each party\'s levels apart', () => {
    const parties = new Parties();
    expect(parties.nudgeDue('main', 1)).toBe(true);
    expect(parties.nudgeDue('agent:a1', 1)).toBe(true);
  });

  it('owes one more "now" delivery after a held ask even when its level was already delivered, and only one', () => {
    const parties = new Parties();
    expect(parties.nudgeDue('main', 2)).toBe(true);
    parties.asked('main', 'skip');
    expect(parties.get('main').askHeld).toBe(true);
    expect(parties.nudgeDue('main', 2)).toBe(true);
    expect(parties.get('main').nudgedNow).toBe(true);
    parties.asked('main', 'skip');
    expect(parties.nudgeDue('main', 2)).toBe(false);
    expect(parties.nudgeDue('main', 3)).toBe(true);
  });

  it('owes the "now" delivery after a held ask even below the first nudge level', () => {
    const parties = new Parties();
    parties.asked('agent:a1', 'skip');
    expect(parties.nudgeDue('agent:a1', 0)).toBe(true);
    expect(parties.nudgeDue('agent:a1', 0)).toBe(false);
  });
});

describe('asked, answered and reactive (D8)', () => {
  it('is reactive after a skip until a step completes', () => {
    const parties = new Parties();
    expect(parties.reactive('main')).toBe(false);
    parties.asked('main', 'skip');
    expect(parties.get('main').lastDecision).toBe('skip');
    expect(parties.reactive('main')).toBe(true);
    parties.answered('main');
    expect(parties.reactive('main')).toBe(false);
  });

  it('is cleared by a reading, which only a completed step brings', () => {
    const parties = new Parties();
    parties.asked('agent:a1', 'skip');
    parties.read('agent:a1', 68_000);
    expect(parties.reactive('agent:a1')).toBe(false);
  });

  it('is not reactive when the previous ask was not a skip', () => {
    const parties = new Parties();
    parties.asked('main', 'install');
    expect(parties.reactive('main')).toBe(false);
    parties.asked('main', 'skip');
    parties.asked('main', 'mechanical');
    expect(parties.reactive('main')).toBe(false);
  });

  it('is reactive for the second skip in a row only if no step completed between them', () => {
    const parties = new Parties();
    parties.asked('main', 'skip');
    parties.answered('main');
    parties.asked('main', 'skip');
    expect(parties.reactive('main')).toBe(true);
  });
});

describe('installed', () => {
  it('clears the handoff and the nudges, counts the install, sets the reading and the turn mark', () => {
    const parties = new Parties();
    parties.read('main', 70_000);
    parties.nudgeDue('main', 3);
    parties.asked('main', 'skip');
    parties.nudgeDue('main', 3);
    parties.store('main', handoff('t1'));
    parties.installed('main', 21_000);
    expect(parties.get('main')).toMatchObject({ nudgeLevel: 0, nudgedNow: false, askHeld: false, installs: 1, installedThisTurn: true, reading: 21_000, lastDecision: 'install' });
    expect(parties.get('main').stored).toBeUndefined();
    expect(parties.reactive('main')).toBe(false);
    expect(parties.nudgeDue('main', 1)).toBe(true);
  });

  it('turnEnded clears the turn mark and nothing else', () => {
    const parties = new Parties();
    parties.installed('main', 21_000);
    parties.turnEnded('main');
    expect(parties.get('main')).toMatchObject({ installedThisTurn: false, installs: 1, reading: 21_000 });
  });
});

describe('forget', () => {
  it('starts the party over as if never seen', () => {
    const parties = new Parties();
    parties.describe('agent:a1', { label: 'x', modelWin: 1_000_000 });
    parties.read('agent:a1', 5_000);
    parties.store('agent:a1', handoff('t1'));
    parties.forget('agent:a1');
    expect(parties.get('agent:a1')).toMatchObject({ label: 'agent:a1', installs: 0, modelWin: 200_000 });
    expect(parties.get('agent:a1').stored).toBeUndefined();
    expect(parties.get('agent:a1').reading).toBeUndefined();
  });
});
