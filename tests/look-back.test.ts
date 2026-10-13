import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A missing new module is an assertion red, not a transform/build-error red.
let back: Record<string, any>;
beforeAll(async () => {
  const source = '../plugins/sub-agent-compact/src/look-back.ts';
  try { back = await import(/* @vite-ignore */ source); }
  catch (error) { back = { importError: String(error) }; }
});
const api = (name: string) => {
  expect(back, `look-back API ${name}; ${back.importError ?? ''}`).toHaveProperty(name);
  return back[name];
};
const row = (n: number, content: unknown, type = 'user', extra = {}) => `${n}:${JSON.stringify({ type, timestamp: '2026-01-02T03:04:05Z', message: { role: type, content }, ...extra })}`;
const text = (s: string) => ({ type: 'text', text: s });
const entries = (s: string) => api('parseEntries')(s);

describe('look_back arguments and tool contract (R1–R2)', () => {
  it('publishes the tool, closed schema, required why and either query or entry, and a self-contained description', () => {
    expect(api('LOOK_BACK_TOOL')).toBe('look_back');
    const schema = api('LOOK_BACK_INPUT_SCHEMA');
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['why'], properties: { why: { type: 'string' }, query: { type: 'string' }, entry: { type: 'integer', minimum: 1 } }, anyOf: [{ required: ['query'] }, { required: ['entry'] }] });
    const description = api('LOOK_BACK_DESCRIPTION');
    expect(description.length).toBeLessThanOrEqual(450);
    for (const phrase of ['latest compaction', 'error', 'code', 'value', 'user', 'person']) expect(description).toContain(phrase);
  });
  it.each([
    [{ why: '  lost\n detail  ', query: 'ERROR "two words" port' }, { why: 'lost detail', query: 'ERROR "two words" port', terms: ['ERROR', 'two words', 'port'] }],
    [{ why: 'detail', entry: 4, query: ' ignored ' }, { why: 'detail', entry: 4, query: 'ignored', terms: [] }],
    [{ why: 'x'.repeat(130), query: 'x' }, { why: 'x'.repeat(115) + '[cut]', terms: ['x'] }],
  ])('normalizes arguments %j', (input, expected) => {
    const got = api('parseLookBack')(input);
    expect(got).toMatchObject(expected);
    expect(got.why.length).toBeLessThanOrEqual(120);
    expect(got.error).toBeUndefined();
  });
  it.each([
    [{ query: 'x' }, 'why'], [{ why: ' ' , query: 'x' }, 'why'], [{ why: 'x' }, 'query or entry'],
    [{ why: 'x', query: ' "" ' }, 'query'], [{ why: 'x', entry: 0 }, 'entry'], [{ why: 'x', entry: 1.2 }, 'entry'],
    [{ why: 'x', query: '"unclosed' }, 'quote'], [{ why: 'x', query: 'x\u0000y' }, 'query'],
    [{ why: 'x', query: '"two\nwords"' }, 'query'], [{ why: 'x', query: 7 }, 'query'],
    [{ why: 'x', query: 'x', other: true }, 'other'],
  ])('reports invalid arguments %j', (input, problem) => expect(api('parseLookBack')(input).error).toContain(problem));
});

