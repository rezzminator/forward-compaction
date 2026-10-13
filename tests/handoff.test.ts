import { describe, expect, it } from 'vitest';
import { BRIEF_MARKER, BRIEF_MAX_TOKENS, seatedBrief, type BriefMessage } from '../plugins/sub-agent-compact/src/brief.ts';
import {
  CONTINUE_AFTER_HANDOFF,
  HANDOFF_INPUT_DESCRIPTION,
  HANDOFF_MIN_CHARS,
  HANDOFF_OPENING,
  HANDOFF_TOOL_DESCRIPTION,
  handoffDisarmedText,
  handoffMarker,
  handoffMarkerRequest,
  handoffNudgeText,
  handoffProblem,
  handoffRefusal,
  handoffStopRequest,
  handoffStoredText,
  installHandoff,
} from '../plugins/sub-agent-compact/src/handoff.ts';
import { resolveOptions } from '../plugins/sub-agent-compact/src/limits.ts';
import { Parties } from '../plugins/sub-agent-compact/src/parties.ts';

type Use = { tool_use_id: string; tool: string; input: Record<string, unknown>; text?: string };
type Msg = BriefMessage & { toolUses: readonly Use[]; toolResults?: readonly { tool_use_id: string; text: string; isError: boolean }[] };

const HANDOFF = [
  'Task (person, verbatim): "rename the ledger column qty to quantity in every report".',
  'Done: reports/a.sql and reports/b.sql renamed; `npm test` 41/41 green after each.',
  'Facts: reports/c.sql:12 reads `SELECT qty, price FROM ledger` and is the last one.',
  'Next step: edit reports/c.sql:12, then run npm test.',
].join('\n');

const user = (text: string, handle: string): Msg => ({ role: 'user', text, toolUses: [], handle });
const say = (text: string, handle: string, toolUses: Use[] = []): Msg => ({ role: 'assistant', text, toolUses, handle });
const results = (handle: string, ...pairs: [string, string][]): Msg => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: pairs.map(([id, text]) => ({ tool_use_id: id, text, isError: false })),
  handle,
});
const handoffUse = (id = 'h1', text = HANDOFF): Use => ({ tool_use_id: id, tool: 'mcp__sub-agent-compact__handoff', input: { handoff: text } });
const read = (id: string, path: string): Use => ({ tool_use_id: id, tool: 'Read', input: { file_path: path } });

describe('resolveOptions: the two tool flags', () => {
  it('turns the compact tool on and the handoff tool off by default', () => {
    const options = resolveOptions({});
    expect(options.compactTool).toBe(true);
    expect(options.handoffTool).toBe(false);
  });

  it('reads both as on/off values', () => {
    const options = resolveOptions({ compactTool: 'off', handoffTool: true });
    expect(options.compactTool).toBe(false);
    expect(options.handoffTool).toBe(true);
  });

  it('names a bad value and keeps the default', () => {
    const options = resolveOptions({ compactTool: 'sometimes', handoffTool: 7 });
    expect(options.compactTool).toBe(true);
    expect(options.handoffTool).toBe(false);
    expect(options.errors.some((line) => line.includes('compactTool'))).toBe(true);
    expect(options.errors.some((line) => line.includes('handoffTool'))).toBe(true);
  });
});

describe('handoffProblem', () => {
  it('refuses a missing, empty or too short handoff, saying what it must carry', () => {
    for (const bad of [undefined, 42, '', '   ', 'next: c.sql']) {
      const problem = handoffProblem(bad);
      expect(problem).toMatch(/^Not stored:/);
      expect(problem).toMatch(/next step/);
    }
    expect(handoffProblem('x'.repeat(HANDOFF_MIN_CHARS - 1))).toBeDefined();
  });

  it('accepts a handoff of substance', () => {
    expect(handoffProblem(HANDOFF)).toBeUndefined();
  });
});

describe('handoffRefusal', () => {
  it('refuses Haiku, an ungoverned loop and a party below its first nudge point, and lets the rest through', () => {
    expect(handoffRefusal({ haiku: true, unlisted: false, tokens: 150_000, nudgeStart: 100_000 })).toMatch(/Haiku/);
    expect(handoffRefusal({ haiku: false, unlisted: true, tokens: 150_000, nudgeStart: 100_000 })).toMatch(/does not govern/);
    expect(handoffRefusal({ haiku: false, unlisted: false, tokens: 60_000, nudgeStart: 100_000 })).toMatch(/60k, below 100k/);
    expect(handoffRefusal({ haiku: false, unlisted: false, tokens: 150_000, nudgeStart: 100_000 })).toBeUndefined();
    expect(handoffRefusal({ haiku: false, unlisted: false, tokens: undefined, nudgeStart: 100_000 })).toBeUndefined();
  });
});

