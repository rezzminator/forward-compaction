import { describe, expect, it } from 'vitest';
import { finishText, k, lastNudge, noticeFor, nudgeLevel, nudgeStart, nudgeText } from '../plugins/forward-compaction/src/nudge.ts';
import { Parties } from '../plugins/forward-compaction/src/parties.ts';
import { emptyHeld } from '../plugins/forward-compaction/src/lists.ts';

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

describe('lastNudge', () => {
  it('is true once one more step of growth reaches the ceiling', () => {
    expect([109_999, 110_000, 110_001].map((tokens) => lastNudge(tokens, 10_000, 120_000))).toEqual([false, true, true]);
  });
});

describe('nudgeStart', () => {
  it.each<[floor: number, ceiling: number, start: number | undefined, want: number]>([
    [42_000, 800_000, undefined, 102_000], // far from the ceiling: the whole 60k room
    [69_999, 160_000, undefined, 129_999], // the whole room still fits two steps below the ceiling
    [70_001, 160_000, undefined, 130_000], // held to two steps below the ceiling
    [110_000, 160_000, undefined, 130_000],
    [115_001, 160_000, undefined, 130_001], // never under one step
    [150_000, 160_000, undefined, 165_000],
    [42_000, 800_000, 200_000, 200_000], // a set start, whatever the floor
  ])('a floor of %i under a ceiling of %i with the start %s starts the nudges at %i', (floor, ceiling, start, want) => {
    expect(nudgeStart(floor, { room: 60_000, every: 15_000, ceiling, ...(start === undefined ? {} : { start }) })).toBe(want);
  });
});

const TOOL = 'mcp__forward-compaction__forward_compaction';
const DEV_TOOL = 'mcp__forward-compaction-dev__forward_compaction';
const WHERE = 'what only a later step reads goes in storage (its value in storage.add); load_files only what the next step reads, a long file by its line range';
const ARGS = `with objective, next and what the rest of the work needs added to orders, decisions, done, remaining and findings; ${WHERE}`;
const CHANGED = `with only what changed since your last frontier, by item number: remove what is finished, lifted or wrong, edit what changed, add what is new; ${WHERE}`;
const FINISH = 'If the whole work finishes first, call it before the final report, with the finished steps removed from remaining, next "write the final report", and all the report needs added to done and findings: the compaction can land before your next request, and the report is then written from the frontier.';
const END = 'No such tool? Carry on.';

