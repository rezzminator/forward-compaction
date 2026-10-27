import { describe, expect, it } from 'vitest';
import { askPointOf, ceilingTokens, charsPerToken, ignoredBy, loadFilesRoom, partyMarks, RATIO_MIN_GROWTH, RATIO_RANGE, startWarnings, apiChars } from '../plugins/forward-compaction/src/window.ts';

describe('askPointOf: the ask point from $.session.usage', () => {
  it("is the breakdown's autoCompactThreshold when Claude Code reports one", () => {
    expect(askPointOf({ autoCompactThreshold: 63_000, rawMaxTokens: 100_000, autocompactSource: 'env' }, 1_000_000)).toEqual({ tokens: 63_000, source: 'autoCompactThreshold' });
  });

  it('falls back to rawMaxTokens with auto-compaction off, naming the threshold missing', () => {
    expect(askPointOf({ rawMaxTokens: 1_000_000, autocompactSource: 'model-default' }, 1_000_000)).toEqual({ tokens: 1_000_000, source: 'rawMaxTokens', missing: 'autoCompactThreshold' });
  });

  it("falls back to main's context.window with no breakdown, naming the breakdown missing, and is undefined with no window either", () => {
    expect(askPointOf(undefined, 200_000)).toEqual({ tokens: 200_000, source: 'window', missing: 'breakdown' });
    expect(askPointOf({}, 200_000)).toEqual({ tokens: 200_000, source: 'window', missing: 'autoCompactThreshold' });
    expect(askPointOf(undefined, undefined)).toBeUndefined();
    expect(askPointOf({ autoCompactThreshold: 0 }, 0)).toBeUndefined();
  });
});

describe('ignoredBy (Ignored models)', () => {
  it('is the list entry the model id holds, case-insensitive', () => {
    expect(ignoredBy('claude-haiku-4-5-20251001', ['haiku'])).toBe('haiku');
    expect(ignoredBy('us.anthropic.Claude-HAIKU-5-5', ['haiku'])).toBe('haiku');
    expect(ignoredBy('gpt-6-sol', ['haiku', 'gpt'])).toBe('gpt');
  });

  it('is undefined for a model no entry matches, an empty list, an empty entry or a model not known yet', () => {
    expect(ignoredBy('claude-opus-5-5', ['haiku'])).toBeUndefined();
    expect(ignoredBy('claude-haiku-4-5', [])).toBeUndefined();
    expect(ignoredBy('claude-haiku-4-5', [''])).toBeUndefined();
    expect(ignoredBy(undefined, ['haiku'])).toBeUndefined();
  });
});

describe('ceilingTokens', () => {
  it("is the size against the party's max context", () => {
    expect(ceilingTokens({ percent: 60 }, 200_000)).toBe(120_000);
    expect(ceilingTokens({ percent: 60 }, 1_000_000)).toBe(600_000);
    expect(ceilingTokens({ tokens: 40_000 }, 200_000)).toBe(40_000);
  });
});

