import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['why'], properties: { why: { type: 'string' }, query: { type: 'string' }, entry: { type: 'integer', minimum: 1 } } });
    // No anyOf: the parser checks query-or-entry itself, and a client that sends `entry: null` is not refused by the schema.
    expect(schema.anyOf).toBeUndefined();
    const description = api('LOOK_BACK_DESCRIPTION');
    expect(description.length).toBeLessThanOrEqual(450);
    for (const phrase of ['latest compaction', 'error', 'code', 'value', 'user', 'person']) expect(description).toContain(phrase);
  });
  it.each([
    [{ why: '  lost\n detail  ', query: 'ERROR "two words" port' }, { why: 'lost detail', query: 'ERROR "two words" port', terms: ['ERROR', 'two words', 'port'] }],
    [{ why: 'detail', entry: 4, query: ' ignored ' }, { why: 'detail', entry: 4, query: 'ignored', terms: [] }],
    [{ why: 'x'.repeat(130), query: 'x' }, { why: 'x'.repeat(115) + '[cut]', terms: ['x'] }],
    // A null beside the other argument is absent, as clients send unset optional fields.
    [{ why: 'detail', query: 'alpha beta', entry: null }, { why: 'detail', query: 'alpha beta', terms: ['alpha', 'beta'] }],
    [{ why: 'detail', entry: 4, query: null }, { why: 'detail', entry: 4, terms: [] }],
    // A backslash-escaped quote is a literal quote character, inside a phrase or a word (the live devbox query).
    [{ why: 'x', query: '"Agent \\"rr" total_tokens' }, { why: 'x', query: '"Agent \\"rr" total_tokens', terms: ['Agent "rr', 'total_tokens'] }],
    [{ why: 'x', query: 'say \\"hi C:\\dir' }, { why: 'x', terms: ['say', '"hi', 'C:\\dir'] }],
  ])('normalizes arguments %j', (input, expected) => {
    const got = api('parseLookBack')(input);
    expect(got).toMatchObject(expected);
    expect(got.why.length).toBeLessThanOrEqual(120);
    expect(got.error).toBeUndefined();
  });
  it.each([
    [{ query: 'x' }, 'why'], [{ why: ' ' , query: 'x' }, 'why'], [{ why: 'x' }, 'query or entry'],
    [{ why: 'x', query: ' "" ' }, 'query'], [{ why: 'x', entry: 0 }, 'entry'], [{ why: 'x', entry: 1.2 }, 'entry'],
    [{ why: 'x', query: '"unclosed' }, 'quote'], [{ why: 'x', query: '"open \\"' }, 'quote'], [{ why: 'x', query: 'x\u0000y' }, 'query'],
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
    expect(out.error).toBe('1 entry could not be read: #1: unsupported entry type future_entry');
  });
  it('fails an entry fetch of an entry it cannot read, never returning its placeholder as the entry', () => {
    const out = api('entryResult')(entries('1:{"type":"future_entry","payload":"needle"}'), 1, 2);
    expect(out.error).toBe('entry 1 could not be read: unsupported entry type future_entry');
  });
  it.each([
    ['a task notification', { type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>child result needle</task-notification>', commandMode: 'task-notification' } }, 'task-notification', '<task-notification>child result needle</task-notification>'],
    ['a hook context attachment', { type: 'attachment', attachment: { type: 'hook_additional_context', content: ['first needle', 'second'] } }, 'attachment hook_additional_context', 'first needle\nsecond'],
    ['a reminder attachment', { type: 'attachment', attachment: { type: 'silent_turn_reminder', text: 'say needle' } }, 'attachment silent_turn_reminder', 'say needle'],
    ['a system entry', { type: 'system', subtype: 'informational', content: 'system needle' }, 'system', 'system needle'],
    ['a summary entry', { type: 'summary', summary: 'summary needle' }, 'summary', 'summary needle'],
  ])('reads %s', (_name, entry, kind, text) => {
    const [e] = entries(`4:${JSON.stringify({ timestamp: '2026-01-02T03:04:05Z', ...entry })}`);
    expect(e).toMatchObject({ line: 4, kind, text, warnings: [] });
  });
  // Claude Code 2.1.300's own non-message entries, shaped as a real transcript writes them (secrets and paths invented).
  const BOOKKEEPING = [
    { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-10-14T23:48:35.247Z' },
    { type: 'queue-operation', operation: 'remove', timestamp: '2026-10-14T23:37:23.772Z', content: 'needle prompt', reason: 'absorbed_mid_turn', commandUuid: 'c1', deliveryId: 'd1' },
    { type: 'queue-operation', operation: 'popAll', timestamp: '2026-10-13T22:15:17.059Z', content: 'needle prompt' },
    { type: 'api-request-blob', hash: 'h1', message: { role: 'user', content: [{ type: 'text', text: 'needle copy of a request' }] } },
    { type: 'api-request', id: 'r1', timestamp: '2026-10-14T23:33:57.521Z', querySource: 'repl_main_thread', shapeHash: 's1', params: { model: 'needle' } },
    { type: 'api-request-shape', shapeHash: 's1', shape: { system: [{ type: 'text', text: 'needle' }] } },
    { type: 'last-prompt', lastPrompt: 'needle prompt', leafUuid: 'u1' },
    { type: 'mode', mode: 'normal' },
    { type: 'permission-mode', permissionMode: 'default' },
    { type: 'atis-latch', atis: 'needle' },
    { type: 'ai-title', aiTitle: 'needle title' },
    { type: 'custom-title', customTitle: 'needle' },
    { type: 'agent-name', agentName: 'needle' },
    { type: 'bridge-session', bridgeSessionId: 'needle' },
    { type: 'history-suppression', cause: 'needle' },
    { type: 'frame-link', path: '/tmp/needle', frameUrl: 'https://example.invalid/a', title: 'needle' },
    { type: 'pr-link', prNumber: 4, prUrl: 'https://example.invalid/pull/4', prRepository: 'needle/repo' },
    { type: 'file-history-snapshot', messageId: 'm1', snapshot: { trackedFileBackups: { needle: {} } }, isSnapshotUpdate: false },
    { type: 'file-history-delta', messageId: 'm1', trackingPath: '/tmp/needle', backup: {} },
    { type: 'cost-state', totalCostUSD: 1, modelUsage: { needle: {} } },
    { type: 'artifact-comment-monitor', v: 1, artifacts: { needle: {} } },
    { type: 'artifact-autoreact-ledger', v: 1, artifacts: { needle: {} } },
    { type: 'system', subtype: 'stop_hook_summary', hookCount: 1, hookInfos: [{ command: 'needle' }], level: 'suggestion' },
    { type: 'system', subtype: 'turn_duration', durationMs: 5, messageCount: 2, isMeta: false, note: 'needle' },
    { type: 'system', subtype: 'agents_killed', isMeta: false, note: 'needle' },
  ];
  it.each(BOOKKEEPING.map((entry) => [`${entry.type}${'operation' in entry ? ` ${entry.operation}` : ''}${'subtype' in entry ? ` ${entry.subtype}` : ''}`, entry]))('skips Claude Code bookkeeping silently: %s', (_name, entry) => {
    const found = entries([`${BOOKKEEPING.indexOf(entry) + 1}:${JSON.stringify(entry)}`, row(40, [text('the needle the user said')])].join('\n'));
    expect(found[0]).toMatchObject({ kind: 'bookkeeping', warnings: [] });
    const out = api('searchResults')(found, ['needle'], 50);
    expect(out).toEqual({ text: expect.stringMatching(/^#40 /), hits: 1 });
    expect(out.text).not.toContain('unsupported');
    expect(api('entryResult')(found, found[0].line, 50)).toMatchObject({ error: `entry ${found[0].line} is Claude Code bookkeeping (${entry.type}), not part of the conversation`, input: true });
  });
  it('names a tool reference and notes a document without failing the search', () => {
    const found = entries(row(5, [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'tool_reference', name: 'mcp__docs__guide' }, { type: 'tool_reference', tool_name: 'Read' }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AA==' } }, text('needle')] }]));
    expect(found[0]).toMatchObject({ text: '[tool mcp__docs__guide]\n[tool Read]\n[document block]\nneedle', warnings: ['document block'] });
    const out = api('searchResults')(found, ['needle'], 9);
    expect(out.hits).toBe(1);
    expect(out.error).toBeUndefined();
  });
  it('reads a queued prompt as one', () => {
    const [e] = entries('7:{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-14T23:36:33.912Z","content":"pick max 10 needles"}');
    expect(e).toMatchObject({ kind: 'queued prompt', text: 'pick max 10 needles', warnings: [] });
  });
  it('still reports an entry type it does not know, which could be a message', () => {
    const found = entries('3:{"type":"future_message","message":{"role":"user","content":"needle"}}');
    expect(api('searchResults')(found, ['needle'], 9).error).toBe('1 entry could not be read: #3: unsupported entry type future_message');
  });
  it('shows an attachment with no text field raw, hiding nothing', () => {
    const [e] = entries('4:{"type":"attachment","attachment":{"type":"file","content":{"file":{"content":"needle"}}}}');
    expect(e).toMatchObject({ kind: 'attachment file raw', text: '{"type":"file","content":{"file":{"content":"needle"}}}', warnings: [] });
  });
  it("ranks the party's own forward handoff call below every other hit", () => {
    const found = entries([
      row(3, [text('the needle as the user said it')]),
      row(5, [{ type: 'tool_use', id: 'f1', name: 'mcp__sub-agent-compact__forward_handoff', input: { next: 'needle' } }], 'assistant'),
      row(6, [{ type: 'tool_result', tool_use_id: 'f1', content: 'Forward handoff stored: needle' }]),
    ].join('\n'));
    const out = api('searchResults')(found, ['needle'], 9, api('toolNames')(found), 'mcp__sub-agent-compact__forward_handoff');
    expect(out.text.split('\n\n').map((hit: string) => hit.split('  ')[0])).toEqual(['#3', '#6', '#5']);
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
  it('documents look_back and counted misses in tools prose and the changelog (R10)', () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');
    expect(readme).toContain('### Look back');
    expect(readme).toContain('Every call is a counted compaction miss');
    expect(readme).toContain('look-back-manual');
    const changelog = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md'), 'utf8');
    expect(changelog.split('\n## [').some((section) => section.includes('`look_back`') && section.includes('shown to the person'))).toBe(true);
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
  it('reports a missing entry rather than treating it as a blank entry, as the caller\'s input', () => expect(api('entryResult')([], 4, 10)).toMatchObject({ error: expect.stringContaining('entry 4'), input: true }));
});

describe('look_back shell protocol (R3–R4)', () => {
  it('finds a term holding a quote or a backslash in the raw JSONL, where JSON escapes them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'look-back-escape-'));
    try {
      const file = join(directory, 'party.jsonl');
      writeFileSync(file, [JSON.stringify({ type: 'user', message: { content: 'ran Agent "rr" for total_tokens in C:\\dir' } }), JSON.stringify({ subtype: 'compact_boundary' })].join('\n'));
      const terms = api('parseLookBack')({ why: 'x', query: '"Agent \\"rr" C:\\dir' }).terms;
      expect(terms).toEqual(['Agent "rr', 'C:\\dir']);
      const argv = api('searchArgv')(file, 2, terms);
      const found = entries(api('processOutput')({ exitCode: 0, stdout: execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' }), stderr: '' }, 'search', true));
      expect(api('searchResults')(found, terms, 2)).toMatchObject({ hits: 1 });
      // A tool call's input is nested JSON: a quote in a value is escaped in the line, a structural quote is bare.
      const call = join(directory, 'call.jsonl');
      writeFileSync(call, [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git commit -m "fix" in C:\\dir', subagent_type: 'rr' } }] } }), JSON.stringify({ subtype: 'compact_boundary' })].join('\n'));
      for (const query of ['"-m \\"fix"', 'C:\\dir', '"\\"subagent_type\\":\\"rr\\""']) {
        const t = api('parseLookBack')({ why: 'x', query }).terms;
        const a = api('searchArgv')(call, 2, t);
        const hit = entries(api('processOutput')({ exitCode: 0, stdout: execFileSync(a[0], a.slice(1), { encoding: 'utf8' }), stderr: '' }, 'search', true));
        expect(api('searchResults')(hit, t, 2), query).toMatchObject({ hits: 1 });
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
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

describe('look_back on lines holding a raw line separator', () => {
  it('reads an entry and a boundary whose JSON carries U+2028 or U+2029 unescaped, as Claude Code writes them', () => {
    const line = row(105, [text('run 20261010-141759-c0ef next line end')]);
    expect(line).toContain(' ');
    const [entry] = entries(line);
    expect(entry.line).toBe(105);
    expect(entry.text).toContain('20261010-141759-c0ef');
    const boundary = `145:${JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'x y' })}`;
    expect(api('boundaryLine')(boundary)).toBe(145);
  });
});
