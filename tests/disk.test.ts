import { describe, expect, it } from 'vitest';
import { DONE_EARLIER_FILE, DONE_EARLIER_RECORD, notSaved, PartyFiles, partyRoot, projectName, unreadMeans } from '../plugins/forward-compaction/src/disk.ts';
import { memFs } from './fakes/fs.ts';
import { emptyHeld, listApply, type Held } from '../plugins/forward-compaction/src/lists.ts';

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
  it('keeps the party\'s floor in floor.json with whether it has settled, loads a settled one back, and names a file that holds none', async () => {
    const fs = memFs(), files = new PartyFiles(R);
    files.changed('floor');
    expect(await files.flush(fs, { ...emptyHeld(), floor: 42_000 })).toEqual([]);
    expect([fs.files[`${R}/floor.json`], files.dirty.size]).toEqual(['{\n  "floor": 42000,\n  "settled": true\n}\n', 0]);
    const loaded = await new PartyFiles(R).load(fs);
    expect([loaded.held.floor, loaded.problems]).toEqual([42_000, []]);
    files.changed('floor');
    expect(await files.flush(fs, { ...emptyHeld(), floor: 58_000, settling: true })).toEqual([]);
    expect(fs.files[`${R}/floor.json`]).toBe('{\n  "floor": 58000,\n  "settled": false\n}\n');
    // a floor not settled, an install's first reading alone and every floor an earlier version kept, is not loaded: the party's next reading is its floor
    const unsettled = await Promise.all([fs.files[`${R}/floor.json`]!, '{"floor": 58000}'].map((text) => new PartyFiles(R).load(memFs({ [`${R}/floor.json`]: text }))));
    expect(unsettled.map((u) => [u.held.floor, u.problems])).toEqual([[undefined, []], [undefined, []]]);
    const unread = await new PartyFiles(R).load(memFs({ [`${R}/floor.json`]: '{"floor": "x"}' }));
    expect([unread.held.floor, unread.problems]).toEqual([undefined, [{ file: 'floor.json', error: 'not a {floor}' }]]);
  });

  it('keeps each item\'s added time in its file and its history line, loads it back, loads an item stored without one as before, and drops one that is no ISO time', async () => {
    const fs = memFs(), files = new PartyFiles(R), held = emptyHeld(), at = '2026-10-27T14:53:00.000Z';
    held.lists.findings = listApply('findings', held.lists.findings, { add: ['a', 'b'] }, 0, at).list;
    files.changed('findings');
    expect(await files.flush(fs, held)).toEqual([]);
    const out = listApply('findings', held.lists.findings, { remove: [1] }, 0, '2026-10-28T00:00:00.000Z');
    held.lists.findings = out.list, files.changed('findings', out.left);
    expect(await files.flush(fs, held)).toEqual([]);
    expect([fs.files[`${R}/data/findings.json`], fs.files[`${R}/history/findings.jsonl`]]).toEqual(['{\n  "next_id": 3,\n  "items": [\n    {\n      "id": 2,\n      "text": "b",\n      "added": "2026-10-27T14:53:00.000Z"\n    }\n  ]\n}\n', '{"id":1,"text":"a","left":"removed","added":"2026-10-27T14:53:00.000Z"}\n']);
    const loaded = await new PartyFiles(R).load(memFs({ ...fs.files, [`${R}/data/done.json`]: '{"next_id":4,"items":[{"id":1,"text":"old"},{"id":2,"text":"x","added":"yesterday"},{"id":3,"text":"y","added":"2026-10-27T14:53:00Z"}]}' }));
    expect([loaded.held.lists.findings.items, loaded.held.lists.done.items, loaded.problems]).toEqual([[{ id: 2, text: 'b', added: at }], [{ id: 1, text: 'old' }, { id: 2, text: 'x' }, { id: 3, text: 'y', added: '2026-10-27T14:53:00Z' }], []]);
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

  it('loads an unreadable file as empty, names it, leaves it until a change, then copies its text to history/unreadable first; done-earlier.md of an unreadable done list is left and copied with it', async () => {
    const fs = memFs({ [`${R}/data/done.json`]: '{broken', [`${R}/history/done.jsonl`]: '{"id":7,"text":"x","left":"removed"}\n', [`${R}/data/next.json`]: '[1]', [`${R}/${DONE_EARLIER_FILE}`]: '[1] the first round\n' });
    const files = new PartyFiles(R);
    const { held, problems } = await files.load(fs);
    expect(problems.map((p) => p.file)).toEqual(['data/done.json', 'data/next.json']);
    expect([held.lists.done, held.next, [...files.unreadable]]).toEqual([{ next_id: 8, items: [] }, undefined, ['done', 'next']]);
    expect(await files.flush(fs, held, 100)).toEqual([]);
    expect([fs.files[`${R}/data/done.json`], fs.files[`${R}/${DONE_EARLIER_FILE}`]]).toEqual(['{broken', '[1] the first round\n']);
    held.lists.done = listApply('done', held.lists.done, { add: ['z'] }).list;
    files.changed('done');
    expect(await files.flush(fs, held, 100)).toEqual([]);
    expect([fs.files[`${R}/history/unreadable/done.json`], JSON.parse(fs.files[`${R}/data/done.json`]!)]).toEqual(['{broken', { next_id: 9, items: [{ id: 8, text: 'z' }] }]);
    expect([fs.files[`${R}/history/unreadable/${DONE_EARLIER_FILE}`], fs.files[`${R}/${DONE_EARLIER_FILE}`]]).toEqual(['[1] the first round\n', 'No earlier done items: every live done item is in the wake.\n']);
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

describe('done-earlier.md: the done items a wake names instead of showing', () => {
  const PATH = `${R}/${DONE_EARLIER_FILE}`, RECORD = `${R}/${DONE_EARLIER_RECORD}`, A = 'a'.repeat(14), B = 'b'.repeat(14), C = 'c'.repeat(14);
  const through = (n: number): string => `{\n  "through": ${n}\n}\n`;
  const changed = (held: Held, change: Parameters<typeof listApply>[2]): Held => ({ ...held, lists: { ...held.lists, done: listApply('done', held.lists.done, change).list } });
  const doneOf = (...texts: string[]) => {
    const held = emptyHeld();
    held.lists.done = listApply('done', held.lists.done, { add: texts }).list;
    return held;
  };
  const ids = (items: readonly { id: number }[] | undefined): number[] | undefined => items?.map((item) => item.id);

  it('holds the earlier items whole, oldest first; the wake shows the rest and names it once written; together they are every live item, none in both', async () => {
    const fs = memFs(), files = new PartyFiles(R), held = doneOf('first\nof two lines', 'second', 'third', 'fourth');
    expect(files.doneWake(held, 11)).toBe(undefined);
    expect(await files.flush(fs, held, 11)).toEqual([]);
    const wake = files.doneWake(held, 11);
    expect([fs.files[PATH], fs.files[RECORD], ids(wake?.shown), ids(wake?.earlier), wake?.path]).toEqual(['[1] first\nof two lines\n[2] second\n', through(2), [3, 4], [1, 2], PATH]);
    const inFile = [...fs.files[PATH]!.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1]));
    expect([...inFile, ...ids(wake?.shown)!].sort()).toEqual(held.lists.done.items.map((item) => item.id));
  });

  it('follows a remove of an earlier item, says it holds none once the party has read a wake showing the whole list, and is never created for a list that fits', async () => {
    const fs = memFs(), files = new PartyFiles(R);
    let held = doneOf('first', 'second', 'third');
    expect(await files.flush(fs, held, 10)).toEqual([]);
    held = changed(held, { remove: [1] });
    expect(await files.flush(fs, held, 10)).toEqual([]);
    expect([fs.files[PATH], ids(files.doneWake(held, 10)?.shown)]).toEqual(['[2] second\n', [3]]);
    files.wakeRendered('the whole list', files.doneWake(held, 11));
    files.doneReached(() => true);
    expect(await files.flush(fs, held, 11)).toEqual([]);
    expect([fs.files[PATH], fs.files[RECORD], files.doneWake(held, 11)]).toEqual(['No earlier done items: every live done item is in the wake.\n', through(0), undefined]);
    const fresh = memFs(), fits = new PartyFiles(R);
    fits.changed('done');
    expect(await fits.flush(fresh, held, 11)).toEqual([]);
    expect([JSON.parse(fresh.files[`${R}/data/done.json`]!).items.length, PATH in fresh.files, RECORD in fresh.files]).toEqual([2, false, false]);
  });

  it.each<[string, Parameters<typeof listApply>[2], number, number[] | undefined]>([
    ['a remove of the newest item', { remove: [3] }, 20, [2]],
    ['an edit that shortens the newest item', { edit: [{ id: 3, text: 'cc' }] }, 20, [2, 3]],
    ['a raised cap that shows the whole list', {}, 100, undefined],
  ])('still holds every live item it held after %s, in the same run and in a new one over the same folder', async (_name, change, cap, shown) => {
    const fs = memFs(), before = new PartyFiles(R);
    let held = doneOf(A, B, C);
    expect(await before.flush(fs, held, 20)).toEqual([]);
    expect([fs.files[PATH], fs.files[RECORD], ids(before.doneWake(held, 20)?.shown)]).toEqual([`[1] ${A}\n[2] ${B}\n`, through(2), [3]]);
    held = changed(held, change);
    const restarted = new PartyFiles(R);
    expect((await restarted.load(fs)).problems).toEqual([]);
    for (const files of [before, restarted]) {
      expect(await files.flush(fs, held, cap)).toEqual([]);
      expect([fs.files[PATH], fs.files[RECORD], ids(files.doneWake(held, cap)?.shown)]).toEqual([`[1] ${A}\n[2] ${B}\n`, through(2), shown]);
    }
  });

  it('gives up the items a wake showed only once the party\'s transcript holds that wake, and is the earlier items alone again', async () => {
    const fs = memFs(), files = new PartyFiles(R), held = changed(doneOf(A, B, C), { remove: [3] }), asked: string[] = [];
    files.wakeRendered('an earlier wake', undefined);
    expect(await files.flush(fs, doneOf(A, B, C), 20)).toEqual([]);
    expect(await files.flush(fs, held, 20)).toEqual([]);
    files.wakeRendered('the frontier', files.doneWake(held, 20)); // rendered, not yet read: [2] is in the wake and still in the file
    files.doneReached((frontier) => (asked.push(frontier), false));
    expect(await files.flush(fs, held, 20)).toEqual([]);
    expect([asked, fs.files[PATH], fs.files[RECORD]]).toEqual([['the frontier'], `[1] ${A}\n[2] ${B}\n`, through(2)]);
    files.doneReached(() => true);
    expect(await files.flush(fs, held, 20)).toEqual([]);
    expect([fs.files[PATH], fs.files[RECORD], ids(files.doneWake(held, 20)?.earlier), ids(files.doneWake(held, 20)?.shown)]).toEqual([`[1] ${A}\n`, through(1), [1], [2]]);
    files.doneReached(() => { throw new Error('no wake waits: a transcript is asked once per wake read'); });
  });

  it('writes the file and its record for two flushes at once one after the other, the later flush\'s items standing', async () => {
    const fs = memFs(), files = new PartyFiles(R);
    let release = (): void => undefined, held = false;
    const slow = { ...fs, write: async (path: string, text: string) => { if (path === RECORD && !held) (held = true), await new Promise<void>((resolve) => { release = resolve; }); return fs.write(path, text); } };
    const first = files.flush(slow, doneOf(A, B, C), 20), second = files.flush(fs, doneOf(A, B, C, 'd'.repeat(14)), 20);
    await Promise.resolve().then(() => release());
    expect([await first, await second, fs.files[PATH], fs.files[RECORD]]).toEqual([[], [], `[1] ${A}\n[2] ${B}\n[3] ${C}\n`, through(3)]);
  });

  it('with a record it cannot read, names it, holds every live done item, keeps the record\'s text in history/unreadable, and is the earlier items alone again after a wake the party read', async () => {
    const fs = memFs({ [RECORD]: '{"through":"x"}', [PATH]: `[1] ${A}\n` }), files = new PartyFiles(R), held = doneOf(A, B, C);
    expect((await files.load(fs)).problems).toEqual([{ file: 'done-earlier.json', error: 'not a {through}' }]);
    expect([unreadMeans('done-earlier.json'), unreadMeans('data/done.json')]).toEqual(['what done-earlier.md held is unknown, so it holds every live done item until the party has read a wake that shows them', 'it is shown empty and left as it is until a call changes it']);
    expect(files.doneWake(held, 20)).toBe(undefined);
    expect(await files.flush(fs, held, 20)).toEqual([]);
    expect([fs.files[PATH], fs.files[RECORD], fs.files[`${R}/history/unreadable/done-earlier.json`], ids(files.doneWake(held, 20)?.shown)]).toEqual([`[1] ${A}\n[2] ${B}\n[3] ${C}\n`, through(3), '{"through":"x"}', [3]]);
    files.wakeRendered('the frontier', files.doneWake(held, 20));
    files.doneReached(() => true);
    expect(await files.flush(fs, held, 20)).toEqual([]);
    expect([fs.files[PATH], fs.files[RECORD]]).toEqual([`[1] ${A}\n[2] ${B}\n`, through(2)]);
  });

  it('with the file not written, the wake shows the whole done list, the failure is returned, and the next flush writes it', async () => {
    const files = new PartyFiles(R), ok = memFs();
    let held = doneOf('aaaa', 'bbbb', 'cccc');
    expect(await files.flush(ok, held, 8)).toEqual([]);
    expect(ids(files.doneWake(held, 8)?.shown)).toEqual([2, 3]);
    held = { ...held, lists: { ...held.lists, done: listApply('done', held.lists.done, { add: ['dddd'] }).list } };
    const failing = memFs(ok.files, { write: { [PATH]: 'ENOSPC: no space left on device' } });
    expect(await files.flush(failing, held, 8)).toEqual([{ file: 'done-earlier.md', error: 'ENOSPC: no space left on device' }]);
    expect([files.doneWake(held, 8), ok.files[PATH]]).toEqual([undefined, '[1] aaaa\n']);
    expect(await files.flush(ok, held, 8)).toEqual([]);
    expect([ok.files[PATH], ids(files.doneWake(held, 8)?.shown)]).toEqual(['[1] aaaa\n[2] bbbb\n', [3, 4]]);
    held = changed(held, { add: ['eeee'] });
    const noRecord = memFs(ok.files, { write: { [RECORD]: 'EROFS: read-only file system' } }); // the record is written before the file gains an item: without it the file stays as it is
    expect(await files.flush(noRecord, held, 8)).toEqual([{ file: 'done-earlier.json', error: 'EROFS: read-only file system' }]);
    expect([files.doneWake(held, 8), ok.files[PATH], ok.files[RECORD]]).toEqual([undefined, '[1] aaaa\n[2] bbbb\n', through(2)]);
    expect(await files.flush(ok, held, 8)).toEqual([]);
    expect([ok.files[PATH], ok.files[RECORD], ids(files.doneWake(held, 8)?.shown)]).toEqual(['[1] aaaa\n[2] bbbb\n[3] cccc\n', through(3), [4, 5]]);
  });
});
