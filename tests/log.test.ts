import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as log from '../plugins/sub-agent-compact/src/log.ts';
import { appendRows, sessionLogPath } from '../plugins/sub-agent-compact/src/log.ts';

// Optional lookup lets the unimplemented writer fail on the required output, not an import error.
const future: Record<string, any> = log;
const fields = { plugin: 'sub-agent-compact', level: 'error', event: 'tool-register-failed', msg: 'registration failed', where: 'hooks/sub-agent-compact.ts#registerForwardTool', session: 's1', detail: { error: 'refused' } };
const now = 1791991231123;
const render = (input = fields) => future.levelRow?.(input, now) ?? '';
const exec = promisify(execFile);
const rows = (dir: string, file: string): any[] => existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
const shell = (dir: string, pairs: string[]) => exec('/bin/sh', ['-c', future.APPEND_SCRIPT ?? ':', 'plugin-log', dir, 'sub-agent-compact', ...pairs]);

describe('sessionLogPath', () => {
  it.each([
    ['/tmp/sac/decisions.jsonl', 'abc-123', '/tmp/sac/decisions.abc-123.jsonl'],
    ['/tmp/sac/decisions', 'abc-123', '/tmp/sac/decisions.abc-123'],
    ['/tmp/sac.d/decisions', 'abc', '/tmp/sac.d/decisions.abc'],
    ['/tmp/sac/.decisions', 'abc', '/tmp/sac/.decisions.abc'],
    ['/tmp/sac/a.b.jsonl', 'abc', '/tmp/sac/a.b.abc.jsonl'],
    ['/x/logs/sub-agent-compact/decisions/.jsonl', 's1', '/x/logs/sub-agent-compact/decisions/s1.jsonl'],
  ])('%s + %s → %s', (file, session, path) => {
    expect(sessionLogPath(file, session)).toBe(path);
  });

  it('keeps a session id from escaping the log directory', () => {
    expect(sessionLogPath('/tmp/sac/decisions.jsonl', '../../etc/x y')).toBe('/tmp/sac/decisions.______etc_x_y.jsonl');
  });

  it('rejects an empty session id', () => {
    expect(() => sessionLogPath('/tmp/sac/decisions.jsonl', '')).toThrow(/empty session id/);
  });
});

describe('appendRows', () => {
  it('keeps the rows already in the file and appends the new ones', () => {
    expect(appendRows('{"a":1}\n{"a":2}\n', ['{"a":3}'], 10)).toBe('{"a":1}\n{"a":2}\n{"a":3}\n');
  });

  it('starts a missing or empty file', () => {
    expect(appendRows('', ['{"a":1}'], 10)).toBe('{"a":1}\n');
  });

  it('drops blank lines and keeps only the newest rows past the cap', () => {
    expect(appendRows('{"a":1}\n\n{"a":2}', ['{"a":3}', '{"a":4}'], 3)).toBe('{"a":2}\n{"a":3}\n{"a":4}\n');
  });
});

