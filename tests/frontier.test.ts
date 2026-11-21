import { describe, expect, it } from 'vitest';
import {
  FORWARD_INPUT_SCHEMA,
  FORWARD_TOOL,
  FORWARD_TOOL_DESCRIPTION,
  LOAD_FILE_MAX_LINES,
  WHY_MAX_CHARS,
  applyCall,
  loadFileNote,
  parseCall,
  parseLineRanges,
  experimental,
  receipt,
  sliceFile,
  toolInput,
} from '../plugins/forward-compaction/src/frontier.ts';
import { emptyHeld, LISTS } from '../plugins/forward-compaction/src/lists.ts';

// The call contract: the model sends changes, never a whole frontier; nothing is refused, whatever cannot be read is one note.

const notes = (input: unknown, cwd?: string): string[] => parseCall(input, cwd).notes;
const FIELDS_NOTE = 'The fields are objective, next, orders, decisions, done, remaining, blocked, findings, storage and load_files.';

describe('the forward_compaction tool as registered', () => {
  it('is named forward_compaction, says changes go by number, and holds one example call', () => {
    expect(FORWARD_TOOL).toBe('forward_compaction');
    expect(FORWARD_TOOL_DESCRIPTION).toBe('Compacts your large context at a clean milestone. The plugin keeps your frontier as numbered lists; send only changes: add texts, remove or edit by number; what you leave out stays. MANDATORY: keep it clean: each call removes what is finished, lifted or wrong, edits what changed. At the next compaction the lists and recorded facts replace all before this call; the newest later messages that fit stay verbatim. Always stores. Example: forward_compaction({"next": "Run the gate", "done": {"add": ["Parser merged, 41 tests pass"]}, "remaining": {"remove": [3]}}). Exact old detail later → look_back.');
  });

  it('closes the schema: two texts, six lists each with add, remove and edit, storage and load_files, none required', () => {
    expect(FORWARD_INPUT_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false });
    expect(FORWARD_INPUT_SCHEMA).not.toHaveProperty('required');
    expect(Object.keys(FORWARD_INPUT_SCHEMA.properties)).toEqual(['objective', 'next', 'decisions', 'done', 'remaining', 'blocked', 'findings', 'orders', 'storage', 'load_files']);
    expect(FORWARD_INPUT_SCHEMA.properties.objective.description).toBe('What the work is for and what done means. Send it on your first call, then only when it changes.');
    expect(FORWARD_INPUT_SCHEMA.properties.next.description).toBe('Every call: the first concrete action after the wake.');
    expect(Object.fromEntries(LISTS.map((name) => [name, FORWARD_INPUT_SCHEMA.properties[name].description]))).toEqual({
      orders: `Every rule of the user's that binds the rest of the work (a prohibition, a limit, a rule), in the user's words; several may share one item. An instruction for one part of the work is no order: it goes to remaining. A rule the user changes is edited. A rule the user lifts leaves entirely, never kept as a LIFTED note: remove its item, or edit the item down to its other rules. Example: [2] reads 'Never push. Tests go in tests/. One CHANGELOG line per fix.' and the user drops the CHANGELOG rule. Wrong: {"edit": [{"id": 2, "text": "Never push. Tests go in tests/. LIFTED: one CHANGELOG line per fix."}]}. Right: {"edit": [{"id": 2, "text": "Never push. Tests go in tests/."}]}.`,
      decisions: "Every ruling the user gave on how something gets done, in the user's words, each with its undo when one exists. A question the user put on hold goes to blocked.",
      done: 'Finished pieces, each with how it was verified; every figure with the command that produced it.',
      remaining: 'Every step left, in order. An added step lands last, or before a step it names: {"before": 4, "text": "..."}.',
      blocked: "Every question or choice on hold until the user answers, in the user's words; removed once answered.",
      findings: 'Your own choices with why, errors verbatim, the commands and recipes you will need again.',
    });
    const done = FORWARD_INPUT_SCHEMA.properties.done.properties;
    expect([done.add.description, done.remove.description, done.edit.description]).toEqual(['New items, one text each; the result gives each its number. Your first call has only adds.', 'Numbers of items to drop, as the wake shows them: [2, 5].', 'Replaces one item\'s whole text: [{"id": 4, "text": "..."}].']);
    expect(done.add.items).toEqual({ type: 'string' });
    expect(FORWARD_INPUT_SCHEMA.properties.remaining.properties.add.items).toEqual({ anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: false, required: ['text'], properties: { before: { type: 'integer' }, text: { type: 'string' } } }] });
    expect(FORWARD_INPUT_SCHEMA.properties.storage.description).toBe('Markdown files you keep for a later step and read or edit yourself with Read and Edit; the wake lists each by name and description.');
    expect(FORWARD_INPUT_SCHEMA.properties.load_files.description).toBe('Files read into the new context when it installs: each up to 250 lines; a longer file or range carries its first 250 and names where to Read the rest.');
    expect(Object.keys(FORWARD_INPUT_SCHEMA.properties.load_files.items.properties)).toEqual(['path', 'lines', 'why']);
    expect([LOAD_FILE_MAX_LINES, WHY_MAX_CHARS]).toEqual([250, 200]);
  });
});

