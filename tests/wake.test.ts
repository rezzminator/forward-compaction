import { describe, expect, it } from 'vitest';
import { START_END, type BuiltMessage } from '../plugins/forward-compaction/src/kept.ts';
import { buildWake, COMMANDS_KEPT, landedLine, mechanicalWake, recentFiles, RECENT_FILES_KEPT, wakeBudget, type WakeFacts } from '../plugins/forward-compaction/src/wake.ts';
import { assistant, results, user, type Msg } from './fakes/messages.ts';
import { wakeRow, type RowNode } from '../plugins/forward-compaction/src/wake-row.ts';
import { PLUGIN_VERSION } from '../plugins/forward-compaction/src/wake.ts';

/** A built message as the transcript draws it folded (wake-row.ts): the engine stamps a hook's message `unclassified`. */
const folded = (m: BuiltMessage): RowNode | undefined => wakeRow({ text: m.text, origin: { kind: 'unclassified' }, isExpanded: false });
const dimLine = (text: string): RowNode => ({ type: 'Box', props: { marginTop: 1 }, children: [{ type: 'Text', props: { dimColor: true }, children: [text] }] });

const noFacts: WakeFacts = { user: [], notices: [], received: [], skills: [], unattributedSkills: [] };
const T0 = Date.UTC(2026, 9, 23, 10, 0, 0);
// 3.5 characters a token stands in for the ratio the adapter measures (window.ts `charsPerToken`).
const base = { tokens: 41_200, askPoint: 67_000, now: T0 + 60_000, charsPerToken: 3.5 };
const facts = (f: Partial<WakeFacts> = {}) => () => ({ ...noFacts, ...f });
const mainInput = (messages: Msg[], f: Partial<WakeFacts> = {}) => ({ ...base, messages, party: 'main' as const, facts: facts(f) });

