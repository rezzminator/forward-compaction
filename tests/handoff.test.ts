import { describe, expect, it } from 'vitest';
import { BRIEF_MARKER, BRIEF_MAX_TOKENS, seatedBrief, type BriefMessage } from '../plugins/sub-agent-compact/src/brief.ts';
import {
  CONTINUE_AFTER_HANDOFF,
  HANDOFF_INPUT_SCHEMA,
  HANDOFF_MAX_CHARS,
  HANDOFF_STORED_PREFIX,
  handoffInputOf,
  handoffNotice,
  installLine,
  parseHandoff,
  recoverHandoff,
  transcriptShapeProblem,
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
  it('turns the compact tool off and the handoff tool on by default', () => {
    const options = resolveOptions({});
    expect(options.compactTool).toBe(false);
    expect(options.handoffTool).toBe(true);
  });

  it('reads both as on/off values', () => {
    const options = resolveOptions({ compactTool: 'on', handoffTool: false });
    expect(options.compactTool).toBe(true);
    expect(options.handoffTool).toBe(false);
  });

  it('names a bad value and keeps the default', () => {
    const options = resolveOptions({ compactTool: 'sometimes', handoffTool: 7 });
    expect(options.compactTool).toBe(false);
    expect(options.handoffTool).toBe(true);
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
    for (const part of [/only memory|whole memory|all you will have/, /next_step/, /goal/]) expect(HANDOFF_TOOL_DESCRIPTION).toMatch(part);
    expect(HANDOFF_INPUT_SCHEMA.properties.goal?.description).toMatch(/verbatim/);
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

// ---- the typed handoff ----

const GOAL = 'Rename the ledger column qty to quantity in every report (person, verbatim).';
const NEXT = 'Edit reports/c.sql:12, then run npm test.';
const mustFail = (input: Record<string, unknown>): string => {
  const parsed = parseHandoff(input);
  if (!('problem' in parsed)) throw new Error(`expected a problem, got a handoff: ${parsed.text}`);
  return parsed.problem;
};

describe('parseHandoff', () => {
  it('renders the two required fields alone, goal first and next step last', () => {
    expect(parseHandoff({ goal: GOAL, next_step: NEXT })).toEqual({ text: `**Goal**\n${GOAL}\n\n**Next step**\n${NEXT}`, loads: [] });
  });

  it('renders every filled field in a fixed order and omits the empty ones', () => {
    const parsed = parseHandoff({
      goal: GOAL,
      next_step: NEXT,
      standing_rules: ['no push'],
      done_verified: ['a.sql, b.sql: npm test 41/41'],
      decisions: ['keep the alias: other reports read qty'],
      dead_ends: ['sed across files: breaks c.sql'],
      files: ['reports/c.sql:12'],
      in_flight: ['nothing running'],
      notes: 'free text',
      load_on_wake: [],
    });
    if (!('text' in parsed)) throw new Error(parsed.problem);
    const labels = ['**Goal**', '**Standing rules**', '**Done (verified)**', '**Decisions**', '**Dead ends (do not retry)**', '**Files**', '**In flight**', '**Notes**', '**Next step**'];
    const at = labels.map((l) => parsed.text.indexOf(l));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(parsed.text).toContain('**Files**\n- reports/c.sql:12');
    const bare = parseHandoff({ goal: GOAL, next_step: NEXT, done_verified: [], decisions: '', files: ['  '], notes: '   ' });
    if (!('text' in bare)) throw new Error(bare.problem);
    expect(bare.text).toBe(`**Goal**\n${GOAL}\n\n**Next step**\n${NEXT}`);
  });

  it('adds little around the content: a full handoff is its words plus at most 200 characters of labels', () => {
    const fields = { goal: GOAL, next_step: NEXT, standing_rules: ['r1'], done_verified: ['d1'], decisions: ['x1'], dead_ends: ['e1'], files: ['f1'], in_flight: ['i1'], notes: 'n1' };
    const parsed = parseHandoff(fields);
    if (!('text' in parsed)) throw new Error(parsed.problem);
    const content = Object.values(fields).flat().join('').length;
    expect(parsed.text.length - content).toBeLessThanOrEqual(200);
  });

  it('names every missing or short required field at once', () => {
    const problem = mustFail({});
    expect(problem).toMatch(/^Not stored/);
    expect(problem).toMatch(/`goal`/);
    expect(problem).toMatch(/`next_step`/);
    expect(mustFail({ goal: GOAL })).toMatch(/`next_step`.*required/);
    expect(mustFail({ goal: 'rename it', next_step: NEXT })).toMatch(/`goal`.*characters/);
  });

  it('refuses a wrong type and an over-long field, naming the field and the limit', () => {
    expect(mustFail({ goal: GOAL, next_step: NEXT, done_verified: 5 })).toMatch(/`done_verified`.*list/);
    expect(mustFail({ goal: 'g'.repeat(3_001), next_step: NEXT })).toMatch(/`goal`.*3000/);
    expect(mustFail({ goal: GOAL, next_step: 'n'.repeat(1_001) })).toMatch(/`next_step`.*1000/);
    expect(mustFail({ goal: GOAL, next_step: NEXT, notes: 'n'.repeat(1_501) })).toMatch(/`notes`.*1500/);
    expect(mustFail({ goal: GOAL, next_step: NEXT, files: Array.from({ length: 13 }, (_, i) => `f${i}`) })).toMatch(/`files`.*12/);
    expect(mustFail({ goal: GOAL, next_step: NEXT, decisions: ['d'.repeat(501)] })).toMatch(/`decisions`.*500/);
  });

  it('refuses a total past the cap, with the size', () => {
    const big = Array.from({ length: 12 }, () => 'x'.repeat(500));
    const problem = mustFail({ goal: 'g'.repeat(3_000), next_step: NEXT, done_verified: big, decisions: big });
    expect(problem).toMatch(new RegExp(`${HANDOFF_MAX_CHARS}`));
  });

  it('takes a list as newline-separated lines, dropping dashes', () => {
    const parsed = parseHandoff({ goal: GOAL, next_step: NEXT, files: '- a.ts:1\n- b.ts:2\n\n' });
    if (!('text' in parsed)) throw new Error(parsed.problem);
    expect(parsed.text).toContain('**Files**\n- a.ts:1\n- b.ts:2\n');
  });

  it('still takes the free-text form of the earlier tool, validated as before', () => {
    expect(parseHandoff({ handoff: `  ${HANDOFF}  ` })).toEqual({ text: HANDOFF, loads: [] });
    expect(mustFail({ handoff: 'next: c.sql' })).toMatch(/^Not stored/);
    expect(mustFail({ handoff: 'x'.repeat(HANDOFF_MAX_CHARS + 1) })).toMatch(new RegExp(`${HANDOFF_MAX_CHARS}`));
  });

  it('returns the names to load when the model woke, and refuses a bad name or too many', () => {
    expect(parseHandoff({ goal: GOAL, next_step: NEXT, load_on_wake: ['/pfm-testing-manual', 'quality:prompt'] })).toMatchObject({ loads: ['pfm-testing-manual', 'quality:prompt'] });
    expect(mustFail({ goal: GOAL, next_step: NEXT, load_on_wake: ['../etc/passwd'] })).toMatch(/`load_on_wake`.*\.\.\/etc\/passwd/);
    // A colon becomes a path separator for commands: a segment that does not start alphanumeric could climb out.
    expect(mustFail({ goal: GOAL, next_step: NEXT, load_on_wake: ['x:..:..:etc'] })).toMatch(/`load_on_wake`.*x:\.\.:\.\.:etc/);
    expect(mustFail({ goal: GOAL, next_step: NEXT, load_on_wake: Array.from({ length: 9 }, (_, i) => `s${i}`) })).toMatch(/`load_on_wake`.*8/);
  });
});

describe('the tool text stays no longer than the free-text tool it replaces', () => {
  it('describes the tool and its fields in at most the 1568 characters of the earlier description and input text', () => {
    const fields = Object.values(HANDOFF_INPUT_SCHEMA.properties).map((p) => p.description.length);
    expect(Object.keys(HANDOFF_INPUT_SCHEMA.properties).sort()).toEqual(['decisions', 'dead_ends', 'done_verified', 'files', 'goal', 'in_flight', 'load_on_wake', 'next_step', 'notes', 'standing_rules'].sort());
    expect(HANDOFF_INPUT_SCHEMA.required).toEqual(['goal', 'next_step']);
    expect(HANDOFF_INPUT_SCHEMA.additionalProperties).toBe(false);
    expect(HANDOFF_TOOL_DESCRIPTION.length + fields.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1568);
  });
});

describe('handoffInputOf', () => {
  it('reads the fields from the event itself, or from its input when they are not at the top', () => {
    expect(handoffInputOf({ tool: 't', goal: 'a', next_step: 'b', tool_use_id: 'h1' })).toMatchObject({ goal: 'a', next_step: 'b' });
    expect(handoffInputOf({ tool: 't', input: { goal: 'a', next_step: 'b' } })).toEqual({ goal: 'a', next_step: 'b' });
    expect(handoffInputOf({ tool: 't', handoff: 'x' })).toMatchObject({ handoff: 'x' });
  });

  it('keeps a key that is not a field, so the check names it rather than dropping it unseen', () => {
    const input = handoffInputOf({ tool: 't', tool_use_id: 'h1', agentId: 'a1', goal: GOAL, next_step: NEXT, dead_end: ['x'] });
    expect(input).toEqual({ goal: GOAL, next_step: NEXT, dead_end: ['x'] });
    expect(mustFail(input)).toMatch(/`dead_end` is not a field/);
  });
});

describe('recoverHandoff', () => {
  const NAME = 'mcp__sub-agent-compact__handoff';
  const stored = (id: string, input: Record<string, unknown>, result = 'Handoff stored (1k tokens). At your next ...'): Msg[] => [
    say('', `a-${id}`, [{ tool_use_id: id, tool: NAME, input }]),
    results(`r-${id}`, [id, result]),
  ];
  const typed = { goal: GOAL, next_step: NEXT };

  it('finds the handoff the transcript shows stored, rendered, anchored on its call', () => {
    const found = recoverHandoff([user('go', 'u0'), ...stored('h1', typed)], NAME);
    expect(found).toEqual({ text: `**Goal**\n${GOAL}\n\n**Next step**\n${NEXT}`, anchor: { toolUseId: 'h1' }, loads: [] });
  });

  it('takes the last of two, and the free-text input of the earlier tool', () => {
    expect(recoverHandoff([...stored('h1', typed), ...stored('h2', { handoff: HANDOFF })], NAME)).toMatchObject({ text: HANDOFF, anchor: { toolUseId: 'h2' } });
  });

  it('ignores a call whose result says it was not stored, a call without a result, another tool and an invalid input', () => {
    expect(recoverHandoff(stored('h1', typed, 'Not stored: too early'), NAME)).toBeUndefined();
    expect(recoverHandoff([say('', 'a', [{ tool_use_id: 'h1', tool: NAME, input: typed }])], NAME)).toBeUndefined();
    expect(recoverHandoff(stored('h1', typed), 'mcp__other__handoff')).toBeUndefined();
    expect(recoverHandoff(stored('h1', { goal: GOAL }), NAME)).toBeUndefined();
  });

  it('never falls back to an earlier handoff when the latest stored one no longer reads: the latest replaced it', () => {
    expect(recoverHandoff([...stored('h1', typed), ...stored('h2', { handoff: 'x'.repeat(HANDOFF_MAX_CHARS + 1) })], NAME)).toBeUndefined();
  });

  it('reads the result from the call itself when the transcript records it there', () => {
    const msgs: Msg[] = [say('', 'a', [{ tool_use_id: 'h1', tool: NAME, input: typed, text: `${HANDOFF_STORED_PREFIX} (1k tokens).` }])];
    expect(recoverHandoff(msgs, NAME)).toMatchObject({ anchor: { toolUseId: 'h1' } });
  });

  it('leaves out a handoff the person spoke after: their message cancelled it', () => {
    expect(recoverHandoff([...stored('h1', typed), user('stop, do something else', 'u2')], NAME)).toBeUndefined();
    const carried: Msg = { ...results('r2', ['x', 'ok']), text: 'note delivered with the result' };
    expect(recoverHandoff([...stored('h1', typed), say('', 'a2', [{ tool_use_id: 'x', tool: 'Read', input: {} }]), carried], NAME)).toMatchObject({ anchor: { toolUseId: 'h1' } });
  });
});

describe('transcriptShapeProblem', () => {
  it('passes a transcript in the shape installs read, and names the first thing wrong otherwise', () => {
    expect(transcriptShapeProblem([user('a', 'u0'), say('b', 'a0', [])])).toBeUndefined();
    expect(transcriptShapeProblem(undefined)).toMatch(/not a list/);
    expect(transcriptShapeProblem([user('a', 'u0'), { role: 'assistant', text: 'x' }])).toMatch(/message 1.*toolUses/);
    expect(transcriptShapeProblem([{ role: 'system', text: 'x', toolUses: [] }])).toMatch(/message 0.*role/);
    expect(transcriptShapeProblem([{ role: 'user', text: 5, toolUses: [] }])).toMatch(/message 0.*text/);
  });
});

describe('what the model reads about its handoff', () => {
  it('opens every notice with the plugin name and carries the detail', () => {
    for (const kind of ['recovered', 'skipped', 'fallback', 'manual', 'marker-stored', 'marker-refused', 'shape'] as const) {
      expect(handoffNotice(kind, 'DETAIL')).toMatch(/^sub-agent-compact: /);
    }
    expect(handoffNotice('skipped', 'busy')).toMatch(/busy.*still stored|still stored.*busy/);
    expect(handoffNotice('fallback', 'not anchored')).toMatch(/not anchored.*summary|summary.*not anchored/);
    expect(handoffNotice('manual')).toMatch(/\/compact/);
    expect(handoffNotice('recovered')).toMatch(/transcript/);
    expect(handoffNotice('marker-refused', 'too short')).toMatch(/too short/);
  });

  it('says when a handoff installs: a sub-agent at Claude Code\'s ask, the main chat at the end of its turn', () => {
    const sub = handoffStoredText({ chars: 4_000, main: false, askPoint: 67_000 });
    expect(sub.startsWith(HANDOFF_STORED_PREFIX)).toBe(true);
    expect(sub).toMatch(/about 67k/);
    expect(sub).toMatch(/nothing is installed/);
    expect(handoffStoredText({ chars: 4_000, main: false })).toMatch(/next compaction ask/);
    expect(handoffStoredText({ chars: 4_000, main: true })).toMatch(/this turn ends/);
  });

  it('draws an install as sizes before and after, and warns when most of the context was kept', () => {
    expect(installLine({ label: 'main', before: 250_000, after: 25_000, tail: 0, recovered: false })).toEqual({ line: expect.stringMatching(/main.*250k.*25k/), warn: false });
    expect(installLine({ label: 'main', before: 250_000, after: 200_000, tail: 80, recovered: false }).warn).toBe(true);
    expect(installLine({ label: 'a1', before: undefined, after: 20_000, tail: 0, recovered: true }).line).toMatch(/recovered/);
  });

  it('leaves out the tool name only for a sub-agent whose tool did not register, and says nothing to the main chat', () => {
    const base = { tokens: 120_000, level: 0, autoCompact: 600_000, firstReading: 40_000 };
    expect(handoffNudgeText({ ...base, main: true, toolName: undefined })).toBeUndefined();
    const sub = handoffNudgeText({ ...base, main: false, toolName: undefined });
    expect(sub).toMatch(/<handoff>/);
    expect(sub).not.toMatch(/undefined|mcp__/);
  });

  it('is no longer than the nudge of the free-text tool it replaces', () => {
    const base = { tokens: 120_000, level: 0, autoCompact: 600_000, toolName: 'mcp__sub-agent-compact__handoff', firstReading: 40_000 };
    expect(handoffNudgeText({ ...base, main: true })!.length).toBeLessThanOrEqual(997);
    expect(handoffNudgeText({ ...base, main: false })!.length).toBeLessThanOrEqual(1032);
  });

  it('teaches the typed fields and carrying an earlier handoff forward', () => {
    const text = handoffNudgeText({ tokens: 120_000, level: 0, autoCompact: 600_000, main: true, toolName: 'mcp__sub-agent-compact__handoff', firstReading: undefined });
    expect(text).toMatch(/next_step/);
    expect(text).toMatch(/goal/);
    expect(text).toMatch(/earlier handoff/);
  });
});