describe('parseCall passes each change on as sent and names every argument it reads another way', () => {
  it('passes texts, lists and storage on untouched, and has no load files when the call sends none', () => {
    const input = { objective: 'ship it', next: 'wire the hook', done: { add: ['parser'] }, remaining: 'not an object', storage: { add: [{ name: 'a.md' }] } };
    expect(parseCall(input)).toEqual({ texts: { objective: 'ship it', next: 'wire the hook' }, lists: { done: { add: ['parser'] }, remaining: 'not an object' }, extra: {}, storage: { add: [{ name: 'a.md' }] }, loadAt: [], notes: [] });
    expect(parseCall({ load_files: [] })).toMatchObject({ loadFiles: [], notes: [] });
    for (const input of ['## Objective', undefined, null]) expect(parseCall(input)).toEqual({ texts: {}, lists: {}, extra: {}, loadAt: [], notes: [] });
  });

  it.each([
    [{ notes: 'keep the cache warm' }, { findings: ['[notes, an argument forward_compaction does not take]\nkeep the cache warm'] }, [`unknown field "notes" added to findings. ${FIELDS_NOTE}`]],
    [{ extra: { a: 1 } }, { findings: ['[extra, an argument forward_compaction does not take]\n{"a":1}'] }, [`unknown field "extra" added to findings. ${FIELDS_NOTE}`]],
    [{ standing_orders: [{ order: 'never push' }, 'Write no files.', { order: ' ' }] }, { orders: ['never push', 'Write no files.'] }, ['standing_orders is now orders: its 2 entries are taken as orders.add.']],
    [{ standing_orders: { order: 'never push' } }, { orders: ['never push'] }, ['standing_orders is now orders: its 1 entry is taken as orders.add.']],
    [{ lifted: [{ order: 'never push', by: 'push it' }] }, {}, ['lifted is no field: to lift an order, send its number in orders.remove. Nothing lifted.']],
    [{ keep_skills: ['notes'] }, {}, ['keep_skills is no field: ignored.']],
    [{ drop_skills: ['notes'] }, {}, ['drop_skills is no field: ignored.']],
    [{ drop_files: ['/a'] }, {}, ['drop_files is no field: ignored.']],
  ])('%j joins %j', (input, extra, want) => {
    const call = parseCall(input);
    expect([call.extra, call.notes]).toEqual([extra, want]);
  });

  it('takes back out the parameters a broken call folded into a text after its closing tag, naming each', () => {
    const out = parseCall({ objective: 'ship it</objective>\n<parameter name="done">{"add": ["parser"]}</done>\n<parameter name="next">wire the hook' });
    expect([out.texts, out.lists, out.notes]).toEqual([{ objective: 'ship it', next: 'wire the hook' }, { done: { add: ['parser'] } }, [
      'done arrived inside objective, after "</objective>": your call\'s markup closed objective early; taken back out as its own field.',
      'next arrived inside objective, after "</objective>": your call\'s markup closed objective early; taken back out as its own field.',
    ]]);
    expect(parseCall({ next: 'a</next>\n<parameter name="done">parser, tested' }).lists).toEqual({ done: 'parser, tested' });
    const sent = parseCall({ objective: 'a</objective>\n<parameter name="next">other', next: 'mine' });
    expect([sent.texts, sent.notes]).toEqual([{ objective: 'a\n\n[next, as it arrived inside objective]\nother', next: 'mine' }, ['next arrived inside objective, after "</objective>", but the call also sent next: kept in objective as it arrived.']]);
    const unknown = parseCall({ next: 'a</next>\n<parameter name="notes">keep this' });
    expect([unknown.texts, unknown.notes]).toEqual([{ next: 'a\n\n[notes, as it arrived inside next]\nkeep this' }, ['notes arrived inside next, after "</next>", but notes is no field: kept in next as it arrived.']]);
    const broken = parseCall({ next: 'a</next>\n<parameter name="storage">[{"name": "x"</storage>' });
    expect(broken.notes).toEqual([`storage arrived inside next, after "</next>", but it is not JSON (${(() => { try { JSON.parse('[{"name": "x"'); } catch (e) { return (e as Error).message; } })()}): kept in next as it arrived.`]);
    expect(parseCall({ next: 'a </b> <parameter name="done">x' }).texts).toEqual({ next: 'a </b> <parameter name="done">x' });
  });

  it('V7 load_files that is not an array carries no file, and the earlier call\'s stay', () => {
    for (const bad of ['a', {}, null, 3]) expect(parseCall({ load_files: bad })).toEqual({ texts: {}, lists: {}, extra: {}, loadAt: [], notes: ['load_files must be an array of {path, lines?, why}: none carried.'] });
  });

  it('V8 has no count cap: every well-formed entry is carried, none named', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({ path: `/f${i}`, why: 'w' }));
    expect(parseCall({ load_files: twenty })).toMatchObject({ loadFiles: twenty, notes: [] });
  });

  it('V9 a relative path is carried resolved against the session directory; a missing one skips that entry only (R15)', () => {
    const rel = parseCall({ load_files: [{ path: 'src/a.ts', why: 'x' }, { path: './b.ts' }] }, '/work/');
    expect([rel.loadFiles, rel.notes]).toEqual([[{ path: '/work/src/a.ts', why: 'x' }, { path: '/work/b.ts' }], ['load_files[0].path "src/a.ts" is relative: carried as /work/src/a.ts, in the session\'s directory.', 'load_files[1].path "./b.ts" is relative: carried as /work/b.ts, in the session\'s directory.']]);
    const unknown = parseCall({ load_files: [{ path: 'src/a.ts', why: 'x' }] });
    expect([unknown.loadFiles, unknown.notes]).toEqual([[{ path: 'src/a.ts', why: 'x' }], ['load_files[0].path "src/a.ts" is relative and the session\'s directory is unknown: carried as given.']]);
    const out = parseCall({ load_files: [{ path: '/ok', why: 'x' }, { why: 'x' }, '/ok', { path: ' ' }] });
    expect([out.loadFiles, out.loadAt, out.notes]).toEqual([[{ path: '/ok', why: 'x' }], [0], ['load_files[1].path must be a non-blank string; got undefined: skipped.', 'load_files[2].path must be a non-blank string; got undefined: skipped.', 'load_files[3].path must be a non-blank string; got string: skipped.']]);
  });

  it('V10 a why that is missing or blank carries the file without it, one over 200 is cut, one not a string is named', () => {
    expect(parseCall({ load_files: [{ path: '/a' }, { path: '/b', why: '   ' }] })).toMatchObject({ loadFiles: [{ path: '/a' }, { path: '/b' }], notes: [] });
    expect(parseCall({ load_files: [{ path: '/a', why: 'w'.repeat(200) }] })).toMatchObject({ loadFiles: [{ path: '/a', why: 'w'.repeat(200) }], notes: [] });
    expect(parseCall({ load_files: [{ path: '/a', why: 'w'.repeat(201) }] })).toMatchObject({ loadFiles: [{ path: '/a', why: 'w'.repeat(200) }], notes: ['load_files[0].why is 201 characters, over 200: cut to its first 200.'] });
    expect(parseCall({ load_files: [{ path: '/a', why: 3 }] })).toMatchObject({ loadFiles: [{ path: '/a' }], notes: ['load_files[0].why must be a string; got number: /a carried without it.'] });
  });

  it('V11 lines that are not a range list carry that file from line 1, naming the bad range (R15)', () => {
    expect(parseCall({ load_files: [{ path: '/a', why: 'x', lines: '10-' }] })).toMatchObject({ loadFiles: [{ path: '/a', why: 'x' }], notes: ['load_files[0].lines "10-" is not a range like "10-40" or "1-60,160-185": /a carried from line 1.'] });
    expect(notes({ load_files: [{ path: '/a', lines: '' }] })).toEqual(['load_files[0].lines "" is not a range like "10-40" or "1-60,160-185": /a carried from line 1.']);
    expect(notes({ load_files: [{ path: '/a', lines: 5 }] })).toEqual(['load_files[0].lines "5" is not a range like "10-40" or "1-60,160-185": /a carried from line 1.']);
  });

  it('a load file\'s later is read as no field, and the file is carried', () => {
    expect(parseCall({ load_files: [{ path: '/a', why: 'w', later: true }] })).toMatchObject({ loadFiles: [{ path: '/a', why: 'w' }], notes: ['load_files[0].later is no field: /a is carried.'] });
  });
});