describe('buildWake (R20)', () => {
  const call = assistant('writing the frontier', [{ id: 't9', tool: 'mcp__forward-compaction__forward_compaction' }]);
  const res = results(['t9', 'Frontier stored']);
  const frontier = '## Objective\nship\n## Done\nx\n## Remaining\ny\n## Next\nz';

  it('returns [F, H, ...tail]: H is the last built message, carries the frontier verbatim, the tail is the input objects', () => {
    const t1 = assistant('step one', [], 'engine-1');
    const t2 = user('thanks', 'engine-2');
    const wake = buildWake({ ...mainInput([user('hello'), call, res, t1, t2]), toolUseId: 't9', frontier });
    const [f, h, ...tail] = wake.messages as [BuiltMessage, BuiltMessage, ...Msg[]];
    expect(f.text.startsWith('[forward-compaction: facts]')).toBe(true);
    expect(folded(f)).toEqual({ type: 'Box', props: { display: 'none' } });
    expect(folded(h)).toEqual(dimLine('forward-compaction installed the frontier: the transcript view (ctrl+o) shows it and the recorded facts in full'));
    expect(h.text).toContain(`=== frontier ===\n${frontier}\n=== end of frontier ===`);
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
    const stored = 'Frontier stored (40 characters). It installs before your next request.';
    const receipt = `${stored}\nforward-compaction is experimental. If it gave you any trouble, append a short note to /logs/issues.md.`;
    const h = buildWake({ ...mainInput([call, results(['t9', receipt])]), toolUseId: 't9', frontier, logDir: '/logs' }).messages[1] as BuiltMessage;
    expect(h.text).toContain(`Your forward_compaction call returned:\n${stored}\n\n`);
    expect(h.text.split('\n').at(-1)).toBe('forward-compaction is experimental. If it gave you any trouble, append a short note of what happened to /logs/issues.md; it will be taken care of later.');
    expect(h.text.split('forward-compaction is experimental.').length).toBe(2);
  });

  it('ends a mechanical wake with the experimental line too', () => {
    const w = mechanicalWake({ ...mainInput([user('a'), assistant('b')]), logDir: '/logs', reason: { kind: 'ceiling', ceiling: 120_000 } });
    const head = w.messages.find((m) => (m as BuiltMessage).text?.startsWith('[forward-compaction: no frontier')) as BuiltMessage;
    expect(head.text.split('\n').at(-1)).toMatch(/^forward-compaction is experimental\. .*\/logs\/issues\.md; it will be taken care of later\.$/);
  });

  it('promises a woken party nothing about what the next compaction keeps', () => {
    const h = buildWake({ ...mainInput([call, res]), toolUseId: 't9', frontier }).messages[1] as BuiltMessage;
    const w = mechanicalWake({ ...mainInput([user('a'), assistant('b')]), reason: { kind: 'ceiling', ceiling: 120_000 } });
    const head = w.messages.find((m) => (m as BuiltMessage).text?.startsWith('[forward-compaction: no frontier')) as BuiltMessage;
    for (const text of [h.text, head.text]) expect(text).not.toMatch(/costs you nothing|every message after it/);
  });

  it('says nothing happened when the call was the last thing', () => {
    const h = buildWake({ ...mainInput([call, res]), toolUseId: 't9', frontier }).messages[1] as BuiltMessage;
    expect(h.text).toContain('Nothing happened after you wrote it. Continue from ## Next.');
    expect(h.text).not.toContain('messages after this one');
  });

  it('carries the frontier with the newest messages that fit when its call is not in the transcript, saying so', () => {
    const filler = [user('a'), ...Array.from({ length: 10 }, (_, i) => assistant(`${i}`.repeat(1000), [], `e${i}`))];
    const wake = buildWake({ ...mainInput(filler), askPoint: 4000, toolUseId: 't9', frontier });
    expect([wake.kept > 0, wake.dropped > 0, wake.kept + wake.dropped]).toEqual([true, true, 11]);
    expect(wake.messages.slice(2)).toEqual(filler.slice(wake.dropped));
    const h = wake.messages[1] as BuiltMessage;
    expect(h.text).toContain(`=== frontier ===\n${frontier}\n=== end of frontier ===`);
    expect(h.text).toContain(`Your forward_compaction call is not in the transcript, so which messages came after it is unknown: the newest ${wake.kept} are kept verbatim after this one, some perhaps from before your frontier; ${wake.dropped} older did not fit and are gone (look_back finds an exact detail). Continue from ## Next.`);
    const unmeasured = buildWake({ ...mainInput(filler), charsPerToken: undefined, toolUseId: 't9', frontier });
    expect([unmeasured.kept, unmeasured.dropped]).toEqual([0, 11]);
  });

  it('drops the oldest tail messages that do not fit, states how many in H, and keeps the whole output within the budget', () => {
    const filler = Array.from({ length: 10 }, (_, i) => assistant(`${i}`.repeat(1000), [], `e${i}`));
    const input = { ...mainInput([call, res, ...filler]), askPoint: 4000, toolUseId: 't9', frontier };
    const wake = buildWake(input);
    expect(wake.kept).toBeGreaterThan(0);
    expect(wake.kept).toBeLessThan(10);
    expect(wake.dropped).toBe(10 - wake.kept);
    const h = wake.messages[1] as BuiltMessage;
    expect(h.text).toContain(`${wake.dropped} older messages after your frontier did not fit and are gone (look_back finds an exact detail)`);
    expect(wake.messages.slice(2)).toEqual(filler.slice(wake.dropped));
    const chars = wake.messages.reduce((n, m) => n + m.text.length, 0);
    expect(Math.ceil(chars / 3.5)).toBeLessThanOrEqual(wakeBudget(4000));
  });

  it('names the tool as registered when it asks for the next frontier', () => {
    const filler = Array.from({ length: 10 }, (_, i) => assistant(`${i}`.repeat(1000), [], `e${i}`));
    const tool = 'mcp__forward-compaction-dev__forward_compaction';
    const h = buildWake({ ...mainInput([call, res, ...filler]), askPoint: 4000, toolUseId: 't9', frontier, tool }).messages[1] as BuiltMessage;
    expect(h.text).toContain(`call ${tool} again at your next milestone`);
  });

  it('never leaves a tool result at the head of the tail', () => {
    const useA = assistant('x'.repeat(2800), [{ id: 'r1', tool: 'Read' }]);
    const answer = results(['r1', 'y'.repeat(100)]);
    const last = assistant('z'.repeat(300));
    const wake = buildWake({ ...mainInput([call, res, useA, answer, last]), askPoint: 2000, toolUseId: 't9', frontier });
    expect((wake.messages[2] as Msg | undefined)?.toolResults).toBeUndefined();
    expect(wake.messages.slice(2)).toEqual([last]);
  });

  it('sizes the facts against the kept tail: facts get the kept texts, and a smaller tail is re-asked until it is stable', () => {
    const seen: string[][] = [];
    const filler = Array.from({ length: 6 }, (_, i) => user(`m${i} ${'x'.repeat(900)}`, `e${i}`));
    // the user's words in a message already kept are left out; each dropped message puts its words back in the facts
    const input = {
      ...mainInput([call, res, ...filler]), askPoint: 3000, toolUseId: 't9', frontier,
      facts: (kept: readonly string[]): WakeFacts => {
        seen.push([...kept]);
        const user = filler.filter((m) => !kept.includes(m.text)).map((m, i) => ({ at: T0 + i, text: m.text }));
        return { ...noFacts, user };
      },
    };
    const wake = buildWake(input);
    expect(seen[0]).toEqual(filler.map((m) => m.text));
    const finalKept = wake.messages.slice(2).map((m) => m.text);
    expect(seen.at(-1)).toEqual(finalKept);
    expect(wake.kept).toBeLessThan(6);
    // the user's words are carried whole, outside B: each filler message is in the wake exactly once, kept or in the facts
    const all = wake.messages.map((m) => m.text).join('\n');
    for (const m of filler) expect(all.split(m.text).length - 1).toBe(1);
  });

  it("hands the facts a kept tool call's own text, so a fact the tail shows there is left out", () => {
    const seen: string[][] = [];
    const later: Msg = { role: 'assistant', text: '', handle: 'h-later', toolUses: [{ tool_use_id: 't20', tool: 'Skill', input: {}, text: 'SKILL-BODY' }] };
    buildWake({ ...mainInput([call, res, later]), toolUseId: 't9', frontier, facts: (kept) => (seen.push([...kept]), noFacts) });
    expect(seen[0]).toContain('SKILL-BODY');
  });

  it('prints no size for the call: the plugin measures none at that moment', () => {
    const wake = buildWake({ ...mainInput([call, res]), toolUseId: 't9', frontier, tokens: 64_000 });
    expect((wake.messages[1] as BuiltMessage).text.split('\n')[0]).toBe('[forward-compaction: frontier] Below is your frontier as forward-compaction holds it: continue from its ## Next. When a notice next asks for a forward_compaction call, send only changes, by item number; whatever you leave out stays.');
  });

  it('counts the F sections that hold content', () => {
    const wake = buildWake({
      ...mainInput([call, res], { user: [{ at: T0, text: 'fix it' }], skills: [{ skill: 'god-speed', text: 'rules', source: 'user' }] }),
      toolUseId: 't9', frontier,
    });
    expect(wake.facts).toBe(2);
  });
});

