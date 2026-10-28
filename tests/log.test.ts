import { describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as log from '../plugins/forward-compaction/src/log.ts';
import { levelRow } from '../plugins/forward-compaction/src/plugin-log.ts';
import { runCwd, sessionLogPath } from '../plugins/forward-compaction/src/log.ts';

// Optional lookup lets the unimplemented writer fail on the required output, not an import error.
const future: Record<string, any> = log;
const exec = promisify(execFile);
const rows = (dir: string, file: string): any[] => existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];

describe('sessionLogPath', () => {
  it.each([
    ['/tmp/sac/decisions.jsonl', 'abc-123', '/tmp/sac/decisions.abc-123.jsonl'],
    ['/tmp/sac/decisions', 'abc-123', '/tmp/sac/decisions.abc-123'],
    ['/tmp/sac.d/decisions', 'abc', '/tmp/sac.d/decisions.abc'],
    ['/tmp/sac/.decisions', 'abc', '/tmp/sac/.decisions.abc'],
    ['/tmp/sac/a.b.jsonl', 'abc', '/tmp/sac/a.b.abc.jsonl'],
    ['/x/logs/forward-compaction/decisions/.jsonl', 's1', '/x/logs/forward-compaction/decisions/s1.jsonl'],
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

describe('decision events in the level files', () => {
  it.each([
    ...['turn-end-rejected', 'tool-register-failed', 'look-back-manual-error', 'option-error'].map((event) => [event, 'error', event, {}] as [string, string, string, Record<string, unknown>]),
    ...['compact-window', 'ceiling-below-ask', 'decision-retention-failed', 'unseen-compaction'].map((event) => [event, 'warning', event, {}] as [string, string, string, Record<string, unknown>]),
    ['compact', 'error', 'compact-error', { decision: 'error', error: 'bad reading' }],
  ])('routes %s as %s without carrying tool bodies', (event, level, output, extra) => {
    const routed = future.pluginLogEvent?.({ event, ...extra as object, line: 'diagnostic', party: 'main', error: 'diagnostic failure', focus: 'private prompt', text: 'private frontier', query: 'private query', input: { body: 'private input' } });
    expect(routed).toMatchObject({ level, event: output, where: 'hooks/forward-compaction.ts#record' });
    expect(routed.detail).toEqual({ party: 'main', error: 'diagnostic failure', ...('why' in (extra as object) ? { why: (extra as any).why } : {}), ...('decision' in (extra as object) ? { decision: (extra as any).decision } : {}) });
  });
  it('logs unexpected API shapes without serializing transcript bodies', () => {
    expect(future.pluginLogEvent?.({ event: 'decision-retention-failed', problem: 'transcript: unreadable ({"body":"private transcript"})' })).toMatchObject({ level: 'warning', event: 'decision-retention-failed', msg: 'transcript: unreadable (unexpected API shape)', detail: { problem: 'transcript: unreadable (unexpected API shape)' } });
  });
  it('files routine hook traffic at info, keeping errors and warnings at their levels', () => {
    const traffic = [{ event: 'nudge', party: 'main', tokens: 51_000, focus: 'private' }, { event: 'option-error', error: 'seating failed' }, { event: 'stored', party: 'main', chars: 40, line: 'stored 40 characters' }, { event: 'compact', party: 'main', decision: 'install', why: 'stored', line: 'main frontier landed' }];
    expect(traffic.flatMap((row) => future.pluginLogEvent?.(row) ?? []).map((row: any) => [row.level, row.event, row.msg])).toEqual([
      ['info', 'nudge', 'nudge'], ['error', 'option-error', 'seating failed'], ['info', 'stored', 'stored 40 characters'], ['info', 'compact', 'main frontier landed'],
    ]);
    expect(future.pluginLogEvent?.({ event: 'nudge', party: 'main', tokens: 51_000, focus: 'private' }).detail).toEqual({ party: 'main', tokens: 51_000 });
    expect(future.pluginLogEvent?.({ event: 'stored', party: 'main', chars: 40, files: 2, tokens: 9 }).detail).toEqual({ party: 'main', chars: 40, files: 2, tokens: 9 });
    expect(future.pluginLogEvent?.({ event: 'skips', party: 'main', count: 7 })).toMatchObject({ level: 'info', event: 'skips', msg: '7 more held compaction asks folded' });
    expect(future.pluginLogEvent?.({ event: 'nudge', party: 'main', level: 2, tokens: 9 }).detail).toEqual({ party: 'main', level: 2, tokens: 9 });
    expect(future.pluginLogEvent?.({ event: 'compact', party: 'main', trigger: 'auto', decision: 'skip', why: 'waiting', tokens: 9 }).detail).toEqual({ party: 'main', trigger: 'auto', decision: 'skip', why: 'waiting', tokens: 9 });
    expect(future.pluginLogEvent?.({ event: 'skips', party: 'main', count: 4, from: 'a', to: 'b', firstTokens: 1, lastTokens: 2, ts: 'b' }).detail).toEqual({ party: 'main', count: 4, from: 'a', to: 'b', firstTokens: 1, lastTokens: 2 });
  });
  it('stamps a folded skips row with its streak\'s time and any other row with the writing time', () => {
    const stamp = (fields: object, now: number) => JSON.parse(levelRow({ plugin: 'p', level: 'info', event: 'skips', msg: 'm', where: 'w', ...fields }, now)).ts;
    const late = Date.parse('2026-10-24T00:06:52.411Z');
    expect(stamp({}, late)).toBe('2026-10-24T00:06:52.411Z');
    expect(stamp({ ts: '2026-10-24T00:06:25.004Z' }, late)).toBe('2026-10-24T00:06:25.004Z');
    expect(stamp({ ts: 'not a time' }, late)).toBe('2026-10-24T00:06:52.411Z');
    expect((future.pluginLogEvent?.({ event: 'skips', party: 'main', count: 4, ts: '2026-10-24T00:06:25.004Z' }) as any).ts).toBe('2026-10-24T00:06:25.004Z');
    expect((future.pluginLogEvent?.({ event: 'nudge', party: 'main', ts: '2026-10-24T00:06:25.004Z' }) as any).ts).toBeUndefined();
  });

  it('takes `where` from the row, the function that raised it, and falls back to the writer', () => {
    expect(log.pluginLogEvent({ event: 'turn-end-rejected', where: 'turnEnds', error: 'busy' })).toMatchObject({ level: 'error', where: 'hooks/forward-compaction.ts#turnEnds' });
    expect(log.pluginLogEvent({ event: 'stored', party: 'main' })).toMatchObject({ level: 'info', where: 'hooks/forward-compaction.ts#record' });
  });
  it('maps no said row (say writes its own) and no plugin-log failure (it would recurse into the failing log)', () => {
    expect(future.pluginLogEvent?.({ event: 'said', line: 'x', shown: false })).toBeUndefined();
    expect(future.pluginLogEvent?.({ event: 'plugin-log-failed', error: 'EACCES', dropped: 1 })).toBeUndefined();
  });
});

describe('decision log', () => {
  it('reports at session end what the bound cut and every row the hold dropped, the cut branch included', () => {
    const at = { boundMs: 400, levelRows: 0, error: 'EACCES', path: '/logs/d.jsonl' };
    const cut = future.endReport?.({ ...at, timedOut: true, decisionRows: 7, held: 7, dropped: 3 });
    expect(cut?.cut).toBe('forward-compaction: the session-end bound (400 ms) ran out before the logs were written; 7 decision rows may be lost');
    expect(cut?.lost).toEqual({ line: 'forward-compaction: 3 decision rows were not written to /logs/d.jsonl (3 of them dropped past the 2000-row hold): EACCES', rows: 3, dropped: 3, error: 'EACCES' });
    expect(future.endReport?.({ ...at, timedOut: true, decisionRows: 0, held: 0, dropped: 0 })).toEqual({ cut: 'forward-compaction: the session-end bound (400 ms) ran out while the log writes were finishing; no row was in flight' });
    expect(future.endReport?.({ ...at, timedOut: false, decisionRows: 2, held: 2, dropped: 0 })?.lost?.rows).toBe(2);
    expect(future.endReport?.({ ...at, timedOut: false, decisionRows: 0, held: 0, dropped: 0 })).toEqual({});
  });

  const runSh = (argv: string[], stdin = '', env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { env });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('close', (code) => resolve({ code, stderr }));
      // A child that exits before reading its stdin (the retention script reads none) closes the pipe: EPIPE is that race, any other error fails the test.
      child.stdin.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') reject(err); });
      child.stdin.end(stdin);
    });
  const append = (path: string, lines: string[], cap?: number) => runSh(future.decisionAppendArgv?.(path, ...(cap === undefined ? [] : [cap])) ?? ['/bin/sh', '-c', 'exit 9'], lines.map((line) => `${line}\n`).join(''));
  const lines = (path: string): string[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
  const skip = (ts: string, tokens: number, agentId: string | null = null, trigger = 'auto') => ({ ts, event: 'compact', party: agentId ? `agent:${agentId}` : 'main', trigger, decision: 'skip', why: trigger === 'precompute' ? 'precompute' : 'waiting', tokens });

  it('writes the first skip of a streak, folds the rest, and closes the streak at the party\'s next decision', () => {
    const fold = future.SkipFold ? new future.SkipFold() : undefined;
    const out: any[] = [];
    for (let i = 0; i < 5; i++) out.push(...(fold?.add(skip(`t${i}`, 1000 + i)) ?? []));
    out.push(...(fold?.add({ ts: 't5', event: 'said', line: 'x' }) ?? []));
    out.push(...(fold?.add({ ts: 't6', event: 'compact', party: 'main', trigger: 'auto', decision: 'install', why: 'stored', tokens: 125_000 }) ?? []));
    expect(out).toEqual([
      skip('t0', 1000),
      { ts: 't5', event: 'said', line: 'x' },
      { ts: 't4', event: 'skips', party: 'main', trigger: 'auto', count: 4, from: 't1', to: 't4', firstTokens: 1001, lastTokens: 1004 },
      { ts: 't6', event: 'compact', party: 'main', trigger: 'auto', decision: 'install', why: 'stored', tokens: 125_000 },
    ]);
  });

  it('folds each party and trigger on its own, closes every 100 folded skips, and drains what is open at the end', () => {
    const fold = future.SkipFold ? new future.SkipFold() : undefined;
    const out: any[] = [];
    for (let i = 0; i < 102; i++) out.push(...(fold?.add(skip(`m${i}`, i)) ?? []));
    out.push(...(fold?.add(skip('a0', 7, 'agent-1')) ?? []), ...(fold?.add(skip('a1', 8, 'agent-1')) ?? []));
    out.push(...(fold?.add(skip('p0', 9, null, 'precompute')) ?? []));
    out.push(...(fold?.add({ ts: 'w', event: 'compact', party: 'main', trigger: 'precompute', decision: 'error', error: 'bad reading' }) ?? []));
    out.push(...(fold?.drain() ?? []));
    expect(out.map((row: any) => [row.event, row.ts, row.count ?? null, row.party])).toEqual([
      ['compact', 'm0', null, 'main'],
      ['skips', 'm100', 100, 'main'],
      ['compact', 'a0', null, 'agent:agent-1'],
      ['compact', 'p0', null, 'main'],
      ['skips', 'm101', 1, 'main'],
      ['compact', 'w', null, 'main'],
      ['skips', 'a1', 1, 'agent:agent-1'],
    ]);
    expect(fold?.drain()).toEqual([]);
  });

  it('appends the rows on stdin to a private file and keeps the rows already there', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'decision-log-'));
    const path = join(parent, 'logs', 'decisions.s1.jsonl');
    try {
      expect((await append(path, ['{"a":1}', '{"a":2}'])).code).toBe(0);
      expect((await append(path, ['{"a":3}'])).code).toBe(0);
      expect(lines(path)).toEqual(['{"a":1}', '{"a":2}', '{"a":3}']);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(parent, 'logs')).mode & 0o777).toBe(0o700);
      expect(existsSync(`${path}.lock`)).toBe(false);
      // An append killed mid-row left a torn last line: the retried rows start on a line of their own.
      appendFileSync(path, '{"torn":');
      expect((await append(path, ['{"a":4}'])).code).toBe(0);
      expect(lines(path).slice(-2)).toEqual(['{"torn":', '{"a":4}']);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('loses no row when four writers append at once across a rotation', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'decision-log-'));
    const path = join(parent, 'decisions.s1.jsonl');
    try {
      const writers = [0, 1, 2, 3].map(async (w) => {
        for (let i = 0; i < 25; i++) {
          const out = await append(path, [0, 1, 2, 3].map((k) => JSON.stringify({ w, i, k, pad: 'x'.repeat(40) })), 4096);
          expect(out.code, out.stderr).toBe(0);
        }
      });
      await Promise.all(writers);
      const all = [...lines(`${path}.1`), ...lines(path)].map((line) => JSON.parse(line));
      expect(statSync(`${path}.1`).size).toBeGreaterThan(4096);
      expect(lines(path).length).toBeGreaterThan(0);
      // .1 keeps only the last rotated part: every row of the current file and .1 parses, and nothing is cut.
      expect(all.every((row) => typeof row.w === 'number' && row.pad.length === 40)).toBe(true);
    } finally { rmSync(parent, { recursive: true, force: true }); }
    // Real processes contending for one lock: about 2 s on an idle machine, past vitest's 5 s default on a loaded one.
  }, 30_000);

  it('moves a file past the cap aside before appending', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'decision-log-'));
    const path = join(parent, 'decisions.s1.jsonl');
    try {
      writeFileSync(path, `${'{"old":1}\n'.repeat(20)}`);
      expect((await append(path, ['{"new":1}'], 100)).code).toBe(0);
      expect(lines(`${path}.1`)).toHaveLength(20);
      expect(lines(path)).toEqual(['{"new":1}']);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('waits on a lock its live holder keeps and appends once it is released', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'decision-log-'));
    const path = join(parent, 'decisions.s1.jsonl');
    try {
      mkdirSync(`${path}.lock`); writeFileSync(join(`${path}.lock`, 'pid'), `${process.pid}\n`);
      const pending = append(path, ['{"a":1}']);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(lines(path)).toEqual([]);
      rmSync(`${path}.lock`, { recursive: true, force: true });
      expect((await pending).code).toBe(0);
      expect(lines(path)).toEqual(['{"a":1}']);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('breaks a lock whose holder is gone', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'decision-log-'));
    const path = join(parent, 'decisions.s1.jsonl');
    const dead = 999_999;
    expect(() => process.kill(dead, 0)).toThrow();
    try {
      mkdirSync(`${path}.lock`); writeFileSync(join(`${path}.lock`, 'pid'), `${dead}\n`);
      const out = await append(path, ['{"a":1}']);
      expect(out.code, out.stderr).toBe(0);
      expect(lines(path)).toEqual(['{"a":1}']);
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('breaks a lock whose claimer died holding its token, leaving the lock without one', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'decision-log-'));
    const path = join(parent, 'decisions.s1.jsonl');
    const dead = 999_999;
    expect(() => process.kill(dead, 0)).toThrow();
    try {
      mkdirSync(`${path}.lock`); writeFileSync(join(`${path}.lock`, `pid.claim.${dead}`), `${dead} 0\n`);
      const out = await append(path, ['{"a":1}']);
      expect(out.code, out.stderr).toBe(0);
      expect(lines(path)).toEqual(['{"a":1}']);
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }, 30_000);

  it('keeps a live claimer\'s fresh claim even when the token it took is old', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'decision-log-'));
    const path = join(parent, 'decisions.s1.jsonl');
    try {
      const claim = join(`${path}.lock`, `pid.claim.${Math.floor(Date.now() / 1000)}.${process.pid}`);
      mkdirSync(`${path}.lock`); writeFileSync(claim, `${process.pid} 0\n`);
      const old = new Date(Date.now() - 600_000); utimesSync(claim, old, old);
      const out = await append(path, ['{"a":1}']);
      expect(out.stderr).toContain('lock held by another writer');
      expect(existsSync(claim)).toBe(true);
      expect(lines(path)).toEqual([]);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }, 60_000);

  // A writer whose stdin stays open holds the lock between its first and second half of a row.
  const holding = (argv: string[], env: NodeJS.ProcessEnv = process.env) => {
    const child = spawn(argv[0]!, argv.slice(1), { env });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.stdin.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err; });
    const done = new Promise<{ code: number | null; stderr: string }>((resolve) => child.on('close', (code) => resolve({ code, stderr })));
    return { child, done };
  };
  const until = async (test: () => boolean, ms: number): Promise<boolean> => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 20))) if (test()) return true;
    return test();
  };
  const tokenPid = (lockDir: string): string => { try { return readFileSync(join(lockDir, 'pid'), 'utf8').trim().split(' ')[0]!; } catch { return ''; } };
  const settle = async (pending: Promise<unknown>, ms: number) => Promise.race([pending.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);

  it('keeps the lock a second waiter broke and took while the first stalls between reading the dead holder and breaking', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'decision-log-'));
    const path = join(parent, 'decisions.s1.jsonl');
    const lockDir = `${path}.lock`;
    const stall = mkdtempSync(join(tmpdir(), 'lock-stall-'));
    const realPath = process.env.PATH ?? '/usr/bin:/bin';
    const dead = 999_999;
    expect(() => process.kill(dead, 0)).toThrow();
    // Waiter B's cat: its second read of the dead holder's token returns what it read, after A has broken and taken the lock.
    writeFileSync(join(stall, 'cat'), `#!/bin/sh
if [ $# -eq 1 ] && [ -f "$1" ]; then
  seen=$(PATH='${realPath}' cat "$1")
  if [ "$seen" = '${dead}' ]; then
    n=$(( $(PATH='${realPath}' cat '${stall}/count' 2>/dev/null || echo 0) + 1 )); echo "$n" > '${stall}/count'
    if [ "$n" -eq 2 ]; then : > '${stall}/reached'; while [ ! -e '${stall}/go' ]; do PATH='${realPath}' sleep 0.02; done; fi
    printf '%s\\n' "$seen"; exit 0
  fi
fi
PATH='${realPath}' exec cat "$@"
`);
    chmodSync(join(stall, 'cat'), 0o755);
    const argv = future.decisionAppendArgv?.(path) ?? ['/bin/sh', '-c', 'exit 9'];
    try {
      mkdirSync(lockDir); writeFileSync(join(lockDir, 'pid'), `${dead}\n`);
      const b = holding(argv, { ...process.env, PATH: `${stall}:${realPath}` });
      b.child.stdin.end('{"w":"B"}\n');
      expect(await until(() => existsSync(join(stall, 'reached')), 5000)).toBe(true);
      const a = holding(argv);
      a.child.stdin.write('{"w":"A",');
      await until(() => tokenPid(lockDir) === String(a.child.pid), 1500);
      writeFileSync(join(stall, 'go'), '');
      await settle(b.done, 800);
      if (tokenPid(lockDir) === String(a.child.pid)) {
        // B may have appended and released before A took the lock; under A's lock its row would land after A's half.
        const text = () => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
        expect(await until(() => text().includes('{"w":"A",'), 4000)).toBe(true);
        expect(['{"w":"A",', '{"w":"B"}\n{"w":"A",']).toContain(text());
      } else {
        expect(await until(() => tokenPid(lockDir) === String(a.child.pid), 4000)).toBe(true);
      }
      a.child.stdin.end('"half":2}\n');
      const [outA, outB] = await Promise.all([a.done, b.done]);
      expect(outA.code, outA.stderr).toBe(0);
      expect(outB.code, outB.stderr).toBe(0);
      expect(lines(path).map((line) => JSON.parse(line).w).sort()).toEqual(['A', 'B']);
      expect(existsSync(lockDir)).toBe(false);
      expect(readdirSync(parent).filter((name) => name.includes('.lock'))).toEqual([]);
    } finally { rmSync(parent, { recursive: true, force: true }); rmSync(stall, { recursive: true, force: true }); }
  }, 20_000);

  it('leaves the successor\'s lock when a holder released after its lock was broken for age', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'decision-log-'));
    const path = join(parent, 'decisions.s1.jsonl');
    const lockDir = `${path}.lock`;
    const argv = future.decisionAppendArgv?.(path) ?? ['/bin/sh', '-c', 'exit 9'];
    try {
      const first = holding(argv);
      first.child.stdin.write('{"w":"first"}\n');
      expect(await until(() => tokenPid(lockDir) === String(first.child.pid), 4000)).toBe(true);
      const old = new Date(Date.now() - 120_000);
      utimesSync(join(lockDir, 'pid'), old, old); utimesSync(lockDir, old, old);
      const next = holding(argv);
      next.child.stdin.write('{"w":"next"}\n');
      expect(await until(() => tokenPid(lockDir) === String(next.child.pid), 4000)).toBe(true);
      first.child.stdin.end();
      expect((await first.done).code).toBe(0);
      expect(tokenPid(lockDir)).toBe(String(next.child.pid));
      next.child.stdin.end();
      expect((await next.done).code).toBe(0);
      expect(lines(path).map((line) => JSON.parse(line).w).sort()).toEqual(['first', 'next']);
      expect(readdirSync(parent).filter((name) => name.includes('.lock'))).toEqual([]);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }, 20_000);

  it('keeps its own lock when its token was claimed away while it checked it', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'decision-log-'));
    const path = join(parent, 'decisions.s1.jsonl');
    const lockDir = `${path}.lock`;
    const stall = mkdtempSync(join(tmpdir(), 'lock-claimed-'));
    const realPath = process.env.PATH ?? '/usr/bin:/bin';
    // The writer's first read of its new lock's token finds no token: a claimer (a waiter breaking a stale holder, or a
    // holder outlived by an age break releasing) has renamed it aside for its check and puts it back right after.
    writeFileSync(join(stall, 'cat'), `#!/bin/sh
if [ $# -eq 1 ] && [ "$1" = '${lockDir}/pid' ] && [ ! -e '${stall}/claimed' ]; then : > '${stall}/claimed'; exit 1; fi
PATH='${realPath}' exec cat "$@"
`);
    chmodSync(join(stall, 'cat'), 0o755);
    const argv = future.decisionAppendArgv?.(path) ?? ['/bin/sh', '-c', 'exit 9'];
    try {
      const out = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = execFile(argv[0]!, argv.slice(1), { env: { ...process.env, PATH: `${stall}:${realPath}` } }, (error, _stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stderr }));
        child.stdin!.end('{"a":1}\n');
      });
      expect(existsSync(join(stall, 'claimed'))).toBe(true);
      expect(out.code, out.stderr).toBe(0);
      expect(lines(path)).toEqual(['{"a":1}']);
      expect(readdirSync(parent).filter((name) => name.includes('.lock'))).toEqual([]);
    } finally { rmSync(parent, { recursive: true, force: true }); rmSync(stall, { recursive: true, force: true }); }
  }, 20_000);

  describe('retention', () => {
    const uuid = (n: number) => `0000000${n % 10}-aaaa-4bbb-8ccc-${String(n).padStart(12, '0')}`;
    const age = (path: string, days: number) => { const t = (Date.now() - days * 86_400_000) / 1000; utimesSync(path, t, t); };
    const retain = (logFile: string, self: string, policy?: { days: number; keep: number }) => runSh(future.retentionArgv?.(logFile, self, ...(policy ? [policy] : [])) ?? ['/bin/sh', '-c', 'exit 9']);

    it('passes the 14-day, 200-file policy by default', () => {
      expect(future.retentionArgv?.('/d/decisions.jsonl', `/d/decisions.${uuid(1)}.jsonl`)?.slice(3)).toEqual(['decision-retention', '/d', 'decisions.', '.jsonl', '14', '200', `decisions.${uuid(1)}.jsonl`]);
      expect(future.retentionArgv?.('/d/logs/.jsonl', `/d/logs/${uuid(1)}.jsonl`)?.slice(4, 7)).toEqual(['/d/logs', '', '.jsonl']);
      expect(future.retentionArgv?.('/d/decisions', `/d/decisions.${uuid(1)}`)?.slice(4, 7)).toEqual(['/d', 'decisions.', '']);
    });

    it('deletes this log\'s session files past the age and past the newest count, never the session\'s own or another file', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'decision-retention-'));
      const file = (name: string, days: number, row = '{"ts":"2026-10-01T00:00:00.000Z","event":"start"}') => { writeFileSync(join(dir, name), `${row}\n`); age(join(dir, name), days); return name; };
      try {
        const self = file(`decisions.${uuid(0)}.jsonl`, 30);
        const old = file(`decisions.${uuid(1)}.jsonl`, 20); const oldRotated = file(`${old}.1`, 20);
        const orphan = file(`decisions.${uuid(2)}.jsonl.1`, 20);
        const fresh = [3, 4, 5, 6].map((n) => file(`decisions.${uuid(n)}.jsonl`, n - 2));
        const freshRotated = file(`${fresh[3]}.1`, 4);
        const foreign = [file('decisions.notes.jsonl', 40), file('other.jsonl', 40), file(`audit.${uuid(7)}.jsonl`, 40), file(`decisions.${uuid(8)}.jsonl`, 40, '{"type":"user","sessionId":"x"}')];
        const out = await retain(join(dir, 'decisions.jsonl'), join(dir, self), { days: 14, keep: 3 });
        expect(out.code, out.stderr).toBe(0);
        const left = readdirSync(dir).sort();
        expect(left).toEqual([self, fresh[0], fresh[1], ...foreign].sort());
        for (const gone of [old, oldRotated, orphan, fresh[2], fresh[3], freshRotated]) expect(left).not.toContain(gone);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('deletes a session file just past the age and keeps one just short of it', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'decision-retention-'));
      const file = (name: string, days: number) => { writeFileSync(join(dir, name), '{"ts":"2026-10-01T00:00:00.000Z","event":"start"}\n'); age(join(dir, name), days); return name; };
      try {
        const self = file(`decisions.${uuid(0)}.jsonl`, 0);
        const short = file(`decisions.${uuid(1)}.jsonl`, 14 - 1 / 24);
        file(`decisions.${uuid(2)}.jsonl`, 14 + 1 / 24);
        const out = await retain(join(dir, 'decisions.jsonl'), join(dir, self), { days: 14, keep: 200 });
        expect(out.code, out.stderr).toBe(0);
        expect(readdirSync(dir).sort()).toEqual([self, short].sort());
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('prunes 260 session files to the 200-file cap with one find, not one process per file', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'decision-retention-'));
      const bin = mkdtempSync(join(tmpdir(), 'decision-retention-bin-'));
      const counter = join(bin, 'finds');
      const realFind = ['/usr/bin/find', '/bin/find'].find((path) => existsSync(path))!;
      writeFileSync(join(bin, 'find'), `#!/bin/sh\necho x >> '${counter}'\nexec '${realFind}' "$@"\n`);
      chmodSync(join(bin, 'find'), 0o755);
      try {
        const names = Array.from({ length: 260 }, (_, n) => `decisions.${uuid(n + 1)}.jsonl`);
        names.forEach((name, n) => { writeFileSync(join(dir, name), '{"ts":"2026-10-01T00:00:00.000Z","event":"start"}\n'); age(join(dir, name), n / 1000); });
        const self = names[259]!;
        const started = Date.now();
        const out = await runSh(future.retentionArgv?.(join(dir, 'decisions.jsonl'), join(dir, self)) ?? ['/bin/sh', '-c', 'exit 9'], '', { ...process.env, PATH: `${bin}:${process.env.PATH}` });
        const ms = Date.now() - started;
        expect(out.code, out.stderr).toBe(0);
        const left = readdirSync(dir);
        expect(left).toHaveLength(200);
        expect(left).toContain(self);
        expect(left).toEqual(expect.arrayContaining(names.slice(0, 199)));
        expect(existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0).toBeLessThanOrEqual(1);
        expect(ms).toBeLessThan(5_000);
      } finally { rmSync(dir, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
    });

    it('goes on with the names find printed when an entry vanishes mid-listing', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'decision-retention-'));
      const bin = mkdtempSync(join(tmpdir(), 'decision-retention-bin-'));
      const realFind = ['/usr/bin/find', '/bin/find'].find((path) => existsSync(path))!;
      // find exits 1 when an entry another session removes goes missing under it, after printing the rest.
      writeFileSync(join(bin, 'find'), `#!/bin/sh\n'${realFind}' "$@"\nexit 1\n`);
      chmodSync(join(bin, 'find'), 0o755);
      try {
        const old = `decisions.${uuid(1)}.jsonl`;
        const self = `decisions.${uuid(2)}.jsonl`;
        for (const name of [old, self]) writeFileSync(join(dir, name), '{"ts":"2026-10-01T00:00:00.000Z","event":"start"}\n');
        age(join(dir, old), 30);
        const out = await runSh(future.retentionArgv?.(join(dir, 'decisions.jsonl'), join(dir, self)) ?? ['/bin/sh', '-c', 'exit 9'], '', { ...process.env, PATH: `${bin}:${process.env.PATH}` });
        expect(out.code, out.stderr).toBe(0);
        expect(readdirSync(dir)).toEqual([self]);
      } finally { rmSync(dir, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
    });

    it('ages a symlinked session file by the link\'s own time, as it deletes the link and never its target', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'decision-retention-'));
      const elsewhere = mkdtempSync(join(tmpdir(), 'decision-retention-target-'));
      try {
        const target = join(elsewhere, 'kept.jsonl');
        writeFileSync(target, '{"ts":"2026-10-01T00:00:00.000Z","event":"start"}\n');
        const link = `decisions.${uuid(1)}.jsonl`;
        const self = `decisions.${uuid(2)}.jsonl`;
        symlinkSync(target, join(dir, link));
        writeFileSync(join(dir, self), '{"ts":"2026-10-01T00:00:00.000Z","event":"start"}\n');
        const t = (Date.now() - 30 * 86_400_000) / 1000;
        lutimesSync(join(dir, link), t, t);
        const out = await retain(join(dir, 'decisions.jsonl'), join(dir, self));
        expect(out.code, out.stderr).toBe(0);
        expect(readdirSync(dir)).toEqual([self]);
        expect(existsSync(target)).toBe(true);
      } finally { rmSync(dir, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
    });

    it('passes over a log directory that does not exist', async () => {
      const out = await retain('/nonexistent-sac/decisions.jsonl', `/nonexistent-sac/decisions.${uuid(0)}.jsonl`);
      expect(out.code, out.stderr).toBe(0);
    });
  });
});

