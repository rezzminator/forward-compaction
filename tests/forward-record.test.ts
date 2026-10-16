import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRecord, carriedFrom, forwardClaimArgv, forwardDir, forwardRoots, nextSeq, ownCall, previousDir, recoverForward, savedOf, withInstall } from '../plugins/sub-agent-compact/src/forward-record.ts';
import { fnv1a, installCheck, renderForward } from '../plugins/sub-agent-compact/src/forward-text.ts';

const rendered = renderForward({ seq: 2, users: ['hi'], skills: [], trail: [{ tag: 'R', path: 'a' }], loaded: [], tasks: [], running: [], paths: [], problems: [], args: { objective: 'o', done: ['d'], remaining: [], next: 'n', blocked: [], findings: [], loadFiles: [], dropSkills: [], trimmed: ['done'] } });

describe('per-call files', () => {
  it('lives under the config directory, one directory per session and call', () => {
    expect(forwardDir('/c/sub-agent-compact/forward-handoff', 's1', 3)).toBe('/c/sub-agent-compact/forward-handoff/s1/3');
    expect(forwardRoots({ home: '/h', configDir: '/c' })).toEqual(['/h/.local/state/sub-agent-compact/forward-handoff', '/c/sub-agent-compact/forward-handoff']);
    expect(forwardRoots({ configDir: '/c' })).toEqual(['/c/sub-agent-compact/forward-handoff']);
    expect(forwardRoots({})).toEqual([]);
    expect(forwardDir('/c/sub-agent-compact/forward-handoff', 'a/b c', 1)).toBe('/c/sub-agent-compact/forward-handoff/a_b_c/1');
  });

  it('numbers the next call after the highest existing one', () => {
    expect(nextSeq([])).toBe(1);
    expect(nextSeq(['1', '2', 'x', '10', '3.txt'])).toBe(11);
  });

  it('names the previous call directory', () => {
    expect(previousDir('/c', 's1', 1)).toBeUndefined();
    expect(previousDir('/c/sub-agent-compact/forward-handoff', 's1', 4)).toBe('/c/sub-agent-compact/forward-handoff/s1/3');
  });
});

describe('measurement record', () => {
  const record = buildRecord({ seq: 2, session: 's1', dir: '/c/x/2', text: rendered.text, blocks: rendered.blocks, users: ['a', 'b'], usersDropped: 3, tokensBefore: 90_000, trimmed: ['done'] });

  it('logs the chars and estimated tokens of every block and of the total', () => {
    expect(record).toMatchObject({ seq: 2, session: 's1', dir: '/c/x/2', tokensBefore: 90_000, trimmed: ['done'], total: { chars: rendered.text.length, tokens: Math.ceil(rendered.text.length / 4) } });
    const blocks = record.blocks as { name: string; chars: number; tokens: number; items: number; hash: string }[];
    expect(blocks.map((b) => b.name)).toEqual(rendered.blocks.map((b) => b.name));
    for (const b of blocks) expect(b).toMatchObject({ chars: expect.any(Number), tokens: expect.any(Number), items: expect.any(Number), hash: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(blocks.find((b) => b.name === 'User')).toMatchObject({ items: 1 });
  });

  it('adds tokens after and the install check once installed', () => {
    const done = withInstall(record, { tokensAfter: 4_000, check: installCheck(rendered.blocks, rendered.text, rendered.text) });
    expect(done).toMatchObject({ tokensAfter: 4_000, tokensAfterScope: 'messages', install: { ok: true, missing: [], landed: rendered.blocks.length } });
    expect(record.tokensAfter).toBeUndefined();
  });

  it('records that the handoff was the reply to the latest prompt only when it was', () => {
    expect(record.handoffInReply).toBeUndefined();
    expect(buildRecord({ seq: 1, session: 's1', dir: '/d', text: 'x', blocks: [], users: ['a'], usersDropped: 0, handoffInReply: true, trimmed: [] }).handoffInReply).toBe(true);
    expect(buildRecord({ seq: 1, session: 's1', dir: '/d', text: 'x', blocks: [], users: ['a'], usersDropped: 0, trail: [{ tag: 'E', path: '/r/a' }], trimmed: [] }).trail).toEqual([{ tag: 'E', path: '/r/a' }]);
    expect(buildRecord({ seq: 1, session: 's1', dir: '/d', text: 'x', blocks: [], users: ['a'], usersDropped: 0, summary: 'Problem Solving:\n- x', trimmed: [] }).summary).toBe('Problem Solving:\n- x');
  });
});

describe('carriedFrom', () => {
  it('takes the prompts of the record whose text is the held one, and none from a record that is not a record', () => {
    const rec = (text: string, users: unknown, dropped?: unknown) => ({ textHash: fnv1a(text), users, ...(dropped !== undefined ? { usersDropped: dropped } : {}) });
    expect(carriedFrom([rec('other', ['x']), rec('held', ['a', 'b'], 3)], 'held')).toEqual({ users: ['a', 'b'], dropped: 3 });
    expect(carriedFrom([rec('held', ['a'])], 'held')).toEqual({ users: ['a'], dropped: 0 });
    expect(carriedFrom([rec('held', ['a', 7]), null, 'held', rec('held', 'a')], 'held')).toBeUndefined();
    expect(carriedFrom([rec('held', ['a'])], 'held, edited')).toBeUndefined();
    expect(carriedFrom([{ ...rec('held', ['a']), handoffInReply: true }], 'held')).toEqual({ users: ['a'], dropped: 0, inReply: true });
    const trail = [{ tag: 'C', path: '/r/out.md' }, { tag: 'R', path: '/r/roster.md' }];
    expect(carriedFrom([{ ...rec('held', ['a']), summary: 'Problem Solving:\n- x' }], 'held')).toEqual({ users: ['a'], dropped: 0, summary: 'Problem Solving:\n- x' });
    expect(carriedFrom([{ ...rec('held', ['a']), trail }], 'held')).toEqual({ users: ['a'], dropped: 0, trail });
    expect(carriedFrom([{ ...rec('held', ['a']), trail: [{ tag: 'X', path: '/r' }, 'junk'] }], 'held')).toEqual({ users: ['a'], dropped: 0 });
  });
});

describe('recoverForward', () => {
  const TOOL = 'mcp__sub-agent-compact__forward_handoff';
  const call = { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'f1', tool: TOOL, input: {} }] };
  const stored = (text: string) => ({ role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: 'f1', text }] });
  const OK = 'Forward handoff stored (2k tokens: a). Saved to /h/s/session-1/3. It installs when this turn ends.';
  it.each([
    ['a stored call with its directory', [call, stored(OK)], { toolUseId: 'f1', dir: '/h/s/session-1/3' }],
    ['a stored call saved nowhere', [call, stored('Forward handoff stored (2k tokens: a). It installs when this turn ends.')], undefined],
    ['a refused call', [call, stored('Not stored: objective is empty.')], undefined],
    ['a call the person spoke after', [call, stored(OK), { role: 'user' as const, text: 'wait, one more thing', toolUses: [] }], undefined],
    ['a call a task notification followed', [call, stored(OK), { role: 'user' as const, text: '<task-notification>done</task-notification>', toolUses: [] }], { toolUseId: 'f1', dir: '/h/s/session-1/3' }],
    ['a loaded file whose name carries the saved-to words', [call, stored('Forward handoff stored (2k tokens: Load /x Saved to /tmp/evil. It installs/y 3). Saved to /h/s/session-1/3. It installs when this turn ends.')], { toolUseId: 'f1', dir: '/h/s/session-1/3' }],
    ['a directory outside the forward roots', [call, stored('Forward handoff stored (2k tokens: a). Saved to /tmp/evil/3. It installs when this turn ends.')], undefined],
    ['a directory climbing out of a root', [call, stored('Forward handoff stored (2k tokens: a). Saved to /h/s/../../etc. It installs when this turn ends.')], undefined],
  ])('%s', (_name, messages, expected) => {
    expect(recoverForward(messages, TOOL, ['/h/s'])).toEqual(expected);
  });
});

