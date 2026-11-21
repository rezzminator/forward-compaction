import { describe, expect, it } from 'vitest';
import { notSaved, PartyFiles, partyRoot, projectName } from '../plugins/forward-compaction/src/disk.ts';
import { memFs } from './fakes/fs.ts';
import { emptyHeld, listApply } from '../plugins/forward-compaction/src/lists.ts';

const R = '/h/.local/state/forward-compaction/proj/s1';

describe('where a party\'s files live', () => {
  it.each([
    ['/work/proj', 'main', R],
    ['/work/.professor/', 'main', '/h/.local/state/forward-compaction/professor/s1'],
    ['/work/proj', 'agent:a1b2', `${R}/agents/a1b2`],
  ])('%s, %s → %s', (dir, party, root) => {
    expect(partyRoot('/h/', dir, 's1', party)).toBe(root);
  });
  it('names the project by the last name of the directory, without a leading dot', () => {
    expect([projectName('/a/.hidden'), projectName('/a/b c'), projectName('/')]).toEqual(['hidden', 'b-c', 'unknown']);
  });
});

describe('PartyFiles: write, history and load', () => {
  it('writes each changed list and text and appends what left to its history, then loads it all back with every number', async () => {
    const fs = memFs();
    const files = new PartyFiles(R);
    const held = emptyHeld();
    held.lists.decisions = listApply('decisions', held.lists.decisions, { add: ['a', 'b', 'c'] }).list;
    held.objective = 'goal';
    files.changed('decisions'), files.changed('objective');
    expect(await files.flush(fs, held)).toEqual([]);
    const second = listApply('decisions', held.lists.decisions, { remove: [2], edit: [{ id: 3, text: 'C' }] });
    held.lists.decisions = second.list;
    held.objective = 'goal 2';
    files.changed('decisions', second.left), files.changed('objective', ['goal']);
    expect(await files.flush(fs, held)).toEqual([]);
    expect(fs.files[`${R}/data/decisions.json`]).toBe('{\n  "next_id": 4,\n  "items": [\n    {\n      "id": 1,\n      "text": "a"\n    },\n    {\n      "id": 3,\n      "text": "C"\n    }\n  ]\n}\n');
    expect(fs.files[`${R}/history/decisions.jsonl`]).toBe('{"id":3,"text":"c","left":"edited"}\n{"id":2,"text":"b","left":"removed"}\n');
    expect(fs.files[`${R}/history/objective.jsonl`]).toBe('{"text":"goal"}\n');
    expect([files.dirty.size, files.history.size]).toEqual([0, 0]);
    const loaded = await new PartyFiles(R).load(fs);
    expect([loaded.held.lists.decisions, loaded.held.objective, loaded.problems]).toEqual([{ next_id: 4, items: [{ id: 1, text: 'a' }, { id: 3, text: 'C' }] }, 'goal 2', []]);
  });

  it('keeps the round count and each item\'s round, never loads a count behind an item\'s own, and names a count it cannot read', async () => {
    const fs = memFs();
    const files = new PartyFiles(R);
    const held = { ...emptyHeld(), rounds: 2 };
    held.lists.done = listApply('done', held.lists.done, { add: ['a'] }, 2).list;
    files.changed('done'), files.changed('rounds');
    expect(await files.flush(fs, held)).toEqual([]);
    expect([fs.files[`${R}/rounds.json`], fs.files[`${R}/data/done.json`]]).toEqual(['{\n  "rounds": 2\n}\n', '{\n  "next_id": 2,\n  "items": [\n    {\n      "id": 1,\n      "text": "a",\n      "round": 2\n    }\n  ]\n}\n']);
    const loaded = await new PartyFiles(R).load(fs);
    expect([loaded.held.rounds, loaded.held.lists.done.items, loaded.problems]).toEqual([2, [{ id: 1, text: 'a', round: 2 }], []]);
    const behind = await new PartyFiles(R).load(memFs({ ...fs.files, [`${R}/rounds.json`]: '{"rounds": 1}' }));
    expect([behind.held.rounds, behind.problems]).toEqual([2, []]);
    const unread = await new PartyFiles(R).load(memFs({ ...fs.files, [`${R}/rounds.json`]: '{"rounds": "x"}' }));
    expect([unread.held.rounds, unread.problems]).toEqual([2, [{ file: 'rounds.json', error: 'not a {rounds}' }]]);
  });
  it('keeps the party\'s floor in floor.json, loads it back, and names a file that holds none', async () => {
    const fs = memFs(), files = new PartyFiles(R);
    files.changed('floor');
    expect(await files.flush(fs, { ...emptyHeld(), floor: 42_000 })).toEqual([]);
    expect([fs.files[`${R}/floor.json`], files.dirty.size]).toEqual(['{\n  "floor": 42000\n}\n', 0]);
    const loaded = await new PartyFiles(R).load(fs);
    expect([loaded.held.floor, loaded.problems]).toEqual([42_000, []]);
    const unread = await new PartyFiles(R).load(memFs({ [`${R}/floor.json`]: '{"floor": "x"}' }));
    expect([unread.held.floor, unread.problems]).toEqual([undefined, [{ file: 'floor.json', error: 'not a {floor}' }]]);
  });

  it('keeps a change it could not write due, and writes it at the next flush', async () => {
    const fs = memFs({}, { write: { [`${R}/orders.json`]: 'EACCES: permission denied' } });
    const files = new PartyFiles(R);
    const held = emptyHeld();
    held.lists.orders = listApply('orders', held.lists.orders, { add: ['never push'] }).list;
    files.changed('orders');
    expect(await files.flush(fs, held)).toEqual([{ file: 'orders.json', error: 'EACCES: permission denied' }]);
    expect([...files.dirty]).toEqual(['orders']);
    const ok = memFs(fs.files);
    expect(await files.flush(ok, held)).toEqual([]);
    expect(JSON.parse(ok.files[`${R}/orders.json`]!)).toEqual({ next_id: 2, items: [{ id: 1, text: 'never push' }] });
  });

  it('keeps history lines it could not append, never losing the file\'s own lines', async () => {
    const fs = memFs({ [`${R}/history/done.jsonl`]: '{"id":1,"text":"x","left":"removed"}' }, { read: { [`${R}/history/done.jsonl`]: 'EIO: i/o error' } });
    const files = new PartyFiles(R);
    files.changed('done', [{ id: 2, text: 'y', left: 'removed' }]);
    expect(await files.flush(fs, emptyHeld())).toEqual([{ file: 'history/done.jsonl', error: 'EIO: i/o error' }]);
    expect(await files.flush(memFs(fs.files), emptyHeld())).toEqual([]);
    expect(fs.files[`${R}/history/done.jsonl`]).toBe('{"id":1,"text":"x","left":"removed"}\n{"id":2,"text":"y","left":"removed"}\n');
  });

  it('loads an unreadable file as empty, names it, leaves it until a change, then copies its text to history/unreadable first', async () => {
    const fs = memFs({ [`${R}/data/done.json`]: '{broken', [`${R}/history/done.jsonl`]: '{"id":7,"text":"x","left":"removed"}\n', [`${R}/data/next.json`]: '[1]' });
    const files = new PartyFiles(R);
    const { held, problems } = await files.load(fs);
    expect(problems.map((p) => p.file)).toEqual(['data/done.json', 'data/next.json']);
    expect([held.lists.done, held.next, [...files.unreadable]]).toEqual([{ next_id: 8, items: [] }, undefined, ['done', 'next']]);
    expect(await files.flush(fs, held)).toEqual([]);
    expect(fs.files[`${R}/data/done.json`]).toBe('{broken');
    held.lists.done = listApply('done', held.lists.done, { add: ['z'] }).list;
    files.changed('done');
    expect(await files.flush(fs, held)).toEqual([]);
    expect([fs.files[`${R}/history/unreadable/done.json`], JSON.parse(fs.files[`${R}/data/done.json`]!)]).toEqual(['{broken', { next_id: 9, items: [{ id: 8, text: 'z' }] }]);
  });

  it('starts every list past the numbers its history holds, and past those an unparsable live file still names', async () => {
    const fs = memFs({
      [`${R}/history/done.jsonl`]: '{"id":4,"text":"x","left":"removed"}\n',
      [`${R}/data/remaining.json`]: '{"next_id": 7, "items": [{"id": 5, "text": "a"}, {"id": 6,', [`${R}/history/remaining.jsonl`]: '{"id":3,"text":"x","left":"removed"}\n',
      [`${R}/data/blocked.json`]: '{"next_id":2,"items":[{"id":1,"text":"b"}]}', [`${R}/history/blocked.jsonl`]: '{"id":9,"text":"x","left":"edited"}\n',
    });
    const { held } = await new PartyFiles(R).load(fs);
    expect([held.lists.done, held.lists.remaining, held.lists.blocked, held.lists.findings]).toEqual([{ next_id: 5, items: [] }, { next_id: 7, items: [] }, { next_id: 10, items: [{ id: 1, text: 'b' }] }, { next_id: 1, items: [] }]);
  });

  it('writes no live file while its history cannot be appended, so what left is never in memory alone', async () => {
    const fs = memFs({ [`${R}/data/done.json`]: 'as it was' }, { read: { [`${R}/history/done.jsonl`]: 'EIO: i/o error' } });
    const files = new PartyFiles(R);
    files.changed('done', [{ id: 1, text: 'x', left: 'removed' }]);
    expect(await files.flush(fs, emptyHeld())).toEqual([{ file: 'history/done.jsonl', error: 'EIO: i/o error' }]);
    expect([fs.files[`${R}/data/done.json`], [...files.dirty]]).toEqual(['as it was', ['done']]);
    expect(await files.flush(memFs(fs.files), emptyHeld())).toEqual([]);
    expect([fs.files[`${R}/history/done.jsonl`], JSON.parse(fs.files[`${R}/data/done.json`]!)]).toEqual(['{"id":1,"text":"x","left":"removed"}\n', { next_id: 1, items: [] }]);
  });

  it('copies an unreadable file to history/unreadable once, however often the write after it fails', async () => {
    const fs = memFs({ [`${R}/data/done.json`]: '{broken' }, { write: { [`${R}/data/done.json`]: 'EACCES' } });
    const files = new PartyFiles(R);
    const { held } = await files.load(fs);
    files.changed('done');
    expect([await files.flush(fs, held), await files.flush(fs, held)]).toEqual([[{ file: 'data/done.json', error: 'EACCES' }], [{ file: 'data/done.json', error: 'EACCES' }]]);
    expect(Object.keys(fs.files).filter((path) => path.includes('/history/'))).toEqual([`${R}/history/unreadable/done.json`]);
  });

  it('names a file not saved by its list or entry, a storage file by its place in the folder, never the path of a list or history file', () => {
    expect([
      notSaved({ file: 'data/remaining.json', error: `EACCES: permission denied, open '${R}/data/remaining.json'` }, R),
      notSaved({ file: 'history/orders.jsonl', error: `EIO, read ${R}/history/orders.jsonl: bad sector` }, R),
      notSaved({ file: 'storage/a.md', error: `ENOSPC, write '${R}/storage/a.md'` }, R),
    ]).toEqual([
      "Not saved to disk yet: remaining (EACCES: permission denied, open '…'); it is held and saved again at your next call.",
      'Not saved to disk yet: what left orders (EIO, read …: bad sector); it is held and saved again at your next call.',
      "Not saved to disk yet: storage/a.md (ENOSPC, write '…/storage/a.md'); it is held and saved again at your next call.",
    ]);
  });

  it('says when no orders file was found, so the previous build\'s orders may seed it', async () => {
    const none = new PartyFiles(R);
    await none.load(memFs());
    const some = new PartyFiles(R);
    await some.load(memFs({ [`${R}/orders.json`]: '{"next_id":1,"items":[]}' }));
    expect([none.ordersAbsent, some.ordersAbsent]).toEqual([true, false]);
  });

  it('copies a storage value that leaves to history/storage under a free name, then writes the new one', async () => {
    const fs = memFs({ [`${R}/history/storage/survey.md`]: 'oldest' });
    const files = new PartyFiles(R);
    files.queueStorage('survey.md', 'new', 'old');
    expect(await files.flush(fs, emptyHeld())).toEqual([]);
    expect([fs.files[`${R}/history/storage/survey.2.md`], fs.files[`${R}/storage/survey.md`], files.storage]).toEqual(['old', 'new', []]);
  });

  it('holds a storage write back while the copy before it fails', async () => {
    const fs = memFs({}, { write: { [`${R}/history/storage/a.md`]: 'ENOSPC' } });
    const files = new PartyFiles(R);
    files.queueStorage('a.md', 'new', 'old');
    expect(await files.flush(fs, emptyHeld())).toEqual([{ file: 'history/storage/a.md', error: 'ENOSPC' }]);
    expect([fs.files[`${R}/storage/a.md`], files.storage.length]).toEqual([undefined, 2]);
  });
});