describe('applyCall changes the held frontier by item number', () => {
  const first = applyCall(emptyHeld(), parseCall({ objective: 'ship it', next: 'wire the hook', done: { add: ['parser'] }, remaining: { add: ['adapter', 'docs'] }, extra: 'a note' }));

  it('a first call of adds numbers each item from 1, objective first, next last, and an outside item after its list\'s own', () => {
    expect(first.lines).toEqual(['objective set', 'Added to done: [1]', 'Added to remaining: [1], [2]', 'Added to findings: [1]', 'next set']);
    expect(first.notes).toEqual([`unknown field "extra" added to findings. ${FIELDS_NOTE}`]);
    expect([first.held.objective, first.held.next, first.held.lists.remaining, first.held.lists.findings]).toEqual(['ship it', 'wire the hook', { next_id: 3, items: [{ id: 1, text: 'adapter' }, { id: 2, text: 'docs' }] }, { next_id: 2, items: [{ id: 1, text: '[extra, an argument forward_compaction does not take]\na note' }] }]);
    expect(first.changed.map((c) => c.key)).toEqual(['done', 'remaining', 'findings', 'objective', 'next']);
    expect([first.missing, first.counts.remaining]).toEqual([[], { added: 2, removed: 0, edited: 0, skipped: 0 }]);
  });

  it('a second call removes and edits by number and adds, never reusing a number, and leaves every list it does not name', () => {
    const second = applyCall(first.held, parseCall({ remaining: { remove: [1], edit: [{ id: 2, text: 'docs and README' }], add: ['gate'] } }));
    expect(second.lines).toEqual(['Added to remaining: [3]', 'Removed from remaining: [1] adapter', 'Edited in remaining: [2], was: docs', 'next kept: wire the hook']);
    expect(second.held.lists.remaining).toEqual({ next_id: 4, items: [{ id: 2, text: 'docs and README' }, { id: 3, text: 'gate' }] });
    expect(second.held.lists.done).toBe(first.held.lists.done);
    expect(second.changed).toEqual([{ key: 'remaining', left: [{ id: 2, text: 'docs', left: 'edited' }, { id: 1, text: 'adapter', left: 'removed' }] }]);
  });

  it('names each text still missing, and a replaced one leaves its old value', () => {
    expect(applyCall(emptyHeld(), parseCall({ done: { add: ['x'] } })).missing).toEqual(['objective', 'next']);
    expect(applyCall(first.held, parseCall({ objective: 'ship v2' })).changed).toEqual([{ key: 'objective', left: ['ship it'] }]);
  });
});

