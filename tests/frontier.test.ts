import { describe, expect, it } from 'vitest';
import { DROP_MAX } from '../plugins/forward-compaction/src/drop.ts';
import {
  FORWARD_INPUT_SCHEMA,
  FORWARD_TOOL,
  FORWARD_TOOL_DESCRIPTION,
  LOAD_FILE_MAX_LINES,
  WHY_MAX_CHARS,
  loadFileNote,
  parseFrontier,
  parseLineRanges,
  experimental,
  receipt,
  sliceFile,
  changesNote,
  toolInput,
  INCOMPLETE_NOTE,
} from '../plugins/forward-compaction/src/frontier.ts';

const valid = { objective: 'ship it', decisions: 'none', done: 'parser, tested', remaining: 'the adapter', next: 'wire the hook' };
const text = '## Objective\nship it\n\n## Decisions\nnone\n\n## Done\nparser, tested\n\n## Remaining\nthe adapter\n\n## Next\nwire the hook';
const notes = (input: unknown): string[] => parseFrontier(input).notes;
const SECTIONS = ['objective', 'decisions', 'done', 'remaining', 'next', 'blocked', 'findings'];
const REQUIRED = ['objective', 'decisions', 'done', 'remaining', 'next'];

describe('the forward_compaction tool as registered', () => {
  it('is named forward_compaction and its description is short and holds one example call with the section arguments (R17)', () => {
    expect(FORWARD_TOOL).toBe('forward_compaction');
    expect(FORWARD_TOOL_DESCRIPTION.length).toBeLessThanOrEqual(600);
    expect(FORWARD_TOOL_DESCRIPTION).toContain('forward_compaction({"objective": "…", "decisions": "…", "done": "…", "remaining": "…", "next": "…", "load_files": []})');
    expect(FORWARD_TOOL_DESCRIPTION).not.toContain('"frontier"');
    expect(FORWARD_TOOL_DESCRIPTION).toContain('standing_orders');
    expect(FORWARD_TOOL_DESCRIPTION).toContain('the newest later messages that fit stay verbatim, the rest named as not carried');
  });

  it('names its caps once, and the schema agrees with them', () => {
    expect([LOAD_FILE_MAX_LINES, WHY_MAX_CHARS]).toEqual([250, 200]);
    expect(FORWARD_INPUT_SCHEMA.properties.load_files).not.toHaveProperty('maxItems');
    expect(FORWARD_INPUT_SCHEMA.properties.load_files.description).toBe('Files carried into the new context, read when it installs: each up to 250 lines; a longer file or range carries its first 250 and names where to Read the rest. Pass lines ranges to carry only what you need.');
    expect(FORWARD_INPUT_SCHEMA.properties.load_files.items.properties.why.maxLength).toBe(WHY_MAX_CHARS);
  });

  it('closes the schema: five required sections, two optional ones, load_files each with a path and a why', () => {
    expect(FORWARD_INPUT_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false, required: REQUIRED });
    expect(Object.keys(FORWARD_INPUT_SCHEMA.properties)).toEqual([...SECTIONS, 'load_files', 'drop_skills', 'standing_orders', 'lifted']);
    for (const name of SECTIONS) expect(FORWARD_INPUT_SCHEMA.properties[name as 'objective']).toMatchObject({ type: 'string', description: expect.any(String) });
    for (const name of REQUIRED) expect(FORWARD_INPUT_SCHEMA.properties[name as 'objective'].description).toMatch(/^MANDATORY: /);
    expect(FORWARD_INPUT_SCHEMA.properties.objective.description).toBe('MANDATORY: what the work is for and what done means.');
    expect(FORWARD_INPUT_SCHEMA.properties.decisions.description).toBe("MANDATORY: every ruling the person gave on how something gets done, in the person's words, each with its undo when one exists; \"none\" when there are none. Rules binding the rest of the work go in standing_orders.");
    expect(FORWARD_INPUT_SCHEMA.properties.done.description).toBe('MANDATORY: finished pieces, each with how it was verified; every figure with the command that produced it.');
    expect(FORWARD_INPUT_SCHEMA.properties.remaining.description).toBe('MANDATORY: every step left, in order; "none" when nothing is left.');
    expect(FORWARD_INPUT_SCHEMA.properties.next.description).toBe('MANDATORY: the first concrete action after the wake.');
    expect(FORWARD_INPUT_SCHEMA.properties.findings.description).toBe('Optional: your own choices with why, errors verbatim, the commands and recipes you will need again.');
    for (const name of SECTIONS.filter((n) => !REQUIRED.includes(n))) expect(FORWARD_INPUT_SCHEMA.properties[name as 'blocked'].description).toMatch(/^Optional: /);
    const files = FORWARD_INPUT_SCHEMA.properties.load_files;
    expect(files).toMatchObject({ type: 'array', items: { additionalProperties: false, required: ['path', 'why'], properties: { why: { maxLength: 200 } } } });
  });
});

