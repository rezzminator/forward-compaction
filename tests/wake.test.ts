import { describe, expect, it } from 'vitest';
import {
  buildWake, fitTail, landedLine, mechanicalLine, mechanicalWake, splitAtCall, wakeBudget,
  type BuiltMessage, type WakeFacts, type WakeMessage,
} from '../plugins/forward-compaction/src/wake.ts';

type Msg = WakeMessage & { handle: string };
const user = (text: string, handle = `h-${text.slice(0, 12)}`): Msg => ({ role: 'user', text, toolUses: [], handle });
const assistant = (text: string, uses: { id: string; tool: string; input?: Record<string, unknown> }[] = [], handle = `h-${text.slice(0, 12)}`): Msg => ({
  role: 'assistant', text, handle,
  toolUses: uses.map((u) => ({ tool_use_id: u.id, tool: u.tool, input: u.input ?? {} })),
});
const results = (...answers: [string, string][]): Msg => ({ role: 'user', text: '', toolUses: [], toolResults: answers.map(([id, text]) => ({ tool_use_id: id, text })), handle: `h-res-${answers[0]![0]}` });

const noFacts: WakeFacts = { person: [], notices: [], received: [], skills: [], unattributedSkills: [] };
const T0 = Date.UTC(2026, 9, 23, 10, 0, 0);
const base = { tokens: 41_200, askPoint: 67_000, now: T0 + 60_000 };
const facts = (f: Partial<WakeFacts> = {}) => () => ({ ...noFacts, ...f });
const mainInput = (messages: Msg[], f: Partial<WakeFacts> = {}) => ({ ...base, messages, party: 'main' as const, facts: facts(f) });

describe('splitAtCall (R18)', () => {
  const u0 = user('start');
  const a1 = assistant('calling', [{ id: 't9', tool: 'mcp__forward-compaction__forward_compaction' }, { id: 't10', tool: 'Read', input: { file_path: '/a' } }]);
  const u2 = results(['t9', 'Handoff stored'], ['t10', 'file body']);
  const a3 = assistant('after');
  const u4 = user('next');

  it('returns the messages after the results, as the same objects, and the sibling calls with their results', () => {
    const split = splitAtCall([u0, a1, u2, a3, u4], 't9')!;
    expect(split.tail).toEqual([a3, u4]);
    expect(split.tail[0]).toBe(a3);
    expect(split.siblings).toEqual([{ tool: 'Read', input: { file_path: '/a' }, text: 'file body' }]);
  });

  it('returns undefined when the call is not in the transcript', () => {
    expect(splitAtCall([u0, a1, u2], 'nope')).toBeUndefined();
  });

  it('takes the run of assistant messages around the anchor as one response, and finds the last anchor', () => {
    const half = assistant('thinking', [{ id: 't8', tool: 'Grep' }]);
    const split = splitAtCall([u0, half, a1, results(['t8', 'g'], ['t9', 'ok'], ['t10', 'r']), a3], 't9')!;
    expect(split.tail).toEqual([a3]);
    expect(split.siblings.map((s) => [s.tool, s.text])).toEqual([['Grep', 'g'], ['Read', 'r']]);
  });

  it('stops at a user message whose results answer other calls, leaving it in the tail', () => {
    const stray = results(['t0', 'old']);
    expect(splitAtCall([u0, a1, u2, stray, a3], 't9')!.tail).toEqual([stray, a3]);
  });

  it('says so for a sibling whose result was never recorded', () => {
    const split = splitAtCall([a1, results(['t9', 'ok'])], 't9')!;
    expect(split.siblings[0]!.text).toBe('(no result recorded)');
  });
});

