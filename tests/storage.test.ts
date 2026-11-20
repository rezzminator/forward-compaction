import { describe, expect, it } from 'vitest';
import { PartyFiles } from '../plugins/forward-compaction/src/disk.ts';
import { storageApply, storageName, storageSection } from '../plugins/forward-compaction/src/storage.ts';
import { memFs } from './fakes/fs.ts';

const R = '/h/.local/state/forward-compaction/proj/s1';
const S = `${R}/storage`;

describe('storageName', () => {
  it.each([
    ['survey.md', 'survey.md'],
    ['survey', 'survey.md'],
    ['Gate Recipe.MD', 'gate-recipe.md'],
    ['a_b/c', 'a-b-c.md'],
    ['--x--', 'x.md'],
    ['!!!', undefined],
    ['a'.repeat(100), `${'a'.repeat(100)}.md`],
    ['a'.repeat(101), `${'a'.repeat(100)}.md`],
    [`${'b'.repeat(99)}-c`, `${'b'.repeat(99)}.md`],
  ])('%s → %s', (sent, name) => {
    expect(storageName(sent)).toBe(name);
  });
});

describe('storageApply', () => {
  it('writes a value and lists the entry, and the wake shows the folder once and each entry', async () => {
    const fs = memFs();
    const files = new PartyFiles(R);
    const out = await storageApply(fs, files, [], { add: [{ name: 'survey', description: '24 legacy call sites', value: 'abc' }, { name: 'Gate Recipe', description: 'the fence command', value: 'x' }] });
    expect([out.entries, out.lines, out.notes, out.count]).toEqual([
      [{ name: 'survey.md', description: '24 legacy call sites' }, { name: 'gate-recipe.md', description: 'the fence command' }],
      ['Stored survey.md (3 characters)', 'Stored gate-recipe.md (1 characters)'],
      ['storage.add[1].name "Gate Recipe" is stored as gate-recipe.md: a name is lower-case letters, digits and dashes, ending .md.'],
      { added: 2, removed: 0 },
    ]);
    await files.flush(fs, { lists: {} as never, storage: out.entries });
    expect([fs.files[`${S}/survey.md`], JSON.parse(fs.files[`${R}/storage.json`]!)]).toEqual(['abc', out.entries]);
    expect(storageSection(S, out.entries)).toBe(`## Storage — files in ${S}/\nsurvey.md — 24 legacy call sites\ngate-recipe.md — the fence command`);
    expect(storageSection(S, [])).toBeUndefined();
  });

  it('copies the old value of a listed entry to the history before overwriting it, and an add without value changes only the description', async () => {
    const fs = memFs({ [`${S}/survey.md`]: 'old' });
    const files = new PartyFiles(R);
    const listed = [{ name: 'survey.md', description: 'd' }];
    const out = await storageApply(fs, files, listed, { add: [{ name: 'survey.md', value: 'new' }] });
    await files.flush(fs, { lists: {} as never, storage: out.entries });
    expect([fs.files[`${R}/history/storage/survey.md`], fs.files[`${S}/survey.md`], out.entries]).toEqual(['old', 'new', listed]);
    const described = await storageApply(fs, files, listed, { add: [{ name: 'survey.md', description: 'e' }] });
    expect([described.entries, described.lines, files.storage]).toEqual([[{ name: 'survey.md', description: 'e' }], ['Described survey.md'], []]);
  });

  it('copies a value the same call wrote to the history when the call overwrites or removes it', async () => {
    const fs = memFs();
    const files = new PartyFiles(R);
    const out = await storageApply(fs, files, [], { add: [{ name: 'plan', description: 'p', value: 'one' }, { name: 'plan', value: 'two' }], remove: ['plan'] });
    await files.flush(fs, { lists: {} as never, storage: out.entries });
    expect([out.entries, out.lines]).toEqual([[], ['Stored plan.md (3 characters)', 'Stored plan.md (3 characters)', 'Storage no longer lists plan.md']]);
    expect([fs.files[`${R}/history/storage/plan.md`], fs.files[`${R}/history/storage/plan.2.md`], fs.files[`${S}/plan.md`]]).toEqual(['one', 'two', 'two']);
  });

  it('copies a file already in the folder to the history before a value overwrites it, though no entry lists it', async () => {
    const fs = memFs({ [`${S}/notes.md`]: 'written by hand' });
    const files = new PartyFiles(R);
    const out = await storageApply(fs, files, [], { add: [{ name: 'notes', description: 'd', value: 'new' }] });
    await files.flush(fs, { lists: {} as never, storage: out.entries });
    expect([out.lines, fs.files[`${R}/history/storage/notes.md`], fs.files[`${S}/notes.md`]]).toEqual([['Stored notes.md (3 characters)'], 'written by hand', 'new']);
  });

  it('unlists a removed entry and copies its value to the history under a free name; the file stays in the folder', async () => {
    const fs = memFs({ [`${S}/survey.md`]: 'v2', [`${R}/history/storage/survey.md`]: 'v1' });
    const files = new PartyFiles(R);
    const out = await storageApply(fs, files, [{ name: 'survey.md', description: 'd' }], { remove: ['survey', 'ghost.md'] });
    await files.flush(fs, { lists: {} as never, storage: out.entries });
    expect([out.entries, out.lines, out.notes]).toEqual([[], ['Storage no longer lists survey.md'], ['storage.remove[1]: ghost.md is not listed: skipped.']]);
    expect([fs.files[`${R}/history/storage/survey.2.md`], fs.files[`${S}/survey.md`]]).toEqual(['v2', 'v2']);
  });

  it('lists a file already in the folder when an add names it without value, and skips one that is not there', async () => {
    const fs = memFs({ [`${S}/notes.md`]: 'written by hand' });
    const out = await storageApply(fs, new PartyFiles(R), [], { add: [{ name: 'notes', description: 'n' }, { name: 'none', description: 'x' }] });
    expect([out.entries, out.lines, out.notes]).toEqual([[{ name: 'notes.md', description: 'n' }], ['Stored notes.md (15 characters, as it is in the folder)'], ['storage.add[1] has no value and storage/none.md does not exist: skipped.']]);
  });

  it('names each malformed entry by its place and never throws', async () => {
    const fs = memFs({}, { read: { [`${S}/a.md`]: 'EIO' } });
    const out = await storageApply(fs, new PartyFiles(R), [{ name: 'a.md', description: '' }], { add: ['x', { name: '' }, { name: 'b', value: 3 }, { name: 'a', value: 'new' }], remove: 5, rename: 1 });
    expect([out.entries, out.notes]).toEqual([[{ name: 'a.md', description: '' }], [
      'storage.rename is not add or remove: ignored.',
      'storage.add[0] must be {name, description, value}; got string: skipped.',
      'storage.add[1].name must be a non-blank name; got a blank one: skipped.',
      'storage.add[2].value must be a text; got number: skipped.',
      'storage.add[3]: storage/a.md could not be read (EIO), so its value cannot be kept in the history: skipped.',
      'storage.remove must be an array; got number: skipped.',
    ]]);
    expect((await storageApply(fs, new PartyFiles(R), [], 'x')).notes).toEqual(['storage must be {add, remove}; got string: nothing changed.']);
  });
});