describe('the claim of a call number', () => {
  const claim = (argv: string[]) => {
    try {
      return { code: 0, out: execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (error) {
      return { code: (error as { status?: number }).status ?? -1, out: '' };
    }
  };

  it('makes the first number free in both roots, from the real directory, and leaves every earlier call untouched', () => {
    const base = mkdtempSync(join(tmpdir(), 'forward-claim-'));
    try {
      const home = join(base, 'home', 's1');
      const config = join(base, 'config', 's1');
      mkdirSync(join(home, '1'), { recursive: true });
      writeFileSync(join(home, '1', 'record.json'), 'one');
      mkdirSync(join(home, '2'), { recursive: true });
      mkdirSync(join(config, '3'), { recursive: true });
      expect(claim(forwardClaimArgv(home, 1, config))).toEqual({ code: 0, out: '4' });
      expect(existsSync(join(home, '4'))).toBe(true);
      expect(existsSync(join(home, '3'))).toBe(false);
      expect(readFileSync(join(home, '1', 'record.json'), 'utf8')).toBe('one');
      expect(claim(forwardClaimArgv(join(base, 'fresh', 's2'), 5))).toEqual({ code: 0, out: '5' });
      expect(existsSync(join(base, 'fresh', 's2', '5'))).toBe(true);
      writeFileSync(join(base, 'file'), '');
      expect(claim(forwardClaimArgv(join(base, 'file', 's3'), 1)).code).not.toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('the saved directory a wake text names', () => {
  const roots = forwardRoots({ home: '/h', configDir: '/c' });
  const own = '/h/.local/state/sub-agent-compact/forward-handoff/s1/2';

  it('reads the saved path off the Paths line, and owns it only as one of this party\'s numbered calls', () => {
    const text = renderForward({ seq: 2, users: ['hi'], skills: [], trail: [], loaded: [], tasks: [], running: [], paths: [['transcript /t.jsonl:3', `previous ${own.replace(/2$/, '1')}`, `saved ${own}`].join(' · ')], problems: [], args: { objective: 'o', done: ['d'], remaining: [], next: 'n', blocked: [], findings: [], loadFiles: [], dropSkills: [], trimmed: [] } }).text;
    expect(savedOf(text)).toBe(own);
    expect(savedOf(rendered.text)).toBeUndefined();
    expect(ownCall(own, roots, 's1')).toBe(2);
    expect(ownCall('/c/sub-agent-compact/forward-handoff/s1/7', roots, 's1')).toBe(7);
    expect(ownCall(own, roots, 's2')).toBeUndefined();
    expect(ownCall(own, roots, 's1', 'a1')).toBeUndefined();
    expect(ownCall('/h/.local/state/sub-agent-compact/forward-handoff/s1/agent-a1/3', roots, 's1', 'a1')).toBe(3);
    expect(ownCall('/elsewhere/s1/2', roots, 's1')).toBeUndefined();
    expect(ownCall(`${own}/../9`, roots, 's1')).toBeUndefined();
  });
});