describe('parseFrontier assembles the sections and keeps their text whole', () => {
  it('assembles the five required sections in order, Decisions right after Objective, and no load files when none are given', () => {
    expect(parseFrontier(valid)).toEqual({ frontier: text, loadFiles: [], loadAt: [], dropSkills: [], standingOrders: [], lifted: [], missing: [], notes: [] });
  });

  it('places the optional sections after them, Blocked before Findings, and leaves out an absent or blank one', () => {
    expect(parseFrontier({ findings: 'f', ...valid, blocked: 'b' })).toEqual({ frontier: `${text}\n\n## Blocked\nb\n\n## Findings\nf`, loadFiles: [], loadAt: [], dropSkills: [], standingOrders: [], lifted: [], missing: [], notes: [] });
    expect(parseFrontier({ ...valid, findings: 'f' })).toEqual({ frontier: `${text}\n\n## Findings\nf`, loadFiles: [], loadAt: [], dropSkills: [], standingOrders: [], lifted: [], missing: [], notes: [] });
    expect(parseFrontier({ ...valid, blocked: '  ' })).toEqual({ frontier: text, loadFiles: [], loadAt: [], dropSkills: [], standingOrders: [], lifted: [], missing: [], notes: [] });
  });

  it('keeps a section\'s own headings, blank lines, trailing space and Windows line ends untouched', () => {
    const own = 'x  \r\n\r\n### Goal\r\n## Notes\r\n';
    expect(parseFrontier({ ...valid, objective: own })).toEqual({ frontier: text.replace('ship it', own), loadFiles: [], loadAt: [], dropSkills: [], standingOrders: [], lifted: [], missing: [], notes: [] });
  });

  it('keeps a load file as given, lines and why included', () => {
    const files = [{ path: '/a/b.ts', lines: '1-60,160-185', why: 'the parser' }, { path: 'C:\\a\\b.ts', why: 'win' }];
    expect(parseFrontier({ ...valid, load_files: files })).toEqual({ frontier: text, loadFiles: files, loadAt: [0, 1], dropSkills: [], standingOrders: [], lifted: [], missing: [], notes: [] });
  });

  it('takes a frontier of any length whole, never refused or trimmed for size', () => {
    const next = valid.next + 'x'.repeat(200_000 - text.length);
    const out = parseFrontier({ ...valid, next });
    expect(out.frontier.length).toBe(200_000);
    const eight = Array.from({ length: 8 }, (_, i) => ({ path: `/f${i}`, why: 'w' }));
    expect(parseFrontier({ ...valid, load_files: eight })).toMatchObject({ loadFiles: eight });
    expect(parseFrontier({ ...valid, load_files: [{ path: '/f', why: 'w'.repeat(200) }] }).notes).toEqual([]);
  });
});

