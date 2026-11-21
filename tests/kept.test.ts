import { describe, expect, it } from 'vitest';
import { fitTail, keptStart, splitAtCall, START_END } from '../plugins/forward-compaction/src/kept.ts';
import { assistant, results, user, type Msg } from './fakes/messages.ts';

describe("keptStart: a sub-agent's first messages, handed back before every wake", () => {
  const brief = user('Fix the parser. No git stash.', 'engine-brief');
  const built = { role: 'assistant', text: START_END, toolUses: [] };
  const facts = user('[forward-compaction: facts] earlier', 'engine-f');

  it('takes every user message the transcript opens with, and builds the line that ends them', () => {
    const more = user('One more thing: keep the old flag.', 'engine-more');
    expect(keptStart([brief, more, assistant('reading'), user('later')])).toEqual({ start: [brief, more], end: built });
    expect(keptStart([brief, more])!.start).toEqual([brief, more]);
  });

  it("hands back the engine's own end line once a wake has installed it", () => {
    const own = assistant(START_END, [], 'engine-end');
    const got = keptStart([brief, own, facts])!;
    expect(got.start).toEqual([brief]);
    expect(got.start[0]).toBe(brief);
    expect(got.end).toBe(own);
  });

  it.each([
    ['an assistant line of other words', assistant('I will read the parser first.', [], 'engine-1')],
    ['the end line beside a tool call', assistant(START_END, [{ id: 't1', tool: 'Read' }], 'engine-1')],
    ['the end line with no handle', { role: 'assistant', text: START_END, toolUses: [] } as unknown as Msg],
    ['a wake message, the start ending there', facts],
  ])('builds the end line when the start is followed by %s', (_name, next) => {
    const got = keptStart([brief, next])!;
    expect(got.start).toEqual([brief]);
    expect(got.end).toEqual(built);
    expect(got.end).not.toBe(next);
  });

  it.each([
    ['no message', []],
    ['a wake built without a start', [facts, user('[forward-compaction: frontier] earlier', 'engine-h')]],
    ["a mechanical wake's note", [user('[forward-compaction: no frontier written by the model] earlier', 'engine-n')]],
    ['a message with no handle', [{ role: 'user', text: 'built', toolUses: [] } as unknown as Msg, assistant('hi')]],
    ['an assistant message', [assistant('hi'), brief]],
    ['tool results', [results(['t1', 'r']), brief]],
  ])('has no start for a transcript that opens with %s', (_name, messages) => {
    expect(keptStart(messages)).toBeUndefined();
  });
});

describe('splitAtCall (R18)', () => {
  const u0 = user('start');
  const a1 = assistant('calling', [{ id: 't9', tool: 'mcp__forward-compaction__forward_compaction' }, { id: 't10', tool: 'Read', input: { file_path: '/a' } }]);
  const u2 = results(['t9', 'Frontier stored'], ['t10', 'file body']);
  const a3 = assistant('after');
  const u4 = user('next');

  it('returns the messages after the results, as the same objects, and the sibling calls with their results', () => {
    const split = splitAtCall([u0, a1, u2, a3, u4], 't9')!;
    expect(split.tail).toEqual([a3, u4]);
    expect(split.tail[0]).toBe(a3);
    expect(split.siblings).toEqual([{ tool: 'Read', input: { file_path: '/a' }, text: 'file body' }]);
  });

  it('returns undefined when the call is not in the transcript', () => {
    expect(splitAtCall([u0, a1, u2], 'nope')).toBeUndefined();
  });

  it('takes the run of assistant messages around the anchor as one response, and finds the last anchor', () => {
    const half = assistant('thinking', [{ id: 't8', tool: 'Grep' }]);
    const split = splitAtCall([u0, half, a1, results(['t8', 'g'], ['t9', 'ok'], ['t10', 'r']), a3], 't9')!;
    expect(split.tail).toEqual([a3]);
    expect(split.siblings.map((s) => [s.tool, s.text])).toEqual([['Grep', 'g'], ['Read', 'r']]);
  });

  it('anchors on the last of two messages holding the call, and takes assistant messages after it into the response', () => {
    const late = assistant('more calls', [{ id: 't11', tool: 'Grep' }]);
    const split = splitAtCall([a1, u2, u0, a1, late, results(['t9', 'ok'], ['t10', 'r'], ['t11', 'g']), a3], 't9')!;
    expect(split.tail).toEqual([a3]);
    expect(split.siblings.map((s) => [s.tool, s.text])).toEqual([['Read', 'r'], ['Grep', 'g']]);
  });

  it('stops at a user message answering this response and another call alike', () => {
    const mixed = results(['t10', 'r'], ['t0', 'old']);
    expect(splitAtCall([a1, results(['t9', 'ok']), mixed, a3], 't9')!.tail).toEqual([mixed, a3]);
  });

  it("takes a sibling's recorded result over the text on its call", () => {
    const withText: Msg = { ...a1, toolUses: a1.toolUses.map((u) => ({ ...u, text: 'call text' })) };
    expect(splitAtCall([withText, u2], 't9')!.siblings[0]!.text).toBe('file body');
  });

  it('stops at a user message whose results answer other calls, leaving it in the tail', () => {
    const stray = results(['t0', 'old']);
    expect(splitAtCall([u0, a1, u2, stray, a3], 't9')!.tail).toEqual([stray, a3]);
  });

  it('says so for a sibling whose result was never recorded', () => {
    const split = splitAtCall([a1, results(['t9', 'ok'])], 't9')!;
    expect(split.siblings[0]!.text).toBe('(no result recorded)');
  });
});

describe('fitTail (R19)', () => {
  const orphan = results(['x', 'r'.repeat(700)]);
  const a = assistant('a'.repeat(350));
  const u = user('u'.repeat(350));
  const a2 = assistant('b'.repeat(350));

  it('drops from the oldest until the rest fits, then the leading tool-result user message too', () => {
    // orphan 200 tokens, a/u/a2 100 each: budget 300 keeps the last three
    expect(fitTail([orphan, a, u, a2], 300, 3.5)).toEqual({ messages: [a, u, a2], dropped: 1 });
    // budget 250 drops `a` too
    expect(fitTail([orphan, a, u, a2], 250, 3.5)).toEqual({ messages: [u, a2], dropped: 2 });
  });

  it('never starts with a tool-result user message, even when the budget would keep it', () => {
    const kept = fitTail([assistant('x', [{ id: 'x', tool: 'Read' }]), orphan, a], 100_000, 3.5);
    expect(kept.messages[0]!.toolResults).toBeUndefined();
    const dropOrphan = fitTail([a, orphan, u], 100_000, 3.5 /* all fit */);
    expect(dropOrphan.messages).toEqual([a, orphan, u]);
    expect(fitTail([orphan, orphan, a], 100_000, 3.5).messages).toEqual([a]);
  });

  it('sizes a message by its tool inputs and its tool results, not its text alone', () => {
    const bigInput = assistant('', [{ id: 'w', tool: 'Write', input: { content: 'i'.repeat(7000) } }]);
    expect(fitTail([bigInput, u], 300, 3.5).messages).toEqual([u]);
    const bigResult = results(['w', 'r'.repeat(7000)]);
    expect(fitTail([a, bigResult, u], 300, 3.5).messages).toEqual([u]);
  });

  it('keeps the input objects, and nothing for a zero budget', () => {
    const kept = fitTail([a, u], 1000, 3.5).messages;
    expect(kept[0]).toBe(a);
    expect(fitTail([a, u], 0, 3.5)).toEqual({ messages: [], dropped: 2 });
  });
});