describe('runCwd', () => {
  it('runs a script of absolute paths from /, and one with a relative path from the session directory', () => {
    expect(runCwd('/logs/decisions.s.jsonl')).toEqual({ cwd: '/' });
    expect(runCwd('/logs/decisions/.jsonl', '/logs/decisions/s.jsonl')).toEqual({ cwd: '/' });
    expect(runCwd('logs/x.jsonl')).toEqual({});
    expect(runCwd('')).toEqual({});
    expect(runCwd()).toEqual({});
  });
});

describe('hookRow: the debug row of a hook entry', () => {
  it('names the hook, the party, and the trigger, model and tool the event carries', () => {
    expect(log.hookRow('session.compact', { agentId: 'a1', trigger: 'auto', messages: [] })).toEqual({ hook: 'session.compact', party: 'agent:a1', trigger: 'auto', model: null, tool: null });
    expect(log.hookRow('turn.step', { model: 'claude-haiku-4-5' })).toEqual({ hook: 'turn.step', party: 'main', trigger: null, model: 'claude-haiku-4-5', tool: null });
    expect(log.hookRow('tool.call', { tool: 'Read', agentId: '' })).toEqual({ hook: 'tool.call', party: 'main', trigger: null, model: null, tool: 'Read' });
    expect(log.hookRow('session.end', undefined)).toEqual({ hook: 'session.end', party: 'main', trigger: null, model: null, tool: null });
  });
});