describe('look_back readable transcript entries (R4)', () => {
  it.each([
    [row(1, 'hello'), 'user', 'hello'],
    [row(2, [text('hello'), { type: 'thinking', thinking: 'private' }, text('world')], 'assistant'), 'assistant', 'hello\nworld'],
    [row(3, [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'file.ts' } }], 'assistant'), 'tool Read', 'Read {"file_path":"file.ts"}'],
    [row(4, [{ type: 'tool_result', tool_use_id: 'r1', content: 'error text' }]), 'result of Read', 'error text'],
    [row(5, [{ type: 'tool_result', tool_use_id: 'r1', content: [text('error'), text('text')] }]), 'result of Read', 'error\ntext'],
    ['6:broken JSON: hello', 'raw', 'broken JSON: hello'],
    [row(7, [{ type: 'image', source: { data: 'secret' } }, { type: 'future_block', value: 'unknown' }]), 'user', '[image block]\n[unsupported future_block block]'],
  ])('reads %s without thinking or opaque payloads', (line, kind, readable) => {
    const parsed = entries(line);
    const out = api('entryResult')(parsed, Number(line.split(':')[0]), 10, { r1: 'Read' });
    expect(out.error).toBeUndefined();
    expect(out.text).toBe(`#${line.split(':')[0]}  ${kind === 'raw' ? 'unknown time' : '2026-01-02 03:04'}  ${kind}\n${readable}`);
  });
  it('re-checks all terms in decoded readable text, excludes JSON-key and thinking hits, and keeps newest first', () => {
    const raw = [row(1, 'ALPHA beta old'), row(2, [text('Alpha beta new')], 'assistant'), row(3, 'alpha', 'user', { beta: 'metadata' }), row(4, [{ type: 'thinking', thinking: 'alpha beta' }], 'assistant'), '5:raw Alpha beta', row(6, 'alpha beta already held')].join('\n');
    const out = api('searchResults')(entries(raw), ['alpha', 'beta'], 6);
    expect(out.hits).toBe(3);
    expect(out.text.match(/^#\d+/gm)).toEqual(['#5', '#2', '#1']);
    expect(out.text).toContain('raw Alpha beta');
  });
  it('drops a hit in JSON escaping and requires a quoted phrase as a whole', () => {
    const raw = [row(1, 'alpha\nbeta'), row(2, 'alpha other beta'), row(3, 'ALPHA BETA')].join('\n');
    expect(api('searchResults')(entries(raw), ['alpha beta'], 4).hits).toBe(1);
    expect(api('searchResults')(entries(row(1, 'line\ntext')), ['\\n'], 2).hits).toBe(0);
  });
  it('centres a bounded snippet on the first term', () => {
    const got = api('snippet')('a'.repeat(900) + 'NEEDLE' + 'z'.repeat(900), ['needle']);
    expect(got).toContain('NEEDLE');
    expect(got.length).toBeLessThanOrEqual(406);
    expect(got).toMatch(/^…a+NEEDLEz+…$/);
  });
  it.each([['hits', 'assistant', 25], ['chars', 'tool ' + 'Long'.repeat(350), 20]])('caps %s and counts omitted readable matches in the narrowing footer', (_, kind, count) => {
    const parsed = entries(Array.from({ length: count }, (_, n) => row(n + 1, 'needle ' + 'x'.repeat(600), 'assistant')).join('\n'));
    for (const e of parsed) e.kind = kind;
    const out = api('searchResults')(parsed, ['needle'], 100);
    expect(out.hits).toBeGreaterThan(0);
    expect(out.hits).toBeLessThan(count);
    expect(out.hits).toBeLessThanOrEqual(20);
    expect(out.text.length).toBeLessThanOrEqual(12_000);
    expect(out.text.endsWith(`${count - out.hits} more matches: narrow the query, or fetch one with entry`)).toBe(true);
  });
  it('distinguishes zero matches and reports unrecognized transcript shapes', () => {
    const out = api('searchResults')(entries('1:{"type":"future_entry","payload":"needle"}'), ['needle'], 2);
    expect(out.hits).toBe(0);
    expect(out.text).toContain('No entry before the compaction at line 2 matches: needle');
    expect(out.text).toContain('fewer or other words');
    expect(out.text).toContain('unsupported entry type future_entry');
  });
  it('resolves result tool names through ids and explicitly labels an unavailable name', () => {
    const uses = entries(row(1, [{ type: 'tool_use', id: 'r1', name: 'Bash', input: { command: 'true' } }], 'assistant'));
    const results = entries(row(2, [{ type: 'tool_result', tool_use_id: 'r1', content: 'needle' }]));
    expect(api('resultIds')(results)).toEqual(['r1']);
    expect(api('toolNames')(uses)).toEqual({ r1: 'Bash' });
    expect(api('entryResult')(results, 2, 3, api('toolNames')(uses)).text).toContain('result of Bash');
    expect(api('entryResult')(results, 2, 3).text).toContain('result of unknown tool r1');
  });
});