describe('fitTail (R19)', () => {
  const orphan = results(['x', 'r'.repeat(700)]);
  const a = assistant('a'.repeat(350));
  const u = user('u'.repeat(350));
  const a2 = assistant('b'.repeat(350));

  it('drops from the oldest until the rest fits, then the leading tool-result user message too', () => {
    // orphan 200 tokens, a/u/a2 100 each: budget 300 keeps the last three
    expect(fitTail([orphan, a, u, a2], 300)).toEqual({ messages: [a, u, a2], dropped: 1 });
    // budget 250 drops `a` too
    expect(fitTail([orphan, a, u, a2], 250)).toEqual({ messages: [u, a2], dropped: 2 });
  });

  it('never starts with a tool-result user message, even when the budget would keep it', () => {
    const kept = fitTail([assistant('x', [{ id: 'x', tool: 'Read' }]), orphan, a], 100_000);
    expect(kept.messages[0]!.toolResults).toBeUndefined();
    const dropOrphan = fitTail([a, orphan, u], 100_000 /* all fit */);
    expect(dropOrphan.messages).toEqual([a, orphan, u]);
    expect(fitTail([orphan, orphan, a], 100_000).messages).toEqual([a]);
  });

  it('keeps the input objects, and nothing for a zero budget', () => {
    const kept = fitTail([a, u], 1000).messages;
    expect(kept[0]).toBe(a);
    expect(fitTail([a, u], 0)).toEqual({ messages: [], dropped: 2 });
  });
});

describe('buildWake (R20)', () => {
  const call = assistant('writing the handoff', [{ id: 't9', tool: 'mcp__forward-compaction__forward_compaction' }]);
  const res = results(['t9', 'Handoff stored']);
  const handoff = '## Objective\nship\n## Done\nx\n## Remaining\ny\n## Next\nz';

  it('returns [F, H, ...tail]: H is the last built message, carries the handoff verbatim, the tail is the input objects', () => {
    const t1 = assistant('step one', [], 'engine-1');
    const t2 = user('thanks', 'engine-2');
    const wake = buildWake({ ...mainInput([user('hello'), call, res, t1, t2]), toolUseId: 't9', handoff });
    const [f, h, ...tail] = wake.messages as [BuiltMessage, BuiltMessage, ...Msg[]];
    expect(f.text.startsWith('[forward-compaction: facts]')).toBe(true);
    expect(h.text).toContain(`=== handoff ===\n${handoff}\n=== end of handoff ===`);
    expect(h.text).toContain('at 41k tokens');
    expect(h.text).toContain('The 2 messages after this one are what happened after you wrote it, kept verbatim.');
    expect(h.text).not.toContain('did not fit');
    expect((f as { handle?: string }).handle).toBeUndefined();
    expect((h as { handle?: string }).handle).toBeUndefined();
    expect(tail[0]).toBe(t1);
    expect(tail[1]).toBe(t2);
    expect(tail.map((m) => m.handle)).toEqual(['engine-1', 'engine-2']);
    expect(wake).toMatchObject({ kept: 2, dropped: 0 });
  });

  it('says nothing happened when the call was the last thing', () => {
    const h = buildWake({ ...mainInput([call, res]), toolUseId: 't9', handoff }).messages[1] as BuiltMessage;
    expect(h.text).toContain('Nothing happened after you wrote it. Continue from ## Next.');
    expect(h.text).not.toContain('messages after this one');
  });

  it('throws when the call is not in the transcript, naming it', () => {
    expect(() => buildWake({ ...mainInput([user('a')]), toolUseId: 't9', handoff })).toThrow('t9');
  });

  it('drops the oldest tail messages that do not fit, states how many in H, and keeps the whole output within the budget', () => {
    const filler = Array.from({ length: 10 }, (_, i) => assistant(`${i}`.repeat(1000), [], `e${i}`));
    const input = { ...mainInput([call, res, ...filler]), askPoint: 4000, toolUseId: 't9', handoff };
    const wake = buildWake(input);
    expect(wake.kept).toBeGreaterThan(0);
    expect(wake.kept).toBeLessThan(10);
    expect(wake.dropped).toBe(10 - wake.kept);
    const h = wake.messages[1] as BuiltMessage;
    expect(h.text).toContain(`${wake.dropped} older messages after your handoff did not fit and are gone (look_back finds an exact detail)`);
    expect(wake.messages.slice(2)).toEqual(filler.slice(wake.dropped));
    const chars = wake.messages.reduce((n, m) => n + m.text.length, 0);
    expect(Math.ceil(chars / 3.5)).toBeLessThanOrEqual(wakeBudget(4000));
  });

  it('never leaves a tool result at the head of the tail', () => {
    const useA = assistant('x'.repeat(2800), [{ id: 'r1', tool: 'Read' }]);
    const answer = results(['r1', 'y'.repeat(100)]);
    const last = assistant('z'.repeat(300));
    const wake = buildWake({ ...mainInput([call, res, useA, answer, last]), askPoint: 2000, toolUseId: 't9', handoff });
    expect((wake.messages[2] as Msg | undefined)?.toolResults).toBeUndefined();
    expect(wake.messages.slice(2)).toEqual([last]);
  });

  it('sizes the facts against the kept tail: facts get the kept texts, and a smaller tail is re-asked until it is stable', () => {
    const seen: string[][] = [];
    const filler = Array.from({ length: 6 }, (_, i) => user(`m${i} ${'x'.repeat(900)}`, `e${i}`));
    // the person's words in a message already kept are left out; each dropped message puts its words back in the facts
    const input = {
      ...mainInput([call, res, ...filler]), askPoint: 3000, toolUseId: 't9', handoff,
      facts: (kept: readonly string[]): WakeFacts => {
        seen.push([...kept]);
        const person = filler.filter((m) => !kept.includes(m.text)).map((m, i) => ({ at: T0 + i, text: m.text }));
        return { ...noFacts, person };
      },
    };
    const wake = buildWake(input);
    expect(seen[0]).toEqual(filler.map((m) => m.text));
    const finalKept = wake.messages.slice(2).map((m) => m.text);
    expect(seen.at(-1)).toEqual(finalKept);
    expect(wake.kept).toBeLessThan(6);
    const chars = wake.messages.reduce((n, m) => n + m.text.length, 0);
    expect(Math.ceil(chars / 3.5)).toBeLessThanOrEqual(wakeBudget(3000));
  });

  it('counts the F sections that hold content', () => {
    const wake = buildWake({
      ...mainInput([call, res], { person: [{ at: T0, text: 'fix it' }], skills: [{ skill: 'god-speed', text: 'rules', source: 'user' }] }),
      toolUseId: 't9', handoff,
    });
    expect(wake.facts).toBe(2);
  });
});

