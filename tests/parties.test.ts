import { describe, expect, it } from 'vitest';
import { installable, Parties, type StoredFrontier } from '../plugins/forward-compaction/src/parties.ts';
import { nudgeLevel } from '../plugins/forward-compaction/src/nudge.ts';

const LANDING = { kind: 'frontier' as const, label: 'main', before: 70_000, chars: 10, facts: 1, kept: 0, dropped: 0 };
const frontier = (toolUseId: string, storedAtTokens = 41_200): Omit<StoredFrontier, 'seq'> => ({
  text: '## Objective\nx\n## Done\ny\n## Remaining\nz\n## Next\nw',
  loadFiles: [],
  toolUseId,
  storedAtTokens,
  since: 0,
});

describe('Parties state', () => {
  it('creates a party on first touch with the defaults', () => {
    const parties = new Parties();
    expect(parties.get('main')).toMatchObject({ key: 'main', label: 'main', nudgeLevel: 0, absorbNext: false, installs: 0, installedThisTurn: false });
    expect(parties.get('main').stored).toBeUndefined();
    expect(parties.get('main').reading).toBeUndefined();
    expect(parties.get('agent:a1').label).toBe('agent:a1');
  });

  it('describe sets the label and model, leaving the rest', () => {
    const parties = new Parties();
    parties.read('agent:a1', 12_000);
    parties.describe('agent:a1', { label: 'general-purpose a1b2c3', model: 'sonnet' });
    expect(parties.get('agent:a1')).toMatchObject({ label: 'general-purpose a1b2c3', model: 'sonnet', reading: 12_000 });
  });

  it('keeps each party separate', () => {
    const parties = new Parties();
    parties.read('main', 60_000);
    parties.read('agent:a1', 10_000);
    expect(parties.get('main').reading).toBe(60_000);
    expect(parties.get('agent:a1').reading).toBe(10_000);
  });
});

describe('ignored and windowUnknown (Ignored models)', () => {
  const ignore = ['haiku'];

  it("names the list entry a party's model matches, once a step named the model", () => {
    const parties = new Parties();
    expect(parties.ignored('agent:a1', ignore)).toBeUndefined(); // model not known yet
    parties.describe('agent:a1', { model: 'claude-haiku-4-5-20251001' });
    expect(parties.ignored('agent:a1', ignore)).toBe('haiku');
    expect(parties.ignored('agent:a1', [])).toBeUndefined();
    parties.describe('main', { model: 'claude-haiku-5-5' });
    expect(parties.ignored('main', ignore)).toBe('haiku');
    parties.describe('agent:a1', { model: 'claude-sonnet-5-5' });
    expect(parties.ignored('agent:a1', ignore)).toBeUndefined();
  });

  it("knows main's max context only once it is set or main's window was read, and a sub-agent's always", () => {
    const parties = new Parties();
    expect(parties.windowUnknown('main', false)).toBe(true);
    expect(parties.windowUnknown('main', true)).toBe(false);
    expect(parties.windowUnknown('agent:a1', false)).toBe(false); // the sub-agent max context, never main's window
    parties.describe('agent:a1', { model: 'claude-haiku-4-5' });
    expect(parties.windowUnknown('agent:a1', false)).toBe(false);
  });
});

