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
  parseHandoff,
  parseLineRanges,
  receipt,
  sliceFile,
} from '../plugins/forward-compaction/src/handoff.ts';

const valid = '## Objective\nship it\n## Done\nparser, tested\n## Remaining\nthe adapter\n## Next\nwire the hook';
const P = 'forward_compaction refused, nothing stored: ';
const refusal = (input: unknown): string | undefined => {
  const out = parseHandoff(input);
  return 'refusal' in out ? out.refusal : undefined;
};

describe('the forward_compaction tool as registered', () => {
  it('is named forward_compaction and its description is short and holds one example call (R17)', () => {
    expect(FORWARD_TOOL).toBe('forward_compaction');
    expect(FORWARD_TOOL_DESCRIPTION.length).toBeLessThanOrEqual(600);
    expect(FORWARD_TOOL_DESCRIPTION).toContain('forward_compaction({"handoff":');
  });

  it('names its caps once, and the schema agrees with them', () => {
    expect([HANDOFF_MAX_CHARS, LOAD_FILES_MAX, WHY_MAX_CHARS, LOAD_FILE_MAX_BYTES]).toEqual([20_000, 8, 200, 1_048_576]);
    expect(FORWARD_INPUT_SCHEMA.properties.load_files.maxItems).toBe(LOAD_FILES_MAX);
    expect(FORWARD_INPUT_SCHEMA.properties.load_files.items.properties.why.maxLength).toBe(WHY_MAX_CHARS);
    expect(FORWARD_INPUT_SCHEMA.properties.handoff.description).toContain(`${HANDOFF_MAX_CHARS} characters`);
  });

  it('closes the schema: one required markdown handoff, at most 8 load_files with a path and a why', () => {
    expect(FORWARD_INPUT_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false, required: ['handoff'] });
    expect(Object.keys(FORWARD_INPUT_SCHEMA.properties)).toEqual(['handoff', 'load_files']);
    const files = FORWARD_INPUT_SCHEMA.properties.load_files;
    expect(files).toMatchObject({ type: 'array', maxItems: 8, items: { additionalProperties: false, required: ['path', 'why'], properties: { why: { maxLength: 200 } } } });
    for (const heading of ['## Objective', '## Done', '## Remaining', '## Next', '## Blocked', '## Findings']) expect(FORWARD_INPUT_SCHEMA.properties.handoff.description).toContain(heading);
  });
});

describe('parseHandoff accepts and keeps the text whole', () => {
  it('returns the handoff verbatim and no load files when none are given', () => {
    expect(parseHandoff({ handoff: valid })).toEqual({ handoff: valid, loadFiles: [] });
  });

  it('keeps other headings, blank lines, trailing space and Windows line ends untouched', () => {
    const text = '## Objective\r\nx  \r\n\r\n## Done\r\ny\r\n## Remaining\r\nz\r\n## Next\r\nn\r\n## Findings\r\nf\r\n## Notes\r\n\r\n';
    expect(parseHandoff({ handoff: text })).toEqual({ handoff: text, loadFiles: [] });
  });

  it('keeps a load file as given, lines and why included', () => {
    const files = [{ path: '/a/b.ts', lines: '1-60,160-185', why: 'the parser' }, { path: 'C:\\a\\b.ts', why: 'win' }];
    expect(parseHandoff({ handoff: valid, load_files: files })).toEqual({ handoff: valid, loadFiles: files });
  });

  it('takes a 20,000-character handoff (R12) and exactly 8 files', () => {
    const text = valid + 'x'.repeat(HANDOFF_MAX_CHARS - valid.length);
    expect(text.length).toBe(20_000);
    expect(parseHandoff({ handoff: text })).toEqual({ handoff: text, loadFiles: [] });
    const eight = Array.from({ length: 8 }, (_, i) => ({ path: `/f${i}`, why: 'w' }));
    expect(parseHandoff({ handoff: valid, load_files: eight })).toMatchObject({ loadFiles: eight });
    expect(parseHandoff({ handoff: valid, load_files: [{ path: '/f', why: 'w'.repeat(200) }] })).not.toHaveProperty('refusal');
  });
});

