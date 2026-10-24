import { describe, expect, it } from 'vitest';
import {
  FORWARD_INPUT_SCHEMA,
  FORWARD_TOOL,
  FORWARD_TOOL_DESCRIPTION,
  HANDOFF_MAX_CHARS,
  LOAD_FILES_MAX,
  LOAD_FILE_MAX_BYTES,
  WHY_MAX_CHARS,
  loadFileRefusal,
  loadRoomRefusal,
  parseHandoff,
  parseLineRanges,
  experimental,
  receipt,
  sliceFile,
  ignoredRefusal,
} from '../plugins/forward-compaction/src/handoff.ts';

const valid = { objective: 'ship it', done: 'parser, tested', remaining: 'the adapter', next: 'wire the hook' };
const text = '## Objective\nship it\n\n## Done\nparser, tested\n\n## Remaining\nthe adapter\n\n## Next\nwire the hook';
const P = 'forward_compaction refused, nothing stored: ';
const refusal = (input: unknown): string | undefined => {
  const out = parseHandoff(input);
  return 'refusal' in out ? out.refusal : undefined;
};
const SECTIONS = ['objective', 'done', 'remaining', 'next', 'blocked', 'findings'];

describe('the forward_compaction tool as registered', () => {
  it('is named forward_compaction and its description is short and holds one example call with the section arguments (R17)', () => {
    expect(FORWARD_TOOL).toBe('forward_compaction');
    expect(FORWARD_TOOL_DESCRIPTION.length).toBeLessThanOrEqual(600);
    expect(FORWARD_TOOL_DESCRIPTION).toContain('forward_compaction({"objective": "…", "done": "…", "remaining": "…", "next": "…", "load_files": []})');
    expect(FORWARD_TOOL_DESCRIPTION).not.toContain('"handoff"');
  });

  it('names its caps once, and the schema agrees with them', () => {
    expect([HANDOFF_MAX_CHARS, LOAD_FILES_MAX, WHY_MAX_CHARS, LOAD_FILE_MAX_BYTES]).toEqual([20_000, 8, 200, 1_048_576]);
    expect(FORWARD_INPUT_SCHEMA.properties.load_files.maxItems).toBe(LOAD_FILES_MAX);
    expect(FORWARD_INPUT_SCHEMA.properties.load_files.items.properties.why.maxLength).toBe(WHY_MAX_CHARS);
    expect(FORWARD_TOOL_DESCRIPTION).toContain(`${HANDOFF_MAX_CHARS.toLocaleString('en-US')} characters`);
  });

  it('closes the schema: four required sections, two optional ones, at most 8 load_files with a path and a why', () => {
    expect(FORWARD_INPUT_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false, required: ['objective', 'done', 'remaining', 'next'] });
    expect(Object.keys(FORWARD_INPUT_SCHEMA.properties)).toEqual([...SECTIONS, 'load_files']);
    for (const name of SECTIONS) expect(FORWARD_INPUT_SCHEMA.properties[name as 'objective']).toMatchObject({ type: 'string', description: expect.any(String) });
    expect(FORWARD_INPUT_SCHEMA.properties.objective.description).toBe('What the work is for and what done means.');
    expect(FORWARD_INPUT_SCHEMA.properties.findings.description).toBe('Optional: decisions with why, errors verbatim.');
    const files = FORWARD_INPUT_SCHEMA.properties.load_files;
    expect(files).toMatchObject({ type: 'array', maxItems: 8, items: { additionalProperties: false, required: ['path', 'why'], properties: { why: { maxLength: 200 } } } });
  });
});

