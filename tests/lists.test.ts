import { describe, expect, it } from 'vitest';
import { doneFiled, doneLines, doneSizes, doneSplit, emptyHeld, emptyList, frontierSize, listApply, renderFrontier, roundPassed, sizeLines, textApply, unchangedNote, type Item, type List } from '../plugins/forward-compaction/src/lists.ts';

const list = (...texts: string[]): List => ({ next_id: texts.length + 1, items: texts.map((text, i) => ({ id: i + 1, text })) });
const shown = (l: List): string[] => l.items.map((item) => `[${item.id}] ${item.text}`);

describe('listApply: one call\'s change to one list, by item number', () => {
  const cases: { name: string; list: List; change: unknown; list_: string[]; next: number; lines: string[]; notes: string[] }[] = [
    { name: 'a first call of adds numbers them from 1', list: emptyList(), change: { add: ['a', 'b'] }, list_: ['[1] a', '[2] b'], next: 3, lines: ['Added to decisions: [1], [2]'], notes: [] },
    { name: 'a remove leaves the other numbers as they were, never shifted', list: list('a', 'b', 'c'), change: { remove: [2] }, list_: ['[1] a', '[3] c'], next: 4, lines: ['Removed from decisions: [2] b'], notes: [] },
    { name: 'a number is never reused: an add after a remove takes the next free one', list: { next_id: 4, items: [{ id: 1, text: 'a' }, { id: 3, text: 'c' }] }, change: { add: ['d'] }, list_: ['[1] a', '[3] c', '[4] d'], next: 5, lines: ['Added to decisions: [4]'], notes: [] },
    { name: 'an edit replaces the whole text and keeps its number and place', list: list('a', 'b'), change: { edit: [{ id: 1, text: 'A' }] }, list_: ['[1] A', '[2] b'], next: 3, lines: ['Edited in decisions: [1], was: a'], notes: [] },
    { name: 'removes and edits aim at the numbers seen, then the adds', list: list('a', 'b'), change: { add: ['c'], remove: [1], edit: [{ id: 2, text: 'B' }] }, list_: ['[2] B', '[3] c'], next: 4, lines: ['Added to decisions: [3]', 'Removed from decisions: [1] a', 'Edited in decisions: [2], was: b'], notes: [] },
    { name: 'a number both removed and edited is removed, with a note', list: list('a'), change: { remove: [1], edit: [{ id: 1, text: 'A' }] }, list_: [], next: 2, lines: ['Removed from decisions: [1] a'], notes: ['decisions.edit[0]: [1] is also removed: removed.'] },
    { name: 'an add equal to a live item across spacing and case is skipped as already', list: list('Keep the gate under 200 s.'), change: { add: ['keep  the gate\nunder 200 S.', 'new'] }, list_: ['[1] Keep the gate under 200 s.', '[2] new'], next: 3, lines: ['Added to decisions: [2]', 'Skipped in decisions: already [1]'], notes: [] },
    { name: 'the same text added twice in one call is added once', list: emptyList(), change: { add: ['x', 'X'] }, list_: ['[1] x'], next: 2, lines: ['Added to decisions: [1]', 'Skipped in decisions: already [1]'], notes: [] },
    { name: 'a number not live, a blank text and a malformed entry are each skipped with a note naming its place', list: list('a'), change: { add: ['', 7], remove: [9, 'x'], edit: [{ id: 5, text: 't' }, { id: 1, text: ' ' }, { text: 'no id' }] }, list_: ['[1] a'], next: 2, lines: [], notes: ['decisions.add[0] is blank: skipped.', 'decisions.add[1] must be a text; got number: skipped.', 'decisions.remove[1] must be an item number; got string: skipped.', 'decisions.edit[1].text is blank: skipped.', 'decisions.edit[2].id must be an item number; got undefined: skipped.', 'decisions.remove[0]: [9] is not a live item: skipped.', 'decisions.edit[0]: [5] is not a live item: skipped.'] },
    { name: 'an item of 80 characters that left is shown whole', list: list('a'.repeat(80), 'b'.repeat(80)), change: { remove: [1], edit: [{ id: 2, text: 'B' }] }, list_: ['[2] B'], next: 3, lines: [`Removed from decisions: [1] ${'a'.repeat(80)}`, `Edited in decisions: [2], was: ${'b'.repeat(80)}`], notes: [] },
    { name: 'a longer one is shown by its first 80 characters, on one line', list: list(`one\ntwo ${'a'.repeat(73)}`, 'b'.repeat(81)), change: { remove: [1], edit: [{ id: 2, text: 'B' }] }, list_: ['[2] B'], next: 3, lines: [`Removed from decisions: [1] one two ${'a'.repeat(72)}…`, `Edited in decisions: [2], was: ${'b'.repeat(80)}…`], notes: [] },
    { name: 'a plain text is one added item', list: emptyList(), change: 'the whole section, as before', list_: ['[1] the whole section, as before'], next: 2, lines: ['Added to decisions: [1]'], notes: ['decisions was a text, not {add, remove, edit}: taken as one added item.'] },
    { name: 'an operation name sent alone is no item', list: list('a'), change: ' Add ', list_: ['[1] a'], next: 2, lines: [], notes: ['decisions was only the word "add", an operation with no item: nothing changed.'] },
    { name: 'an added text loses the number written before it, an edit only its own number, and a number that is the whole text or runs into a word stays', list: list('a', 'b'), change: { add: ['[3] c', '[9] d', '[5]', '[2]nd run'], edit: [{ id: 1, text: '[1] A' }, { id: 2, text: '[7] see B' }] }, list_: ['[1] A', '[2] [7] see B', '[3] c', '[4] d', '[5] [5]', '[6] [2]nd run'], next: 7, lines: ['Added to decisions: [3], [4], [5], [6]', 'Edited in decisions: [1], was: a', 'Edited in decisions: [2], was: b'], notes: [] },
    { name: 'an array sent straight is its adds', list: emptyList(), change: ['a', 'b'], list_: ['[1] a', '[2] b'], next: 3, lines: ['Added to decisions: [1], [2]'], notes: ['decisions was an array, not {add, remove, edit}: taken as its adds.'] },
    { name: 'a number sent as a string and a lone number are read as numbers', list: list('a', 'b', 'c'), change: { remove: ['[1]', '3'] }, list_: ['[2] b'], next: 4, lines: ['Removed from decisions: [1] a', 'Removed from decisions: [3] c'], notes: [] },
    { name: 'an unknown operation and a non-object change are named', list: list('a'), change: { replace: 'x' }, list_: ['[1] a'], next: 2, lines: [], notes: ['decisions.replace is not add, remove or edit: ignored.'] },
    { name: 'an edit to the same text changes nothing', list: list('a'), change: { edit: [{ id: 1, text: 'a' }] }, list_: ['[1] a'], next: 2, lines: [], notes: ['decisions.edit[0]: [1] already reads so: unchanged.'] },
    { name: 'before is for remaining only', list: emptyList(), change: { add: [{ before: 1, text: 'x' }] }, list_: ['[1] x'], next: 2, lines: ['Added to decisions: [1]'], notes: ['decisions.add[0].before is for remaining only: added last.'] },
    { name: 'an edit entry that is no {id, text} and an add entry with a key it does not take are each named', list: list('a'), change: { add: [{ id: 1, text: 'b' }], edit: [1] }, list_: ['[1] a', '[2] b'], next: 3, lines: ['Added to decisions: [2]'], notes: ['decisions.add[0].id is not text or before: ignored.', 'decisions.edit[0] must be {id, text}; got number: skipped.'] },
  ];
  it.each(cases)('$name', ({ list: before, change, list_, next, lines, notes }) => {
    const out = listApply('decisions', before, change);
    expect([shown(out.list), out.list.next_id, out.lines, out.notes]).toEqual([list_, next, lines, notes]);
  });

  it('names a change that is no list change at all', () => {
    expect(listApply('done', list('a'), 5).notes).toEqual(['done must be {add, remove, edit}; got number: nothing changed.']);
    expect(listApply('done', list('a'), '  ').notes).toEqual(['done was blank: nothing changed.']);
  });

  it('records each value that left, and counts each kind of change', () => {
    const out = listApply('done', list('a', 'b', 'c'), { remove: [1], edit: [{ id: 2, text: 'B' }], add: ['c', 'd'] });
    expect([out.left, out.count]).toEqual([[{ id: 2, text: 'b', left: 'edited' }, { id: 1, text: 'a', left: 'removed' }], { added: 1, removed: 1, edited: 1, skipped: 1 }]);
  });

  it('stamps an added or edited item with the round it happened in, leaves an untouched one its own, and stamps none at round 0', () => {
    const before: List = { next_id: 4, items: [{ id: 1, text: 'a' }, { id: 2, text: 'b', round: 1 }, { id: 3, text: 'c', round: 1 }] };
    expect(listApply('done', before, { edit: [{ id: 3, text: 'C' }], add: ['d'] }, 2).list).toEqual({ next_id: 5, items: [{ id: 1, text: 'a' }, { id: 2, text: 'b', round: 1 }, { id: 3, text: 'C', round: 2 }, { id: 4, text: 'd', round: 2 }] });
    expect(listApply('done', emptyList(), { add: ['a'] }).list).toEqual({ next_id: 2, items: [{ id: 1, text: 'a' }] });
  });

  it('stamps an added item with the call\'s time, keeps it through an edit, carries it into each value that leaves, and invents none for an item stored without one', () => {
    const at = '2026-10-27T14:53:00.000Z', later = '2026-10-28T09:00:00.000Z';
    const first = listApply('done', { next_id: 2, items: [{ id: 1, text: 'old' }] }, { add: ['a', 'b'] }, 0, at);
    expect(first.list).toEqual({ next_id: 4, items: [{ id: 1, text: 'old' }, { id: 2, text: 'a', added: at }, { id: 3, text: 'b', added: at }] });
    const second = listApply('done', first.list, { edit: [{ id: 1, text: 'OLD' }, { id: 2, text: 'A' }], remove: [3], add: ['c'] }, 2, later);
    expect([second.list, second.left]).toEqual([
      { next_id: 5, items: [{ id: 1, text: 'OLD', round: 2 }, { id: 2, text: 'A', added: at, round: 2 }, { id: 4, text: 'c', round: 2, added: later }] },
      [{ id: 1, text: 'old', left: 'edited' }, { id: 2, text: 'a', left: 'edited', added: at }, { id: 3, text: 'b', left: 'removed', added: at }],
    ]);
  });

  it('drops a tag the model copied back from a wake, in an add and in an edit', () => {
    expect(shown(listApply('done', list('a'), { add: ['b [2 rounds unchanged]'], edit: [{ id: 1, text: 'A [1 round unchanged] ' }] }).list)).toEqual(['[1] A', '[2] b']);
  });

  it('in remaining, places a step before a live one, and last before a number not live', () => {
    const out = listApply('remaining', list('one', 'three'), { remove: [1], add: [{ before: 2, text: 'two' }, { before: 1, text: 'four' }, { before: 'x', text: 'five' }] });
    expect([shown(out.list), out.notes]).toEqual([['[3] two', '[2] three', '[4] four', '[5] five'], ['remaining.add[2].before must be a step number; got string: added last.', 'remaining.add[1].before: [1] is not a live step: added last.']]);
  });
});