describe('nudgeText (R29)', () => {
  it('gives every notice since the last compaction its own text, each firmer than the one before', () => {
    const rows: [notice: number, party: 'main' | 'subagent', text: string][] = [
      [1, 'main', `forward-compaction: context 55k and increasing. A compaction drops what you have read, so reading done just before one is done twice: once the step in hand has its result saved and checked, and before you read for the next step, call ${TOOL} ${ARGS}. ${FINISH} ${END}`],
      [2, 'main', `forward-compaction: context 55k, and every request re-sends all of it. As soon as the step in hand has its result saved and checked, and before any reading for the next step, call ${TOOL} ${ARGS}. ${FINISH} ${END}`],
      [3, 'main', `forward-compaction: context 55k. Start no new step and read nothing new: save the work in hand, then call ${TOOL} ${ARGS}. What later steps need travels in the frontier and storage. ${FINISH} ${END}`],
      [1, 'subagent', `forward-compaction: context 55k and increasing. A compaction drops what you have read, so reading done just before one is done twice: once the step in hand has its result saved and checked, and before you read for the next step, call ${TOOL} ${ARGS}. Skip it if all your work ends within a few calls. ${END}`],
      [2, 'subagent', `forward-compaction: context 55k, and every request re-sends all of it. As soon as the step in hand has its result saved and checked, and before any reading for the next step, call ${TOOL} ${ARGS}. Skip it only if your work ends within a few calls. ${END}`],
      [3, 'subagent', `forward-compaction: context 55k. Start no new step and read nothing new: save the work in hand, then call ${TOOL} ${ARGS}. What later steps need travels in the frontier and storage. Skip it only if the step in hand is your last. ${END}`],
      [4, 'main', `forward-compaction: context 55k. Compact now: your next call is ${TOOL} ${ARGS}. An unfinished step goes in remaining and next: a frontier needs no finished step. ${END}`],
      [5, 'main', `forward-compaction: context 55k. Nothing ahead needs this context: the frontier, storage and load_files carry what you will use, and look_back finds any exact old detail. Stop and call ${TOOL} ${ARGS}. ${END}`],
      [6, 'main', `forward-compaction: context 55k, 5 notices unanswered. Leave the work where it stands, finished or not, and call ${TOOL} ${ARGS}. ${END}`],
      [7, 'main', `forward-compaction: context 55k, 6 notices unanswered. Call ${TOOL} ${ARGS}, and nothing else: all other work waits for the wake. ${END}`],
      [9, 'subagent', `forward-compaction: context 55k, 8 notices unanswered. Call ${TOOL} ${ARGS}, and nothing else: all other work waits for the wake. ${END}`],
    ];
    for (const [notice, party, text] of rows) expect(nudgeText({ tokens: 55_400, party, notice })).toBe(text);
  });

  it('gives a sub-agent the same text as main from the fourth notice on', () => {
    for (const notice of [4, 5, 6, 7]) expect(nudgeText({ tokens: 55_400, party: 'subagent', notice })).toBe(nudgeText({ tokens: 55_400, party: 'main', notice }));
  });

  it('is the first notice to a main that holds no frontier when only the size is given, with the exact text', () => {
    expect(nudgeText({ tokens: 55_400 })).toBe(
      'forward-compaction: context 55k and increasing. A compaction drops what you have read, so reading done just before one is done twice: once the step in hand has its result saved and checked, and before you read for the next step, call mcp__forward-compaction__forward_compaction with objective, next and what the rest of the work needs added to orders, decisions, done, remaining and findings; what only a later step reads goes in storage (its value in storage.add); load_files only what the next step reads, a long file by its line range. If the whole work finishes first, call it before the final report, with the finished steps removed from remaining, next "write the final report", and all the report needs added to done and findings: the compaction can land before your next request, and the report is then written from the frontier. No such tool? Carry on.',
    );
  });

  it('asks a party that holds a frontier for its changes by item number, in every notice and with the exact text', () => {
    expect(nudgeText({ tokens: 55_400, held: true })).toBe(
      'forward-compaction: context 55k and increasing. A compaction drops what you have read, so reading done just before one is done twice: once the step in hand has its result saved and checked, and before you read for the next step, call mcp__forward-compaction__forward_compaction with only what changed since your last frontier, by item number: remove what is finished, lifted or wrong, edit what changed, add what is new; what only a later step reads goes in storage (its value in storage.add); load_files only what the next step reads, a long file by its line range. If the whole work finishes first, call it before the final report, with the finished steps removed from remaining, next "write the final report", and all the report needs added to done and findings: the compaction can land before your next request, and the report is then written from the frontier. No such tool? Carry on.',
    );
    expect(nudgeText({ tokens: 55_400, held: true, notice: 4 })).toBe(`forward-compaction: context 55k. Compact now: your next call is ${TOOL} ${CHANGED}. An unfinished step goes in remaining and next: a frontier needs no finished step. ${END}`);
    expect(nudgeText({ tokens: 213_000, held: true, last: true })).toBe(`forward-compaction: context 213k. Last notice: the plugin compacts this context itself before another comes, with no frontier from you, and you wake on its recorded facts alone. To wake on your own account of the work, call ${TOOL} ${CHANGED} now. ${END}`);
  });

  it('names what the plugin does next in the last notice before the ceiling, whatever its count or party', () => {
    const last = `forward-compaction: context 213k. Last notice: the plugin compacts this context itself before another comes, with no frontier from you, and you wake on its recorded facts alone. To wake on your own account of the work, call ${TOOL} ${ARGS} now. ${END}`;
    expect(nudgeText({ tokens: 213_000, notice: 1, last: true })).toBe(last);
    expect(nudgeText({ tokens: 213_000, party: 'subagent', notice: 4, last: true })).toBe(last);
  });

  it('names the storage folder when the party has one, so a later step\'s material is written there once and listed by name', () => {
    expect(nudgeText({ tokens: 55_400, notice: 4, storage: '/h/.local/state/forward-compaction/shop/s1/storage' })).toBe(
      `forward-compaction: context 55k. Compact now: your next call is ${TOOL} with objective, next and what the rest of the work needs added to orders, decisions, done, remaining and findings; what only a later step reads goes in storage (write it as a .md file in /h/.local/state/forward-compaction/shop/s1/storage/, then storage.add its name and description); load_files only what the next step reads, a long file by its line range. An unfinished step goes in remaining and next: a frontier needs no finished step. ${END}`,
    );
  });

  it('names the registered tool, so a -dev copy is called by its own name', () => {
    expect(nudgeText({ tokens: 213_000, tool: DEV_TOOL, notice: 4 })).toBe(
      `forward-compaction: context 213k. Compact now: your next call is ${DEV_TOOL} ${ARGS}. An unfinished step goes in remaining and next: a frontier needs no finished step. ${END}`,
    );
  });
});