describe('F sections', () => {
  const call = assistant('go', [{ id: 't9', tool: 'fc' }, { id: 't10', tool: 'Read', input: { file_path: '/a.ts' } }]);
  const res = results(['t9', 'stored'], ['t10', 'SIBLING-RESULT']);
  const wakeOf = (input: Partial<Parameters<typeof buildWake<Msg>>[0]> & { f?: Partial<WakeFacts> }, party: 'main' | 'subagent' = 'main') => {
    const { f, ...rest } = input;
    const wake = buildWake({ ...mainInput([call, res], f), party, toolUseId: 't9', handoff: '## Next\nx', ...rest });
    return { wake, f: (wake.messages[0] as BuiltMessage).text };
  };

  it('puts the person messages oldest first under the (n of m) heading, with ISO times', () => {
    const { f } = wakeOf({ f: { person: [{ at: T0, text: 'fix the parser' }, { at: T0 + 1000, text: 'also add tests' }] } });
    expect(f).toContain("## The person's messages, oldest first (2 of 2)");
    expect(f.indexOf('fix the parser')).toBeLessThan(f.indexOf('also add tests'));
    expect(f).toContain('### 2026-10-23T10:00:00.000Z\nfix the parser');
  });

  it('keeps the newest person messages that fit 25% of B and counts the oldest left out (R21)', () => {
    const person = Array.from({ length: 5 }, (_, i) => ({ at: T0 + i * 1000, text: `p${i} ${'w'.repeat(300)}` }));
    const { f } = wakeOf({ askPoint: 2000, f: { person } });
    expect(f).toContain("## The person's messages, oldest first (2 of 5; the 3 oldest are not carried: look_back finds them)");
    expect(f).toContain('p3 ');
    expect(f).toContain('p4 ');
    expect(f).not.toContain('p2 ');
  });

  it('states no person message with the ledger start, and without one when there is no start', () => {
    expect(wakeOf({ f: { startedAt: T0 } }).f).toContain(`## The person's messages\n(none recorded since 2026-10-23T10:00:00.000Z)`);
    expect(wakeOf({}).f).toContain("## The person's messages\n(none recorded)");
  });

  it('says every person message is in the messages below when the tail holds them all, never that none was recorded', () => {
    const f = wakeOf({ f: { startedAt: T0, personInTail: 3 } }).f;
    expect(f).toContain("## The person's messages\n(all 3 are in the messages below)");
    expect(f).not.toContain('none recorded');
  });

  it('adds the resume line only on resume', () => {
    expect(wakeOf({ f: { startedAt: T0, startReason: 'resume' } }).f).toContain('The ledger started at 2026-10-23T10:00:00.000Z when this process resumed; anything earlier is not recorded.');
    expect(wakeOf({ f: { startedAt: T0, startReason: 'startup' } }).f).not.toContain('resumed');
  });

  it('carries a sub-agent brief verbatim, and no person section', () => {
    const { f } = wakeOf({ f: { brief: { text: 'Review the diff.' }, person: [{ at: T0, text: 'hi' }] } }, 'subagent');
    expect(f).toContain('## Your brief\nReview the diff.');
    expect(f).not.toContain("person's messages");
  });

  it('names a brief that is over its room, and one that was never recorded', () => {
    const { f } = wakeOf({ askPoint: 2000, f: { brief: { text: 'b'.repeat(2000) } } }, 'subagent');
    expect(f).toContain('## Your brief\n(not carried: 2,000 characters, over the 875-character room; look_back finds it)');
    expect(f).not.toContain('bbbbbbbbbb');
    expect(wakeOf({}, 'subagent').f).toContain('(not recorded: this agent was spawned before forward-compaction started in this process)');
  });

  it("gives a sub-agent its coordinator's messages and main its notifications, newest first within 5% of B", () => {
    const entries = Array.from({ length: 4 }, (_, i) => ({ at: T0 + i * 1000, origin: 'coordinator', text: `c${i} ${'k'.repeat(100)}` }));
    const sub = wakeOf({ askPoint: 2000, f: { received: entries } }, 'subagent').f;
    expect(sub).toContain('## Messages from your coordinator\n(3 older not carried)\n### 2026-10-23T10:00:03.000Z (coordinator)\nc3 ');
    const main = wakeOf({ f: { notices: [{ at: T0, origin: 'task-notification', text: '<task-notification>done</task-notification>' }] } }).f;
    expect(main).toContain('## Notifications delivered to you\n### 2026-10-23T10:00:00.000Z (task-notification)\n<task-notification>done</task-notification>');
  });

  it('carries the sibling calls with their input and result, or says a result is not carried', () => {
    expect(wakeOf({}).f).toContain('## Results of the calls you made beside the handoff\n### Read {"file_path":"/a.ts"}\nSIBLING-RESULT');
    const big = results(['t9', 'stored'], ['t10', 's'.repeat(5000)]);
    const wake = buildWake({ ...mainInput([call, big]), askPoint: 2000, toolUseId: 't9', handoff: '## Next\nx' });
    expect((wake.messages[0] as BuiltMessage).text).toContain('- Read: result not carried (5,000 characters)');
  });

  it('carries skills newest first, names the ones over the room and the unattributed ones', () => {
    const f = wakeOf({
      askPoint: 2000,
      f: {
        skills: [
          { skill: 'small', text: 'tiny', source: 'user', path: '/s/SKILL.md' },
          { skill: 'huge', text: 'h'.repeat(4000), source: 'plugin' },
        ],
        unattributedSkills: [{ skill: 'mystery' }],
      },
    }).f;
    expect(f).toContain('## Skills in force, as loaded\n### small (user, /s/SKILL.md)\ntiny');
    expect(f).toContain('## Skills not carried\n- huge: over the skill room (4,000 characters); call Skill huge to load it again.');
    expect(f).toContain('- mystery: loaded in this session by an unidentified party; call Skill mystery if it applies to you.');
    expect(f).not.toContain('hhhhhhhhhh');
  });

  it('lists agents (at most 50) or says why it could not', () => {
    const rows = Array.from({ length: 52 }, (_, i) => ({ id: `a${i}`, type: 'general-purpose', status: 'completed', description: `job ${i}` }));
    const f = wakeOf({ agents: rows }).f;
    expect(f).toContain('## Agents, listed at install\n- a0 general-purpose completed: job 0');
    expect(f).toContain('- a49 general-purpose completed: job 49');
    expect(f).not.toContain('a50 ');
    expect(f).toContain('(2 more not listed)');
    expect(wakeOf({ agents: { error: 'timed out' } }).f).toContain('## Agents\n(could not be listed: timed out)');
    expect(wakeOf({ agents: [] }).f).not.toContain('## Agents');
  });

  it('states the unknown shells when no Stop event came (R24)', () => {
    expect(wakeOf({}).f).toContain('(unknown: no Stop event yet in this process)');
  });

  it('lists shells and crons with the age of the snapshot', () => {
    const f = wakeOf({
      f: {
        shells: {
          at: T0,
          tasks: [{ id: 'b1', status: 'running', description: 'dev server', command: 'npm run dev' }, { id: 'b2', status: 'running', description: 'watcher' }],
          crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check ci' }],
        },
      },
    }).f;
    expect(f).toContain('## Background shells and crons (session-wide, from the Stop event 1m before install)');
    expect(f).toContain('- shell b1 running: npm run dev');
    expect(f).toContain('- shell b2 running: watcher');
    expect(f).toContain('- cron c1 */5 * * * * recurring: check ci');
    expect(f).not.toContain('unknown');
  });

  it('says a snapshot with nothing running as that, not as unknown', () => {
    const f = wakeOf({ f: { shells: { at: T0, tasks: [], crons: [] } } }).f;
    expect(f).toContain('(none running)');
    expect(f).not.toContain('unknown');
  });

  it('carries load files with their range and why, and names those not carried (R22)', () => {
    const { f } = wakeOf({
      files: [
        { path: '/abs/a.ts', lines: '1-3', why: 'the bug', content: 'line1\nline2\nline3' },
        { path: '/abs/f.ts', why: 'whole', content: 'x'.repeat(50_000) },
        { path: '/abs/gone.ts', why: 'gone', problem: 'lines 10-40 out of range (5 lines)' },
        { path: '/abs/err.ts', why: 'err', problem: 'EACCES: permission denied' },
      ],
    });
    expect(f).toContain('## Files you asked to carry\n### /abs/a.ts lines 1-3 — the bug\nline1\nline2\nline3');
    expect(f).toContain('## Files not carried\n- /abs/f.ts: 50,000 characters, over the room left');
    expect(f).toContain('- /abs/gone.ts: lines 10-40 out of range (5 lines)');
    expect(f).toContain('- /abs/err.ts: EACCES: permission denied');
    expect(f).not.toContain('xxxxxxxxxx');
  });

  it('stops carrying files when the section room is spent, and a file past 40,000 characters is never carried', () => {
    const files = [
      { path: '/abs/1.ts', why: 'a', content: 'a'.repeat(9000) },
      { path: '/abs/2.ts', why: 'b', content: 'b'.repeat(9000) },
      { path: '/abs/3.ts', why: 'c', content: 'c'.repeat(100) },
    ];
    const { f } = wakeOf({ files });
    expect(f).toContain('### /abs/1.ts');
    expect(f).toContain('- /abs/2.ts: 9,000 characters, over the room left');
    expect(f).toContain('### /abs/3.ts');
  });
});

