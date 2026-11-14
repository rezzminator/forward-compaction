import { describe, expect, it } from 'vitest';
import { finishText, k, lastNudge, noticeFor, nudgeLevel, nudgeText } from '../plugins/forward-compaction/src/nudge.ts';
import { Parties } from '../plugins/forward-compaction/src/parties.ts';

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

const TOOL = 'mcp__forward-compaction__forward_compaction';
const DEV_TOOL = 'mcp__forward-compaction-dev__forward_compaction';
const ARGS = 'with objective, decisions, done, remaining and next, and in load_files the files you will read again';
const FINISH = 'If the whole work finishes first, call it before the final report, with remaining "none", next "write the final report" and all the report needs in done and findings: the compaction can land before your next request, and the report is then written from the frontier.';
const END = 'No such tool? Carry on.';

describe('nudgeText (R29)', () => {
  it('gives every notice since the last compaction its own text, each firmer than the one before', () => {
    const rows: [notice: number, party: 'main' | 'subagent', text: string][] = [
      [1, 'main', `forward-compaction: context 55k and increasing. At your first milestone, call ${TOOL} ${ARGS}. A step that needs all of this context may reach its own milestone first. ${FINISH} ${END}`],
      [2, 'main', `forward-compaction: context 55k, and every request re-sends all of it. At the end of the step in hand, call ${TOOL} ${ARGS}: that is your milestone. ${FINISH} ${END}`],
      [3, 'main', `forward-compaction: context 55k. Start no new step: finish the one in hand, then call ${TOOL} ${ARGS}. What later steps need travels in the frontier and load_files. ${FINISH} ${END}`],
      [1, 'subagent', `forward-compaction: context 55k and increasing. At your first milestone, call ${TOOL} ${ARGS}. A step that needs all of this context may reach its own milestone first. Skip it if all your work ends within a few calls. ${END}`],
      [2, 'subagent', `forward-compaction: context 55k, and every request re-sends all of it. At the end of the step in hand, call ${TOOL} ${ARGS}: that is your milestone. Skip it only if your work ends within a few calls. ${END}`],
      [3, 'subagent', `forward-compaction: context 55k. Start no new step: finish the one in hand, then call ${TOOL} ${ARGS}. What later steps need travels in the frontier and load_files. Skip it only if the step in hand is your last. ${END}`],
      [4, 'main', `forward-compaction: context 55k. Compact now: your next call is ${TOOL} ${ARGS}. An unfinished step goes in remaining and next: a frontier needs no finished step. ${END}`],
      [5, 'main', `forward-compaction: context 55k. Nothing ahead needs this context: the frontier and load_files carry what you will use, and look_back finds any exact old detail. Stop and call ${TOOL} ${ARGS}. ${END}`],
      [6, 'main', `forward-compaction: context 55k, 5 notices unanswered. Leave the work where it stands, finished or not, and call ${TOOL} ${ARGS}. ${END}`],
      [7, 'main', `forward-compaction: context 55k, 6 notices unanswered. Call ${TOOL} ${ARGS}, and nothing else: all other work waits for the wake. ${END}`],
      [9, 'subagent', `forward-compaction: context 55k, 8 notices unanswered. Call ${TOOL} ${ARGS}, and nothing else: all other work waits for the wake. ${END}`],
    ];
    for (const [notice, party, text] of rows) expect(nudgeText({ tokens: 55_400, party, notice })).toBe(text);
  });

  it('gives a sub-agent the same text as main from the fourth notice on', () => {
    for (const notice of [4, 5, 6, 7]) expect(nudgeText({ tokens: 55_400, party: 'subagent', notice })).toBe(nudgeText({ tokens: 55_400, party: 'main', notice }));
  });

  it('is the first notice to main when only the size is given, with the exact text', () => {
    expect(nudgeText({ tokens: 55_400 })).toBe(
      'forward-compaction: context 55k and increasing. At your first milestone, call mcp__forward-compaction__forward_compaction with objective, decisions, done, remaining and next, and in load_files the files you will read again. A step that needs all of this context may reach its own milestone first. If the whole work finishes first, call it before the final report, with remaining "none", next "write the final report" and all the report needs in done and findings: the compaction can land before your next request, and the report is then written from the frontier. No such tool? Carry on.',
    );
  });

  it('names what the plugin does next in the last notice before the ceiling, whatever its count or party', () => {
    const last = `forward-compaction: context 213k. Last notice: the plugin compacts this context itself before another comes, with no frontier from you, and you wake on its recorded facts alone. To wake on your own account of the work, call ${TOOL} ${ARGS} now. ${END}`;
    expect(nudgeText({ tokens: 213_000, notice: 1, last: true })).toBe(last);
    expect(nudgeText({ tokens: 213_000, party: 'subagent', notice: 4, last: true })).toBe(last);
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
      'forward-compaction: context 127k. Nothing to do yet. When the whole work is finished, call mcp__forward-compaction__forward_compaction before the final report, so the person\'s reply meets a small context: objective, decisions, done, remaining "none" and next "write the final report", with all the report needs in done and findings, as the compaction can land before your next request and the report is then written from the frontier. No such tool? Carry on.',
    );
  });

  it('names the registered tool', () => {
    expect(finishText({ tokens: 100_000, tool: DEV_TOOL })).toBe(
      `forward-compaction: context 100k. Nothing to do yet. When the whole work is finished, call ${DEV_TOOL} before the final report, so the person's reply meets a small context: objective, decisions, done, remaining "none" and next "write the final report", with all the report needs in done and findings, as the compaction can land before your next request and the report is then written from the frontier. No such tool? Carry on.`,
    );
  });
});