describe('the handoff tool teaches what to pass', () => {
  it('says the text is installed verbatim as the whole past, with no summary, and that a left-out detail is lost', () => {
    expect(HANDOFF_TOOL_DESCRIPTION).toMatch(/verbatim/);
    expect(HANDOFF_TOOL_DESCRIPTION).toMatch(/[Nn]othing summarizes/);
    expect(HANDOFF_TOOL_DESCRIPTION).toMatch(/re-read/);
    expect(HANDOFF_TOOL_DESCRIPTION).toMatch(/kept/);
  });

  it('lists what goes in: fixed values, evidence, the facts with their anchors, decisions, what is left, the next step', () => {
    for (const part of [/fixed/, /evidence/, /file:line/, /rejected/, /in flight/, /next step/]) expect(HANDOFF_TOOL_DESCRIPTION).toMatch(part);
    expect(HANDOFF_INPUT_DESCRIPTION).toMatch(/only memory/);
  });

  it('says when not to call it', () => {
    expect(HANDOFF_TOOL_DESCRIPTION).toMatch(/person waits/);
    expect(HANDOFF_TOOL_DESCRIPTION).toMatch(/final answer/);
    expect(HANDOFF_TOOL_DESCRIPTION).toMatch(/nudged/);
  });
});

describe('handoffMarker', () => {
  it('reads the handoff between the tags, trimmed, and ignores a quoted or empty marker', () => {
    expect(handoffMarker(`working <handoff>\n${HANDOFF}\n</handoff>`)).toBe(HANDOFF);
    expect(handoffMarker('`<handoff>x</handoff>`')).toBeUndefined();
    expect(handoffMarker('<handoff>  </handoff>')).toBeUndefined();
    expect(handoffMarker('no marker')).toBeUndefined();
  });

  it('counts a sub-agent response that also calls a tool, never the main chat or a final answer', () => {
    const answer = `<handoff>${HANDOFF}</handoff>`;
    expect(handoffMarkerRequest({ answer, toolCalls: 1, main: false })).toBe(HANDOFF);
    expect(handoffMarkerRequest({ answer, toolCalls: 0, main: false })).toBeUndefined();
    expect(handoffMarkerRequest({ answer, toolCalls: 1, main: true })).toBeUndefined();
  });

  it('keeps a sub-agent going once when it stopped on a lone marker', () => {
    expect(handoffStopRequest({ lastMessage: `<handoff>${HANDOFF}</handoff>`, continued: false })).toBe(HANDOFF);
    expect(handoffStopRequest({ lastMessage: `<handoff>${HANDOFF}</handoff>`, continued: true })).toBeUndefined();
    expect(CONTINUE_AFTER_HANDOFF).toMatch(/not done/);
  });
});

describe('handoffNudgeText', () => {
  const base = { tokens: 120_000, level: 0, autoCompact: 600_000, toolName: 'mcp__sub-agent-compact__handoff', firstReading: 40_000 };

  it('frames the size as what every request re-sends and what a handoff would cut it to', () => {
    const text = handoffNudgeText({ ...base, main: true });
    expect(text).toMatch(/120k/);
    expect(text).toMatch(/every request re-sends/);
    expect(text).toMatch(/about 40k plus your handoff/);
    expect(text).toMatch(/mcp__sub-agent-compact__handoff/);
  });

  it('teaches the content: verbatim values, evidence, the facts the rest uses, so nothing is read again', () => {
    const text = handoffNudgeText({ ...base, main: true });
    expect(text).toMatch(/verbatim/);
    expect(text).toMatch(/read again/);
    expect(text).toMatch(/next step/);
  });

  it('never names the compact tool', () => {
    for (const main of [true, false]) for (const level of [0, 3]) expect(handoffNudgeText({ ...base, main, level })).not.toMatch(/__compact\b|compact-now|compact yourself/);
  });

  it('puts the person and the final answer first, and escalates past the first nudge', () => {
    expect(handoffNudgeText({ ...base, main: true })).toMatch(/person/);
    expect(handoffNudgeText({ ...base, main: false })).not.toMatch(/person/);
    expect(handoffNudgeText({ ...base, main: true })).toMatch(/final answer/);
    expect(handoffNudgeText({ ...base, main: true, level: 2 })).toMatch(/Nudge 3/);
  });

  it('asks for the handoff as the next call, never deferred past a step that may be the last', () => {
    for (const level of [0, 2]) {
      const text = handoffNudgeText({ ...base, main: true, level });
      expect(text).toMatch(/your next call, before any other tool/);
      expect(text).not.toMatch(/finish the step in hand|very next milestone/);
    }
  });

  it('gives a sub-agent the marker beside the tool', () => {
    expect(handoffNudgeText({ ...base, main: false })).toMatch(/<handoff>/);
    expect(handoffNudgeText({ ...base, main: true })).not.toMatch(/<handoff>/);
  });

  it('leaves the estimate out when the first reading is unknown', () => {
    expect(handoffNudgeText({ ...base, main: true, firstReading: undefined })).not.toMatch(/plus your handoff/);
  });
});