describe('look_back public documentation and oversized queries', () => {
  it('keeps a zero-hit answer within 12k even for an oversized query (R4)', () => {
    const out = api('searchResults')([], ['needle'.repeat(5_000)], 10);
    expect(out.text.length).toBeLessThanOrEqual(12_000);
    expect(out.text).toContain('No entry before the compaction at line 10 matches:');
    expect(out.text).toContain('[query cut]');
    expect(out.text).toContain('fewer or other words');
  });
  it('documents look_back and counted misses in tools prose and Unreleased (R10)', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain('### Look back');
    expect(readme).toContain('Every call is a counted compaction miss');
    expect(readme).toContain('look-back-manual');
    const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    const unreleased = changelog.split('## [Unreleased]')[1]!.split('\n## [')[0]!;
    expect(unreleased).toContain('`look_back`');
    expect(unreleased).toContain('shown to the person');
  });
});

describe('look_back entry fetch (R5)', () => {
  it.each([24_000, 24_100])('returns readable text whole up to 24k, with original-length cut marker for %i chars', (n) => {
    const out = api('entryResult')(entries(row(4, 'x'.repeat(n))), 4, 10);
    const body = out.text.split('\n').slice(1).join('\n');
    expect(body).toBe('x'.repeat(Math.min(n, 24_000)) + (n > 24_000 ? `\n[cut at 24k of ${n} chars]` : ''));
  });
  it.each([10, 11])('refuses entry %i at or after the latest compaction', (n) => {
    const out = api('entryResult')(entries(row(n, 'held')), n, 10);
    expect(out.error).toMatch(/already in context/);
    expect(out.text).not.toContain('held');
  });
  it('reports a missing entry rather than treating it as a blank entry', () => expect(api('entryResult')([], 4, 10).error).toContain('entry 4'));
});