describe('noticeFor', () => {
  const MARKS = { start: 150_000, every: 50_000, ceiling: 600_000, finish: 100_000 };
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
    const text = 'forward-compaction: context 120k. Nothing to do yet. When the whole work is finished, call mcp__forward-compaction__forward_compaction before the final report, so the person\'s reply meets a small context: objective, decisions, done, remaining "none" and next "write the final report", with all the report needs in done and findings, as the compaction can land before your next request and the report is then written from the frontier. No such tool? Carry on.';
    expect(noticeFor(parties, 'main', 120_000, MARKS, ['haiku'])).toEqual({ level: 0, withheld: 'below-start', sent: { row: { event: 'finish-notice', party: 'main', tokens: 120_000, start: 100_000 }, text } });
    expect(noticeFor(parties, 'main', 130_000, MARKS, ['haiku'])).toEqual({ level: 0, withheld: 'below-start' });
    expect(noticeFor(new Parties(), 'agent:a1', 120_000, { start: 150_000, every: 50_000, ceiling: 600_000 }, ['haiku'])).toEqual({ level: 0, withheld: 'below-start' });
  });

  it('sends each nudge with its count since the last compaction, a sub-agent\'s in its own words, the one before the ceiling as the last', () => {
    const parties = new Parties();
    expect(noticeFor(parties, 'agent:a1', 160_000, MARKS, ['haiku'], DEV_TOOL)).toEqual({
      level: 1,
      sent: { row: { event: 'nudge', party: 'agent:a1', level: 1, notice: 1, last: false, tokens: 160_000, start: 150_000, every: 50_000 }, text: `forward-compaction: context 160k and increasing. At your first milestone, call ${DEV_TOOL} ${ARGS}. A step that needs all of this context may reach its own milestone first. Skip it if all your work ends within a few calls. ${END}` },
    });
    expect(noticeFor(parties, 'agent:a1', 170_000, MARKS, ['haiku'])).toEqual({ level: 1, withheld: 'not-due' });
    expect(noticeFor(parties, 'agent:a1', 550_000, MARKS, ['haiku'])).toEqual({
      level: 9,
      sent: { row: { event: 'nudge', party: 'agent:a1', level: 9, notice: 2, last: true, tokens: 550_000, start: 150_000, every: 50_000 }, text: `forward-compaction: context 550k. Last notice: the plugin compacts this context itself before another comes, with no frontier from you, and you wake on its recorded facts alone. To wake on your own account of the work, call ${TOOL} ${ARGS} now. ${END}` },
    });
  });
});

describe('k', () => {
  it('prints thousands as k and a million or more as M with at most one decimal', () => {
    expect([0, 999, 51_400, 999_499].map(k)).toEqual(['0k', '1k', '51k', '999k']);
    expect([999_500, 1_000_000, 1_049_999, 1_500_000, 2_000_000].map(k)).toEqual(['1M', '1M', '1M', '1.5M', '2M']);
  });
});