describe('parseHandoff assembles the sections and keeps their text whole', () => {
  it('assembles the four required sections in order, and no load files when none are given', () => {
    expect(parseHandoff(valid)).toEqual({ handoff: text, loadFiles: [] });
  });

  it('places the optional sections after them, Blocked before Findings, and leaves out an absent or blank one', () => {
    expect(parseHandoff({ findings: 'f', ...valid, blocked: 'b' })).toEqual({ handoff: `${text}\n\n## Blocked\nb\n\n## Findings\nf`, loadFiles: [] });
    expect(parseHandoff({ ...valid, findings: 'f' })).toEqual({ handoff: `${text}\n\n## Findings\nf`, loadFiles: [] });
    expect(parseHandoff({ ...valid, blocked: '  ' })).toEqual({ handoff: text, loadFiles: [] });
  });

  it('keeps a section\'s own headings, blank lines, trailing space and Windows line ends untouched', () => {
    const own = 'x  \r\n\r\n### Goal\r\n## Notes\r\n';
    expect(parseHandoff({ ...valid, objective: own })).toEqual({ handoff: text.replace('ship it', own), loadFiles: [] });
  });

  it('keeps a load file as given, lines and why included', () => {
    const files = [{ path: '/a/b.ts', lines: '1-60,160-185', why: 'the parser' }, { path: 'C:\\a\\b.ts', why: 'win' }];
    expect(parseHandoff({ ...valid, load_files: files })).toEqual({ handoff: text, loadFiles: files });
  });

  it('takes a 20,000-character assembled handoff (R12) and exactly 8 files', () => {
    const next = valid.next + 'x'.repeat(HANDOFF_MAX_CHARS - text.length);
    const out = parseHandoff({ ...valid, next });
    expect('handoff' in out && out.handoff.length).toBe(20_000);
    const eight = Array.from({ length: 8 }, (_, i) => ({ path: `/f${i}`, why: 'w' }));
    expect(parseHandoff({ ...valid, load_files: eight })).toMatchObject({ loadFiles: eight });
    expect(parseHandoff({ ...valid, load_files: [{ path: '/f', why: 'w'.repeat(200) }] })).not.toHaveProperty('refusal');
  });
});

