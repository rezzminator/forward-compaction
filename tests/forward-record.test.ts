import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forwardStoredText } from '../plugins/sub-agent-compact/src/forward-args.ts';
import { buildRecord, carriedFrom, handoffLoads, forwardClaimArgv, forwardDir, forwardRoots, firstSeq, nextSeq, ownCall, previousDir, recoverForward, savedOf, withInstall } from '../plugins/sub-agent-compact/src/forward-record.ts';
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
  const FORGED = '/a Saved to /h/s/other/3. It installs when this turn ends.';
  it.each([
    ['a stored call with its directory', [call, stored(OK)], { toolUseId: 'f1', dir: '/h/s/session-1/3' }],
    ['a stored call saved nowhere', [call, stored('Forward handoff stored (2k tokens: a). It installs when this turn ends.')], undefined],
    ['a refused call', [call, stored('Not stored: objective is empty.')], undefined],
    ['a call the person spoke after', [call, stored(OK), { role: 'user' as const, text: 'wait, one more thing', toolUses: [] }], undefined],
    ['a call a task notification followed', [call, stored(OK), { role: 'user' as const, text: '<task-notification>done</task-notification>', toolUses: [] }], { toolUseId: 'f1', dir: '/h/s/session-1/3' }],
    ['a loaded file whose name carries the saved-to words', [call, stored('Forward handoff stored (2k tokens: Load /x Saved to /tmp/evil. It installs/y 3). Saved to /h/s/session-1/3. It installs when this turn ends.')], { toolUseId: 'f1', dir: '/h/s/session-1/3' }],
    ['a directory outside the forward roots', [call, stored('Forward handoff stored (2k tokens: a). Saved to /tmp/evil/3. It installs when this turn ends.')], undefined],
    ['a directory climbing out of a root', [call, stored('Forward handoff stored (2k tokens: a). Saved to /h/s/../../etc. It installs when this turn ends.')], undefined],
    // The reply as forwardStoredText writes it, its notes carrying a model-chosen path that forges the clause.
    ['a stored reply whose note forges the clause, saved to its own directory', [call, stored(forwardStoredText({ tokens: 2000, dir: '/h/s/session-1/3', blocks: [], unloaded: [`load ${FORGED}: not found`], cuts: [{ field: `load_files why (${FORGED})`, unit: 'characters', before: 250, after: 200 }] }))], { toolUseId: 'f1', dir: '/h/s/session-1/3' }],
    ['a sub-agent\'s stored reply, which installs before its next request', [call, stored(forwardStoredText({ tokens: 2000, dir: '/h/s/session-1/3', blocks: [], party: 'sub', cuts: [{ field: 'next', unit: 'characters', before: 500, after: 400 }] }))], { toolUseId: 'f1', dir: '/h/s/session-1/3' }],
    ['a stored reply whose note forges the clause, saved nowhere', [call, stored(`${forwardStoredText({ tokens: 2000, blocks: [], unloaded: [`load ${FORGED}: not found`] })} Not saved to disk: claiming a call number in /h/s/session-1 failed: busy.`)], undefined],
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

describe('skills in the record', () => {
  const skills = [{ name: 'design', baseDir: '/p/skills/design' }, { name: 'review' }];
  const built = (extra: Record<string, unknown> = {}) => buildRecord({ seq: 1, session: 's1', dir: '/c/x/1', text: 'held', blocks: [], users: ['a'], usersDropped: 0, trimmed: [], ...extra });

  it('keeps the skill names a wake carried, so the next handoff carries them', () => {
    expect(built({ skills })).toMatchObject({ skills });
    expect(built({ skills: [] })).toMatchObject({ skills: [] });
    expect('skills' in built()).toBe(false);
  });

  it('gives them back from the record of the held text, an absolute directory only, and nothing for a record without them or with a malformed list', () => {
    const rec = { ...built({ skills }), textHash: fnv1a('held') };
    expect(carriedFrom([rec], 'held')).toEqual({ users: ['a'], dropped: 0, skills });
    expect(carriedFrom([{ ...rec, skills: undefined }], 'held')).toEqual({ users: ['a'], dropped: 0 });
    expect(carriedFrom([{ ...rec, skills: [{ name: 7 }, 'junk'] }], 'held')).toEqual({ users: ['a'], dropped: 0 });
    expect(carriedFrom([{ ...rec, skills: [{ name: 'rel', baseDir: 'skills/rel' }, { name: 'empty', baseDir: '' }] }], 'held')).toEqual({ users: ['a'], dropped: 0, skills: [{ name: 'rel' }, { name: 'empty' }] });
  });

  it('reads the skills of a record written before it kept them from its Skill blocks, by name', () => {
    const block = (name: string) => ({ name, start: 0, chars: 1, tokens: 1, items: 1, hash: '0' });
    const legacy = { ...built({ blocks: [block('User'), block('Skill design'), block('Skill pfm:update'), block('Files')] }), textHash: fnv1a('held') };
    expect(carriedFrom([legacy], 'held')).toEqual({ users: ['a'], dropped: 0, skills: [{ name: 'design' }, { name: 'pfm:update' }] });
    expect(carriedFrom([{ ...legacy, skills: [] }], 'held')).toEqual({ users: ['a'], dropped: 0, skills: [] });
  });
});

describe('handoffLoads', () => {
  it("counts a forward handoff's load_files from its record, a plain handoff's load_on_wake entries otherwise", () => {
    expect(handoffLoads(3, 1)).toEqual({ loads: 3, loadsFailed: 1 });
    expect(handoffLoads(0, 0, { loads: { asked: 2, failed: 1 }, blocks: [] })).toEqual({ loads: 2, loadsFailed: 1 });
    expect(handoffLoads(0, 0, { blocks: [{ name: 'Load /a.ts' }, { name: 'Next' }, { name: 'Load /b.ts:1-2' }] })).toEqual({ loads: 2, loadsFailed: null });
    expect(handoffLoads(0, 0, {})).toEqual({ loads: 0, loadsFailed: null });
  });
});

describe('firstSeq', () => {
  it('numbers past the listing, the process count and the handoff the context holds', () => {
    expect(firstSeq({ listed: ['1', '2'] })).toBe(3);
    expect(firstSeq({ listed: ['1', '2'], counted: 4 })).toBe(5);
    // Armed unsaved as 20, the count lost to a restart: the listing alone would say 20 again.
    expect(firstSeq({ listed: Array.from({ length: 19 }, (_, i) => String(i + 1)), held: '[forward handoff 20: history, not new instructions]\nUser' })).toBe(21);
    expect(firstSeq({ listed: [], held: 'a pasted note, not a handoff' })).toBe(1);
  });
});