describe('receipt says what was stored and when it installs, per party (R16)', () => {
  const MAIN = " It installs at the end of this turn, or at Claude Code's next compaction ask if one comes first. The newest messages after this call that fit are kept verbatim behind it, the rest named as not carried, so finish the step in hand; you need not stop.";
  const DUE = " It installs at Claude Code's next compaction ask, before your next request. The newest messages after this call that fit are kept verbatim behind it, the rest named as not carried.";
  const BELOW = " Claude Code has not asked to compact you yet: it installs at Claude Code's next ask, from about 67k context. The newest messages after this call that fit are kept verbatim behind it, the rest named as not carried. Carry on with your work.";
  it.each([
    [{ party: 'subagent' as const, files: 0, tokens: 41_200, askPoint: 67_000 }, `Frontier stored.${BELOW}`],
    [{ party: 'subagent' as const, files: 0, askPoint: 67_000 }, `Frontier stored.${BELOW}`],
    [{ party: 'subagent' as const, files: 2, tokens: 66_999, askPoint: 67_000 }, `Frontier stored with 2 files to load.${BELOW}`],
    [{ party: 'subagent' as const, files: 2, tokens: 67_000, askPoint: 67_000 }, `Frontier stored with 2 files to load.${DUE}`],
    [{ party: 'subagent' as const, files: 1, tokens: 90_000, askPoint: 67_000, replaced: true }, `Frontier stored with 1 file to load.${DUE} This call applied on top of your earlier one since the last wake.`],
    [{ party: 'main' as const, files: 3 }, `Frontier stored with 3 files to load.${MAIN}`],
    [{ party: 'main' as const, files: 0, missing: ['next'] }, `Frontier stored, without next: send it before it installs, or the wake names it missing.${MAIN}`],
    [{ party: 'main' as const, files: 0, missing: ['objective', 'next'], replaced: true }, `Frontier stored, without objective and next: send them before it installs, or the wake names them missing.${MAIN} This call applied on top of your earlier one since the last wake.`],
  ])('%j', (input, want) => {
    expect(receipt(input)).toBe(want);
  });
});

