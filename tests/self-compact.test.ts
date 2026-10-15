import { describe, expect, it } from 'vitest';
import { armedText, compactMarker, disarmedText, markerRequest, nudgeLevel, nudgeText, stopRequest } from '../plugins/sub-agent-compact/src/nudge.ts';
import { ENGINE_COMPACT_BUFFER, engineAskPoint, isHaiku, modelWindow } from '../plugins/sub-agent-compact/src/window.ts';
import * as windowModule from '../plugins/sub-agent-compact/src/window.ts';

const future: Record<string, any> = windowModule;

describe('forcedPoint', () => {
  it.each([
    [{ tokens: 600_000 }, 200_000, { limit: 167_000, set: 600_000, clamped: true }],
    [{ tokens: 150_000 }, 200_000, { limit: 150_000, set: 150_000, clamped: false }],
    [{ percent: 60 }, 1_000_000, { limit: 600_000, set: 600_000, clamped: false }],
    [{ percent: 100 }, 200_000, { limit: 167_000, set: 200_000, clamped: true }],
  ])('clamps %j against a %i window to Claude Code\'s ask point', (size, window, expected) => {
    expect(future.forcedPoint?.(size, window)).toEqual(expected);
  });
});

describe('modelWindow', () => {
  it('knows Haiku at 200k, a [1m] id and Sonnet 5 at 1M', () => {
    expect(modelWindow('claude-haiku-4-5-20251001', 1_000_000)).toBe(200_000);
    // Haiku 5.5 is natively 1M in Claude Code 2.1.300's model table (`context:{window:1e6,native_1m:!0}`), on every provider id.
    expect(modelWindow('claude-haiku-5-5', 200_000)).toBe(1_000_000);
    expect(modelWindow('us.anthropic.claude-haiku-5-5', 200_000)).toBe(1_000_000);
    expect(modelWindow('anthropic.claude-haiku-5-5', 200_000)).toBe(1_000_000);
    expect(modelWindow('claude-opus-5-5[1m]', 200_000)).toBe(1_000_000);
    expect(modelWindow('claude-sonnet-5', 200_000)).toBe(1_000_000);
  });

  it('falls back to the given window for a Claude model it does not know, or none', () => {
    expect(modelWindow('claude-opus-5-5', 400_000)).toBe(400_000);
    expect(modelWindow('us.anthropic.claude-opus-5-5', 400_000)).toBe(400_000);
    expect(modelWindow('opus', 400_000)).toBe(400_000);
    expect(modelWindow(undefined, 400_000)).toBe(400_000);
  });

  it("gives a model that is not Claude, such as a GPT model behind a gateway, Claude Code's default 200k", () => {
    expect(modelWindow('gpt-6-sol', 1_000_000)).toBe(200_000);
    expect(modelWindow('gpt-6-luna', 400_000)).toBe(200_000);
  });
});

describe('isHaiku', () => {
  it('matches Haiku ids and aliases only', () => {
    expect(isHaiku('claude-haiku-4-5-20251001')).toBe(true);
    expect(isHaiku('haiku')).toBe(true);
    expect(isHaiku('claude-sonnet-5')).toBe(false);
    expect(isHaiku(undefined)).toBe(false);
  });
});

describe('engineAskPoint', () => {
  it('is the window less the engine buffer', () => {
    expect(ENGINE_COMPACT_BUFFER).toBe(33_000);
    expect(engineAskPoint(100_000)).toBe(67_000);
    expect(engineAskPoint(200_000)).toBe(167_000);
  });
});

describe('nudgeLevel', () => {
  it('is -1 below the start, then one level per step past it', () => {
    expect(nudgeLevel(99_999, 100_000, 100_000)).toBe(-1);
    expect(nudgeLevel(100_000, 100_000, 100_000)).toBe(0);
    expect(nudgeLevel(199_999, 100_000, 100_000)).toBe(0);
    expect(nudgeLevel(200_000, 100_000, 100_000)).toBe(1);
    expect(nudgeLevel(350_000, 100_000, 100_000)).toBe(2);
  });
});

describe('compactMarker', () => {
  it('reads the focus between the marker tags, trimmed', () => {
    expect(compactMarker('Files 1-8 done.\n<compact-now>\n plan in plan.md; next file 9 \n</compact-now>')).toBe('plan in plan.md; next file 9');
  });

  it('is undefined without the tags or with an empty focus', () => {
    expect(compactMarker('no marker here')).toBeUndefined();
    expect(compactMarker('<compact-now>   </compact-now>')).toBeUndefined();
    expect(compactMarker('<compact-now>unclosed')).toBeUndefined();
  });

  it('is undefined for a marker quoted in backticks', () => {
    expect(compactMarker('I used the `<compact-now>focus</compact-now>` tag with my next Read.')).toBeUndefined();
  });
});