describe('doneSplit: the done items a wake shows, newest first while their texts fit the cap', () => {
  const done = (...lengths: number[]): Item[] => lengths.map((n, i) => ({ id: i + 1, text: String.fromCharCode(97 + i).repeat(n) }));
  it.each([
    { name: 'the newest items whose texts sum to the cap are shown, every older one earlier', items: done(4, 4, 4), max: 8, shown: [2, 3], earlier: [1] },
    { name: 'one character under that sum shows one item fewer', items: done(4, 4, 4), max: 7, shown: [3], earlier: [1, 2] },
    { name: 'one character over it shows no item more', items: done(4, 4, 4), max: 9, shown: [2, 3], earlier: [1] },
    { name: 'a list that fits whole is all shown', items: done(4, 4, 4), max: 12, shown: [1, 2, 3], earlier: [] },
    { name: 'the newest is shown even alone over the cap', items: done(4, 20), max: 10, shown: [2], earlier: [1] },
    { name: 'a lone item over the cap is shown', items: done(20), max: 10, shown: [1], earlier: [] },
    { name: 'the walk stops at the first item over the cap: an older one that would fit is earlier too', items: done(2, 20, 4), max: 10, shown: [3], earlier: [1, 2] },
    { name: 'an empty list has none either side', items: [], max: 10, shown: [], earlier: [] },
    { name: 'a list stored out of number order is walked by number: shown keeps the list\'s order, earlier is oldest first', items: [{ id: 5, text: 'eeee' }, { id: 2, text: 'bbbb' }, { id: 9, text: 'iiii' }, { id: 1, text: 'aaaa' }], max: 8, shown: [5, 9], earlier: [1, 2] },
  ])('$name', ({ items, max, shown, earlier }) => {
    const split = doneSplit(items, max);
    expect([split.shown.map((item) => item.id), split.earlier.map((item) => item.id)]).toEqual([shown, earlier]);
  });

  it.each([
    { name: 'the earlier items alone while the file held none', items: done(14, 14, 14), max: 20, through: 0, filed: [1, 2] },
    { name: 'an item it held that the cap now shows, after the newest was removed', items: done(14, 14), max: 20, through: 2, filed: [1, 2] },
    { name: 'an item it held that fits again, after an edit shortened the newest', items: done(14, 14, 2), max: 20, through: 2, filed: [1, 2] },
    { name: 'the items it held under a raised cap that shows the whole list', items: done(14, 14, 14), max: 100, through: 2, filed: [1, 2] },
    { name: 'the earlier items past what it held, once more became earlier', items: done(14, 14, 14, 14), max: 20, through: 1, filed: [1, 2, 3] },
    { name: 'every live item while what it held is unknown', items: done(14, 14, 14), max: 20, through: Infinity, filed: [1, 2, 3] },
    { name: 'no item for a list that fits, the file having held none', items: done(14, 14, 14), max: 100, through: 0, filed: [] },
    { name: 'a list stored out of number order by number, oldest first', items: [{ id: 5, text: 'eeee' }, { id: 2, text: 'bbbb' }, { id: 9, text: 'iiii' }, { id: 1, text: 'aaaa' }], max: 8, through: 5, filed: [1, 2, 5] },
  ])('doneFiled, what done-earlier.md holds: $name', ({ items, max, through, filed }) => {
    expect(doneFiled(items, max, through).map((item) => item.id)).toEqual(filed);
  });

  const held = { ...emptyHeld(), rounds: 2, objective: 'ship it' };
  held.lists.done = { next_id: 10, items: [{ id: 2, text: 'old' }, { id: 5, text: 'mid', round: 1 }, { id: 9, text: 'new', round: 2 }] };
  const PATH = '/h/.local/state/forward-compaction/proj/s1/done-earlier.md';
  const rest = 'finished work like the items below, edited or removed by number like them. Read the file when a step or the final report may rest on one.';

  it('renders done with the line naming the file, then the shown items with their numbers and rounds tags; one earlier item in the singular', () => {
    expect(renderFrontier(held, { ...doneSplit(held.lists.done.items, 3), path: PATH })).toBe(`## Objective\nship it\n\n## Done\n2 earlier done items, [2] to [5], are in ${PATH}, each whole under its number: ${rest}\n[9] new`);
    expect(renderFrontier(held, { ...doneSplit(held.lists.done.items, 6), path: PATH })).toBe(`## Objective\nship it\n\n## Done\n1 earlier done item, [2], is in ${PATH}, whole under its number: ${rest}\n[5] mid [1 round unchanged]\n[9] new`);
  });

  it('renders the whole done list with no line when nothing is earlier or no split is given', () => {
    const whole = '## Objective\nship it\n\n## Done\n[2] old [2 rounds unchanged]\n[5] mid [1 round unchanged]\n[9] new';
    expect([renderFrontier(held, { ...doneSplit(held.lists.done.items, 9), path: PATH }), renderFrontier(held)]).toEqual([whole, whole]);
  });

  it('gives the result its done line and the stored row its counts only for a split with earlier items', () => {
    const split = { ...doneSplit(held.lists.done.items, 3), path: PATH };
    expect([doneLines(split), doneLines({ ...doneSplit(held.lists.done.items, 6), path: PATH }), doneLines(undefined), doneLines({ ...doneSplit(held.lists.done.items, 9), path: PATH })]).toEqual([[`Done: 1 newest item stays in your wake, 2 earlier in ${PATH}`], [`Done: 2 newest items stay in your wake, 1 earlier in ${PATH}`], [], []]);
    expect([doneSizes(held.lists.done, split), doneSizes(held.lists.done, undefined)]).toEqual([{ shown: 1, shownChars: 3, earlier: 2, earlierChars: 6 }, { shown: 3, shownChars: 9, earlier: 0, earlierChars: 0 }]);
  });
});