describe("a sub-agent's kept start", () => {
  const call = assistant('writing the frontier', [{ id: 't9', tool: 'mcp__forward-compaction__forward_compaction' }]);
  const res = results(['t9', 'Frontier stored']);
  const frontier = '## Objective\nship\n## Next\nz';
  const brief = user('Fix the parser. No git stash.', 'engine-brief');
  const end = { role: 'assistant', text: START_END, toolUses: [] };
  const sub = (messages: Msg[], f: Partial<WakeFacts> = {}) => ({ ...base, messages, party: 'subagent' as const, facts: facts(f), toolUseId: 't9', frontier });
  const HEAD = `[forward-compaction: facts] Your context was compacted by forward-compaction ${PLUGIN_VERSION}.`;

  it('hands the first message back by handle, then a built end line, then [F, H, ...tail], and names the brief in the head instead of repeating it', () => {
    const t1 = assistant('step one', [], 'engine-1');
    const wake = buildWake(sub([brief, assistant('reading'), call, res, t1], { brief: { text: 'Fix the parser. No git stash.' } }));
    expect(wake.messages[0]).toBe(brief);
    expect(wake.messages[1]).toEqual(end);
    const f = (wake.messages[2] as BuiltMessage).text;
    expect(f.split('\n')[0]).toBe(`${HEAD} Your brief is the first message above, kept verbatim. These facts were recorded as they happened, never reconstructed. Your own frontier follows in the next message.`);
    expect(f).not.toContain('## Your brief');
    expect((wake.messages[3] as BuiltMessage).text).toContain(`=== frontier ===\n${frontier}\n=== end of frontier ===`);
    expect(wake.messages).toHaveLength(5);
    expect(wake.messages[4]).toBe(t1);
    expect(wake).toMatchObject({ start: 2, kept: 1, dropped: 0 });
  });

  it('renders the documents the brief names under the kept brief, each as read at install, names one not carried, and a mechanical wake renders them too', () => {
    const briefFiles = [
      { path: '/lab/brief.md', content: 'Watch each test fail first.' },
      { path: '/lab/spec.md', lines: '1-2', content: 'a\nb\n[3 more lines not carried: Read /lab/spec.md from line 3]' },
      { path: '/lab/gone.md', problem: 'ENOENT' },
    ];
    const block = '## The documents your brief names, read at install\nThey are part of your brief: where your frontier words one of their rules differently, their words hold.\n### /lab/brief.md\nWatch each test fail first.\n### /lab/spec.md lines 1-2\na\nb\n[3 more lines not carried: Read /lab/spec.md from line 3]';
    const wake = buildWake({ ...sub([brief, call, res], { brief: { text: 'Fix the parser. No git stash.' } }), briefFiles });
    const sections = (wake.messages[2] as BuiltMessage).text.split('\n\n');
    expect(sections[1]).toBe(block); // right under the head, where a brief not kept above would stand
    expect(sections).toContain('## Files not carried\n- /lab/gone.md: ENOENT');
    expect([wake.carried, wake.notCarried]).toEqual([['/lab/brief.md', '/lab/spec.md'], ['/lab/gone.md']]);
    const mechanical = mechanicalWake({ ...base, messages: [brief, assistant('reading')], party: 'subagent', facts: facts({ brief: { text: 'Fix the parser. No git stash.' } }), reason: { kind: 'reactive' }, briefFiles });
    expect((mechanical.messages[2] as BuiltMessage).text.split('\n\n')[1]).toBe(block);
  });

  it("keeps the engine's own end line at the next compaction, building no second one", () => {
    const ownEnd = assistant(START_END, [], 'engine-end');
    const wake = buildWake(sub([brief, ownEnd, user('[forward-compaction: facts] earlier', 'engine-f'), user('[forward-compaction: frontier] earlier', 'engine-h'), assistant('more work'), call, res]));
    expect(wake.messages).toHaveLength(4);
    expect(wake.messages[0]).toBe(brief);
    expect(wake.messages[1]).toBe(ownEnd);
    expect((wake.messages[2] as BuiltMessage).text.startsWith(HEAD)).toBe(true);
    expect(wake.start).toBe(2);
  });

  it.each([
    ['a brief the start does not hold is carried in its section', { brief: { text: 'Another brief.' } }, '## Your brief\nAnother brief.'],
    ['a brief never recorded points at the first message', {}, "## Your brief\n(not recorded by forward-compaction: this run's first message, above, is kept verbatim)"],
  ])('%s', (_name, f, section) => {
    const text = (buildWake(sub([brief, call, res], f as Partial<WakeFacts>)).messages[2] as BuiltMessage).text;
    expect(text.split('\n')[0]).toBe(`${HEAD} These facts were recorded as they happened, never reconstructed. Your own frontier follows in the next message.`);
    expect(text).toContain(section);
  });

  it.each([
    ['the main party', { ...sub([brief, call, res]), party: 'main' as const }],
    ['a sub-agent whose transcript opens with no message of its own to keep', sub([assistant('hi'), call, res])],
  ])('builds no start for %s', (_name, input) => {
    const wake = buildWake(input);
    expect((wake.messages[0] as BuiltMessage).text.startsWith(HEAD)).toBe(true);
    expect(wake.messages).toHaveLength(2);
    expect(wake.start).toBe(0);
  });

  it.each([
    ['a short one leaves the tail its room', 'Fix the parser. No git stash.', { start: 2, kept: 4, dropped: 0 }],
    ['one near the whole budget leaves the tail none', 'b'.repeat(6650), { start: 2, kept: 0, dropped: 4 }],
  ])('counts the start against the budget the tail is fitted to: %s', (_name, text, counts) => {
    // askPoint 4000 at 3.5 characters a token: B is 2,000 tokens, each tail message 200, the long start 1,900
    const first = user(text, 'engine-brief');
    const tail = [1, 2, 3, 4].map((n) => assistant(`${n}`.repeat(700), [], `engine-${n}`));
    const wake = buildWake({ ...sub([first, call, res, ...tail]), askPoint: 4000 });
    expect(wake.messages[0]).toBe(first);
    expect(wake).toMatchObject(counts);
  });

  it('keeps the start once in a mechanical wake, ahead of the facts and out of the kept tail', () => {
    const a1 = assistant('step one', [], 'engine-1');
    const wake = mechanicalWake({ ...base, messages: [brief, a1], party: 'subagent', facts: facts(), reason: { kind: 'reactive' } });
    expect(wake.messages).toHaveLength(5);
    expect(wake.messages[0]).toBe(brief);
    expect(wake.messages[1]).toEqual(end);
    expect(wake.messages[4]).toBe(a1);
    expect(wake).toMatchObject({ start: 2, kept: 1, dropped: 0 });
  });
});