describe('parseFrontier stores whatever it is sent and names what it left out', () => {
  it('V1 an unknown field is ignored and named, the old frontier argument included (R14)', () => {
    expect(notes({ ...valid, drop: [] })).toEqual(['unknown field "drop" ignored. The fields are objective, decisions, done, remaining, next, blocked, findings, load_files, drop_skills, standing_orders and lifted.']);
    expect(notes({ ...valid, frontier: text })[0]).toContain('unknown field "frontier"');
    expect(parseFrontier({ ...valid, frontier: text }).frontier).toBe(text);
  });

  it('takes back out the parameters a broken call folded into a section after its closing tag, naming each', () => {
    const orders = [{ order: 'Write and edit no files.' }];
    const { next, ...rest } = valid;
    const folded = { ...rest, remaining: `the adapter</remaining>\n<parameter name="standing_orders">${JSON.stringify(orders)}</standing_orders>\n<parameter name="next">${next}` };
    const out = parseFrontier(folded);
    expect(out.frontier).toBe(text);
    expect(out.missing).toEqual([]);
    expect(out.notes).toEqual([
      'standing_orders arrived inside remaining, after "</remaining>": your call\'s markup closed remaining early; taken back out as its own field.',
      'next arrived inside remaining, after "</remaining>": your call\'s markup closed remaining early; taken back out as its own field.',
      'standing_orders[0].at must be the ISO time of the person\'s message, like "2026-10-27T14:53:00Z": skipped.',
    ]);
    expect(parseFrontier({ ...valid, remaining: 'a</remaining>\n<parameter name="next">other' }).notes[0]).toBe('next arrived inside remaining, after "</remaining>", but the call also sent next: the text after "</remaining>" is dropped.');
    expect(parseFrontier({ ...rest, remaining: `the adapter</remaining>\n<parameter name="next">${next}</next>\n` })).toMatchObject({ frontier: text, missing: [] });
    expect(parseFrontier({ ...valid, remaining: 'a </b> <parameter name="next">x' }).frontier).toBe(text.replace('the adapter', 'a </b> <parameter name="next">x'));
  });

  it('V2 a required section that is missing, not a string or blank is left out, by name', () => {
    expect(notes({ ...valid, objective: 5 })).toEqual(['objective must be a string; got number: your frontier is stored without it.']);
    expect(notes({ ...valid, done: undefined })).toEqual(['done was missing: your frontier is stored without it.']);
    expect(notes({ ...valid, remaining: null })).toEqual(['remaining must be a string; got null: your frontier is stored without it.']);
    expect(notes({ ...valid, next: ' \n ' })).toEqual(['next was blank: your frontier is stored without it.']);
    expect(parseFrontier({ ...valid, done: undefined }).frontier).toBe('## Objective\nship it\n\n## Decisions\nnone\n\n## Remaining\nthe adapter\n\n## Next\nwire the hook');
  });

  it('lists every required section that is absent, not a string or blank as missing, in section order; an optional one never', () => {
    expect(parseFrontier(valid).missing).toEqual([]);
    expect(parseFrontier({ ...valid, blocked: 3, findings: '' }).missing).toEqual([]);
    expect(parseFrontier({ objective: 'cut off mid-wo' }).missing).toEqual(['decisions', 'done', 'remaining', 'next']);
    expect(parseFrontier({ ...valid, decisions: undefined, next: ' \n ', done: 7 }).missing).toEqual(['decisions', 'done', 'next']);
    expect(parseFrontier(null).missing).toEqual(['objective', 'decisions', 'done', 'remaining', 'next']);
  });

  it('V3 an optional section that is present but not a string is left out, by name', () => {
    expect(notes({ ...valid, blocked: ['a'] })).toEqual(['blocked must be a string; got array: your frontier is stored without it.']);
    expect(notes({ ...valid, findings: 3 })).toEqual(['findings must be a string; got number: your frontier is stored without it.']);
    expect(parseFrontier({ ...valid, findings: 3 }).frontier).toBe(text);
  });

  it('V4 names every bad argument, one line each, and stores an input with nothing in it', () => {
    expect(notes({ done: 'd', extra: 1, findings: {} })).toEqual([
      'unknown field "extra" ignored. The fields are objective, decisions, done, remaining, next, blocked, findings, load_files, drop_skills, standing_orders and lifted.',
      'objective was missing: your frontier is stored without it.',
      'decisions was missing: your frontier is stored without it.',
      'remaining was missing: your frontier is stored without it.',
      'next was missing: your frontier is stored without it.',
      'findings must be a string; got object: your frontier is stored without it.',
    ]);
    for (const input of ['## Objective', undefined, null]) expect(parseFrontier(input)).toMatchObject({ frontier: '', notes: expect.arrayContaining(['objective was missing: your frontier is stored without it.']) });
  });

  it('V7 load_files that is not an array carries no file', () => {
    for (const bad of ['a', {}, null, 3]) expect(parseFrontier({ ...valid, load_files: bad })).toMatchObject({ loadFiles: [], notes: ['load_files must be an array of {path, lines?, why}: none carried.'] });
  });

  it('V8 has no count cap: every well-formed entry is carried, none named', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({ path: `/f${i}`, why: 'w' }));
    const out = parseFrontier({ ...valid, load_files: twenty });
    expect(out.notes).toEqual([]);
    expect(out.loadFiles).toEqual(twenty);
  });

  it('V9 a path that is missing or not absolute skips that entry only (R15)', () => {
    expect(notes({ ...valid, load_files: [{ path: 'src/a.ts', why: 'x' }] })).toEqual(['load_files[0].path must be an absolute path; got "src/a.ts": skipped.']);
    const out = parseFrontier({ ...valid, load_files: [{ path: '/ok', why: 'x' }, { why: 'x' }] });
    expect(out.notes).toEqual(['load_files[1].path must be an absolute path; got "undefined": skipped.']);
    expect(out.loadFiles).toEqual([{ path: '/ok', why: 'x' }]);
    expect(notes({ ...valid, load_files: ['/ok'] })[0]).toContain('load_files[0].path must be an absolute path');
  });

  it('V10 a why that is missing, empty or over 200 skips that entry', () => {
    expect(notes({ ...valid, load_files: [{ path: '/a' }] })).toEqual(['load_files[0].why must be 1–200 characters; it is 0: /a skipped.']);
    expect(notes({ ...valid, load_files: [{ path: '/a', why: '' }] })[0]).toContain('it is 0');
    expect(notes({ ...valid, load_files: [{ path: '/a', why: '   ' }] })[0]).toContain('1–200 characters');
    expect(notes({ ...valid, load_files: [{ path: '/a', why: 'w'.repeat(201) }] })).toEqual(['load_files[0].why must be 1–200 characters; it is 201: /a skipped.']);
  });

  it('V11 lines that are not a range list skips that entry (R15)', () => {
    expect(notes({ ...valid, load_files: [{ path: '/a', why: 'x', lines: '10-' }] })).toEqual(['load_files[0].lines "10-" is not a range like "10-40" or "1-60,160-185": /a skipped.']);
    expect(notes({ ...valid, load_files: [{ path: '/a', why: 'x', lines: '' }] })[0]).toContain('load_files[0].lines ""');
    expect(notes({ ...valid, load_files: [{ path: '/a', why: 'x', lines: 5 }] })[0]).toContain('load_files[0].lines "5" is not a range');
  });

  it('keeps the place each carried file had in load_files, so a later note names the entry the model sent', () => {
    expect(parseFrontier({ ...valid, load_files: [{ path: 'rel', why: 'x' }, { path: '/b', why: 'x' }] })).toMatchObject({ loadFiles: [{ path: '/b', why: 'x' }], loadAt: [1] });
  });

  it('drop_skills: a bad name is skipped, a non-array drops none, and names past the cap are not used', () => {
    expect(parseFrontier({ ...valid, drop_skills: ['a', '', 3] })).toMatchObject({ dropSkills: ['a'], notes: ['drop_skills[1] must be a non-blank string: skipped.', 'drop_skills[2] must be a non-blank string: skipped.'] });
    expect(parseFrontier({ ...valid, drop_skills: 'a' })).toMatchObject({ dropSkills: [], notes: ['drop_skills must be an array of skill or command names: none dropped.'] });
    const many = Array.from({ length: DROP_MAX + 2 }, (_, i) => `s${i}`);
    expect(parseFrontier({ ...valid, drop_skills: many })).toMatchObject({ dropSkills: many.slice(0, DROP_MAX), notes: [expect.stringContaining('over the')] });
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

describe('changesNote lists what the plugin changed in the call', () => {
  it('is empty when nothing changed, else one line per change', () => {
    expect(changesNote([])).toBe('');
    expect(changesNote(['a'])).toBe('Stored with 1 change:\n- a');
    expect(changesNote(['a', 'b'])).toBe('Stored with 2 changes:\n- a\n- b');
  });
});

describe('an incomplete frontier is stored and says it never installs', () => {
  it('opens the receipt with what is stored and that it does not install, for every party and door', () => {
    const text = 'Frontier stored (381 characters, 0 files), but a MANDATORY section is missing, so it does not install: Claude Code\'s compaction stays held as if nothing were stored.';
    expect(receipt({ party: 'main', chars: 381, files: 0, incomplete: true })).toBe(text);
    expect(receipt({ party: 'subagent', chars: 381, files: 0, tokens: 90_000, askPoint: 67_000, incomplete: true })).toBe(text);
    expect(receipt({ party: 'main', chars: 381, files: 0, replaced: true, incomplete: true })).toBe(`${text} It replaces the frontier you stored before.`);
  });

  it('ends its changes list with the line saying how to make it install, only when a section is missing', () => {
    expect(changesNote(['a'], [])).toBe('Stored with 1 change:\n- a');
    expect(changesNote(['next was missing'], ['next'])).toBe(`Stored with 1 change:\n- next was missing\n${INCOMPLETE_NOTE}`);
    expect(INCOMPLETE_NOTE).toBe('This frontier will not install until you call forward_compaction again with every MANDATORY section.');
  });
});

describe('receipt says when the frontier installs, per party (R16)', () => {
  it('sub-agent below its ask point: the spec example, word for word', () => {
    expect(receipt({ party: 'subagent', chars: 4812, files: 0, tokens: 41_200, askPoint: 67_000 })).toBe(
      "Frontier stored (4,812 characters, 0 files). Claude Code has not asked to compact you yet: it installs at Claude Code's next ask, from about 67k context. The newest messages after this call that fit are kept verbatim behind it, the rest named as not carried. Carry on with your work.",
    );
  });

  it('sub-agent at or above its ask point', () => {
    const text = "Frontier stored (900 characters, 2 files). It installs at Claude Code's next compaction ask, before your next request. The newest messages after this call that fit are kept verbatim behind it, the rest named as not carried.";
    expect(receipt({ party: 'subagent', chars: 900, files: 2, tokens: 67_000, askPoint: 67_000 })).toBe(text);
    expect(receipt({ party: 'subagent', chars: 900, files: 2, tokens: 90_000, askPoint: 67_000 })).toBe(text);
  });

  it('main', () => {
    const text = "Frontier stored (4,812 characters, 3 files). It installs at the end of this turn, or at Claude Code's next compaction ask if one comes first. The newest messages after this call that fit are kept verbatim behind it, the rest named as not carried, so finish the step in hand; you need not stop.";
    expect(receipt({ party: 'main', chars: 4812, files: 3 })).toBe(text);
    expect(receipt({ party: 'main', chars: 4812, files: 3, tokens: 80_000, askPoint: 67_000 })).toBe(text);
  });

  it('says it replaced one, printing no size for either call', () => {
    expect(receipt({ party: 'main', chars: 10, files: 0, replaced: true })).toMatch(/ It replaces the frontier you stored before\.$/);
    expect(receipt({ party: 'subagent', chars: 10, files: 0, tokens: 90_000, askPoint: 67_000, replaced: true })).toMatch(/ It replaces the frontier you stored before\.$/);
    expect(receipt({ party: 'main', chars: 10, files: 0 })).not.toContain('replaces');
  });

  it('takes a sub-agent with no reading (none since an install) as below its ask point', () => {
    expect(receipt({ party: 'subagent', chars: 10, files: 0, askPoint: 67_000 })).toContain('Claude Code has not asked to compact you yet');
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
