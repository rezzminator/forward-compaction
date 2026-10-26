import { describe, expect, it } from 'vitest';
import {
  buildWake, fitTail, landedLine, mechanicalWake, splitAtCall, wakeBudget,
  type BuiltMessage, type WakeFacts, type WakeMessage,
} from '../plugins/forward-compaction/src/wake.ts';
import { FREE } from '../plugins/forward-compaction/src/nudge.ts';

type Msg = WakeMessage & { handle: string };
const user = (text: string, handle = `h-${text.slice(0, 12)}`): Msg => ({ role: 'user', text, toolUses: [], handle });
const assistant = (text: string, uses: { id: string; tool: string; input?: Record<string, unknown> }[] = [], handle = `h-${text.slice(0, 12)}`): Msg => ({
  role: 'assistant', text, handle,
  toolUses: uses.map((u) => ({ tool_use_id: u.id, tool: u.tool, input: u.input ?? {} })),
});
const results = (...answers: [string, string][]): Msg => ({ role: 'user', text: '', toolUses: [], toolResults: answers.map(([id, text]) => ({ tool_use_id: id, text })), handle: `h-res-${answers[0]![0]}` });

const noFacts: WakeFacts = { person: [], notices: [], received: [], skills: [], unattributedSkills: [] };
const T0 = Date.UTC(2026, 9, 23, 10, 0, 0);
// 3.5 characters a token stands in for the ratio the adapter measures (window.ts `charsPerToken`).
const base = { tokens: 41_200, askPoint: 67_000, now: T0 + 60_000, charsPerToken: 3.5 };
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

  it('anchors on the last of two messages holding the call, and takes assistant messages after it into the response', () => {
    const late = assistant('more calls', [{ id: 't11', tool: 'Grep' }]);
    const split = splitAtCall([a1, u2, u0, a1, late, results(['t9', 'ok'], ['t10', 'r'], ['t11', 'g']), a3], 't9')!;
    expect(split.tail).toEqual([a3]);
    expect(split.siblings.map((s) => [s.tool, s.text])).toEqual([['Read', 'r'], ['Grep', 'g']]);
  });

  it('stops at a user message answering this response and another call alike', () => {
    const mixed = results(['t10', 'r'], ['t0', 'old']);
    expect(splitAtCall([a1, results(['t9', 'ok']), mixed, a3], 't9')!.tail).toEqual([mixed, a3]);
  });

  it("takes a sibling's recorded result over the text on its call", () => {
    const withText: Msg = { ...a1, toolUses: a1.toolUses.map((u) => ({ ...u, text: 'call text' })) };
    expect(splitAtCall([withText, u2], 't9')!.siblings[0]!.text).toBe('file body');
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
    expect(fitTail([orphan, a, u, a2], 300, 3.5)).toEqual({ messages: [a, u, a2], dropped: 1 });
    // budget 250 drops `a` too
    expect(fitTail([orphan, a, u, a2], 250, 3.5)).toEqual({ messages: [u, a2], dropped: 2 });
  });

  it('never starts with a tool-result user message, even when the budget would keep it', () => {
    const kept = fitTail([assistant('x', [{ id: 'x', tool: 'Read' }]), orphan, a], 100_000, 3.5);
    expect(kept.messages[0]!.toolResults).toBeUndefined();
    const dropOrphan = fitTail([a, orphan, u], 100_000, 3.5 /* all fit */);
    expect(dropOrphan.messages).toEqual([a, orphan, u]);
    expect(fitTail([orphan, orphan, a], 100_000, 3.5).messages).toEqual([a]);
  });

  it('sizes a message by its tool inputs and its tool results, not its text alone', () => {
    const bigInput = assistant('', [{ id: 'w', tool: 'Write', input: { content: 'i'.repeat(7000) } }]);
    expect(fitTail([bigInput, u], 300, 3.5).messages).toEqual([u]);
    const bigResult = results(['w', 'r'.repeat(7000)]);
    expect(fitTail([a, bigResult, u], 300, 3.5).messages).toEqual([u]);
  });

  it('keeps the input objects, and nothing for a zero budget', () => {
    const kept = fitTail([a, u], 1000, 3.5).messages;
    expect(kept[0]).toBe(a);
    expect(fitTail([a, u], 0, 3.5)).toEqual({ messages: [], dropped: 2 });
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
    expect(h.text).not.toMatch(/\d+k tokens/); // no size for the call: none is measured at that moment
    expect(h.text).toContain('The 2 messages after this one are what happened after you wrote it, kept verbatim.');
    expect(h.text).not.toContain('did not fit');
    expect((f as { handle?: string }).handle).toBeUndefined();
    expect((h as { handle?: string }).handle).toBeUndefined();
    expect(tail[0]).toBe(t1);
    expect(tail[1]).toBe(t2);
    expect(tail.map((m) => m.handle)).toEqual(['engine-1', 'engine-2']);
    expect(wake).toMatchObject({ kept: 2, dropped: 0 });
  });

  it("carries the call's own receipt, and ends the wake with the experimental line, once", () => {
    const stored = 'Handoff stored (40 characters). It installs before your next request.';
    const receipt = `${stored}\nforward-compaction is experimental. If it gave you any trouble, append a short note to /logs/issues.md.`;
    const h = buildWake({ ...mainInput([call, results(['t9', receipt])]), toolUseId: 't9', handoff, logDir: '/logs' }).messages[1] as BuiltMessage;
    expect(h.text).toContain(`Your forward_compaction call returned:\n${stored}\n\n`);
    expect(h.text.split('\n').at(-1)).toBe('forward-compaction is experimental. If it gave you any trouble, append a short note of what happened to /logs/issues.md; it will be taken care of later.');
    expect(h.text.split('forward-compaction is experimental.').length).toBe(2);
  });

  it('ends a mechanical wake with the experimental line too', () => {
    const w = mechanicalWake({ ...mainInput([user('a'), assistant('b')]), logDir: '/logs', reason: { kind: 'ceiling', ceiling: 120_000 } });
    const head = w.messages.find((m) => (m as BuiltMessage).text?.startsWith('[forward-compaction: no frontier')) as BuiltMessage;
    expect(head.text.split('\n').at(-1)).toMatch(/^forward-compaction is experimental\. .*\/logs\/issues\.md; it will be taken care of later\.$/);
  });

  it('tells a woken party, handed off or compacted, that the next handoff is free and the task is finished in full', () => {
    const h = buildWake({ ...mainInput([call, res]), toolUseId: 't9', handoff }).messages[1] as BuiltMessage;
    const w = mechanicalWake({ ...mainInput([user('a'), assistant('b')]), reason: { kind: 'ceiling', ceiling: 120_000 } });
    const head = w.messages.find((m) => (m as BuiltMessage).text?.startsWith('[forward-compaction: no frontier')) as BuiltMessage;
    for (const text of [h.text, head.text]) expect(text).toContain(FREE);
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

  it('names the tool as registered when it asks for the next handoff', () => {
    const filler = Array.from({ length: 10 }, (_, i) => assistant(`${i}`.repeat(1000), [], `e${i}`));
    const tool = 'mcp__forward-compaction-dev__forward_compaction';
    const h = buildWake({ ...mainInput([call, res, ...filler]), askPoint: 4000, toolUseId: 't9', handoff, tool }).messages[1] as BuiltMessage;
    expect(h.text).toContain(`call ${tool} again at your next milestone`);
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

  it("hands the facts a kept tool call's own text, so a fact the tail shows there is left out", () => {
    const seen: string[][] = [];
    const later: Msg = { role: 'assistant', text: '', handle: 'h-later', toolUses: [{ tool_use_id: 't20', tool: 'Skill', input: {}, text: 'SKILL-BODY' }] };
    buildWake({ ...mainInput([call, res, later]), toolUseId: 't9', handoff, facts: (kept) => (seen.push([...kept]), noFacts) });
    expect(seen[0]).toContain('SKILL-BODY');
  });

  it('prints no size for the call: the plugin measures none at that moment', () => {
    const wake = buildWake({ ...mainInput([call, res]), toolUseId: 't9', handoff, tokens: 64_000 });
    expect((wake.messages[1] as BuiltMessage).text.split('\n')[0]).toBe('[forward-compaction: handoff] Below is the handoff you wrote with forward_compaction. It is your frontier: continue from its ## Next.');
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
    expect(f.indexOf('p3 ')).toBeLessThan(f.indexOf('p4 '));
    expect(f).not.toContain('p2 ');
  });

  it('carries at most the newest ten person messages, and counts the older ones left out', () => {
    const person = Array.from({ length: 12 }, (_, i) => ({ at: T0 + i * 1000, text: `ask${i}.` }));
    const { f } = wakeOf({ f: { person } });
    expect(f).toContain("## The person's messages, oldest first (10 of 12; the 2 oldest are not carried: look_back finds them)");
    expect(f).toContain('ask2.');
    expect(f).toContain('ask11.');
    expect(f).not.toContain('ask1.');
  });

  it("carries at most a sub-agent's newest ten coordinator messages, and counts the older ones", () => {
    const received = Array.from({ length: 12 }, (_, i) => ({ at: T0 + i * 1000, origin: 'coordinator', text: `note${i}.` }));
    const w = mechanicalWake({ ...base, messages: [user('a'), assistant('b')], party: 'subagent', facts: facts({ brief: { text: 'brief' }, received }), reason: { kind: 'ceiling', ceiling: 120_000 } });
    const f = (w.messages[0] as BuiltMessage).text;
    expect(f).toContain('## Messages delivered to you\n(2 older not carried)');
    expect(f).toContain('note2.');
    expect(f).toContain('note11.');
    expect(f).not.toContain('note1.');
  });

  it('lists the files touched, newest first, at most 15, and counts the older ones', () => {
    const files = Array.from({ length: 17 }, (_, i) => ({ path: `/w/f${i}.ts`, tag: (i === 0 ? 'E' : 'R') as 'E' | 'R' }));
    const { f } = wakeOf({ f: { work: { files, tasks: [] } } });
    expect(f).toContain('## Files touched, newest first (R read, E edited, W written)\nE /w/f0.ts\nR /w/f1.ts');
    expect(f).toContain('R /w/f14.ts\n(2 older not listed)');
    expect(f).not.toContain('/w/f15.ts');
    expect(wakeOf({ f: { work: { files: [], tasks: [] } } }).f).not.toContain('## Files touched');
  });

  it('carries the task list as last set within 5% of B, and names it when over that room', () => {
    expect(wakeOf({ f: { work: { files: [], tasks: ['[x] tests', '[ ] install'] } } }).f).toContain('## Tasks, as last set\n[x] tests\n[ ] install');
    const big = wakeOf({ askPoint: 2000, f: { work: { files: [], tasks: ['[ ] ' + 'w'.repeat(2000)] } } }).f;
    expect(big).toMatch(/## Tasks\n\(not carried: 2,026 characters, over the [\d,]+-character room; look_back finds them\)/);
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
    expect(sub).toContain('## Messages delivered to you\n(3 older not carried)\n### 2026-10-23T10:00:03.000Z (coordinator)\nc3 ');
    const main = wakeOf({ f: { notices: [{ at: T0, origin: 'task-notification', text: '<task-notification>done</task-notification>' }] } }).f;
    expect(main).toContain('## Notifications delivered to you\n### 2026-10-23T10:00:00.000Z (task-notification)\n<task-notification>done</task-notification>');
  });

  it('carries the sibling calls with their input and result, or says a result is not carried', () => {
    expect(wakeOf({}).f).toContain('## Results of the calls you made beside the handoff\n### Read {"file_path":"/a.ts"}\nSIBLING-RESULT');
    const big = results(['t9', 'stored'], ['t10', 's'.repeat(5000)]);
    const wake = buildWake({ ...mainInput([call, big]), askPoint: 2000, toolUseId: 't9', handoff: '## Next\nx' });
    expect((wake.messages[0] as BuiltMessage).text).toContain('- Read: result not carried (5,000 characters)');
  });

  it('carries every skill the party invoked whole, however much of the budget it takes, and names only one larger than the whole budget', () => {
    // askPoint 2000 at 3.5 characters a token: B is 3,500 characters, 25% of it 875
    const f = wakeOf({ askPoint: 2000, f: { skills: [{ skill: 'big', text: 'b'.repeat(2000), source: 'user' }, { skill: 'also', text: 'a'.repeat(1000), source: 'user' }] } }).f;
    expect(f).toContain('### big (user)\n' + 'b'.repeat(2000));
    expect(f).toContain('### also (user)\n' + 'a'.repeat(1000));
    expect(f).not.toContain('## Skills not carried');
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
    expect(f).toContain('## Skills in force, as loaded (one you no longer need: name it in drop_skills on two handoffs in a row)\n### small (user, /s/SKILL.md)\ntiny');
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

  it("lists only a sub-agent's own children, never itself or a sibling, and an emptied list renders no section", () => {
    const rows = [
      { id: 'a0', type: 'general-purpose', status: 'running', description: 'me' },
      { id: 'a1', type: 'general-purpose', status: 'running', description: 'sibling' },
      { id: 'a2', type: 'collector', status: 'running', description: 'child', parentId: 'a0' },
      { id: 'a3', type: 'collector', status: 'running', description: "sibling's child", parentId: 'a1' },
    ];
    const f = wakeOf({ agents: rows, self: 'a0' }, 'subagent').f;
    expect(f).toContain('## Agents, listed at install\n- a2 collector running: child\n\n');
    expect(f).not.toMatch(/a0 general|a1 general|a3 collector/);
    expect(wakeOf({ agents: rows.slice(0, 2), self: 'a0' }, 'subagent').f).not.toContain('## Agents');
    expect(wakeOf({ agents: rows }).f).toContain('- a0 general-purpose running: me\n- a1 general-purpose running: sibling\n- a2 collector running: child\n- a3 collector running: sibling\'s child');
  });

  it('states the unknown shells when no Stop event came (R24)', () => {
    expect(wakeOf({}).f).toContain('(unknown: no Stop event yet in this process)');
  });

  it('lists shells and crons with the age of the snapshot', () => {
    const f = wakeOf({
      f: {
        shells: {
          at: T0,
          tasks: [{ id: 'b1', type: 'local_bash', status: 'running', description: 'dev server', command: 'npm run dev' }, { id: 'b2', type: 'local_bash', status: 'running', description: 'watcher' }, { id: 'ag1', type: 'local_agent', status: 'running', description: 'a child agent' }],
          crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check ci' }],
        },
      },
    }).f;
    expect(f).toContain('## Background shells and crons (session-wide, from the Stop event 1m before install)');
    expect(f).toContain('- local_bash b1 running: npm run dev');
    expect(f).toContain('- local_bash b2 running: watcher');
    expect(f).toContain('- local_agent ag1 running: a child agent');
    expect(f).toContain('- cron c1 */5 * * * * recurring: check ci');
    expect(f).not.toContain('unknown');
  });

  it('leaves the woken party out of the background tasks, and an emptied list reads none running', () => {
    const shells = { at: T0, tasks: [{ id: 'me', type: 'local_agent', status: 'running', description: 'me' }, { id: 'b1', type: 'local_bash', status: 'running', description: 'dev' }], crons: [] };
    const f = wakeOf({ self: 'me', f: { shells } }).f;
    expect(f).toContain('- local_bash b1 running: dev');
    expect(f).not.toContain(' me running');
    expect(wakeOf({ self: 'me', f: { shells: { ...shells, tasks: [shells.tasks[0]!] } } }).f).toContain('(none running)');
  });

  it('says a snapshot with nothing running as that, not as unknown', () => {
    const f = wakeOf({ f: { shells: { at: T0, tasks: [], crons: [] } } }).f;
    expect(f).toContain('(none running)');
    expect(f).not.toContain('unknown');
    expect(wakeOf({ f: { shells: { at: T0, tasks: [], crons: [] } } }).wake.facts).toBe(1); // the sibling section alone
    expect(wakeOf({ now: T0 + 30_000, f: { shells: { at: T0, tasks: [], crons: [] } } }).f).toContain('from the Stop event 30s before install');
  });

  it('carries load files with their range and why, and names those not carried (R22)', () => {
    const { f } = wakeOf({
      maxContext: 400_000,
      charsPerToken: 2.5,
      files: [
        { path: '/abs/a.ts', lines: '1-3', why: 'the bug', content: 'line1\nline2\nline3' },
        { path: '/abs/f.ts', why: 'whole', content: 'x'.repeat(50_000) },
        { path: '/abs/gone.ts', why: 'gone', problem: 'lines 10-40 out of range (5 lines)' },
        { path: '/abs/err.ts', why: 'err', problem: 'EACCES: permission denied' },
      ],
    });
    expect(f).toContain('## Files you asked to carry\n### /abs/a.ts lines 1-3 — the bug\nline1\nline2\nline3');
    expect(f).toContain('## Files not carried\n- /abs/f.ts: 50,000 characters, over the room left'); // 50,000 + the 17 before it, past 400k × 5% × 2.5
    expect(f).toContain('- /abs/gone.ts: lines 10-40 out of range (5 lines)');
    expect(f).toContain('- /abs/err.ts: EACCES: permission denied');
    expect(f).not.toContain('xxxxxxxxxx');
  });

  it("carries files in 5% of the party's max context at its measured ratio, whatever the ask point, and stops when that room is spent", () => {
    const files = [
      { path: '/abs/1.ts', why: 'a', content: 'a'.repeat(30_000) },
      { path: '/abs/2.ts', why: 'b', content: 'b'.repeat(20_001) },
      { path: '/abs/3.ts', why: 'c', content: 'c'.repeat(20_000) },
    ];
    const { f } = wakeOf({ maxContext: 400_000, charsPerToken: 2.5, files }); // room 50,000 characters
    expect(f).toContain('### /abs/1.ts');
    expect(f).toContain('- /abs/2.ts: 20,001 characters, over the room left');
    expect(f).toContain('### /abs/3.ts');
    const big = wakeOf({ maxContext: 1_000_000, charsPerToken: 2.5, files: [{ path: '/abs/big.ts', why: 'big', content: 'z'.repeat(60_000) }] }).f; // inside 125,000
    expect(big).toContain('### /abs/big.ts — big\nzzz');
    expect(wakeOf({ files: [{ path: '/abs/x.ts', why: 'x', content: 'x' }] }).f).toContain('- /abs/x.ts: 1 characters, over the room left'); // no max context, no room
  });

  it('with no measured ratio carries every file and every message after the call, unfitted, and reports each section size', () => {
    const files = [{ path: '/abs/huge.ts', why: 'h', content: 'h'.repeat(500_000) }, { path: '/abs/gone.ts', why: 'g', problem: 'ENOENT' }];
    const tail = Array.from({ length: 40 }, (_, i) => user(`after ${i} ${'y'.repeat(5_000)}`, `t${i}`));
    const wake = buildWake({ ...mainInput([call, res, ...tail], { person: [{ at: T0, text: 'p'.repeat(100_000) }] }), charsPerToken: undefined, askPoint: 2000, maxContext: 200_000, files, toolUseId: 't9', handoff: '## Next\nx' });
    expect(wake).toMatchObject({ kept: 40, dropped: 0, carried: ['/abs/huge.ts'], notCarried: ['/abs/gone.ts'] });
    expect((wake.messages[0] as BuiltMessage).text).toContain('p'.repeat(100_000));
    expect(wake.sizes.map((s) => s.section)).toEqual(expect.arrayContaining(["## The person's messages, oldest first (1 of 1)", '## Files you asked to carry', '## Files not carried']));
    expect(wake.sizes.find((s) => s.section === '## Files you asked to carry')!.chars).toBeGreaterThan(500_000);
    expect(wake.headChars).toBe((wake.messages[1] as BuiltMessage).text.length);
  });
});

describe('mechanicalWake (R23)', () => {
  const msgs = Array.from({ length: 6 }, (_, i) => user(`m${i} ${'x'.repeat(900)}`, `e${i}`));

  it('with no measured ratio keeps no earlier message and says the size was not measured', () => {
    const wake = mechanicalWake({ ...mainInput(msgs), charsPerToken: undefined, tokens: undefined, askPoint: 3000, reason: { kind: 'reactive' } });
    expect(wake).toMatchObject({ kept: 0, dropped: 6 });
    expect(wake.messages).toHaveLength(2);
    expect((wake.messages[1] as BuiltMessage).text).toContain('Your context reached a size not measured yet, and Claude Code reported your request too long');
  });

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

  it('ends when the facts shrink as the tail shrinks: a fit never grows back over the facts rendered for it', () => {
    const four = msgs.slice(0, 4);
    let calls = 0;
    const seen: string[][] = [];
    // a fact that is large only while the oldest message is kept: dropping it makes room the old loop gave back to it, forever
    const input = {
      ...mainInput(four), askPoint: 3000, reason: { kind: 'reactive' as const },
      facts: (kept: readonly string[]): WakeFacts => {
        seen.push([...kept]);
        // past 50 calls the fact stops flipping, so the old endless loop ends and the call count below names it
        return { ...noFacts, person: ++calls <= 50 && kept.includes(four[0]!.text) ? [{ at: T0, text: 'p'.repeat(1200) }] : [{ at: T0, text: 'p' }] };
      },
    };
    const wake = mechanicalWake(input);
    expect(calls).toBe(2);
    expect(wake.kept).toBe(3);
    expect(wake.dropped).toBe(1);
    expect(seen.at(-1)).toEqual(wake.messages.slice(2).map((m) => m.text));
  });

  it('names the tool as registered', () => {
    const h = mechanicalWake({ ...mainInput(msgs), reason: { kind: 'reactive' }, tool: 'mcp__forward-compaction-dev__forward_compaction' }).messages[1] as BuiltMessage;
    expect(h.text).toContain('call mcp__forward-compaction-dev__forward_compaction at your next milestone');
  });

  it('begins the tail on a plain message, never a tool result', () => {
    const wake = mechanicalWake({ ...mainInput([user('a'), assistant('b', [{ id: 'q', tool: 'Read' }]), results(['q', 'r'])]), askPoint: 100, reason: { kind: 'reactive' } });
    expect((wake.messages[2] as Msg | undefined)?.toolResults).toBeUndefined();
  });
});

describe('screen lines', () => {
  const handoffLanding = { kind: 'handoff' as const, label: 'main', before: 164_000, chars: 4812, facts: 3, kept: 5, dropped: 0 };
  const mechanical = { kind: 'mechanical' as const, label: 'main', before: 125_000, tokens: 125_000, ceiling: 120_000 };

  it('says what landed, in the readings before the install and after it', () => {
    expect(landedLine(handoffLanding, 46_000))
      .toBe('forward-compaction: main handoff landed — 164k → 46k context, measured; frontier 4,812 characters, 3 facts, 5 messages kept verbatim.');
    expect(landedLine({ ...handoffLanding, label: 'general-purpose a1b2c3', kept: 2, dropped: 4 }, 30_000)).toContain('2 messages kept verbatim, 4 dropped.');
  });

  it('says an unmeasured size as unknown, never guessed', () => {
    expect(landedLine(handoffLanding)).toBe('forward-compaction: main handoff landed — 164k → unknown context (it ended before a request after the install measured it); frontier 4,812 characters, 3 facts, 5 messages kept verbatim.');
    expect(landedLine({ ...handoffLanding, before: undefined }, 46_000)).toContain('— unknown → 46k context (no reading before the install), measured after;');
  });

  it('says what a mechanical wake did, measured the same way', () => {
    expect(landedLine(mechanical, 38_000)).toBe('forward-compaction: main had no handoff at 125k (ceiling 120k) — mechanical wake installed, 125k → 38k context, measured.');
    expect(landedLine({ ...mechanical, before: undefined, tokens: undefined }, 38_000)).toBe('forward-compaction: main had no handoff at an unmeasured size (no reading yet) (ceiling 120k) — mechanical wake installed, unknown → 38k context (no reading before the install), measured after.');
  });

  it('sets the budget at half the ask point', () => {
    expect(wakeBudget(67_000)).toBe(33_500);
  });
});