describe('look_back shell protocol (R3–R4)', () => {
  it('passes terms separately, cuts below the boundary, keeps newest 200, and runs safely on real JSONL', () => {
    const search = api('searchArgv');
    const directory = mkdtempSync(join(tmpdir(), 'look-back-test-'));
    try {
      const file = join(directory, 'party transcript.jsonl');
      const special = '$(touch not-created); -x';
      writeFileSync(file, [JSON.stringify({ type: 'user', message: { content: 'alpha ' + special } }), JSON.stringify({ type: 'user', message: { content: 'alpha current' } }), JSON.stringify({ subtype: 'compact_boundary' })].join('\n'));
      const argv = search(file, 2, ['alpha', special]);
      expect(argv.slice(4)).toEqual([file, '2', 'alpha', special]);
      expect(argv[2]).toContain('tail -n 200');
      expect(argv[2]).not.toContain(special);
      const output = api('processOutput')({ exitCode: 0, stdout: execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' }), stderr: '' }, 'search', true);
      expect(output).toContain('1:');
      expect(output).not.toContain('current');
      const one = api('entryArgv')(file, 1);
      expect(api('processOutput')({ exitCode: 0, stdout: execFileSync(one[0], one.slice(1), { encoding: 'utf8' }), stderr: '' }, 'entry', true)).toContain('1:');
      const bounds = api('boundaryArgv')(file);
      expect(api('boundaryLine')(api('processOutput')({ exitCode: 0, stdout: execFileSync(bounds[0], bounds.slice(1), { encoding: 'utf8' }), stderr: '' }, 'boundary', true))).toBe(3);
      const names = api('namesArgv')(file, 2, ['r1', 'r2']);
      expect(names.slice(4)).toEqual([file, '2', 'r1', 'r2']);

      // Numbering must survive the 200-candidate tail and argv indexes beyond $9.
      const terms = Array.from({ length: 10 }, (_, n) => `term${n}`);
      const bulk = join(directory, "party's transcript.jsonl");
      writeFileSync(bulk, Array.from({ length: 251 }, (_, n) => JSON.stringify({ type: 'user', message: { content: terms.join(' ') + ` row${n + 1}` } })).join('\n'));
      const many = search(bulk, 251, terms);
      const kept = entries(api('processOutput')({ exitCode: 0, stdout: execFileSync(many[0], many.slice(1), { encoding: 'utf8' }), stderr: '' }, 'search', true));
      expect(kept.map((e: any) => e.line)).toEqual(Array.from({ length: 200 }, (_, n) => n + 51));
      const rendered = api('searchResults')(kept, terms, 251);
      expect(rendered.text.match(/^#\d+/gm)).toEqual(Array.from({ length: 20 }, (_, n) => `#${250 - n}`));
      expect(rendered.text).toContain('180 more matches: narrow the query, or fetch one with entry');

      // tail/printf succeed even if the upstream sed fails: stderr is authoritative.
      const missing = search(join(directory, 'missing.jsonl'), 2, ['needle']);
      const failed = spawnSync(missing[0], missing.slice(1), { encoding: 'utf8' });
      expect(() => api('processOutput')({ exitCode: failed.status ?? -1, stdout: failed.stdout, stderr: failed.stderr }, 'search', true)).toThrow(/search: .*missing\.jsonl/);
      // A quiet upstream failure must not look like a successful empty search.
      writeFileSync(join(directory, 'sed'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
      const quiet = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}` } });
      expect(() => api('processOutput')({ exitCode: quiet.status ?? -1, stdout: quiet.stdout, stderr: quiet.stderr }, 'search', true)).toThrow(/search: .*exit 2/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.each([
    [{ exitCode: 2, stdout: '', stderr: 'sed: denied' }, 'sed: denied'],
    [{ exitCode: 0, stdout: '', stderr: 'grep: denied' }, 'grep: denied'],
    [{ exitCode: 0, stdout: '1:partial', stderr: '' }, 'completion marker'],
  ])('reports process failure or truncated output %j', (output, reason) => expect(() => api('processOutput')(output, 'search', true)).toThrow(reason));
  it.each([true, false])('ignores nested compact_boundary fields with a real boundary=%s', (compacted) => {
    const directory = mkdtempSync(join(tmpdir(), 'look-back-boundary-'));
    try {
      const fake = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Example', input: { subtype: 'compact_boundary', text: 'brace } and escaped " quote' } }] } });
      const genuine = JSON.stringify({ type: 'system', subtype: 'compact_boundary' });
      const file = join(directory, 'party.jsonl');
      writeFileSync(file, [fake, compacted ? genuine : JSON.stringify({ type: 'user', message: { content: 'still held' } }), fake].join('\n'));
      const argv = api('boundaryArgv')(file);
      const output = api('processOutput')({ exitCode: 0, stdout: execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' }), stderr: '' }, 'boundary', true);
      expect(api('boundaryLine')(output)).toBe(compacted ? 2 : undefined);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('selects the last boundary and rejects malformed boundary output', () => {
    expect(api('boundaryLine')('2:{"subtype":"compact_boundary"}\n19:{"subtype":"compact_boundary"}\n')).toBe(19);
    expect(api('boundaryLine')('')).toBeUndefined();
    expect(() => api('boundaryLine')('oops')).toThrow('boundary');
  });
});

describe('look_back miss notices and manual detection (R6–R7)', () => {
  it.each([
    ['Read', { file_path: '/data/session-1.jsonl' }, undefined, true],
    ['Grep', { path: '/data/session-1.jsonl', pattern: 'error' }, undefined, true],
    ['Bash', { command: 'sed -n 1p /data/session-1.jsonl' }, undefined, true],
    ['Read', { file_path: '/data/agent-a1.jsonl' }, 'a1', true],
    ['Read', { file_path: '/data/session-1.jsonl' }, 'a1', false],
    ['Read', { file_path: '/data/agent-a2.jsonl' }, 'a1', false],
    ['Read', { file_path: '/data/old-session-1.jsonl.bak' }, undefined, false],
    ['Write', { file_path: '/data/session-1.jsonl' }, undefined, false],
  ])('detects only the caller file in %s %j', (tool, input, agentId, expected) => expect(api('manualTranscriptCall')(tool, input, 'session-1', agentId)).toBe(expected));
  it('renders one notice for a search, entry or failed attempt', () => {
    const notice = api('lookBackNotice');
    expect(notice('main', { why: 'lost text' }, { hits: 2 })).toBe('look back (main): lost text — 2 hits');
    expect(notice('reviewer', { why: 'lost text', entry: 4 }, {})).toBe('look back (reviewer): lost text — entry 4');
    expect(notice('main', { why: 'lost text' }, { error: 'denied\nretry' })).toBe('look back (main): lost text — failed: denied retry');
  });
});