describe('parseHandoff refuses, naming what to fix', () => {
  it('V1 an unknown field (R14)', () => {
    expect(refusal({ handoff: valid, drop_skills: [] })).toBe(`${P}unknown field "drop_skills". The fields are handoff and load_files.`);
  });

  it('V2 a handoff that is not a string, or no handoff at all', () => {
    expect(refusal({ handoff: 5 })).toBe(`${P}handoff must be a markdown string; got number.`);
    expect(refusal({})).toBe(`${P}handoff must be a markdown string; got undefined.`);
    expect(refusal({ handoff: null })).toBe(`${P}handoff must be a markdown string; got null.`);
    expect(refusal({ handoff: ['a'] })).toBe(`${P}handoff must be a markdown string; got array.`);
    expect(refusal('## Objective')).toBe(`${P}handoff must be a markdown string; got undefined.`);
    expect(refusal(undefined)).toBe(`${P}handoff must be a markdown string; got undefined.`);
  });

  it('V3 a handoff over 20,000 characters, with the count in thousands separators (R12)', () => {
    const text = valid + 'x'.repeat(20_001 - valid.length);
    expect(refusal({ handoff: text })).toBe(`${P}the handoff is 20,001 characters, over the 20,000 cap. Shorten it (detail can go in load_files, or stay in the transcript for look_back) and call again.`);
  });

  it('V4 a missing required heading, the first in order (R11)', () => {
    const message = `${P}the handoff has no "## Next" heading. Required, each followed by at least one line: ## Objective, ## Done, ## Remaining, ## Next. Call again with all four.`;
    expect(refusal({ handoff: '## Objective\nx\n## Done\ny\n## Remaining\nz' })).toBe(message);
    expect(refusal({ handoff: '## Done\ny\n## Remaining\nz\n## Next\nn' })).toContain('no "## Objective" heading');
    expect(refusal({ handoff: '## Objective\nx\n## Remaining\nz' })).toContain('no "## Done" heading');
  });

  it('V4 counts only a whole heading line: a deeper heading, a suffixed one or an indented one is no heading', () => {
    for (const bad of ['### Next', '## Next steps', ' ## Next', '#Next', '## next']) {
      expect(refusal({ handoff: `## Objective\nx\n## Done\ny\n## Remaining\nz\n${bad}\nn` })).toContain('no "## Next" heading');
    }
  });

  it('V4 beats V5 and V6: absence is reported first', () => {
    expect(refusal({ handoff: '## Objective\n## Objective\n' })).toContain('no "## Done" heading');
  });

  it('V5 a heading twice, required or optional (R13)', () => {
    expect(refusal({ handoff: `${valid}\n## Next\nagain` })).toBe(`${P}the handoff has "## Next" 2 times; give it once.`);
    expect(refusal({ handoff: `${valid}\n## Findings\na\n## Findings\nb\n## Findings\nc` })).toBe(`${P}the handoff has "## Findings" 3 times; give it once.`);
    expect(refusal({ handoff: `${valid}\n## Blocked\na\n## Blocked\nb` })).toContain('"## Blocked" 2 times');
  });

  it('V6 a required heading with no text under it (R13)', () => {
    expect(refusal({ handoff: '## Objective\nx\n## Done\n## Remaining\nz\n## Next\nn' })).toBe(`${P}"## Done" has no text under it.`);
    expect(refusal({ handoff: '## Objective\nx\n## Done\ny\n## Remaining\nz\n## Next\n  \n\n' })).toBe(`${P}"## Next" has no text under it.`);
    expect(refusal({ handoff: '## Objective\n\n## Done\ny\n## Remaining\nz\n## Next\nn' })).toContain('"## Objective" has no text');
  });

  it('V6 text under a deeper heading or before the next section counts as text', () => {
    expect(parseHandoff({ handoff: '## Objective\n### Goal\nx\n## Done\ny\n## Remaining\nz\n## Next\nn' })).not.toHaveProperty('refusal');
  });

  it('V7 load_files that is not an array', () => {
    for (const bad of ['a', {}, null, 3]) expect(refusal({ handoff: valid, load_files: bad })).toBe(`${P}load_files must be an array of {path, lines?, why}.`);
  });

  it('V8 more than 8 entries (R15)', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ path: `/f${i}`, why: 'w' }));
    expect(refusal({ handoff: valid, load_files: nine })).toBe(`${P}load_files has 9 entries, over the 8 cap.`);
  });

  it('V9 a path that is missing or not absolute (R15)', () => {
    expect(refusal({ handoff: valid, load_files: [{ path: 'src/a.ts', why: 'x' }] })).toBe(`${P}load_files[0].path must be an absolute path; got "src/a.ts".`);
    expect(refusal({ handoff: valid, load_files: [{ path: '/ok', why: 'x' }, { why: 'x' }] })).toBe(`${P}load_files[1].path must be an absolute path; got "undefined".`);
    expect(refusal({ handoff: valid, load_files: ['/ok'] })).toContain('load_files[0].path must be an absolute path');
  });

  it('V10 a why that is missing, empty or over 200', () => {
    expect(refusal({ handoff: valid, load_files: [{ path: '/a' }] })).toBe(`${P}load_files[0].why must be 1–200 characters; it is 0.`);
    expect(refusal({ handoff: valid, load_files: [{ path: '/a', why: '' }] })).toContain('it is 0.');
    expect(refusal({ handoff: valid, load_files: [{ path: '/a', why: '   ' }] })).toContain('1–200 characters');
    expect(refusal({ handoff: valid, load_files: [{ path: '/a', why: 'w'.repeat(201) }] })).toBe(`${P}load_files[0].why must be 1–200 characters; it is 201.`);
  });

  it('V11 lines that are not a range list (R15)', () => {
    expect(refusal({ handoff: valid, load_files: [{ path: '/a', why: 'x', lines: '10-' }] })).toBe(`${P}load_files[0].lines "10-" is not a range like "10-40" or "1-60,160-185".`);
    expect(refusal({ handoff: valid, load_files: [{ path: '/a', why: 'x', lines: '' }] })).toContain('load_files[0].lines ""');
    expect(refusal({ handoff: valid, load_files: [{ path: '/a', why: 'x', lines: 5 }] })).toContain('load_files[0].lines "5" is not a range');
  });

  it('refuses in table order: an unknown field before a bad handoff, a bad handoff before a bad file', () => {
    expect(refusal({ extra: 1, handoff: 5, load_files: 'x' })).toContain('unknown field "extra"');
    expect(refusal({ handoff: 5, load_files: 'x' })).toContain('handoff must be a markdown string');
    expect(refusal({ handoff: valid, load_files: [{ path: 'rel', why: '' }] })).toContain('.path must be an absolute path');
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
      "Handoff stored (4,812 characters, 0 files). Claude Code has not asked to compact you yet: it installs at Claude Code's next ask, from about 67k context (you are at 41k). Everything after this call is kept verbatim behind it. Carry on with your work.",
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

  it('appends what it replaced, in thousands rounded', () => {
    expect(receipt({ party: 'main', chars: 10, files: 0, replaced: 30_500 })).toMatch(/ It replaces the handoff you stored at 31k\.$/);
    expect(receipt({ party: 'subagent', chars: 10, files: 0, tokens: 90_000, askPoint: 67_000, replaced: 30_400 })).toMatch(/ It replaces the handoff you stored at 30k\.$/);
    expect(receipt({ party: 'main', chars: 10, files: 0 })).not.toContain('replaces');
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