describe('store and takeStored', () => {
  it('stores a frontier with a rising seq and returns the one it replaced', () => {
    const parties = new Parties();
    expect(parties.store('main', frontier('t1', 30_500))).toBeUndefined();
    expect(parties.get('main').stored).toMatchObject({ toolUseId: 't1', storedAtTokens: 30_500, seq: 1 });
    const replaced = parties.store('main', frontier('t2'));
    expect(replaced).toMatchObject({ toolUseId: 't1', storedAtTokens: 30_500 });
    expect(parties.get('main').stored).toMatchObject({ toolUseId: 't2', seq: 2 });
  });

  it('takeStored hands it back once and clears it', () => {
    const parties = new Parties();
    parties.store('agent:a1', frontier('t1'));
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

  it('owes nothing at level 0 and nothing while a frontier is stored', () => {
    const parties = new Parties();
    expect(parties.nudgeDue('main', 0)).toBe(false);
    parties.store('main', frontier('t1'));
    expect(parties.nudgeDue('main', 5)).toBe(false);
  });

  it('still nudges while the stored frontier is missing a MANDATORY section: it counts as nothing stored', () => {
    const parties = new Parties();
    parties.store('main', { ...frontier('t1'), missing: ['next'] });
    expect(parties.nudgeDue('main', 5)).toBe(true);
  });

  it('keeps each party\'s levels apart', () => {
    const parties = new Parties();
    expect(parties.nudgeDue('main', 1)).toBe(true);
    expect(parties.nudgeDue('agent:a1', 1)).toBe(true);
  });

  it('is the same after a held ask: a held ask owes no extra nudge', () => {
    const parties = new Parties();
    expect(parties.nudgeDue('main', 2)).toBe(true);
    parties.asked('main', 'skip');
    expect(parties.nudgeDue('main', 2)).toBe(false);
    expect(parties.nudgeDue('main', 3)).toBe(true);
    parties.asked('agent:a1', 'skip');
    expect(parties.nudgeDue('agent:a1', 0)).toBe(false);
  });
});

describe('the first reading after an install (no re-nudge)', () => {
  it('absorbs that reading\'s level silently; the next nudge goes only past it', () => {
    // A 200k-window party, start 30k, every 10k: installed, its first reading 61k is level 4.
    const parties = new Parties();
    parties.nudgeDue('agent:a1', 6);
    parties.installed('agent:a1');
    expect(parties.get('agent:a1').absorbNext).toBe(true);
    expect(parties.nudgeDue('agent:a1', 1)).toBe(false); // only the wake's estimate is known yet
    parties.read('agent:a1', 61_000, 4);
    expect(parties.get('agent:a1')).toMatchObject({ absorbNext: false, nudgeLevel: 4 });
    expect(parties.nudgeDue('agent:a1', 4)).toBe(false);
    expect(parties.nudgeDue('agent:a1', 5)).toBe(true); // 70k
  });

  it('absorbs a first reading below the start as level 0: the start still nudges', () => {
    const parties = new Parties();
    parties.installed('main');
    parties.read('main', 20_000, 0);
    expect(parties.nudgeDue('main', 1)).toBe(true);
  });

  it('absorbs only the first reading: later readings nudge as usual', () => {
    const parties = new Parties();
    parties.installed('main');
    parties.read('main', 61_000, 4);
    parties.read('main', 72_000, 5);
    expect(parties.get('main').nudgeLevel).toBe(4);
    expect(parties.nudgeDue('main', 5)).toBe(true);
  });

  it('sends no nudge loop after a wake (S2, decisions 0f3e8b92 rows 20-25): the next one only once the context grew by every past the first reading', () => {
    // start 40k, every 20k: woken, the first reading 66,560 is level 2, just under the 80k boundary.
    const parties = new Parties();
    const at = (tokens: number) => nudgeLevel(tokens, 40_000, 20_000);
    parties.nudgeDue('agent:a1', at(85_000), 85_000, 20_000);
    parties.installed('agent:a1');
    parties.read('agent:a1', 66_560, at(66_560));
    const due = (tokens: number) => (parties.read('agent:a1', tokens, at(tokens)), parties.nudgeDue('agent:a1', at(tokens), tokens, 20_000));
    expect([72_000, 79_000, 81_000, 86_559].map(due)).toEqual([false, false, false, false]); // 81k crossed a level boundary 14k after the wake
    expect(due(86_560)).toBe(true);
  });

  it('absorbs nothing for a party never installed', () => {
    const parties = new Parties();
    parties.read('main', 61_000, 4);
    expect(parties.nudgeDue('main', 4)).toBe(true);
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

  it('is cleared by a new turn, so an ask after an idle gap is not a request too long', () => {
    const parties = new Parties();
    parties.asked('main', 'skip');
    parties.newTurn('main');
    expect(parties.reactive('main')).toBe(false);
    parties.asked('main', 'skip');
    expect(parties.reactive('main')).toBe(true); // a second skip inside the new turn, no step between
  });
});

describe('installed', () => {
  it('clears the frontier, the nudges and the reading, counts the install, sets the turn mark and holds the landing', () => {
    const parties = new Parties();
    parties.read('main', 70_000);
    parties.nudgeDue('main', 3);
    parties.asked('main', 'skip');
    parties.store('main', frontier('t1'));
    expect(parties.installed('main', LANDING)).toBeUndefined();
    expect(parties.get('main')).toMatchObject({ nudgeLevel: 0, absorbNext: true, installs: 1, installedThisTurn: true, lastDecision: 'install', landing: LANDING });
    expect(parties.get('main').reading).toBeUndefined(); // no estimate stands in for a reading
    expect(parties.get('main').stored).toBeUndefined();
    expect(parties.reactive('main')).toBe(false);
    parties.read('main', 25_000, 0);
    expect(parties.nudgeDue('main', 1)).toBe(true);
  });

  it('turnEnded clears the turn mark and nothing else', () => {
    const parties = new Parties();
    parties.installed('main', LANDING);
    parties.turnEnded('main');
    expect(parties.get('main')).toMatchObject({ installedThisTurn: false, installs: 1, landing: LANDING });
  });

  it('hands the landing to the first reading after the install, once, and an unread one to its end or to the next install', () => {
    const parties = new Parties();
    parties.installed('main', LANDING);
    expect(parties.read('main', 30_000)).toEqual(LANDING);
    expect(parties.read('main', 31_000)).toBeUndefined();
    parties.installed('main', LANDING);
    const second = { ...LANDING, before: 31_000 };
    expect(parties.installed('main', second)).toEqual(LANDING);
    parties.installed('agent:a1', LANDING);
    expect(parties.takeLanding('agent:a1')).toEqual(LANDING);
    expect(parties.takeLanding('agent:a1')).toBeUndefined();
    expect(parties.takeLanding('agent:never')).toBeUndefined();
    parties.installed('agent:a2', LANDING);
    expect(parties.takeLandings()).toEqual([['main', second], ['agent:a2', LANDING]]);
    expect(parties.takeLandings()).toEqual([]);
  });
});

describe('forget', () => {
  it('starts the party over as if never seen', () => {
    const parties = new Parties();
    parties.describe('agent:a1', { label: 'x', model: 'claude-opus-5-5' });
    parties.read('agent:a1', 5_000);
    parties.store('agent:a1', frontier('t1'));
    parties.forget('agent:a1');
    expect(parties.get('agent:a1')).toMatchObject({ label: 'agent:a1', installs: 0 });
    expect(parties.get('agent:a1').model).toBeUndefined();
    expect(parties.get('agent:a1').stored).toBeUndefined();
    expect(parties.get('agent:a1').reading).toBeUndefined();
  });
});

describe('Parties ignore judgement', () => {
  const read = { mainKnown: true, ignore: ['haiku'] };

  it("judges main unknown until its window is read, then managed, or ignored once its model is on the list", () => {
    const parties = new Parties();
    expect(parties.judgement('main', { ...read, mainKnown: false })).toBe('unknown');
    expect(parties.judgement('main', read)).toBe('unknown'); // no step has named its model yet, as for a sub-agent
    parties.describe('main', { model: 'claude-sonnet-5-5' });
    expect(parties.judgement('main', read)).toBe('managed');
    expect(parties.judgement('main', { ...read, mainKnown: false })).toBe('unknown');
    parties.describe('main', { model: 'claude-haiku-4-5' });
    expect(parties.judgement('main', read)).toBe('ignored');
    expect(parties.judgement('main', { ...read, mainKnown: false })).toBe('ignored'); // the list needs no window
  });

  it('judges a sub-agent unknown until a step names its model, then managed or ignored, whether or not main is known', () => {
    const parties = new Parties();
    expect(parties.judgement('agent:a1', { ...read, mainKnown: false })).toBe('unknown');
    expect(parties.judgement('agent:a1', read)).toBe('unknown');
    parties.describe('agent:a1', { model: 'claude-haiku-4-5' });
    expect(parties.judgement('agent:a1', read)).toBe('ignored');
    expect(parties.judgement('agent:a1', { ...read, ignore: [] })).toBe('managed');
    parties.describe('agent:a1', { model: 'claude-sonnet-5-5' });
    expect(parties.judgement('agent:a1', read)).toBe('managed');
  });

  it('returns the ignore row once per judgement, with the entry matched, and again only when it changes', () => {
    const parties = new Parties();
    parties.describe('agent:a1', { label: 'collector a1b2c3' });
    expect(parties.judged('agent:a1', read)).toEqual({ event: 'ignore', party: 'agent:a1', label: 'collector a1b2c3', model: null, judged: 'unknown', matched: null });
    expect(parties.judged('agent:a1', read)).toBeUndefined();
    parties.describe('agent:a1', { model: 'claude-haiku-5-5' });
    expect(parties.judged('agent:a1', read)).toEqual({ event: 'ignore', party: 'agent:a1', label: 'collector a1b2c3', model: 'claude-haiku-5-5', judged: 'ignored', matched: 'haiku' });
    expect(parties.judged('agent:a1', read)).toBeUndefined();
    parties.describe('agent:a1', { model: 'claude-haiku-4-5' });
    expect(parties.judged('agent:a1', read)).toBeUndefined(); // the model changed, the judgement did not
    parties.describe('agent:a1', { model: 'claude-sonnet-5-5' });
    expect(parties.judged('agent:a1', read)).toMatchObject({ judged: 'managed', matched: null });
    expect(parties.judged('agent:a1', read)).toBeUndefined();
  });

  it('a party that starts over is judged afresh', () => {
    const parties = new Parties();
    parties.describe('main', { model: 'claude-sonnet-5-5' });
    expect(parties.judged('main', read)?.judged).toBe('managed');
    parties.forget('main');
    expect(parties.judged('main', read)?.judged).toBe('unknown');
  });

  it('keeps a known model when a step names none: no judgement falls back to unknown', () => {
    const parties = new Parties();
    parties.describe('agent:a1', { model: 'claude-sonnet-5-5' });
    expect(parties.judged('agent:a1', read)?.judged).toBe('managed');
    parties.describe('agent:a1', { model: undefined });
    expect(parties.get('agent:a1').model).toBe('claude-sonnet-5-5');
    expect(parties.judged('agent:a1', read)).toBeUndefined();
  });

  it('takes back the judgement and model $.state kept across a plugin reload, so an unchanged judgement writes no row', () => {
    const parties = new Parties();
    parties.restoreJudged('main', 'junk');
    expect(parties.get('main').judged).toBeUndefined();
    parties.restoreJudged('main', { judged: 'managed', model: 'claude-sonnet-5-5' });
    expect(parties.get('main')).toMatchObject({ judged: 'managed', model: 'claude-sonnet-5-5' });
    expect(parties.judged('main', read)).toBeUndefined();
    parties.describe('agent:a1', { model: 'claude-haiku-4-5' });
    parties.restoreJudged('agent:a1', { judged: 'managed', model: 'claude-sonnet-5-5' });
    expect(parties.get('agent:a1').model).toBe('claude-haiku-4-5'); // a model named in this process wins
  });
});

describe('the ratio base (window.ts charsPerToken)', () => {
  it('ends at every compaction of the party, installed or left to Claude Code, and at an unseen one; a skip keeps it', () => {
    const parties = new Parties();
    const base = { chars: 12_000, tokens: 44_800 };
    parties.read('agent:a1', 44_800);
    parties.rebase('agent:a1', base);
    parties.asked('agent:a1', 'skip');
    expect(parties.get('agent:a1').base).toEqual(base);
    parties.installed('agent:a1');
    expect(parties.get('agent:a1').base).toBeUndefined();
    for (const decision of ['native', 'pass'] as const) {
      parties.rebase('agent:a1', base);
      parties.asked('agent:a1', decision);
      expect(parties.get('agent:a1').base, decision).toBeUndefined();
    }
    parties.rebase('agent:a1', base);
    parties.rebase('agent:a1', undefined);
    expect(parties.get('agent:a1').base).toBeUndefined();
  });

  it('gives a party forgotten meanwhile no state', () => {
    const parties = new Parties();
    parties.rebase('agent:gone', { chars: 1, tokens: 1 });
    expect(parties.takeLandings()).toEqual([]);
    expect(parties.get('agent:gone').base).toBeUndefined();
  });
});

describe('installable: only a frontier with every MANDATORY section installs', () => {
  it('is false with nothing stored or a section missing, true for a complete one', () => {
    expect(installable(undefined)).toBe(false);
    expect(installable({ ...frontier('t1'), seq: 1, missing: ['decisions'] })).toBe(false);
    expect(installable({ ...frontier('t1'), seq: 1, missing: [] })).toBe(true);
    expect(installable({ ...frontier('t1'), seq: 1 })).toBe(true);
  });
});