describe('apiChars and charsPerToken: the ratio measured on the growth', () => {
  const file = 'x'.repeat(35_000);
  const window = [
    { role: 'user', content: [{ type: 'text', text: 'read the files' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'both files', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.go' } }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'b.go' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: file }, { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: file }, { type: 'image', source: { type: 'base64', data: 'AAAA' } }] }] },
  ];

  it("counts a live window's text, thinking, tool inputs as JSON and tool results' text, and no media", () => {
    expect(apiChars(window)).toBe(14 + 10 + 2 * JSON.stringify({ file_path: 'a.go' }).length + 70_000);
    expect(apiChars([window[2]!])).toBe(70_000);
    expect(apiChars([{ role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Bash' }] }])).toBe(2);
    expect(apiChars([])).toBe(0);
  });

  it('is the character growth over the token growth since the base: 40k of fixed overhead cancels', () => {
    // base: a 12,000-character brief at a 44,800 reading (40k system prompt and tools); then 48,000 characters over 19,200 tokens
    expect(charsPerToken({ chars: 12_000, tokens: 44_800 }, 60_000, 64_000)).toEqual({ ratio: 2.5 });
  });

  it('is unmeasured with no base, reading or characters', () => {
    expect(charsPerToken(undefined, 70_000, 64_000)).toEqual({ why: 'no-base' });
    expect(charsPerToken({ chars: 0, tokens: 40_000 }, 70_000, undefined)).toEqual({ why: 'no-reading' });
    expect(charsPerToken({ chars: 0, tokens: 40_000 }, undefined, 64_000)).toEqual({ why: 'no-chars' });
  });

  it('is unmeasured while the growth is under RATIO_MIN_GROWTH tokens, and measured from it', () => {
    expect(RATIO_MIN_GROWTH).toBe(5_000);
    expect(charsPerToken({ chars: 12_000, tokens: 60_000 }, 21_997, 63_999)).toEqual({ why: 'below-min-growth' });
    expect(charsPerToken({ chars: 12_000, tokens: 60_000 }, 24_500, 65_000)).toEqual({ ratio: 2.5 });
  });

  it('is unmeasured outside RATIO_RANGE, naming the ratio it found', () => {
    expect(RATIO_RANGE).toEqual({ min: 1, max: 8 });
    expect(charsPerToken({ chars: 0, tokens: 40_000 }, 200_000, 60_000)).toEqual({ why: 'out-of-range', delta: 10 });
    expect(charsPerToken({ chars: 100_000, tokens: 40_000 }, 110_000, 60_000)).toEqual({ why: 'out-of-range', delta: 0.5 });
    expect(charsPerToken({ chars: 0, tokens: 40_000 }, 20_000, 60_000)).toEqual({ ratio: 1 });
    expect(charsPerToken({ chars: 0, tokens: 40_000 }, 160_000, 60_000)).toEqual({ ratio: 8 });
  });
});

describe('loadFilesRoom (M4)', () => {
  it("is 5% of the party's max context at its measured ratio, unbounded with none", () => {
    expect(loadFilesRoom(1_000_000, 2)).toBe(100_000);
    expect(loadFilesRoom(400_000, 2.5)).toBe(50_000);
    expect(loadFilesRoom(1_000_000, undefined)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('partyMarks: a party sized against its max context', () => {
  const sub = { ceiling: { percent: 80 }, nudgeStart: { percent: 40 }, nudgeEvery: { percent: 10 } };

  it('sizes the ceiling and nudges against the max context, the ask point held at or below it (Ignored models example)', () => {
    expect(partyMarks(sub, 200_000, 63_000)).toEqual({ maxContext: 200_000, askPoint: 63_000, ceiling: 160_000, start: 80_000, every: 20_000 });
    expect(partyMarks(sub, 200_000, 963_000)).toMatchObject({ askPoint: 200_000 });
    expect(partyMarks(sub, 200_000, undefined)).toMatchObject({ askPoint: 200_000 });
  });

  it("is undefined while main's max context is not known", () => {
    expect(partyMarks(sub, undefined, 63_000)).toBeUndefined();
  });
});

describe('startWarnings: what session.start names once, from the API numbers', () => {
  const sub = { maxContext: 200_000, askPoint: 63_000, ceiling: 160_000, start: 80_000, every: 20_000 };
  const main = { maxContext: 1_000_000, askPoint: 63_000, ceiling: 600_000, start: 150_000, every: 50_000 };

  it("names a compaction window past 100k by Claude Code's own rawMaxTokens, source and ask point", () => {
    const warnings = startWarnings({ rawMaxTokens: 1_000_000, autocompactSource: 'model-default', autoCompactThreshold: 967_000 }, { tokens: 967_000, source: 'autoCompactThreshold' }, main, { ...sub, askPoint: 200_000 });
    expect(warnings[0]).toEqual({
      key: 'compact-window',
      line: 'forward-compaction: Claude Code compacts against a 1M window (model-default) and asks to compact from about 967k, so a handoff installs no earlier. Set CLAUDE_CODE_AUTO_COMPACT_WINDOW to 100000 in your settings env.',
      row: { event: 'warning', key: 'compact-window', rawMaxTokens: 1_000_000, autocompactSource: 'model-default', askPoint: 967_000 },
    });
  });

  it('names a party whose ceiling is below its ask point, and nothing for a 100k compaction window', () => {
    const ok = { rawMaxTokens: 100_000, autocompactSource: 'env', autoCompactThreshold: 63_000 };
    expect(startWarnings(ok, { tokens: 63_000, source: 'autoCompactThreshold' }, main, sub)).toEqual([]);
    expect(startWarnings(ok, { tokens: 63_000, source: 'autoCompactThreshold' }, { ...main, ceiling: 50_000 }, { ...sub, ceiling: 40_000 }).map((w) => [w.key, w.line])).toEqual([
      ['ceiling-below-ask', "forward-compaction: the main ceiling 50k is below Claude Code's ask point 63k; a main with no handoff is compacted mechanically at its first ask."],
      ['ceiling-below-ask:subagent', "forward-compaction: the sub-agent ceiling 40k is below Claude Code's ask point 63k; a sub-agent with no handoff is compacted mechanically at its first ask."],
    ]);
  });

  it("names nothing it cannot read: no breakdown, no ask point, or main's marks not known", () => {
    expect(startWarnings(undefined, undefined, undefined, sub)).toEqual([]);
  });
});