describe('handoffStoredText and handoffDisarmedText', () => {
  it('says the handoff replaces everything before the call, keeps what follows, and to carry on', () => {
    const text = handoffStoredText({ chars: 4_000 });
    expect(text).toMatch(/1k tokens/);
    expect(text).toMatch(/everything before this call/);
    expect(text).toMatch(/kept/);
    expect(text).toMatch(/[Cc]arry on/);
  });

  it('tells the main chat the person cancelled it', () => {
    expect(handoffDisarmedText()).toMatch(/cancelled/);
  });
});

describe('installHandoff', () => {
  const history = (): Msg[] => [
    user('rename qty to quantity in every report', 'm0'),
    say('', 'm1', [read('r1', 'reports/a.sql')]),
    results('m2', ['r1', 'SELECT qty FROM ledger']),
    say('', 'm3', [handoffUse()]),
    results('m4', ['h1', 'Handoff stored.']),
  ];

  it('makes the handoff the whole past when nothing followed its call', () => {
    const out = installHandoff(history(), { text: HANDOFF, anchor: { toolUseId: 'h1' } });
    expect(out).toBeDefined();
    expect(out!.messages).toHaveLength(1);
    const [only] = out!.messages;
    expect(only!.role).toBe('user');
    expect(only!.handle).toBeUndefined();
    expect(only!.text.startsWith(HANDOFF_OPENING)).toBe(true);
    expect(only!.text).toContain(HANDOFF);
    expect(out!.tail).toBe(0);
  });

  it('keeps every message after the call, whole, with its handle', () => {
    const input = [...history(), say('editing c.sql', 'm5', [read('r2', 'reports/c.sql')]), results('m6', ['r2', 'SELECT qty, price'])];
    const out = installHandoff(input, { text: HANDOFF, anchor: { toolUseId: 'h1' } })!;
    expect(out.messages).toHaveLength(3);
    expect(out.messages[1]).toBe(input[5]);
    expect(out.messages[2]).toBe(input[6]);
    expect(out.tail).toBe(2);
    expect(out.messages[0]!.text).toMatch(/after writing it follows/);
  });

  it('carries the results of tool calls made beside the handoff call as text, since the handoff never saw them', () => {
    const input = [
      user('task', 'm0'),
      say('', 'm1', [handoffUse(), read('r9', 'reports/z.sql')]),
      results('m2', ['h1', 'Handoff stored.'], ['r9', 'SELECT zebra FROM ledger']),
    ];
    const out = installHandoff(input, { text: HANDOFF, anchor: { toolUseId: 'h1' } })!;
    expect(out.siblings).toBe(1);
    expect(out.messages[0]!.text).toContain('SELECT zebra FROM ledger');
    expect(out.messages[0]!.text).toContain('reports/z.sql');
    expect(out.messages[0]!.text).not.toContain('Handoff stored.');
  });

  it('treats a response split over several messages, one per content block, as one response with its results', () => {
    const input = [
      user('task', 'm0'),
      say('wrapping up b.sql', 'm1'),
      say('', 'm2', [handoffUse()]),
      say('', 'm3', [read('r9', 'reports/z.sql')]),
      results('m4', ['h1', 'Handoff stored.']),
      results('m5', ['r9', 'SELECT zebra FROM ledger']),
      say('next', 'm6'),
    ];
    const out = installHandoff(input, { text: HANDOFF, anchor: { toolUseId: 'h1' } })!;
    expect(out.siblings).toBe(1);
    expect(out.messages[0]!.text).toContain('SELECT zebra FROM ledger');
    expect(out.messages.slice(1)).toEqual([input[6]]);
  });

  it('seats a sub-agent brief first and the handoff last, so the next step is the freshest thing read', () => {
    const brief = `${BRIEF_MARKER}\nbrief: rename qty in reports/`;
    const out = installHandoff(history(), { text: HANDOFF, anchor: { toolUseId: 'h1' }, brief })!;
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]!.text).toBe(brief);
    expect(out.messages[1]!.text).toContain(HANDOFF);
  });

  it('anchors a marker handoff on the response that carried it', () => {
    const input = [
      user('task', 'm0'),
      say(`done with b.sql <handoff>${HANDOFF}</handoff>`, 'm1', [read('r3', 'reports/c.sql')]),
      results('m2', ['r3', 'SELECT qty, price']),
      say('next', 'm3'),
    ];
    const out = installHandoff(input, { text: HANDOFF, anchor: { marker: true } })!;
    expect(out.siblings).toBe(1);
    expect(out.messages[0]!.text).toContain('SELECT qty, price');
    expect(out.messages[1]).toBe(input[3]);
  });

  it('is undefined when the call is not in the transcript, so the caller falls back to a summary', () => {
    expect(installHandoff(history(), { text: HANDOFF, anchor: { toolUseId: 'nope' } })).toBeUndefined();
    expect(installHandoff(history(), { text: HANDOFF, anchor: { marker: true } })).toBeUndefined();
  });

  it('replaces an earlier handoff and its brief copy, keeping exactly one brief', () => {
    const brief = `${BRIEF_MARKER}\nbrief: rename qty`;
    const first = installHandoff(history(), { text: HANDOFF, anchor: { toolUseId: 'h1' }, brief })!.messages as Msg[];
    const again: Msg[] = [
      ...first.map((m, i) => ({ ...m, handle: `p${i}` })),
      say('', 'p9', [handoffUse('h2', `${HANDOFF}\nDone: c.sql too.`)]),
      results('p10', ['h2', 'stored']),
    ];
    const out = installHandoff(again, { text: `${HANDOFF}\nDone: c.sql too.`, anchor: { toolUseId: 'h2' }, brief: seatedBrief(again, BRIEF_MAX_TOKENS) })!;
    expect(out.messages).toHaveLength(2);
    expect(out.messages.filter((m) => m.text.startsWith(BRIEF_MARKER))).toHaveLength(1);
    expect(out.messages[1]!.text).toContain('Done: c.sql too.');
  });
});