describe('parseHandoff refuses, naming what to fix', () => {
  it('V1 an unknown field, the old handoff argument included (R14)', () => {
    expect(refusal({ ...valid, drop_skills: [] })).toBe(`${P}unknown field "drop_skills". The fields are objective, done, remaining, next, blocked, findings and load_files.`);
    expect(refusal({ ...valid, handoff: text })).toContain('unknown field "handoff"');
  });

  it('V2 a required section that is missing, not a string or blank, by name', () => {
    expect(refusal({ ...valid, objective: 5 })).toBe(`${P}objective must be a non-blank string; got number.`);
    expect(refusal({ ...valid, done: undefined })).toBe(`${P}done must be a non-blank string; got undefined.`);
    expect(refusal({ ...valid, remaining: null })).toBe(`${P}remaining must be a non-blank string; got null.`);
    expect(refusal({ ...valid, next: ' \n ' })).toBe(`${P}next must be a non-blank string; got a blank string.`);
  });

  it('V3 an optional section that is present but not a string, by name', () => {
    expect(refusal({ ...valid, blocked: ['a'] })).toBe(`${P}blocked must be a string when given; got array.`);
    expect(refusal({ ...valid, findings: 3 })).toBe(`${P}findings must be a string when given; got number.`);
  });

  it('V4 names every bad argument in one refusal, one line each', () => {
    expect(refusal({ done: 'd', extra: 1, findings: {} })).toBe([
      `${P}unknown field "extra". The fields are objective, done, remaining, next, blocked, findings and load_files.`,
      'objective must be a non-blank string; got undefined.',
      'remaining must be a non-blank string; got undefined.',
      'next must be a non-blank string; got undefined.',
      'findings must be a string when given; got object.',
    ].join('\n'));
    for (const input of ['## Objective', undefined, null]) expect(refusal(input)?.split('\n')).toHaveLength(4);
  });

  it('V5 an assembled handoff over 20,000 characters, refused with its total and the cap, never trimmed (R12)', () => {
    const next = valid.next + 'x'.repeat(20_001 - text.length);
    expect(refusal({ ...valid, next })).toBe(`${P}the handoff assembled from your sections is 20,001 characters, over the 20,000 cap. Shorten it (detail can go in load_files, or stay in the transcript for look_back) and call again.`);
  });

  it('V7 load_files that is not an array', () => {
    for (const bad of ['a', {}, null, 3]) expect(refusal({ ...valid, load_files: bad })).toBe(`${P}load_files must be an array of {path, lines?, why}.`);
  });

  it('V8 more than 8 entries (R15)', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ path: `/f${i}`, why: 'w' }));
    expect(refusal({ ...valid, load_files: nine })).toBe(`${P}load_files has 9 entries, over the 8 cap.`);
  });

  it('V9 a path that is missing or not absolute (R15)', () => {
    expect(refusal({ ...valid, load_files: [{ path: 'src/a.ts', why: 'x' }] })).toBe(`${P}load_files[0].path must be an absolute path; got "src/a.ts".`);
    expect(refusal({ ...valid, load_files: [{ path: '/ok', why: 'x' }, { why: 'x' }] })).toBe(`${P}load_files[1].path must be an absolute path; got "undefined".`);
    expect(refusal({ ...valid, load_files: ['/ok'] })).toContain('load_files[0].path must be an absolute path');
  });

  it('V10 a why that is missing, empty or over 200', () => {
    expect(refusal({ ...valid, load_files: [{ path: '/a' }] })).toBe(`${P}load_files[0].why must be 1–200 characters; it is 0.`);
    expect(refusal({ ...valid, load_files: [{ path: '/a', why: '' }] })).toContain('it is 0.');
    expect(refusal({ ...valid, load_files: [{ path: '/a', why: '   ' }] })).toContain('1–200 characters');
    expect(refusal({ ...valid, load_files: [{ path: '/a', why: 'w'.repeat(201) }] })).toBe(`${P}load_files[0].why must be 1–200 characters; it is 201.`);
  });

  it('V11 lines that are not a range list (R15)', () => {
    expect(refusal({ ...valid, load_files: [{ path: '/a', why: 'x', lines: '10-' }] })).toBe(`${P}load_files[0].lines "10-" is not a range like "10-40" or "1-60,160-185".`);
    expect(refusal({ ...valid, load_files: [{ path: '/a', why: 'x', lines: '' }] })).toContain('load_files[0].lines ""');
    expect(refusal({ ...valid, load_files: [{ path: '/a', why: 'x', lines: 5 }] })).toContain('load_files[0].lines "5" is not a range');
  });

  it('refuses in table order: the arguments before the cap, the cap before a bad file', () => {
    expect(refusal({ ...valid, objective: 5, next: 'x'.repeat(20_001), load_files: 'x' })).toBe(`${P}objective must be a non-blank string; got number.`);
    expect(refusal({ ...valid, next: 'x'.repeat(20_001), load_files: 'x' })).toContain('over the 20,000 cap');
    expect(refusal({ ...valid, load_files: [{ path: 'rel', why: '' }] })).toContain('.path must be an absolute path');
  });
});

describe('loadFileRefusal judges what $.fs.stat found', () => {
  it('accepts a regular file at or under 1 MiB', () => {
    expect(loadFileRefusal(0, '/a', { kind: 'file', size: 0 })).toBeUndefined();
    expect(loadFileRefusal(0, '/a', { kind: 'file', size: LOAD_FILE_MAX_BYTES })).toBeUndefined();
  });

  it('V12 absent', () => {
    expect(loadFileRefusal(2, '/a/b.ts', { absent: true })).toBe(`${P}load_files[2] /a/b.ts: no such file.`);
  });

  it('V13 not a regular file', () => {
    expect(loadFileRefusal(0, '/a', { kind: 'dir', size: 4096 })).toBe(`${P}load_files[0] /a is not a regular file.`);
    expect(loadFileRefusal(1, '/a', { kind: 'other', size: 0 })).toBe(`${P}load_files[1] /a is not a regular file.`);
  });

  it('V14 over 1 MiB', () => {
    expect(loadFileRefusal(0, '/big', { kind: 'file', size: 1_048_577 })).toBe(`${P}load_files[0] /big is 1,048,577 bytes, over the 1,048,576 cap for a carried file.`);
  });

  it('V15 a stat that threw is "could not be checked", never "no such file"', () => {
    const out = loadFileRefusal(0, '/a', { error: 'EACCES: permission denied' });
    expect(out).toBe(`${P}load_files[0] /a could not be checked: EACCES: permission denied.`);
    expect(out).not.toContain('no such file');
  });
});