describe('F sections', () => {
  const call = assistant('go', [{ id: 't9', tool: 'fc' }, { id: 't10', tool: 'Read', input: { file_path: '/a.ts' } }]);
  const res = results(['t9', 'stored'], ['t10', 'SIBLING-RESULT']);
  const wakeOf = (input: Partial<Parameters<typeof buildWake<Msg>>[0]> & { f?: Partial<WakeFacts> }, party: 'main' | 'subagent' = 'main') => {
    const { f, ...rest } = input;
    const wake = buildWake({ ...mainInput([call, res], f), party, toolUseId: 't9', frontier: '## Next\nx', ...rest });
    return { wake, f: (wake.messages[0] as BuiltMessage).text };
  };

  it('puts the user messages oldest first under the (n of m) heading, with ISO times', () => {
    const { f } = wakeOf({ f: { user: [{ at: T0, text: 'fix the parser' }, { at: T0 + 1000, text: 'also add tests' }] } });
    expect(f).toContain("## The user's messages, oldest first (2 of 2 recorded)");
    expect(f.indexOf('fix the parser')).toBeLessThan(f.indexOf('also add tests'));
    expect(f).toContain('### 2026-10-23T10:00:00.000Z\nfix the parser');
  });

  it('carries the newest ten user messages whole, however much of B they take', () => {
    const user = Array.from({ length: 5 }, (_, i) => ({ at: T0 + i * 1000, text: `p${i} ${'w'.repeat(3000)}` }));
    const { f } = wakeOf({ askPoint: 2000, f: { user } });
    expect(f).toContain("## The user's messages, oldest first (5 of 5 recorded)");
    for (let i = 0; i < 5; i++) expect(f).toContain(`p${i} ${'w'.repeat(3000)}`);
    expect(f.indexOf('p3 ')).toBeLessThan(f.indexOf('p4 '));
  });

  it('carries at most the newest ten user messages, and counts the older ones left out', () => {
    const user = Array.from({ length: 12 }, (_, i) => ({ at: T0 + i * 1000, text: `ask${i}.` }));
    const { f } = wakeOf({ f: { user } });
    expect(f).toContain("## The user's messages, oldest first (10 of 12 recorded; the 2 oldest recorded are not carried: look_back finds them)");
    expect(f).toContain('ask2.');
    expect(f).toContain('ask11.');
    expect(f).not.toContain('ask1.');
  });

  it('carries every answer to a question beside the ten newest typed messages, each marked as an answer', () => {
    const answer = { at: T0, text: 'Which quote?\nAnswer: Segment', answer: 'Segment' };
    const user = [answer, ...Array.from({ length: 11 }, (_, i) => ({ at: T0 + (i + 1) * 1000, text: `ask${i}.` }))];
    const { f } = wakeOf({ f: { user } });
    expect(f).toContain("## The user's messages, oldest first (11 of 12 recorded, 1 of them answering your questions; the 1 oldest recorded are not carried: look_back finds them)");
    expect(f).toContain('### 2026-10-23T10:00:00.000Z (the user answering your question)\nWhich quote?\nAnswer: Segment');
    expect(f).not.toContain('ask0.');
    expect(f).toContain('ask10.');
  });

  it("carries at most a sub-agent's newest ten coordinator messages, and counts the older ones", () => {
    const received = Array.from({ length: 12 }, (_, i) => ({ at: T0 + i * 1000, origin: 'coordinator', text: `note${i}.` }));
    const w = mechanicalWake({ ...base, messages: [user('a'), assistant('b')], party: 'subagent', facts: facts({ brief: { text: 'brief' }, received }), reason: { kind: 'ceiling', ceiling: 120_000 } });
    const f = (w.messages[2] as BuiltMessage).text; // after the start: its first message and the end line
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

  it('carries the task list as last set whole, whatever its size, never fitted', () => {
    expect(wakeOf({ f: { work: { files: [], tasks: ['[x] tests', '[ ] install'] } } }).f).toContain('## Tasks, as last set\n[x] tests\n[ ] install');
    const big = wakeOf({ askPoint: 2000, f: { work: { files: [], tasks: ['[ ] ' + 'w'.repeat(2000)] } } }).f;
    expect(big).toContain('## Tasks, as last set\n[ ] ' + 'w'.repeat(2000));
    expect(big).not.toContain('not carried: 2,026 characters');
  });

  it('M2 + M4: carries the commands run, newest first, at most COMMANDS_KEPT, within their share, naming those not carried', () => {
    const commands = Array.from({ length: COMMANDS_KEPT + 3 }, (_, i) => ({ command: `make step${i}`, ...(i === 0 ? { description: 'Build the newest' } : {}) }));
    const { f } = wakeOf({ f: { work: { files: [], tasks: [], commands } } });
    expect(f).toContain(`## Shell commands you ran, newest first (3 older not carried; look_back finds them)\n### Build the newest\nmake step0\n### (no description)\nmake step1`);
    expect(f).toContain(`make step${COMMANDS_KEPT - 1}`);
    expect(f).not.toContain(`make step${COMMANDS_KEPT}`);
    const tight = wakeOf({ askPoint: 2000, f: { work: { files: [], tasks: [], commands: [{ command: 'a' }, { command: 'b'.repeat(2000) }] } } }).f;
    expect(tight).toContain('## Shell commands you ran, newest first (1 older not carried; look_back finds them)\n### (no description)\na');
    expect(wakeOf({ f: { work: { files: [], tasks: [], commands: [] } } }).f).not.toContain('## Shell commands');
  });

  it('M6: the facts header names the plugin version that built the wake', () => {
    expect(wakeOf({}).f).toMatch(new RegExp(`^\\[forward-compaction: facts\\] Your context was compacted by forward-compaction ${PLUGIN_VERSION.replace(/\./g, '\\.')}\\. `));
    expect(mechanicalWake({ ...mainInput([call, res]), reason: { kind: 'reactive' } }).messages[0]!.text).toContain(`compacted by forward-compaction ${PLUGIN_VERSION}.`);
  });

  it("M3: names each image of the user's kept messages as not carried, never a silent placeholder", () => {
    const { f } = wakeOf({ f: { user: [{ at: T0, text: 'this screen [Image #1] and [Image #12]' }] } });
    expect(f).toContain('this screen [Image #1] (image not carried: the wake cannot hold images) and [Image #12] (image not carried: the wake cannot hold images)');
  });

  it('states no user message with the ledger start, and without one when there is no start', () => {
    expect(wakeOf({ f: { startedAt: T0 } }).f).toContain(`## The user's messages\n(none recorded since 2026-10-23T10:00:00.000Z)`);
    expect(wakeOf({}).f).toContain("## The user's messages\n(none recorded)");
  });

  it('counts the user messages the kept tail holds in the heading, beside the ones shown', () => {
    const { f } = wakeOf({ f: { user: [{ at: T0, text: 'fix the parser' }, { at: T0 + 1000, text: 'also add tests' }], userInTail: 1 } });
    expect(f).toContain("## The user's messages, oldest first (2 of 3 recorded; 1 is in the messages below)");
  });

  it('promises the frontier only on a frontier wake, never on a mechanical one', () => {
    const facts = (buildWake({ ...mainInput([call, res]), toolUseId: 't9', frontier: '## Next\nx' }).messages[0] as BuiltMessage).text;
    expect(facts).toContain('Your own frontier follows in the next message.');
    const mech = (mechanicalWake({ ...mainInput([user('a'), assistant('b')]), reason: { kind: 'ceiling', ceiling: 120_000 } }).messages[0] as BuiltMessage).text;
    expect(mech).not.toContain('Your own frontier follows');
    expect(mech).toContain('You wrote no frontier: the note after these facts says what happened.');
  });

  it('says every user message is in the messages below when the tail holds them all, never that none was recorded', () => {
    const f = wakeOf({ f: { startedAt: T0, userInTail: 3 } }).f;
    expect(f).toContain("## The user's messages\n(all 3 are in the messages below)");
    expect(f).not.toContain('none recorded');
  });

  it('adds the resume line only on resume', () => {
    expect(wakeOf({ f: { startedAt: T0, startReason: 'resume' } }).f).toContain('The ledger started at 2026-10-23T10:00:00.000Z when this process resumed; anything earlier is not recorded.');
    expect(wakeOf({ f: { startedAt: T0, startReason: 'startup' } }).f).not.toContain('resumed');
  });

  it('carries a sub-agent brief verbatim, and no user section', () => {
    const { f } = wakeOf({ f: { brief: { text: 'Review the diff.' }, user: [{ at: T0, text: 'hi' }] } }, 'subagent');
    expect(f).toContain('## Your brief\nReview the diff.');
    expect(f).not.toContain("user's messages");
  });

  it('carries a brief whole however much of B it takes, and names one that was never recorded', () => {
    const { f } = wakeOf({ askPoint: 2000, f: { brief: { text: 'b'.repeat(20_000) } } }, 'subagent');
    expect(f).toContain('## Your brief\n' + 'b'.repeat(20_000));
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
    expect(wakeOf({}).f).toContain('## Results of the calls you made beside the frontier\n### Read {"file_path":"/a.ts"}\nSIBLING-RESULT');
    const big = results(['t9', 'stored'], ['t10', 's'.repeat(5000)]);
    const wake = buildWake({ ...mainInput([call, big]), askPoint: 2000, toolUseId: 't9', frontier: '## Next\nx' });
    expect((wake.messages[0] as BuiltMessage).text).toContain('- Read: result not carried (5,000 characters)');
  });

  it('carries a skill up to 20,000 characters whatever the wake budget, outside it', () => {
    // askPoint 2000 at 3.5 characters a token: B is 3,500 characters
    const f = wakeOf({ askPoint: 2000, f: { skills: [{ skill: 'big', text: 'b'.repeat(20_000), source: 'user', keep: true }, { skill: 'also', text: 'a'.repeat(1000), source: 'user', keep: true }] } }).f;
    expect(f).toContain('### big (user, pinned)\n' + 'b'.repeat(20_000) + '\n');
    expect(f).toContain('### also (user, pinned)\n' + 'a'.repeat(1000));
    expect(f).not.toContain('skill content truncated');
    expect(f).not.toContain('## Skills not carried');
  });

  it("carries a pinned skill whole, cut past 20,000 characters to Claude Code's own marker, and lists every other one and the unattributed ones", () => {
    const marker = '\n\n[... skill content truncated for compaction; use Read on the skill path if you need the full text]';
    const { f, wake } = wakeOf({
      f: {
        skills: [
          { skill: 'small', text: 'tiny', source: 'user', path: '/s/SKILL.md', keep: true },
          { skill: 'huge', text: 'h'.repeat(40_000), source: 'plugin', keep: true },
          { skill: 'pinned', text: 'p'.repeat(20_001), source: 'user', keep: true },
          { skill: 'listed', text: 'LISTED BODY', source: 'user', path: '/s/l/SKILL.md', description: 'What it is for.' },
          { skill: 'bare', text: 'BARE BODY', source: 'plugin' },
        ],
        unattributedSkills: [{ skill: 'mystery' }],
      },
    });
    expect(f).toContain('## Skills in force, as loaded\n### small (user, /s/SKILL.md, pinned)\ntiny');
    expect(f).toContain('### huge (plugin, pinned)\n' + 'h'.repeat(20_000 - marker.length) + marker + '\n');
    expect(f).toContain('### pinned (user, pinned)\n' + 'p'.repeat(20_000 - marker.length) + marker + '\n');
    expect(f).toContain('## Skills not carried\nTheir text is not in your context: load one again with the Skill tool before doing work it governs.\n- listed (user, /s/l/SKILL.md): What it is for.\n- bare (plugin)\n- mystery: loaded in this session by an unidentified party; call Skill mystery if it applies to you.');
    expect(f).not.toContain('LISTED BODY');
    expect(f).not.toContain('BARE BODY');
    expect([wake.skills, wake.facts]).toEqual([{ carried: 3, listed: 3 }, 3]);
  });

  it('takes skills newest first within 100,000 characters, skipping one that does not fit and carrying a smaller one after it', () => {
    const skills = [
      ...['s1', 's2', 's3', 's4'].map((skill) => ({ skill, text: skill.repeat(15_000), source: 'user', keep: true as const })), // each cut to 20,000: 80,000
      { skill: 's5', text: 'x'.repeat(19_000), source: 'user', keep: true as const }, // 99,000
      { skill: 'big', text: 'y'.repeat(5_000), source: 'user', path: '/s/big/SKILL.md', keep: true as const }, // 1,000 left: skipped, pin or not
      { skill: 'nopath', text: 'z'.repeat(2_000), source: 'plugin', keep: true as const }, // skipped
      { skill: 'tiny', text: 'ok', source: 'user', keep: true as const }, // fits in what is left
    ];
    const f = wakeOf({ f: { skills } }).f;
    expect(f.indexOf('### s1 (user, pinned)')).toBeLessThan(f.indexOf('### s4 (user, pinned)'));
    expect(f).toContain('### s5 (user, pinned)\n' + 'x'.repeat(19_000));
    expect(f).toContain('### tiny (user, pinned)\nok');
    expect(f).not.toContain('yyyyy');
    expect(f).toContain('## Skills not carried\nTheir text is not in your context: load one again with the Skill tool before doing work it governs.\n- big: over the 100,000-character room for skills; call Skill big or Read /s/big/SKILL.md if it applies to you.\n- nopath: over the 100,000-character room for skills; call Skill nopath if it applies to you.');
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

  it('names a child the party spawned that the list no longer holds, after the listed ones and within the row cap', () => {
    const rows = [{ id: 'a2', type: 'collector', status: 'running', description: 'child', parentId: 'a0' }];
    const children = [{ id: 'a2', subagentType: 'collector', description: 'child' }, { id: 'a4', subagentType: 'collector', description: 'finished child' }, { id: 'a5' }];
    const gone = '(finished, stopped or gone)';
    expect(wakeOf({ agents: rows, self: 'a0', f: { children } }, 'subagent').f).toContain(`## Agents, listed at install\n- a2 collector running: child\n- a4 collector not in the list ${gone}: finished child\n- a5 not in the list ${gone}\n\n`);
    expect(wakeOf({ agents: [], self: 'a0', f: { children: children.slice(1, 2) } }, 'subagent').f).toContain(`## Agents, listed at install\n- a4 collector not in the list ${gone}: finished child\n\n`);
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, type: 'general-purpose', status: 'running', description: `job ${i}` }));
    const f = wakeOf({ agents: many, f: { children: [{ id: 'm0' }, { id: 'x1' }] } }).f;
    expect(f).toContain('- m49 general-purpose running: job 49\n(1 more not listed)');
    expect(f).not.toContain('x1 not in the list');
    const newest = wakeOf({ agents: many.slice(0, 48), f: { children: [{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }] } }).f;
    expect(newest).toContain(`- m47 general-purpose running: job 47\n- x2 not in the list ${gone}\n- x3 not in the list ${gone}\n(1 more not listed)\n\n`);
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

  it('carries load files with their range and why, and names those that could not be read (R22)', () => {
    const { f } = wakeOf({
      charsPerToken: 2.5,
      files: [
        { path: '/abs/a.ts', lines: '1-3', why: 'the bug', content: 'line1\nline2\nline3' },
        { path: '/abs/gone.ts', why: 'gone', problem: 'lines 10-40 out of range (5 lines)' },
        { path: '/abs/err.ts', why: 'err', problem: 'EACCES: permission denied' },
      ],
    });
    expect(f).toContain('## Files you asked to carry\n### /abs/a.ts lines 1-3 — the bug\nline1\nline2\nline3');
    expect(f).toContain('## Files not carried\n- /abs/gone.ts: lines 10-40 out of range (5 lines)\n- /abs/err.ts: EACCES: permission denied');
  });

  it('lists the storage by name and description under its absolute folder, after the load files, never a file\'s content, on a mechanical wake too', () => {
    const storage = { dir: '/h/fc/s1/storage', entries: [{ name: 'survey.md', description: 'the API survey' }, { name: 'raw.md', description: '' }] };
    const block = '## Storage — files in /h/fc/s1/storage/\nsurvey.md — the API survey\nraw.md';
    const { f, wake } = wakeOf({ storage, files: [{ path: '/abs/a.ts', content: 'A' }] });
    expect(f).toContain(`## Files you asked to carry\n### /abs/a.ts\nA\n\n${block}`);
    expect([wake.storage, wake.carried]).toEqual([2, ['/abs/a.ts']]);
    const mechanical = mechanicalWake({ ...mainInput([user('before')]), reason: { kind: 'reactive' }, storage });
    expect((mechanical.messages[0] as BuiltMessage).text.split('\n\n').find((x) => x.startsWith('## Storage'))).toBe(block);
    expect(mechanical.storage).toBe(2);
    expect(wakeOf({ storage: { dir: '/h', entries: [] } }).wake.storage).toBe(0);
  });

  it('carries every load file it could read, with no room and no count cap, whatever the ask point or ratio', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ path: `/abs/${i}.ts`, why: `f${i}`, content: String(i).repeat(60_000) }));
    for (const charsPerToken of [2.5, undefined]) {
      const { f, wake } = wakeOf({ askPoint: 2000, charsPerToken, files });
      for (let i = 0; i < 12; i++) expect(f).toContain(`### /abs/${i}.ts — f${i}\n${String(i).repeat(60_000)}`);
      expect(f).not.toContain('## Files not carried');
      expect(wake.carried).toHaveLength(12);
    }
  });

  it('with no measured ratio carries every file and every message after the call, unfitted, and reports each section size', () => {
    const files = [{ path: '/abs/huge.ts', why: 'h', content: 'h'.repeat(500_000) }, { path: '/abs/gone.ts', why: 'g', problem: 'ENOENT' }];
    const tail = Array.from({ length: 40 }, (_, i) => user(`after ${i} ${'y'.repeat(5_000)}`, `t${i}`));
    const wake = buildWake({ ...mainInput([call, res, ...tail], { user: [{ at: T0, text: 'p'.repeat(100_000) }] }), charsPerToken: undefined, askPoint: 2000, files, toolUseId: 't9', frontier: '## Next\nx' });
    expect(wake).toMatchObject({ kept: 40, dropped: 0, carried: ['/abs/huge.ts'], notCarried: ['/abs/gone.ts'] });
    expect((wake.messages[0] as BuiltMessage).text).toContain('p'.repeat(100_000));
    expect(wake.sizes.map((s) => s.section)).toEqual(expect.arrayContaining(["## The user's messages, oldest first (1 of 1 recorded)", '## Files you asked to carry', '## Files not carried']));
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
    expect(folded(wake.messages[0] as BuiltMessage)).toEqual({ type: 'Box', props: { display: 'none' } });
    expect(folded(h)).toEqual(dimLine('forward-compaction compacted mechanically, no frontier was written: the transcript view (ctrl+o) shows its note and the recorded facts in full'));
    expect(h.text).toContain('Your context reached 120k tokens, past the 100k ceiling,');
    expect(h.text).toContain(`${wake.dropped} older messages are gone (look_back finds an exact detail)`);
    expect(h.text).toContain(`your newest ${wake.kept} messages below`);
    expect(h.text).toContain("Re-establish them from the user's messages");
    expect(wake.dropped).toBeGreaterThan(0);
    expect(wake.messages.slice(2)).toEqual(msgs.slice(wake.dropped));
    expect(wake.messages[2]).toBe(msgs[wake.dropped]);
  });

  it('words the reactive case and names the brief for a sub-agent', () => {
    const h = mechanicalWake({ ...mainInput([user('the brief'), ...msgs.map((m) => ({ ...m, role: 'assistant' as const }))]), party: 'subagent', reason: { kind: 'reactive' } }).messages[3] as BuiltMessage; // [brief, end line, facts, head, ...]
    expect(h.text).toContain('Your context reached 41k tokens, and Claude Code reported your request too long, and you had not called');
    expect(h.text).toContain('Re-establish them from your brief');
    expect(h.text).toContain('0 older messages are gone');
  });

  it('has the same facts as the frontier wake, and no load files or siblings', () => {
    const wake = mechanicalWake({ ...mainInput(msgs, { user: [{ at: T0, text: 'fix it' }] }), reason: { kind: 'reactive' } });
    const f = (wake.messages[0] as BuiltMessage).text;
    expect(f).toContain('fix it');
    expect(f).not.toContain('beside the frontier');
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
        return { ...noFacts, user: ++calls <= 50 && kept.includes(four[0]!.text) ? [{ at: T0, text: 'p'.repeat(1200) }] : [{ at: T0, text: 'p' }] };
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
  const frontierLanding = { kind: 'frontier' as const, label: 'main', before: 164_000, chars: 4812, facts: 3, kept: 5, dropped: 0 };
  const mechanical = { kind: 'mechanical' as const, label: 'main', before: 125_000, tokens: 125_000, ceiling: 120_000 };

  it('says what landed, in the readings before the install and after it', () => {
    expect(landedLine(frontierLanding, 46_000))
      .toBe('forward-compaction: main frontier landed — 164k → 46k context, measured; 4,812 characters, 3 facts, 5 messages kept verbatim.');
    expect(landedLine({ ...frontierLanding, label: 'general-purpose a1b2c3', kept: 2, dropped: 4 }, 30_000)).toContain('2 messages kept verbatim, 4 dropped.');
  });

  it('says an unmeasured size as unknown, never guessed', () => {
    expect(landedLine(frontierLanding)).toBe('forward-compaction: main frontier landed — 164k → unknown context (it ended before a request after the install measured it); 4,812 characters, 3 facts, 5 messages kept verbatim.');
    expect(landedLine({ ...frontierLanding, before: undefined }, 46_000)).toContain('— unknown → 46k context (no reading before the install), measured after;');
  });

  it('says what a mechanical wake did, measured the same way', () => {
    expect(landedLine(mechanical, 38_000)).toBe('forward-compaction: main had no frontier at 125k (ceiling 120k) — mechanical wake installed, 125k → 38k context, measured.');
    expect(landedLine({ ...mechanical, before: undefined, tokens: undefined }, 38_000)).toBe('forward-compaction: main had no frontier at an unmeasured size (no reading yet) (ceiling 120k) — mechanical wake installed, unknown → 38k context (no reading before the install), measured after.');
  });

  it('sets the budget at half the ask point', () => {
    expect(wakeBudget(67_000)).toBe(33_500);
  });
});

describe("the mechanical wake re-places the party's newest files, as Claude Code's own compaction does", () => {
  const touched = ['/w/f1.ts', '/w/f2.ts', '/w/f3.ts', '/w/f4.ts', '/w/f5.ts', '/w/f6.ts'].map((path, i) => ({ path, tag: (i % 2 === 0 ? 'E' : 'R') as 'E' | 'R' }));

  it('picks the 5 newest files touched, newest first', () => {
    expect(RECENT_FILES_KEPT).toBe(5);
    expect(recentFiles(touched)).toEqual(['/w/f1.ts', '/w/f2.ts', '/w/f3.ts', '/w/f4.ts', '/w/f5.ts']);
    expect(recentFiles([])).toEqual([]);
  });

  it('carries each file read at install, its trailer kept, and names one that could not be read', () => {
    const recent = [
      { path: '/w/f1.ts', content: 'export const one = 1;\n' },
      { path: '/w/f2.ts', lines: '1-250', content: 'l1\n[10 more lines not carried: Read /w/f2.ts from line 251]' },
      { path: '/w/gone.ts', problem: 'no such file' },
    ];
    const f = mechanicalWake({ ...mainInput([user('a'), assistant('b')]), recent, reason: { kind: 'ceiling', ceiling: 120_000 } }).messages[0] as BuiltMessage;
    expect(f.text).toContain('## Files you were working on, newest first, read at install\n### /w/f1.ts\nexport const one = 1;\n\n### /w/f2.ts lines 1-250\nl1\n[10 more lines not carried: Read /w/f2.ts from line 251]\n### /w/gone.ts\n(not carried: no such file)');
  });

  it('has no such section with none recorded, and a frontier wake never has one', () => {
    const none = mechanicalWake({ ...mainInput([user('a'), assistant('b')]), recent: [], reason: { kind: 'reactive' } }).messages[0] as BuiltMessage;
    expect(none.text).not.toContain('## Files you were working on');
    const call = assistant('writing', [{ id: 't9', tool: 'mcp__forward-compaction__forward_compaction' }]);
    const wake = buildWake({ ...mainInput([call, results(['t9', 'ok'])], { work: { files: touched, tasks: [] } }), toolUseId: 't9', frontier: '## Objective\nx' }).messages[0] as BuiltMessage;
    expect(wake.text).not.toContain('## Files you were working on');
  });

  it('names each text the held frontier lacks, to re-establish from the user or the brief and send in the next call', () => {
    const call = assistant('writing', [{ id: 't9', tool: 'mcp__forward-compaction__forward_compaction' }]);
    const head = (party: 'main' | 'subagent', missing?: string[]) => (buildWake({ ...mainInput([call, results(['t9', 'ok'])]), party, toolUseId: 't9', frontier: '## Objective\nx', ...(missing ? { missing } : {}) }).messages[1] as BuiltMessage).text.split('\n\n');
    expect(head('main', ['objective', 'next'])[2]).toBe("Your frontier has no objective and next: re-establish them from the user's messages and the messages below, and send them in your next forward_compaction call.");
    expect(head('subagent', ['next'])[2]).toBe('Your frontier has no next: re-establish it from your brief and the messages below, and send it in your next forward_compaction call.');
    expect(head('main')[2]).toBe('Your forward_compaction call returned:\nok');
  });
});

describe('the plan file and plan mode, when the session has them, ride in every wake', () => {
  const call = assistant('writing', [{ id: 't9', tool: 'mcp__forward-compaction__forward_compaction' }]);
  const facts = (plan?: Parameters<typeof mechanicalWake>[0]['plan']) => [
    (mechanicalWake({ ...mainInput([user('a')]), ...(plan ? { plan } : {}), reason: { kind: 'reactive' } }).messages[0] as BuiltMessage).text,
    (buildWake({ ...mainInput([call, results(['t9', 'ok'])]), ...(plan ? { plan } : {}), toolUseId: 't9', frontier: '## Objective\nx' }).messages[0] as BuiltMessage).text,
  ];

  it('carries the plan file with its path and content, and the plan-mode section while plan mode is on', () => {
    for (const text of facts({ mode: true, path: '/plans/p.md', content: '# Plan\n1. do it' })) {
      expect(text).toContain('## Plan mode\nThe session is in plan mode: plan, never act, until the user approves the plan; your plan file is /plans/p.md.');
      expect(text).toContain('## Plan file\n/plans/p.md\n# Plan\n1. do it');
    }
  });

  it('carries the plan file after plan mode ended, with no plan-mode section', () => {
    for (const text of facts({ mode: false, path: '/plans/p.md', content: '# Plan' })) {
      expect(text).toContain('## Plan file\n/plans/p.md\n# Plan');
      expect(text).not.toContain('## Plan mode');
    }
  });

  it('names a plan file that could not be read, leaves out one never written, and has neither with no plan known', () => {
    expect(facts({ mode: false, path: '/plans/p.md', problem: 'EACCES' })[0]).toContain('## Plan file\n/plans/p.md\n(could not be read: EACCES)');
    for (const text of facts({ mode: true, path: '/plans/p.md' })) expect([text.includes('## Plan mode'), text.includes('## Plan file')]).toEqual([true, false]);
    for (const text of facts()) expect(text).not.toMatch(/## Plan/);
  });
});