describe('finishText', () => {
  it('tells main, with the exact text, to compact when the whole work is finished, before the final report', () => {
    expect(finishText({ tokens: 126_800 })).toBe(
      'forward-compaction: context 127k. Nothing to do yet. When the whole work is finished, call mcp__forward-compaction__forward_compaction before the final report, so the user\'s reply meets a small context: the finished steps removed from remaining, next "write the final report", and all the report needs added to done and findings, as the compaction can land before your next request and the report is then written from the frontier. No such tool? Carry on.',
    );
  });

  it('names the registered tool', () => {
    expect(finishText({ tokens: 100_000, tool: DEV_TOOL })).toBe(
      `forward-compaction: context 100k. Nothing to do yet. When the whole work is finished, call ${DEV_TOOL} before the final report, so the user's reply meets a small context: the finished steps removed from remaining, next "write the final report", and all the report needs added to done and findings, as the compaction can land before your next request and the report is then written from the frontier. No such tool? Carry on.`,
    );
  });
});

describe('noticeFor', () => {
  const MARKS = { room: 60_000, start: 150_000, every: 50_000, ceiling: 600_000, finish: 100_000 };
  const haiku = (): Parties => { const parties = new Parties(); parties.describe('main', { label: 'main', model: 'claude-haiku-4-5' }); return parties; };

  it('names why no nudge goes, and sends nothing, with no reading, no marks, below both starts, or to an ignored model', () => {
    expect(noticeFor(new Parties(), 'main', undefined, MARKS, ['haiku'])).toEqual({ level: 0, withheld: 'no-reading' });
    expect(noticeFor(new Parties(), 'main', 120_000, undefined, ['haiku'])).toEqual({ level: 0, withheld: 'window-unknown' });
    expect(noticeFor(new Parties(), 'main', 99_999, MARKS, ['haiku'])).toEqual({ level: 0, withheld: 'below-start' });
    expect(noticeFor(haiku(), 'main', 120_000, MARKS, ['haiku'])).toEqual({ level: 0, withheld: 'below-start' });
    expect(noticeFor(haiku(), 'main', 160_000, MARKS, ['haiku'])).toEqual({ level: 1, withheld: 'ignored-model' });
  });

  it('sends the finish notice once to a party with a finish start, and none to one without', () => {
    const parties = new Parties();
    const text = 'forward-compaction: context 120k. Nothing to do yet. When the whole work is finished, call mcp__forward-compaction__forward_compaction before the final report, so the user\'s reply meets a small context: the finished steps removed from remaining, next "write the final report", and all the report needs added to done and findings, as the compaction can land before your next request and the report is then written from the frontier. No such tool? Carry on.';
    expect(noticeFor(parties, 'main', 120_000, MARKS, ['haiku'])).toEqual({ level: 0, withheld: 'below-start', sent: { row: { event: 'finish-notice', party: 'main', tokens: 120_000, start: 100_000 }, text } });
    expect(noticeFor(parties, 'main', 130_000, MARKS, ['haiku'])).toEqual({ level: 0, withheld: 'below-start' });
    expect(noticeFor(new Parties(), 'agent:a1', 120_000, { room: 60_000, start: 150_000, every: 50_000, ceiling: 600_000 }, ['haiku'])).toEqual({ level: 0, withheld: 'below-start' });
  });

  it('sends each nudge from a set start with its count since the last compaction, a sub-agent\'s in its own words, asking a party that holds nothing for a first frontier, the one before the ceiling as the last', () => {
    const parties = new Parties();
    expect(noticeFor(parties, 'agent:a1', 160_000, MARKS, ['haiku'], DEV_TOOL)).toEqual({
      level: 1,
      sent: { row: { event: 'nudge', party: 'agent:a1', level: 1, notice: 1, last: false, tokens: 160_000, start: 150_000, every: 50_000 }, text: `forward-compaction: context 160k and increasing. A compaction drops what you have read, so reading done just before one is done twice: once the step in hand has its result saved and checked, and before you read for the next step, call ${DEV_TOOL} ${ARGS}. Skip it if all your work ends within a few calls. ${END}` },
    });
    expect(noticeFor(parties, 'agent:a1', 170_000, MARKS, ['haiku'])).toEqual({ level: 1, withheld: 'not-due' });
    expect(noticeFor(parties, 'agent:a1', 550_000, MARKS, ['haiku'])).toEqual({
      level: 9,
      sent: { row: { event: 'nudge', party: 'agent:a1', level: 9, notice: 2, last: true, tokens: 550_000, start: 150_000, every: 50_000 }, text: `forward-compaction: context 550k. Last notice: the plugin compacts this context itself before another comes, with no frontier from you, and you wake on its recorded facts alone. To wake on your own account of the work, call ${TOOL} ${ARGS} now. ${END}` },
    });
  });

  it('with no start set, starts a party\'s nudges its working room above its floor, again above its first reading after a compaction, and again as the first notice above a reading that fell below its floor; a party with no floor yet is at its floor, and a floor alone is no frontier', () => {
    const marks = { room: 60_000, every: 15_000, ceiling: 800_000 };
    const parties = new Parties();
    const at = (tokens: number) => (parties.read('agent:a1', tokens), noticeFor(parties, 'agent:a1', tokens, marks, ['haiku']));
    expect(noticeFor(parties, 'agent:a2', 70_000, marks, ['haiku'])).toEqual({ level: 0, withheld: 'below-start' });
    expect([at(42_000), at(101_999)]).toEqual([{ level: 0, withheld: 'below-start' }, { level: 0, withheld: 'below-start' }]);
    expect(at(102_000)).toEqual({
      level: 1,
      sent: { row: { event: 'nudge', party: 'agent:a1', level: 1, notice: 1, last: false, tokens: 102_000, start: 102_000, every: 15_000 }, text: `forward-compaction: context 102k and increasing. A compaction drops what you have read, so reading done just before one is done twice: once the step in hand has its result saved and checked, and before you read for the next step, call ${TOOL} ${ARGS}. Skip it if all your work ends within a few calls. ${END}` },
    });
    parties.installed('agent:a1');
    expect([at(45_000), at(104_999)]).toEqual([{ level: 0, withheld: 'below-start' }, { level: 0, withheld: 'below-start' }]);
    expect(at(105_000).sent?.row).toEqual({ event: 'nudge', party: 'agent:a1', level: 1, notice: 1, last: false, tokens: 105_000, start: 105_000, every: 15_000 });
    expect(at(119_999)).toEqual({ level: 1, withheld: 'not-due' });
    expect(at(120_000).sent?.row).toEqual({ event: 'nudge', party: 'agent:a1', level: 2, notice: 2, last: false, tokens: 120_000, start: 105_000, every: 15_000 });
    expect([at(30_000), at(89_999)]).toEqual([{ level: 0, withheld: 'below-start' }, { level: 0, withheld: 'below-start' }]); // a compaction this plugin did not make
    expect(at(90_000).sent?.row).toEqual({ event: 'nudge', party: 'agent:a1', level: 1, notice: 1, last: false, tokens: 90_000, start: 90_000, every: 15_000 });
  });

  it('asks a party holding a frontier for its changes by item number and shows it no list, in every notice of a cycle', () => {
    const parties = new Parties(), held = emptyHeld();
    held.objective = 'Fix the parser';
    held.lists.orders.items.push({ id: 1, text: 'no new dependencies' });
    parties.get('main').held = held;
    expect(noticeFor(parties, 'main', 160_000, MARKS, ['haiku'])?.sent?.text).toBe(`forward-compaction: context 160k and increasing. A compaction drops what you have read, so reading done just before one is done twice: once the step in hand has its result saved and checked, and before you read for the next step, call ${TOOL} ${CHANGED}. ${FINISH} ${END}`);
    expect(noticeFor(parties, 'main', 210_000, MARKS, ['haiku'])?.sent?.text).toBe(`forward-compaction: context 210k, and every request re-sends all of it. As soon as the step in hand has its result saved and checked, and before any reading for the next step, call ${TOOL} ${CHANGED}. ${FINISH} ${END}`);
  });
});

describe('k', () => {
  it('prints thousands as k and a million or more as M with at most one decimal', () => {
    expect([0, 999, 51_400, 999_499].map(k)).toEqual(['0k', '1k', '51k', '999k']);
    expect([999_500, 1_000_000, 1_049_999, 1_500_000, 2_000_000].map(k)).toEqual(['1M', '1M', '1M', '1.5M', '2M']);
  });
});