describe('receipt says when the handoff installs, per party (R16)', () => {
  it('sub-agent below its ask point: the spec example, word for word', () => {
    expect(receipt({ party: 'subagent', chars: 4812, files: 0, tokens: 41_200, askPoint: 67_000 })).toBe(
      "Handoff stored (4,812 characters, 0 files). Claude Code has not asked to compact you yet: it installs at Claude Code's next ask, from about 67k context. Everything after this call is kept verbatim behind it. Carry on with your work.",
    );
  });

  it('sub-agent at or above its ask point', () => {
    const text = "Handoff stored (900 characters, 2 files). It installs at Claude Code's next compaction ask, before your next request. Everything after this call is kept verbatim behind it.";
    expect(receipt({ party: 'subagent', chars: 900, files: 2, tokens: 67_000, askPoint: 67_000 })).toBe(text);
    expect(receipt({ party: 'subagent', chars: 900, files: 2, tokens: 90_000, askPoint: 67_000 })).toBe(text);
  });

  it('main', () => {
    const text = "Handoff stored (4,812 characters, 3 files). It installs at the end of this turn, or at Claude Code's next compaction ask if one comes first. Everything after this call is kept verbatim behind it, so finish the step in hand; you need not stop.";
    expect(receipt({ party: 'main', chars: 4812, files: 3 })).toBe(text);
    expect(receipt({ party: 'main', chars: 4812, files: 3, tokens: 80_000, askPoint: 67_000 })).toBe(text);
  });

  it('says it replaced one, printing no size for either call', () => {
    expect(receipt({ party: 'main', chars: 10, files: 0, replaced: true })).toMatch(/ It replaces the handoff you stored before\.$/);
    expect(receipt({ party: 'subagent', chars: 10, files: 0, tokens: 90_000, askPoint: 67_000, replaced: true })).toMatch(/ It replaces the handoff you stored before\.$/);
    expect(receipt({ party: 'main', chars: 10, files: 0 })).not.toContain('replaces');
  });

  it('takes a sub-agent with no reading (none since an install) as below its ask point', () => {
    expect(receipt({ party: 'subagent', chars: 10, files: 0, askPoint: 67_000 })).toContain('Claude Code has not asked to compact you yet');
  });
});

