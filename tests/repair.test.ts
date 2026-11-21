import { describe, expect, it } from 'vitest';
import { repairJson } from '../plugins/forward-compaction/src/repair.ts';

describe('repairJson reads an argument whose JSON did not parse', () => {
  it.each([
    ['closes what the end leaves open, an open string first', 'done', '{"add":["a', { own: { add: ['a'] }, beside: {} }],
    ['gives a closer the brackets it skips', 'done', '{"edit":[{"id":1,"text":"a"]}', { own: { edit: [{ id: 1, text: 'a' }] }, beside: {} }],
    ['drops a closer with nothing open', 'done', '{"add":["a"]}}]', { own: { add: ['a'] }, beside: {} }],
    ['reads a bracket and an escaped quote inside a string as text', 'done', '{"add":["say \\"hi ] }"', { own: { add: ['say "hi ] }'] }, beside: {} }],
    ['braces operations written bare', 'done', ' add: ["a"], remove: [1]', { own: { add: ['a'], remove: [1] }, beside: {} }],
    ['leaves an operation name inside an item alone, whatever brackets the item holds', 'done', 'add: ["a ], remove: b"], remove: [2]', { own: { add: ['a ], remove: b'], remove: [2] }, beside: {} }],
    ['takes a value closed early out of the arguments written after it', 'storage', '{"add":[]},"done":{"add":["x"]}}', { own: { add: [] }, beside: { done: { add: ['x'] } } }],
    ['has no reading for plain words', 'done', 'parser merged, 41 tests pass', undefined],
    ['has no reading for a text that is no JSON once balanced', 'done', '{"add": ["a", oops', undefined],
  ])('%s', (_name, key, text, want) => {
    expect(repairJson(key, text)).toEqual(want);
  });
});