describe('mechanicalWake (R23)', () => {
  const msgs = Array.from({ length: 6 }, (_, i) => user(`m${i} ${'x'.repeat(900)}`, `e${i}`));

  it('opens H with the no-frontier line, states the ceiling and how many older messages are gone', () => {
    const wake = mechanicalWake({ ...mainInput(msgs), askPoint: 3000, tokens: 120_000, reason: { kind: 'ceiling', ceiling: 100_000 } });
    const h = wake.messages[1] as BuiltMessage;
    expect(h.text.startsWith('[forward-compaction: no frontier written by the model]')).toBe(true);
    expect(h.text).toContain('Your context reached 120k tokens, past the 100k ceiling,');
    expect(h.text).toContain(`${wake.dropped} older messages are gone (look_back finds an exact detail)`);
    expect(h.text).toContain(`your newest ${wake.kept} messages below`);
    expect(h.text).toContain("Re-establish them from the person's messages");
    expect(wake.dropped).toBeGreaterThan(0);
    expect(wake.messages.slice(2)).toEqual(msgs.slice(wake.dropped));
    expect(wake.messages[2]).toBe(msgs[wake.dropped]);
  });

  it('words the reactive case and names the brief for a sub-agent', () => {
    const h = mechanicalWake({ ...mainInput(msgs), party: 'subagent', reason: { kind: 'reactive' } }).messages[1] as BuiltMessage;
    expect(h.text).toContain('Your context reached 41k tokens, and Claude Code reported your request too long, and you had not called');
    expect(h.text).toContain('Re-establish them from your brief');
    expect(h.text).toContain('0 older messages are gone');
  });

  it('has the same facts as the handoff wake, and no load files or siblings', () => {
    const wake = mechanicalWake({ ...mainInput(msgs, { person: [{ at: T0, text: 'fix it' }] }), reason: { kind: 'reactive' } });
    const f = (wake.messages[0] as BuiltMessage).text;
    expect(f).toContain('fix it');
    expect(f).not.toContain('beside the handoff');
    expect(wake.facts).toBe(1);
  });

  it('begins the tail on a plain message, never a tool result', () => {
    const wake = mechanicalWake({ ...mainInput([user('a'), assistant('b', [{ id: 'q', tool: 'Read' }]), results(['q', 'r'])]), askPoint: 100, reason: { kind: 'reactive' } });
    expect((wake.messages[2] as Msg | undefined)?.toolResults).toBeUndefined();
  });
});

describe('screen lines', () => {
  it('says what landed', () => {
    expect(landedLine({ label: 'main', before: 164_000, after: 46_000, chars: 4812, facts: 3, kept: 5, dropped: 0 }))
      .toBe('forward-compaction: main handoff landed — 164k → 46k tokens; frontier 4,812 characters, 3 facts, 5 messages kept verbatim.');
    expect(landedLine({ label: 'general-purpose a1b2c3', before: 90_000, after: 30_000, chars: 100, facts: 1, kept: 2, dropped: 4 }))
      .toContain('2 messages kept verbatim, 4 dropped.');
  });

  it('says what a mechanical wake did', () => {
    expect(mechanicalLine({ label: 'main', tokens: 100_000, ceiling: 100_000, before: 100_000, after: 40_000 }))
      .toBe('forward-compaction: main had no handoff at 100k (ceiling 100k) — mechanical wake installed, 100k → 40k.');
  });

  it('sets the budget at half the ask point', () => {
    expect(wakeBudget(67_000)).toBe(33_500);
  });
});