describe("loadRoomRefusal (M4): load files past 5% of the max context, at the party's measured characters per token", () => {
  it('passes files that come to the room, and refuses one character past it, naming each file, its size and the room', () => {
    expect(loadRoomRefusal([{ path: '/a', chars: 50_000 }], 400_000, 2.5)).toBeUndefined();
    expect(loadRoomRefusal([], 1_000_000, 2.5)).toBeUndefined();
    expect(loadRoomRefusal([{ path: '/a', chars: 9_000_000 }], 200_000, undefined)).toBeUndefined(); // no reading: nothing measured, accepted
    expect(loadRoomRefusal([{ path: '/a', chars: 30_000 }, { path: '/b', chars: 20_001 }], 400_000, 2.5)).toBe([
      'forward_compaction refused, nothing stored: load_files come to 50,001 characters, over the 50,000-character room for carried files (5% of your 400k max context):',
      '- /a: 30,000 characters',
      '- /b: 20,001 characters',
      'Pass lines ranges (like "10-40" or "1-60,160-185") to carry only what you need, or fewer files, and call again.',
    ].join('\n'));
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
    expect(sliceFile('a\nb\nc\nd\ne', [{ from: 2, to: 4 }])).toEqual({ body: 'b\nc\nd', shown: '2-4' });
  });

  it('takes several ranges, each loaded in order with the lines between them named as not loaded', () => {
    expect(parseLineRanges('1-60,160-185')).toEqual([{ from: 1, to: 60 }, { from: 160, to: 185 }]);
    expect(parseLineRanges(' 3 , 5-6 ')).toEqual([{ from: 3, to: 3 }, { from: 5, to: 6 }]);
    expect(parseLineRanges('1-3,,5')).toBeUndefined();
    expect(parseLineRanges('1-3,x')).toBeUndefined();
    expect(sliceFile('a\nb\nc\nd\ne\nf', [{ from: 1, to: 2 }, { from: 5, to: 6 }])).toEqual({ body: 'a\nb\n[lines 3-4 not loaded]\ne\nf', shown: '1-2,5-6' });
  });

  it('names a range past the end of the file, never loading it as nothing', () => {
    const file = Array.from({ length: 149 }, (_, n) => `line ${n + 1}`).join('\n') + '\n';
    expect(sliceFile(file, [{ from: 150, to: 200 }])).toEqual({ problem: 'lines 150-200: past the end of the file, which has 149 lines' });
    expect(sliceFile(file, [{ from: 148, to: 200 }])).toEqual({ body: 'line 148\nline 149', shown: '148-149', problem: 'lines 148-200: the file ends at line 149' });
    expect(sliceFile(file, [{ from: 1, to: 1 }, { from: 160, to: 170 }])).toEqual({ body: 'line 1', shown: '1', problem: 'lines 160-170: past the end of the file, which has 149 lines' });
    expect(sliceFile('', undefined)).toEqual({ problem: 'the file is empty' });
    expect(sliceFile('x\n', undefined)).toEqual({ body: 'x\n', shown: '' });
  });

  it('names a range of only blank lines, never loading it as a block that says nothing', () => {
    expect(sliceFile('a\n\n\nd\n', [{ from: 2, to: 3 }])).toEqual({ problem: 'lines 2-3: only blank lines' });
    expect(sliceFile('a\n\n', [{ from: 2, to: 5 }])).toEqual({ problem: 'lines 2-5: the file ends at line 2; lines 2: only blank lines' });
  });

  it('loads ranges in file order, an overlap once', () => {
    const file = 'a\nb\nc\nd\ne\nf\ng\n';
    expect(sliceFile(file, [{ from: 6, to: 7 }, { from: 1, to: 2 }])).toEqual({ body: 'a\nb\n[lines 3-5 not loaded]\nf\ng', shown: '1-2,6-7' });
    expect(sliceFile(file, [{ from: 1, to: 3 }, { from: 2, to: 4 }, { from: 5, to: 5 }])).toEqual({ body: 'a\nb\nc\nd\ne', shown: '1-5' });
  });
});

describe('ignoredRefusal (Ignored models)', () => {
  it('names the ignore-list entry and the ceiling it is compacted mechanically at, in one line', () => {
    expect(ignoredRefusal('haiku', 160_000)).toBe('forward_compaction refused, nothing stored: your model is on forward-compaction\'s ignore list ("haiku"), so it takes no handoff from you; carry on with your work, and at 160k the plugin compacts you mechanically.');
    expect(ignoredRefusal(undefined, 160_000)).toBeUndefined();
  });
});

describe('every answer ends with the experimental line', () => {
  it('names the issues file in the level-log directory', () => {
    expect(experimental('Handoff stored (1 characters, 0 files).', '/logs/forward-compaction')).toBe(
      'Handoff stored (1 characters, 0 files).\nforward-compaction is experimental. If it gave you any trouble, append a short note of what happened to /logs/forward-compaction/issues.md; it will be taken care of later.',
    );
    expect(experimental('x', '/logs/forward-compaction/')).toContain('to /logs/forward-compaction/issues.md;');
  });

  it('asks for the note in the reply when no directory resolves', () => {
    expect(experimental('refused', undefined)).toBe('refused\nforward-compaction is experimental. If it gave you any trouble, append a short note of what happened to your reply.');
  });
});