describe('plugin log', () => {
  it.each(['error', 'warning', 'info'])('formats ordered contract keys for %s', (level) => {
    const text = render({ ...fields, level });
    expect(text).toBe(JSON.stringify({ ts: '2026-10-14T15:20:31.123Z', ...fields, level }) + '\n');
    expect(Object.keys(JSON.parse(text))).toEqual(['ts', 'plugin', 'level', 'event', 'msg', 'where', 'session', 'detail']);
  });
  it.each([
    [0, '1970-01-01T00:00:00.000Z'],
    [-1, '1969-12-31T23:59:59.999Z'],
    [Date.parse('2000-02-29T12:34:56.789Z'), '2000-02-29T12:34:56.789Z'],
    [Date.parse('0000-01-01T00:00:00.000Z'), '0000-01-01T00:00:00.000Z'],
    [Date.parse('+010000-01-01T00:00:00.000Z'), '+010000-01-01T00:00:00.000Z'],
    [Date.parse('-000001-01-01T00:00:00.000Z'), '-000001-01-01T00:00:00.000Z'],
  ])('formats UTC timestamp %s as %s', (epoch, expected) => {
    expect(JSON.parse(future.levelRow?.(fields, epoch) || '{}').ts).toBe(expected);
  });
  it('omits an unknown session and optional detail', () => {
    const { session, detail, ...without } = fields;
    expect(future.levelRow?.(without, now)).toBe(JSON.stringify({ ts: '2026-10-14T15:20:31.123Z', ...without }) + '\n');
  });
  it.each(['🙂'.repeat(4096), '\n"\\'.repeat(4096)])('caps UTF-8 and escaped rows without corrupting JSON (largest input)', (msg) => {
    const original = JSON.stringify({ ts: '2026-10-14T15:20:31.123Z', ...fields, msg, detail: { error: 'x'.repeat(6000) } }) + '\n';
    const text = render({ ...fields, msg, detail: { error: 'x'.repeat(6000) } });
    expect(text.endsWith('\n')).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
    const row = JSON.parse(text);
    expect(row.detail).toEqual({ truncated: true, bytes: Buffer.byteLength(original) });
    expect(row.msg).toBe(msg.slice(0, row.msg.length));
    expect(row.msg).not.toMatch(/[\uD800-\uDBFF]$/u);
  });
  it.each([
    ['/x/logs', '/h/u', '/x/logs/auto-effort'],
    [undefined, '/h/u', '/h/u/.local/state/auto-effort/logs'],
    [undefined, undefined, undefined],
    ['', '/h/u/', '/h/u/.local/state/auto-effort/logs'],
  ])('resolves directory %s with HOME %s', (override, home, expected) => {
    expect(future.pluginLogDir?.(override, home, 'auto-effort')).toBe(expected);
  });
  it('appends one exact row per level with private modes and positional shell data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-log-'));
    try {
      const pairs = ['error', 'warning', 'info'].flatMap((level) => [level === 'error' ? 'errors.jsonl' : level === 'warning' ? 'warnings.jsonl' : 'info.jsonl', JSON.stringify({ ...fields, level, ts: '2026-10-14T15:20:31.123Z', msg: "literal $(touch bad); ' \n text" }) + '\n']);
      await shell(dir, pairs);
      for (const [level, file] of [['error', 'errors.jsonl'], ['warning', 'warnings.jsonl'], ['info', 'info.jsonl']]) {
        expect(rows(dir, file!)).toEqual([{ ...fields, level, ts: '2026-10-14T15:20:31.123Z', msg: "literal $(touch bad); ' \n text" }]);
        expect(statSync(join(dir, file!)).mode & 0o777).toBe(0o600);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([
    ['absolute', 'new'], ['absolute', 'existing'], ['absolute', 'capped'],
    ['hyphen-relative', 'new'], ['hyphen-relative', 'existing'], ['hyphen-relative', 'capped'],
  ] as const)('appends exact rows with BSD chmod: %s %s', async (kind, state) => {
    const parent = mkdtempSync(join(tmpdir(), 'plugin-bsd-'));
    const bin = join(parent, 'bin');
    const dir = log.pluginLogDir(kind === 'absolute' ? join(parent, 'logs') : '-logs', undefined, 'sub-agent-compact')!;
    const disk = join(parent, kind === 'absolute' ? 'logs' : '-logs', 'sub-agent-compact');
    const levels = [['errors.jsonl', 'error'], ['warnings.jsonl', 'warning'], ['info.jsonl', 'info']] as const;
    const seed = (file: string) => JSON.stringify({ seed: file }) + '\n';
    const backup = (file: string) => `previous backup: ${file}\n`;
    const oversized = Buffer.alloc(log.PLUGIN_LOG_CAP_BYTES + 1, 'x');
    const pairs = levels.flatMap(([file, level]) => [file, render({ ...fields, level, msg: "literal $(touch bad); ' \\ text" })]);
    const notice = (file: string) => JSON.stringify({ ts: '2026-10-14T15:20:31.123Z', plugin: 'sub-agent-compact', level: 'warning', event: 'log-capped', msg: 'level file exceeded 20971520 bytes; moved aside', where: 'src/log.ts#APPEND_SCRIPT', session: 's1', detail: { file } }) + '\n';
    try {
      mkdirSync(bin);
      const shim = join(bin, 'chmod');
      writeFileSync(shim, `#!/bin/sh
for arg do
  case "$arg" in
    --) printf 'chmod: --: No such file or directory\\n' >&2; exit 1;;
    -*) printf 'chmod: unsafe operand: %s\\n' "$arg" >&2; exit 1;;
  esac
done
exec /bin/chmod "$@"
`);
      chmodSync(shim, 0o755);
      if (state !== 'new') {
        mkdirSync(disk, { recursive: true }); chmodSync(disk, 0o755);
        for (const [file] of levels) {
          writeFileSync(join(disk, file), state === 'capped' && file !== 'info.jsonl' ? oversized : seed(file));
          writeFileSync(join(disk, `${file}.1`), backup(file));
          for (const name of [file, `${file}.1`]) chmodSync(join(disk, name), 0o644);
        }
      }
      const result = await exec('/bin/sh', ['-c', log.APPEND_SCRIPT, 'plugin-log', dir, 'sub-agent-compact', ...pairs], {
        cwd: parent, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` },
      }).then(({ stderr }) => ({ code: 0, stderr }), (error) => ({ code: error.code, stderr: error.stderr }));
      for (const [index, [file]] of levels.entries()) {
        const prefix = state === 'new' || (state === 'capped' && file !== 'info.jsonl') ? '' : seed(file);
        const caps = state === 'capped' && file === 'warnings.jsonl' ? notice('warnings.jsonl') + notice('errors.jsonl') : '';
        const expected = prefix + caps + pairs[index * 2 + 1];
        const actual = existsSync(join(disk, file)) ? readFileSync(join(disk, file), 'utf8') : '';
        expect(actual.endsWith(pairs[index * 2 + 1]!), `writer result: ${JSON.stringify(result)}`).toBe(true);
        expect(actual).toBe(expected);
        if (state === 'new' || (state === 'capped' && file !== 'info.jsonl')) expect(statSync(join(disk, file)).mode & 0o777).toBe(0o600);
        if (state !== 'new') {
          const saved = readFileSync(join(disk, `${file}.1`));
          expect(saved.equals(state === 'capped' && file !== 'info.jsonl' ? oversized : Buffer.from(backup(file)))).toBe(true);
        }
      }
      expect(result).toEqual({ code: 0, stderr: '' });
      if (state === 'new') expect(statSync(disk).mode & 0o777).toBe(0o700);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
  it.each([
    ['errors.jsonl', 'error', true, true], ['errors.jsonl', 'error', true, false],
    ['warnings.jsonl', 'warning', true, true], ['warnings.jsonl', 'warning', false, false],
    ['info.jsonl', 'info', false, true], ['info.jsonl', 'info', true, false],
  ])('names every cap and carries only the known session for %s %s session=%s detail=%s', async (file, level, known, detail) => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-cap-'));
    const session = String.fromCharCode(115, 34, 92, 10, 38634);
    const input = { ...fields, level, msg: 'literal ,"session":"decoy", "detail":{}', detail: detail ? { session: 'nested decoy' } : undefined, ...(known ? { session } : { session: undefined }) };
    const text = future.levelRow?.(input, now) ?? '';
    const notice = (name: string) => ({ ts: '2026-10-14T15:20:31.123Z', plugin: 'sub-agent-compact', level: 'warning', event: 'log-capped', msg: 'level file exceeded 20971520 bytes; moved aside', where: 'src/log.ts#APPEND_SCRIPT', ...(known ? { session } : {}), detail: { file: name } });
    try {
      for (const name of new Set([file, 'warnings.jsonl'])) { writeFileSync(join(dir, name), Buffer.alloc(20971521, 'x')); chmodSync(join(dir, name), 0o644); }
      await shell(dir, [file as string, text]);
      const expected = file === 'warnings.jsonl' ? [notice('warnings.jsonl'), JSON.parse(text)] : [notice('warnings.jsonl'), notice(file as string)];
      expect(rows(dir, 'warnings.jsonl')).toEqual(expected);
      if (file !== 'warnings.jsonl') expect(rows(dir, file as string)).toEqual([JSON.parse(text)]);
      for (const name of new Set([file, 'warnings.jsonl'])) {
        expect(statSync(join(dir, `${name}.1`)).size).toBe(20971521);
      }
      expect(readFileSync(join(dir, 'warnings.jsonl'), 'utf8').trim().split('\n').every((row) => Buffer.byteLength(row + '\n') <= 4096)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('bounds a cap warning after adding a long known session using the row truncation contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-cap-bound-')); const session = 's'.repeat(3890);
    try {
      writeFileSync(join(dir, 'errors.jsonl'), Buffer.alloc(20971521, 'x'));
      const text = future.levelRow?.({ ...fields, event: '', msg: '', where: '', session, detail: undefined }, now) ?? '';
      const expected = { ts: '2026-10-14T15:20:31.123Z', plugin: 'sub-agent-compact', level: 'warning', event: 'log-capped', msg: 'level file exceeded 20971520 bytes; moved aside', where: 'src/log.ts#APPEND_SCRIPT', session, detail: { file: 'errors.jsonl' } };
      const detail = { truncated: true, bytes: Buffer.byteLength(JSON.stringify(expected) + '\n') };
      const available = 4096 - Buffer.byteLength(JSON.stringify({ ...expected, msg: '', detail }) + '\n');
      await shell(dir, ['errors.jsonl', text]);
      expect(rows(dir, 'warnings.jsonl')).toEqual([{ ...expected, msg: expected.msg.slice(0, available), detail }]);
      expect(Buffer.byteLength(readFileSync(join(dir, 'warnings.jsonl'), 'utf8'))).toBeLessThanOrEqual(4096);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('reports cap metadata that cannot fit instead of appending an oversized row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-cap-large-'));
    try {
      writeFileSync(join(dir, 'errors.jsonl'), Buffer.alloc(20971521, 'x'));
      const text = future.levelRow?.({ ...fields, event: '', msg: '', where: '', session: 's'.repeat(3950), detail: undefined }, now) ?? '';
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
      await expect(shell(dir, ['errors.jsonl', text])).rejects.toMatchObject({ stderr: expect.stringContaining(`${dir}/warnings.jsonl: cap warning metadata exceeds 4096 bytes`) });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.skipIf(process.getuid?.() === 0)('skip-because:superuser: unwritable directory names the path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-denied-'));
    chmodSync(dir, 0o500);
    try {
      await expect(shell(dir, ['errors.jsonl', JSON.stringify({ ts: '2026-10-14T15:20:31.123Z', ...fields }) + '\n'])).rejects.toMatchObject({ stderr: expect.stringContaining(dir) });
    } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
  });
  it.skipIf(process.getuid?.() === 0)('skip-because:superuser: cap inspection failure is not a successful append', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-cap-denied-'));
    const path = join(dir, 'errors.jsonl');
    writeFileSync(path, '{}\n'); chmodSync(path, 0o200);
    try {
      await expect(shell(dir, ['errors.jsonl', JSON.stringify({ ts: '2026-10-14T15:20:31.123Z', ...fields }) + '\n'])).rejects.toMatchObject({ stderr: expect.stringContaining(path) });
    } finally { chmodSync(path, 0o600); rmSync(dir, { recursive: true, force: true }); }
  });
  it('bounds batches at 64 pairs and keeps rows in order', () => {
    const input = Array.from({ length: 65 }, (_, n) => JSON.stringify({ ...fields, msg: String(n) }) + '\n');
    const batches: string[][] = future.appendArgv?.('/x/logs/sub-agent-compact', 'sub-agent-compact', input) ?? [];
    expect(batches.map((a) => [a[0], a[3], a[4], a[5], (a.length - 6) / 2])).toEqual([['/bin/sh', 'plugin-log', '/x/logs/sub-agent-compact', 'sub-agent-compact', 64], ['/bin/sh', 'plugin-log', '/x/logs/sub-agent-compact', 'sub-agent-compact', 1]]);
    expect(batches.flatMap((a) => a.slice(6).filter((_, n) => n % 2 === 1))).toEqual(input);
  });
  it('serializes concurrent flushes and rearms one fallback per failing streak', async () => {
    const queue = future.PluginLogQueue ? new future.PluginLogQueue('/x/logs/sub-agent-compact', 'sub-agent-compact') : undefined;
    const notices: unknown[] = [];
    const run = async () => { throw new Error('permission denied'); };
    for (let n = 0; n < 2; n++) { queue?.add(JSON.stringify({ ...fields }) + '\n'); notices.push(await queue?.flush(run)); }
    expect(notices).toEqual([{ dropped: 1, error: 'permission denied' }, { dropped: 1 }]);
    queue?.add(JSON.stringify({ ...fields }) + '\n');
    expect(await queue?.flush(async () => ({ exitCode: 0, stderr: '', stdout: '' }))).toEqual({ dropped: 0 });
    queue?.add(JSON.stringify({ ...fields }) + '\n');
    expect(await queue?.flush(async () => ({ exitCode: 2, stderr: 'disk full\ncontext', stdout: '' }))).toEqual({ dropped: 1, error: 'disk full' });
    const starts: string[] = []; let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    queue?.add(JSON.stringify({ ...fields, msg: 'first' }) + '\n');
    const first = queue?.flush(async (argv: string[]) => { starts.push(JSON.parse(argv[7]!).msg); await held; return { exitCode: 0, stderr: '', stdout: '' }; });
    queue?.add(JSON.stringify({ ...fields, msg: 'second' }) + '\n');
    const second = queue?.flush(async (argv: string[]) => { starts.push(JSON.parse(argv[7]!).msg); return { exitCode: 0, stderr: '', stdout: '' }; });
    await Promise.resolve(); await Promise.resolve();
    expect(starts).toEqual(['first']); release(); await first; await second;
    expect(starts).toEqual(['first', 'second']);
    expect(await queue?.flush(async () => { throw new Error('empty queue executed'); })).toEqual({ dropped: 0 });
  });
  it.each([
    ...['tool-register-failed', 'look-back-manual-error', 'brief-error', 'hook-threw'].map((event) => [event, 'error', event, {}] as [string, string, string, Record<string, unknown>]),
    ...['warning', 'option-error', 'resolve-error', 'handoff-invalid', 'forward-invalid', 'forward-unchecked', 'handoff-fallback', 'compact-unseen'].map((event) => [event, 'warning', event, {}] as [string, string, string, Record<string, unknown>]),
    ...['handoff-refused', 'arm-refused', 'forward-refused', 'stop-refused'].map((event) => [event, 'info', event, {}] as [string, string, string, Record<string, unknown>]),
    ['session.compact', 'error', 'compact-error', { why: 'error', error: 'bad reading' }],
    ['session.compact', 'warning', 'handoff-waits-skipped', { why: 'handoff-waits' }],
    ['session.compact', 'warning', 'haiku-hold', { why: 'haiku-hold' }],
    ['turn.complete', 'error', 'turn-complete-error', { error: 'compaction failed' }],
  ])('routes %s as %s without carrying tool bodies', (event, level, output, extra) => {
    const routed = future.pluginLogEvent?.({ event, ...extra as object, line: 'diagnostic', party: 'main', error: 'diagnostic failure', focus: 'private prompt', text: 'private handoff', query: 'private query', input: { body: 'private input' } });
    expect(routed).toMatchObject({ level, event: output, where: 'hooks/sub-agent-compact.ts#record' });
    expect(routed.detail).toEqual({ party: 'main', error: 'diagnostic failure', ...('why' in (extra as object) ? { why: (extra as any).why } : {}) });
  });
  it('logs unexpected API shapes without serializing transcript bodies', () => {
    expect(future.pluginLogEvent?.({ event: 'forward-invalid', problem: 'transcript: unreadable ({"body":"private transcript"})' })).toMatchObject({ level: 'warning', event: 'forward-invalid', msg: 'transcript: unreadable (unexpected API shape)', detail: { problem: 'transcript: unreadable (unexpected API shape)' } });
  });
  it('selects actionable diagnostics among routine hook traffic', () => {
    const traffic = [{ event: 'nudge', focus: 'private' }, { event: 'brief-error', error: 'seating failed' }];
    expect(traffic.flatMap((row) => future.pluginLogEvent?.(row) ?? []).map((row: any) => [row.level, row.event, row.msg])).toEqual([['error', 'brief-error', 'seating failed']]);
  });
});