describe('textApply: objective and next', () => {
  it.each([
    { name: 'set when none is stored', held: undefined, sent: 'x', out: { text: 'x', lines: ['objective set'], notes: [] } },
    { name: 'replaced, the old one leaving', held: 'old', sent: 'new', out: { text: 'new', lines: ['objective replaced'], notes: [], left: 'old' } },
    { name: 'unchanged when sent again', held: 'x', sent: 'x', out: { text: 'x', lines: ['objective unchanged'], notes: [] } },
    { name: 'kept when left out', held: 'x', sent: undefined, out: { text: 'x', lines: [], notes: [] } },
    { name: 'kept when blank', held: 'x', sent: ' ', out: { text: 'x', lines: [], notes: ['objective was blank: kept.'] } },
    { name: 'kept when not a text', held: undefined, sent: ['x'], out: { lines: [], notes: ['objective must be a text; got array: nothing stored.'] } },
  ])('objective $name', ({ held, sent, out }) => {
    expect(textApply('objective', held, sent)).toEqual(out);
  });
  it('says next is kept, with its text, when the call leaves it out', () => {
    expect(textApply('next', 'run the gate', undefined)).toEqual({ text: 'run the gate', lines: ['next kept: run the gate'], notes: [] });
  });
});

describe('the frontier rendered from the lists, and its size', () => {
  const held = emptyHeld();
  held.objective = 'ship it';
  held.next = 'wire the hook';
  held.lists.decisions = { next_id: 5, items: [{ id: 1, text: 'one' }, { id: 4, text: 'four' }] };
  held.lists.orders = { next_id: 2, items: [{ id: 1, text: 'never push' }] };
  held.lists.findings = { next_id: 2, items: [{ id: 1, text: 'f' }] };

  it('shows each section with content under its heading, items as [n] text, an empty list with no heading, orders apart', () => {
    expect(renderFrontier(held)).toBe('## Objective\nship it\n\n## Decisions\n[1] one\n[4] four\n\n## Next\nwire the hook\n\n## Findings\n[1] f');
    expect(renderFrontier(emptyHeld())).toBe('');
  });

  it('ends each item with the rounds it has passed unchanged, none before its first, and says what the tag means only where one shows', () => {
    const aged = { ...held, rounds: 3, lists: { ...held.lists, decisions: { next_id: 5, items: [{ id: 1, text: 'one' }, { id: 4, text: 'four', round: 2 }] }, findings: { next_id: 2, items: [{ id: 1, text: 'f', round: 3 }] } } };
    expect(renderFrontier(aged)).toBe('## Objective\nship it\n\n## Decisions\n[1] one [3 rounds unchanged]\n[4] four [1 round unchanged]\n\n## Next\nwire the hook\n\n## Findings\n[1] f');
    expect([unchangedNote(undefined, renderFrontier(aged)), unchangedNote(renderFrontier(held), undefined)]).toEqual([' An item tagged [N rounds unchanged] has passed N compactions with no change: keep it only while it is still true and still needed, and a standing order while it binds.', '']);
  });

  it('counts a round for a frontier holding an item, and none for one holding no item', () => {
    expect([roundPassed(held).rounds, roundPassed({ ...held, rounds: 2 }).rounds, roundPassed({ ...emptyHeld(), objective: 'x' }).rounds]).toEqual([1, 3, undefined]);
  });

  it('counts the characters of every live item, the objective and next', () => {
    const size = frontierSize(held);
    expect([size.chars, size.items]).toEqual([7 + 13 + 3 + 4 + 10 + 1, 4]);
    expect(sizeLines(size, 12_000)).toEqual(['Frontier: 38 characters in 4 items (orders 1, decisions 2, findings 1)']);
  });

  it('asks for a shorter objective and next over the threshold, not at it, and asks nothing of a frontier whose lists hold items', () => {
    const texts = frontierSize({ ...emptyHeld(), objective: 'x'.repeat(10), next: 'y'.repeat(10) });
    expect(sizeLines(texts, 20)).toEqual(['Frontier: 20 characters in 0 items']);
    expect(sizeLines(texts, 19)).toEqual([
      'Frontier: 20 characters in 0 items',
      'Frontier is 20 characters, over 19: in your next forward_compaction call send a shorter objective and next.',
    ]);
    expect(sizeLines(frontierSize(held), 37)).toEqual(['Frontier: 38 characters in 4 items (orders 1, decisions 2, findings 1)']);
  });
});