describe('loadFileNote judges what $.fs.stat found', () => {
  it('accepts a regular file', () => {
    expect(loadFileNote(0, '/a', { kind: 'file', size: 0 })).toBeUndefined();
    expect(loadFileNote(0, '/a', { kind: 'file', size: 1_048_576 })).toBeUndefined();
  });

  it('V12 absent', () => {
    expect(loadFileNote(2, '/a/b.ts', { absent: true })).toBe('load_files[2] /a/b.ts: no such file: skipped.');
  });

  it('V13 not a regular file', () => {
    expect(loadFileNote(0, '/a', { kind: 'dir', size: 4096 })).toBe('load_files[0] /a is not a regular file: skipped.');
    expect(loadFileNote(1, '/a', { kind: 'other', size: 0 })).toBe('load_files[1] /a is not a regular file: skipped.');
  });

  it('L6 never skips a file for its size: the wake fits it or names it', () => {
    expect(loadFileNote(0, '/big', { kind: 'file', size: 50_000_000 })).toBeUndefined();
  });

  it('V15 a stat that threw is "could not be checked", never "no such file"', () => {
    const out = loadFileNote(0, '/a', { error: 'EACCES: permission denied' });
    expect(out).toBe('load_files[0] /a could not be checked: EACCES: permission denied: skipped.');
    expect(out).not.toContain('no such file');
  });
});