describe('markerRequest', () => {
  const answer = 'Parts 1-2 done.\n<compact-now>next: part 3</compact-now>';

  it('arms a sub-agent whose response also calls a tool', () => {
    expect(markerRequest({ answer, toolCalls: 1, main: false })).toBe('next: part 3');
  });

  it('ignores a final answer, which calls no tool', () => {
    expect(markerRequest({ answer, toolCalls: 0, main: false })).toBeUndefined();
  });

  it('ignores the main chat, which asks through the tool and may relay a sub-agent answer', () => {
    expect(markerRequest({ answer, toolCalls: 2, main: true })).toBeUndefined();
  });
});

describe('stopRequest', () => {
  const lone = '<compact-now>files 1-10 renamed; next: net/lookup.go</compact-now>';

  it('keeps a sub-agent going once when it stopped on a lone marker', () => {
    expect(stopRequest({ lastMessage: lone, continued: false })).toBe('files 1-10 renamed; next: net/lookup.go');
  });

  it('lets it stop the second time, a quoted marker, or no message', () => {
    expect(stopRequest({ lastMessage: lone, continued: true })).toBeUndefined();
    expect(stopRequest({ lastMessage: 'Done. I used `<compact-now>focus</compact-now>` twice.', continued: false })).toBeUndefined();
    expect(stopRequest({ lastMessage: undefined, continued: false })).toBeUndefined();
  });
});

describe('nudgeText', () => {
  const base = { tokens: 212_000, window: 1_000_000, autoCompact: 300_000, toolName: 'mcp__sub-agent-compact__compact' };

  it('tells the main chat its size, its forced point and the tool', () => {
    const text = nudgeText({ ...base, level: 0, main: true });
    expect(text).toContain('212k tokens (21% of your 1000k window)');
    expect(text).toContain('forced at 300k');
    expect(text).toContain('mcp__sub-agent-compact__compact');
    expect(text).not.toContain('<compact-now>');
  });

  it('tells a party on its last job to finish it instead of compacting, at every level', () => {
    for (const level of [0, 1, 3]) {
      for (const main of [true, false]) {
        const text = nudgeText({ ...base, level, main });
        expect(text).toMatch(/last job/);
        expect(text).toMatch(/finish it first and do not compact/);
        expect(text.indexOf('last job')).toBeLessThan(text.indexOf('compact yourself'));
      }
    }
  });

  it('gives a sub-agent the marker beside the tool, and escalates past the first nudge', () => {
    const text = nudgeText({ ...base, level: 1, main: false });
    expect(text).toContain('<compact-now>');
    expect(text).toContain('mcp__sub-agent-compact__compact');
    expect(text).toContain('Nudge 2');
    expect(text).toContain('never alone');
  });

  it('tells the main chat that a person waiting on it comes before compacting, and a sub-agent nothing of the kind', () => {
    for (const level of [0, 2]) {
      const text = nudgeText({ ...base, level, main: true });
      expect(text).toMatch(/person/);
      expect(text).toMatch(/never compact while they wait/);
      expect(text.indexOf('person')).toBeLessThan(text.indexOf('compact yourself'));
    }
    expect(nudgeText({ ...base, level: 0, main: false })).not.toMatch(/person/);
  });
});

describe('armedText', () => {
  it('says when the compaction runs, by party and ask point', () => {
    expect(armedText({ main: true, tokens: 90_000, askPoint: 67_000 })).toMatch(/before your next model request/);
    expect(armedText({ main: true, tokens: 40_000, askPoint: 67_000 })).toMatch(/when this turn ends/);
    expect(armedText({ main: false, tokens: 90_000, askPoint: 67_000 })).toMatch(/before your next model request/);
    expect(armedText({ main: false, tokens: 40_000, askPoint: 67_000 })).toMatch(/once your context reaches 67k/);
    expect(armedText({ main: false, tokens: 40_000, askPoint: undefined })).toMatch(/when Claude Code next asks/);
  });
});

describe('disarmedText', () => {
  it('tells the model the person cancelled its compaction and not to arm again before their ask is done', () => {
    const text = disarmedText();
    expect(text).toMatch(/cancelled/);
    expect(text).toMatch(/do not ask to compact again/);
  });
});
