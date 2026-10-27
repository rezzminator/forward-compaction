import { describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as log from '../plugins/forward-compaction/src/log.ts';

// The level log loses no row (L1-L3), clears a dead writer's stage (L12) and keeps its rotated history (L4).
const future: Record<string, any> = log;
const exec = promisify(execFile);
const fields = { plugin: 'forward-compaction', level: 'error', event: 'tool-register-failed', msg: 'm', where: 'w', session: 's1' };
const row = (msg: string) => JSON.stringify({ ...fields, msg }) + '\n';
const ok = { exitCode: 0, stderr: '', stdout: '' };
const written = (argv: string[]) => argv.slice(6).filter((_, n) => n % 2 === 1).map((text) => JSON.parse(text).msg as string);
const shell = (dir: string, pairs: string[]) => exec('/bin/sh', ['-c', log.APPEND_SCRIPT, 'plugin-log', dir, 'forward-compaction', ...pairs]).then(() => 0, (error) => error.code as number);

describe('PluginLogQueue keeps every row it could not write', () => {
  it('requeues a failed batch, order kept, and writes it with the next flush', async () => {
    const queue = new log.PluginLogQueue('/x', 'forward-compaction');
    queue.add(row('a')); queue.add(row('b'));
    expect(await queue.flush(async () => ({ exitCode: 1, stderr: 'lock held by another writer\n', stdout: '' }))).toEqual({ held: 2, lost: 0, error: 'lock held by another writer' });
    queue.add(row('c'));
    const seen: string[] = [];
    expect(await queue.flush(async (argv) => { seen.push(...written(argv)); return ok; })).toEqual({ held: 0, lost: 0 });
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('retries a killed batch whole, so a row may repeat but none is lost', async () => {
    const queue = new log.PluginLogQueue('/x', 'forward-compaction');
    for (let n = 0; n < 70; n++) queue.add(row(String(n)));
    let runs = 0;
    const out = await queue.flush(async () => (++runs === 2 ? Promise.reject(new Error('aborted: still running after 15000ms')) : ok));
    expect(out).toEqual({ held: 6, lost: 0, error: 'aborted: still running after 15000ms' });
    const seen: string[] = [];
    await queue.flush(async (argv) => { seen.push(...written(argv)); return ok; });
    expect(seen).toEqual(['64', '65', '66', '67', '68', '69']);
  });

  it('drops only past the hold, oldest first, and reports the exact count once a write succeeds', async () => {
    const queue = new log.PluginLogQueue('/x', 'forward-compaction');
    const hold = log.PLUGIN_LOG_HOLD_ROWS as number;
    for (let n = 0; n < hold + 3; n++) queue.add(row(String(n)));
    const failed = await queue.flush(async () => ({ exitCode: 1, stderr: 'disk full', stdout: '' }));
    expect(failed).toEqual({ held: hold, lost: 0, error: 'disk full' });
    const seen: string[] = [];
    expect(await queue.flush(async (argv) => { seen.push(...written(argv)); return ok; })).toEqual({ held: 0, lost: 3 });
    expect(seen[0]).toBe('3');
    expect(seen).toHaveLength(hold);
    expect(await queue.flush(async () => ok)).toEqual({ held: 0, lost: 0 });
  });
});

describe('the append script', () => {
  it('clears a stage and a broken lock whose writer is dead, keeping a live writer\'s stage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-stale-'));
    const dead = 999_999;
    expect(() => process.kill(dead, 0)).toThrow();
    try {
      for (const name of [`.lock.${dead}`, `.lock.dead.${dead}`, `.lock.${process.pid}`]) mkdirSync(join(dir, name));
      expect(await shell(dir, ['errors.jsonl', row('x')])).toBe(0);
      expect(existsSync(join(dir, `.lock.${dead}`))).toBe(false);
      expect(existsSync(join(dir, `.lock.dead.${dead}`))).toBe(false);
      expect(existsSync(join(dir, `.lock.${process.pid}`))).toBe(true);
      expect(readFileSync(join(dir, 'errors.jsonl'), 'utf8')).toBe(row('x'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps the newest five rotated files of a level log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-rotate-'));
    const big = join(dir, 'errors.jsonl');
    try {
      for (let n = 1; n <= 5; n++) writeFileSync(`${big}.${n}`, `generation ${n}\n`);
      writeFileSync(big, ''); truncateSync(big, log.PLUGIN_LOG_CAP_BYTES + 1);
      expect(await shell(dir, ['errors.jsonl', row('new')])).toBe(0);
      expect(log.PLUGIN_LOG_KEEP).toBeGreaterThanOrEqual(5);
      expect(statSync(`${big}.1`).size).toBe(log.PLUGIN_LOG_CAP_BYTES + 1);
      expect([2, 3, 4, 5].map((n) => readFileSync(`${big}.${n}`, 'utf8'))).toEqual(['generation 1\n', 'generation 2\n', 'generation 3\n', 'generation 4\n']);
      expect(existsSync(`${big}.6`)).toBe(false);
      expect(readFileSync(big, 'utf8')).toBe(row('new'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('waits on a live holder by the clock, never by a count of tries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-wait-'));
    const bin = join(dir, 'bin');
    const [lock, tries, clock] = [join(dir, '.lock'), join(dir, 'tries'), join(dir, 'clock')];
    // `sleep` returns at once, counts its calls, moves the clock STEP seconds on, and frees the lock at try RELEASE_AT;
    // `date +%s` reads that clock. The wait's length is then set by the test, never by how loaded the host is.
    mkdirSync(bin);
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nn=$(( $(cat "$TRIES" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$TRIES"\necho "$(( $(cat "$CLOCK") + STEP ))" > "$CLOCK"\n[ "$n" != "${RELEASE_AT:-}" ] || rm -rf "$LOCK"\n', { mode: 0o755 });
    writeFileSync(join(bin, 'date'), '#!/bin/sh\nif [ "$*" = "+%s" ]; then cat "$CLOCK"; else PATH=${PATH#*:} exec date "$@"; fi\n', { mode: 0o755 });
    const append = (env: Record<string, string>) => {
      rmSync(tries, { force: true }); rmSync(join(dir, 'errors.jsonl'), { force: true });
      writeFileSync(clock, `${Math.floor(Date.now() / 1000)}\n`);
      mkdirSync(lock); writeFileSync(join(lock, 'pid'), `${process.pid} ${Math.floor(Date.now() / 1000)}\n`);
      return new Promise<{ code: number | null; stderr: string; tries: string }>((resolve) => {
        const child = spawn('/bin/sh', ['-c', log.APPEND_SCRIPT, 'plugin-log', dir, 'forward-compaction', 'errors.jsonl', row('late')], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOCK: lock, TRIES: tries, CLOCK: clock, ...env } });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => resolve({ code, stderr, tries: readFileSync(tries, 'utf8').trim() }));
      });
    };
    try {
      // A clock that stands still: the holder lets go on the 101st try, one past a count of 100, and the row is written.
      expect(await append({ STEP: '0', RELEASE_AT: '101' })).toMatchObject({ code: 0, tries: '101' });
      expect(readFileSync(join(dir, 'errors.jsonl'), 'utf8')).toBe(row('late'));
      // A clock a second on per try: the writer gives up once LOCK_WAIT_SECONDS have passed, whatever the count.
      const given = await append({ STEP: '1' });
      expect(given).toMatchObject({ tries: String(log.LOCK_WAIT_SECONDS + 1) });
      expect(given.code).not.toBe(0);
      expect(given.stderr).toContain('lock held by another writer');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});

describe('pluginLogEvent names where a row came from', () => {
  it('takes `where` from the row, the function that raised it, and falls back to the writer', () => {
    expect(log.pluginLogEvent({ event: 'turn-end-rejected', where: 'turnEnds', error: 'busy' })).toMatchObject({ level: 'error', where: 'hooks/forward-compaction.ts#turnEnds' });
    expect(log.pluginLogEvent({ event: 'stored', party: 'main' })).toMatchObject({ level: 'info', where: 'hooks/forward-compaction.ts#record' });
  });
});