describe('parseLineRanges and sliceFile (copied from the old carry module)', () => {
  it('honours a line range exactly', () => {
    expect(parseLineRanges('10-20')).toEqual([{ from: 10, to: 20 }]);
    expect(parseLineRanges('10:20')).toEqual([{ from: 10, to: 20 }]);
    expect(parseLineRanges('7')).toEqual([{ from: 7, to: 7 }]);
    expect(parseLineRanges('20-10')).toBeUndefined();
    expect(parseLineRanges('abc')).toBeUndefined();
    expect(parseLineRanges('10-')).toBeUndefined();
    expect(sliceFile('/f', 'a\nb\nc\nd\ne', [{ from: 2, to: 4 }])).toEqual({ body: 'b\nc\nd', shown: '2-4' });
  });

  it('takes several ranges, each loaded in order with the lines between them named as not loaded', () => {
    expect(parseLineRanges('1-60,160-185')).toEqual([{ from: 1, to: 60 }, { from: 160, to: 185 }]);
    expect(parseLineRanges(' 3 , 5-6 ')).toEqual([{ from: 3, to: 3 }, { from: 5, to: 6 }]);
    expect(parseLineRanges('1-3,,5')).toBeUndefined();
    expect(parseLineRanges('1-3,x')).toBeUndefined();
    expect(sliceFile('/f', 'a\nb\nc\nd\ne\nf', [{ from: 1, to: 2 }, { from: 5, to: 6 }])).toEqual({ body: 'a\nb\n[lines 3-4 not loaded]\ne\nf', shown: '1-2,5-6' });
  });

  it('names a range past the end of the file, never loading it as nothing', () => {
    const file = Array.from({ length: 149 }, (_, n) => `line ${n + 1}`).join('\n') + '\n';
    expect(sliceFile('/f', file, [{ from: 150, to: 200 }])).toEqual({ problem: 'lines 150-200: past the end of the file, which has 149 lines' });
    expect(sliceFile('/f', file, [{ from: 148, to: 200 }])).toEqual({ body: 'line 148\nline 149', shown: '148-149', problem: 'lines 148-200: the file ends at line 149' });
    expect(sliceFile('/f', file, [{ from: 1, to: 1 }, { from: 160, to: 170 }])).toEqual({ body: 'line 1', shown: '1', problem: 'lines 160-170: past the end of the file, which has 149 lines' });
    expect(sliceFile('/f', '', undefined)).toEqual({ problem: 'the file is empty' });
    expect(sliceFile('/f.png', 'PNG\u0000IHDR', undefined)).toEqual({ problem: 'not a text file' });
    expect(sliceFile('/f', 'x'.repeat(40_000), undefined, 40_000)).toEqual({ body: 'x'.repeat(40_000), shown: '' });
    expect(sliceFile('/f', 'x'.repeat(40_001), undefined)).toEqual({ body: 'x'.repeat(40_001), shown: '' });
    expect(sliceFile('/f', 'x'.repeat(40_001), undefined, 40_000)).toEqual({ body: `${'x'.repeat(40_000)}\n[cut at 40000 characters: Read /f for the rest]`, shown: '' });
    expect(sliceFile('/f', `a\n${'x'.repeat(40_001)}`, [{ from: 2, to: 2 }], 40_000)).toEqual({ body: `${'x'.repeat(40_000)}\n[cut at 40000 characters: Read /f for the rest]`, shown: '2' });
    expect(sliceFile('/f', 'x\n', undefined)).toEqual({ body: 'x\n', shown: '' });
  });

  it('names a range of only blank lines, never loading it as a block that says nothing', () => {
    expect(sliceFile('/f', 'a\n\n\nd\n', [{ from: 2, to: 3 }])).toEqual({ problem: 'lines 2-3: only blank lines' });
    expect(sliceFile('/f', 'a\n\n', [{ from: 2, to: 5 }])).toEqual({ problem: 'lines 2-5: the file ends at line 2; lines 2: only blank lines' });
  });

  it('loads ranges in file order, an overlap once', () => {
    const file = 'a\nb\nc\nd\ne\nf\ng\n';
    expect(sliceFile('/f', file, [{ from: 6, to: 7 }, { from: 1, to: 2 }])).toEqual({ body: 'a\nb\n[lines 3-5 not loaded]\nf\ng', shown: '1-2,6-7' });
    expect(sliceFile('/f', file, [{ from: 1, to: 3 }, { from: 2, to: 4 }, { from: 5, to: 5 }])).toEqual({ body: 'a\nb\nc\nd\ne', shown: '1-5' });
  });

  it('carries at most 250 lines of a file, from line 1, and names where to Read the rest', () => {
    const file = (n: number): string => Array.from({ length: n }, (_, i) => `l${i + 1}`).join('\n') + '\n';
    expect(sliceFile('/f', file(250), undefined)).toEqual({ body: file(250), shown: '' });
    const first = Array.from({ length: 250 }, (_, i) => `l${i + 1}`).join('\n');
    expect(sliceFile('/f', file(400), undefined)).toEqual({ body: `${first}\n[150 more lines not carried: Read /f from line 251]`, shown: '1-250' });
  });

  it('carries at most 250 lines of the ranges asked, counting the lines left in the ranges, and names the next one to Read', () => {
    const file = Array.from({ length: 1000 }, (_, i) => `l${i + 1}`).join('\n');
    const body = (from: number, to: number): string => Array.from({ length: to - from + 1 }, (_, i) => `l${from + i}`).join('\n');
    expect(sliceFile('/f', file, [{ from: 101, to: 600 }])).toEqual({ body: `${body(101, 350)}\n[250 more lines not carried: Read /f from line 351]`, shown: '101-350' });
    // 200 from the first range, 50 of the second, then 50 left of it and 100 of the third
    expect(sliceFile('/f', file, [{ from: 1, to: 200 }, { from: 301, to: 400 }, { from: 801, to: 900 }])).toEqual({
      body: `${body(1, 200)}\n[lines 201-300 not loaded]\n${body(301, 350)}\n[150 more lines not carried: Read /f from line 351]`,
      shown: '1-200,301-350',
    });
    expect(sliceFile('/f', file, [{ from: 1, to: 250 }, { from: 900, to: 1200 }])).toEqual({
      body: `${body(1, 250)}\n[101 more lines not carried: Read /f from line 900]`,
      shown: '1-250',
      problem: 'lines 900-1200: the file ends at line 1000',
    });
  });
});

describe('every answer ends with the experimental line', () => {
  it('names the issues file in the level-log directory', () => {
    expect(experimental('Frontier stored (1 characters, 0 files).', '/logs/forward-compaction')).toBe(
      'Frontier stored (1 characters, 0 files).\nforward-compaction is experimental. If it gave you any trouble, append a short note of what happened to /logs/forward-compaction/issues.md; it will be taken care of later.',
    );
    expect(experimental('x', '/logs/forward-compaction/')).toContain('to /logs/forward-compaction/issues.md;');
  });

  it('asks for the note in the reply when no directory resolves', () => {
    expect(experimental('refused', undefined)).toBe('refused\nforward-compaction is experimental. If it gave you any trouble, append a short note of what happened to your reply.');
  });
});

describe('toolInput keeps the event envelope out of the arguments', () => {
  it('drops every reserved key the tool.call event declares', () => {
    const e = { tool: 'mcp__x__y', tool_use_id: 't1', agentId: 'a1', requestMeta: { k: 1 }, consent: { ok: true }, objective: 'ship it' };
    expect(toolInput(e)).toEqual({ objective: 'ship it' });
  });
});