describe('seatedBrief', () => {
  it('is the marked copy of the first user message, or the copy an earlier compaction seated', () => {
    expect(seatedBrief([user('the brief', 'a'), say('x', 'b')], BRIEF_MAX_TOKENS)).toBe(`${BRIEF_MARKER}\nthe brief`);
    expect(seatedBrief([user('summary', 'a'), user(`${BRIEF_MARKER}\nold`, 'b')], BRIEF_MAX_TOKENS)).toBe(`${BRIEF_MARKER}\nold`);
    expect(seatedBrief([say('x', 'b')], BRIEF_MAX_TOKENS)).toBeUndefined();
  });
});

describe('Parties: handoffs', () => {
  it('holds the latest handoff, sends no nudge while one waits, and drops it on a compaction or a cancel', () => {
    const parties = new Parties();
    parties.read('main', 130_000);
    parties.armHandoff('main', { text: HANDOFF, anchor: { toolUseId: 'h1' } });
    expect(parties.handoff('main')?.text).toBe(HANDOFF);
    expect(parties.nudgeDue('main', 100_000, 10_000)).toBeUndefined();
    parties.armHandoff('main', { text: 'newer', anchor: { toolUseId: 'h2' } });
    expect(parties.handoff('main')?.anchor).toEqual({ toolUseId: 'h2' });
    parties.compacted('main', 5_000);
    expect(parties.handoff('main')).toBeUndefined();
    parties.armHandoff('main', { text: HANDOFF, anchor: { toolUseId: 'h3' } });
    expect(parties.disarm('main')).toBe(true);
    expect(parties.handoff('main')).toBeUndefined();
  });

  it('keeps one request at a time: a handoff replaces an armed compaction and the other way round', () => {
    const parties = new Parties();
    parties.arm('a', 'focus');
    parties.armHandoff('a', { text: HANDOFF, anchor: { toolUseId: 'h1' } });
    expect(parties.armed('a')).toBeUndefined();
    parties.arm('a', 'focus');
    expect(parties.handoff('a')).toBeUndefined();
  });

  it('remembers each party first reading across compactions', () => {
    const parties = new Parties();
    parties.read('main', 41_000);
    parties.read('main', 90_000);
    parties.compacted('main', 3_000);
    parties.read('main', 44_000);
    expect(parties.firstReading('main')).toBe(41_000);
  });
});
