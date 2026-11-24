import { describe, expect, it } from 'vitest';
import { forkDueOf, forkEndLine, forkFailure, forkFields, forkPoint, forkPrompt, forkReply, forkRow, forkStand, forkStartLine, forkTrailing, FORK_RESULT_MAX_CHARS, type ForkDue } from '../plugins/forward-compaction/src/fork.ts';
import { decide, type DecideInput } from '../plugins/forward-compaction/src/decide.ts';
import { emptyHeld, type Held } from '../plugins/forward-compaction/src/lists.ts';
import { assistant, results, user, type Msg } from './fakes/messages.ts';
import { buildWake, forkWake, mechanicalWake, type WakeFacts } from '../plugins/forward-compaction/src/wake.ts';
import type { BuiltMessage } from '../plugins/forward-compaction/src/kept.ts';

const noFacts: WakeFacts = { user: [], notices: [], received: [], skills: [], unattributedSkills: [] };
// 3.5 characters a token stands in for the ratio the adapter measures (window.ts `charsPerToken`).
const mainInput = (messages: Msg[]) => ({ tokens: 41_200, askPoint: 67_000, now: Date.UTC(2026, 9, 23, 10, 1, 0), charsPerToken: 3.5, messages, party: 'main' as const, facts: () => noFacts });

const nudge: ForkDue = { point: 2, notice: { row: { event: 'nudge', party: 'main', level: 2 }, text: 'nudge text' } };
const finish: ForkDue = { point: 'finish', notice: { row: { event: 'finish-notice', party: 'main' }, text: 'finish text' } };

describe('forkDueOf', () => {
  it("takes a nudge's level, and the finish notice as the finish point, keeping the notice for a failure", () => {
    expect(forkDueOf(nudge.notice)).toEqual(nudge);
    expect(forkDueOf(finish.notice)).toEqual(finish);
  });
});

describe('forkPoint: the due decision', () => {
  const base: DecideInput = { trigger: 'auto', party: 'main', stored: false, tokens: 80_000, ceiling: 100_000 };
  const at = (patch: Partial<DecideInput>, due?: ForkDue) => { const input = { ...base, ...patch }; return forkPoint({ trigger: input.trigger, action: decide(input), ...(due !== undefined ? { due } : {}) }); };
  it.each([
    ['an automatic ask with a nudge level due', {}, nudge, 2],
    ['an automatic ask with only the finish point due waits for the turn end', {}, finish, undefined],
    ["the plugin's turn-end ask with a nudge level due", { trigger: 'plugin' as const }, nudge, 2],
    ["the plugin's turn-end ask at the finish point", { trigger: 'plugin' as const }, finish, 'finish'],
    ["the plugin's turn-end ask with nothing due", { trigger: 'plugin' as const }, undefined, undefined],
    ['an automatic ask with nothing due', {}, undefined, undefined],
    ['the ceiling, due or not', { tokens: 100_000 }, undefined, 'ceiling'],
    ['one token below the ceiling with nothing due', { tokens: 99_999 }, undefined, undefined],
    ['a request too long', { reactive: true }, nudge, undefined],
    ['a stored call that compacts installs with no fork', { stored: true }, nudge, undefined],
    ['a manual /compact', { trigger: 'manual' as const }, nudge, undefined],
    ['a precompute', { trigger: 'precompute' as const }, nudge, undefined],
    ['the ceiling under Claude Code\'s own summary', { tokens: 100_000, ceilingNative: true }, nudge, undefined],
  ])('%s', (_name, patch, due, want) => {
    expect(at(patch, due)).toEqual(want);
  });
});

describe('forkFailure: each failure\'s fallback', () => {
  it.each([
    [2, 'nothing-to-fork', 'retry'], [2, 'aborted', 'retry'], ['finish', 'aborted', 'retry'],
    [2, 'api-error', 'notice'], [2, 'empty-reply', 'notice'], [2, 'no-json', 'notice'], [2, 'threw', 'notice'], ['finish', 'store-failed', 'notice'],
    ['ceiling', 'nothing-to-fork', 'mechanical'], ['ceiling', 'api-error', 'mechanical'],
  ] as const)('at %s, %s → %s', (point, failure, want) => {
    expect(forkFailure(point, failure)).toBe(want);
  });
});

describe('forkReply: the reply read as a call', () => {
  const args = { next: 'run the tests', done: { add: ['built {x}'] } };
  it.each([
    ['a bare object', JSON.stringify(args), { ok: true, args, notes: [] }],
    ['a fenced object', '```json\n' + JSON.stringify(args) + '\n```', { ok: true, args, notes: ['fenced'] }],
    ['prose around it', 'Here it is:\n' + JSON.stringify(args) + '\nDone.', { ok: true, args, notes: ['prose-around'] }],
    ['broken JSON, repaired', '{"next": "run the tests", "done": {"add": ["built {x}"]}', { ok: true, args, notes: ['repaired'] }],
    ['no object', 'I cannot do that.', { ok: false, error: 'the reply holds no JSON object' }],
    ['no reading parses', '{next: run}', { ok: false, error: "the reply's JSON does not parse, repaired or not" }],
  ])('%s', (_name, text, want) => {
    expect(forkReply(text)).toEqual(want);
  });
});

describe('forkTrailing: what the working model has not answered', () => {
  it('a mid-turn ask: the last assistant run and its unsent results', () => {
    const messages = [user('go'), assistant('one', [{ id: 'a', tool: 'Read' }]), results(['a', 'old']), assistant('two', [{ id: 'b', tool: 'Bash' }]), assistant('', [{ id: 'c', tool: 'Read' }]), results(['b', 'ok'], ['c', 'file'])];
    expect(forkTrailing(messages)).toEqual({ from: 3, results: [{ tool: 'Bash', id: 'b', text: 'ok' }, { tool: 'Read', id: 'c', text: 'file' }] });
  });
  it('a turn end: the last answer, no result', () => {
    expect(forkTrailing([user('go'), assistant('done')])).toEqual({ from: 1, results: [] });
  });
  it('no assistant message: nothing trails', () => {
    expect(forkTrailing([user('go')])).toEqual({ from: 1, results: [] });
  });
});

describe('forkFields', () => {
  it("renders each described field of the tool's schema, nested ones indented, undescribed ones left out", () => {
    const schema = { properties: { next: { description: 'The next step.' }, done: { description: 'Finished.', properties: { add: { description: 'New items.' } } }, load_files: { description: 'Files.', items: { properties: { path: { description: 'Absolute path.' }, lines: {} } } } } };
    expect(forkFields(schema)).toEqual(['- `next`: The next step.', '- `done`: Finished.', '  - `add`: New items.', '- `load_files`: Files.', '  - `path`: Absolute path.']);
  });
  it("is generated from the registered tool's own schema", () => {
    expect(forkFields().slice(0, 2)).toEqual([
      '- `objective`: What the work is for and what done means. Send it on your first call, then only when it changes. Once it is reached, the call that sends the next one reviews every order.',
      '- `next`: Every call: the first concrete action after the wake.',
    ]);
  });
});

const HOW = `## How to write it

- Send changes only: \`add\` new items; \`remove\` and \`edit\` by the numbers shown above. What you leave out stays as it is.
- Clean as you go: remove each \`remaining\` step that is finished, replaced or listed twice, each \`blocked\` question the user answered, each \`findings\` item the rest of the work no longer needs. A finished step becomes one \`done\` item saying how it was verified.
- \`next\` every time: the first action after the wake, exact enough to take with nothing else in view. When a step was in progress, name it and what it waits for: a running agent or command by its name or id, a file half edited.
- Keep what cannot be found again: a ruling or number the user gave, a decision of your own with its reason, an error text, a command that worked, an id or path the next steps need. For what a file or a command holds, name the path or the command instead of copying it.
- The user's words stay the user's words: a ruling goes to \`decisions\`, a rule that binds the rest of the work to \`orders\`, quoted as given. Add no order the user did not give.
- Write only what the conversation shows: a result not seen is not recorded as done.

The reply is one JSON object, the call's arguments, and nothing else.`;

describe('forkPrompt (golden)', () => {
  it.each([
    [false, "The turn is still running: that last message's tool calls have their results below."],
    [true, "The turn has ended: that last message was sent to the user as it stands, and the next thing to arrive is the user's next message."],
  ] as const)('where the turn stands, ended %s', (ended, line) => {
    expect(forkStand(ended)).toBe(line);
  });

  const held: Held = emptyHeld();
  held.objective = 'Ship the parser.';
  held.lists.orders.items = [{ id: 1, text: 'Never push.' }];
  held.lists.done.items = [{ id: 1, text: 'Old step.' }, { id: 2, text: 'Tests pass.', round: 1 }];
  held.lists.remaining.items = [{ id: 3, text: 'Write the docs.' }];
  const schema = { properties: { next: { description: 'The next step.' } } };

  it('a mid-turn ask: the frontier numbered, done split, storage listed, the unsent results, the fields from the schema', () => {
    const { text, sizes } = forkPrompt({ held, done: { shown: [held.lists.done.items[1]!], earlier: [held.lists.done.items[0]!], path: '/state/done-earlier.md' }, storage: [{ name: 'plan.md', description: 'the plan' }], results: [{ tool: 'Bash', id: 'b', text: 'ok' }], tool: 'forward_compaction', schema, ended: false });
    expect(text).toBe(`[forward-compaction: write the frontier]

This conversation is about to be compacted. Everything above this message is dropped except its last assistant message; the work continues from the frontier alone, beside the user's own messages and standing orders, which the plugin carries verbatim. The turn is still running: that last message's tool calls have their results below. Bring the frontier below up to this moment, so the work continues with nothing lost.

Reply with one JSON object and nothing else: the arguments of one \`forward_compaction\` call, as that tool takes them. No tool runs here; the plugin stores your reply as that call.

## The frontier as stored now

### objective
Ship the parser.

### next
(empty)

### orders
[1] Never push.

### decisions
(empty)

### done
1 earlier done item, [1], is in /state/done-earlier.md, whole under its number: finished work like the items below, edited or removed by number like them. Read the file when a step or the final report may rest on one.
[2] Tests pass.

### remaining
[3] Write the docs.

### blocked
(empty)

### findings
(empty)

## Storage files

- plan.md: the plan

## Tool results after the conversation above

The conversation above ends at its last tool calls. These are their results, which it does not show: count them in.

### Bash (b)
ok

## The call's fields

- \`next\`: The next step.

${HOW}`);
    expect(sizes).toEqual({ chars: 2598, frontier: 421, storage: 19, results: 15, fields: 24 });
  });

  it('a turn end: no results section, no storage, a long result cut where one trails', () => {
    const { text } = forkPrompt({ held: emptyHeld(), storage: [], results: [], tool: 't', schema, ended: true });
    expect(text.split('\n\n')[1]).toBe("This conversation is about to be compacted. Everything above this message is dropped except its last assistant message; the work continues from the frontier alone, beside the user's own messages and standing orders, which the plugin carries verbatim. The turn has ended: that last message was sent to the user as it stands, and the next thing to arrive is the user's next message. Bring the frontier below up to this moment, so the work continues with nothing lost.");
    expect(text).toContain('## Storage files\n\nnone\n\n## The call\'s fields');
    expect(text).not.toContain('## Tool results');
    const long = forkPrompt({ held: emptyHeld(), storage: [], results: [{ tool: 'Read', id: 'r', text: 'x'.repeat(FORK_RESULT_MAX_CHARS + 1) }], tool: 't', schema, ended: false }).text;
    expect(long).toContain(`### Read (r)\n${'x'.repeat(FORK_RESULT_MAX_CHARS)}\n[cut: 8,000 of 8,001 characters shown]\n\n## The call's fields`);
    const whole = forkPrompt({ held: emptyHeld(), storage: [], results: [{ tool: 'Read', id: 'r', text: 'x'.repeat(FORK_RESULT_MAX_CHARS) }], tool: 't', schema, ended: false }).text;
    expect(whole).toContain(`### Read (r)\n${'x'.repeat(FORK_RESULT_MAX_CHARS)}\n\n## The call's fields`);
  });
});

describe('forkRow and its lines', () => {
  it("keeps the reply's usage whole and the failure's status and error", () => {
    expect(forkRow({ point: 2, outcome: 'applied', ms: 4200, effort: 'low', usage: { input_tokens: 3, output_tokens: 900, cache_read_input_tokens: 64_000, cache_creation_input_tokens: 12 }, promptChars: 5000, replyChars: 1800, trailing: 3, notes: ['fenced'] }))
      .toEqual({ event: 'fork', party: 'main', point: 2, outcome: 'applied', ms: 4200, effort: 'low', usage: { input: 3, cacheRead: 64_000, cacheWritten: 12, output: 900 }, promptChars: 5000, replyChars: 1800, trailing: 3, notes: ['fenced'] });
    expect(forkRow({ point: 'finish', outcome: 'api-error', ms: 10, promptChars: 5000, trailing: 1, status: null, error: 'invalid_request' }))
      .toEqual({ event: 'fork', party: 'main', point: 'finish', outcome: 'api-error', ms: 10, effort: null, usage: null, promptChars: 5000, replyChars: null, trailing: 1, status: null, error: 'invalid_request' });
  });
  it('says where the fork starts and how it ended', () => {
    expect(forkStartLine(2, 64_000)).toBe('forward-compaction: main reached nudge level 2 at 64,000 tokens; a fork is writing its frontier.');
    expect(forkEndLine(2, 'applied', 4200)).toBe("forward-compaction: the fork wrote main's frontier in 4.2 s; it installs now.");
    expect(forkEndLine('finish', 'api-error', 900, 'notice')).toBe('forward-compaction: the fork wrote no frontier at the finish point (api-error, 0.9 s); main reads the finish notice instead.');
    expect(forkEndLine(3, 'no-json', 900, 'notice')).toBe('forward-compaction: the fork wrote no frontier at nudge level 3 (no-json, 0.9 s); main reads the nudge instead.');
    expect(forkEndLine(3, 'nothing-to-fork', 0, 'retry')).toBe('forward-compaction: the fork wrote no frontier at nudge level 3 (nothing-to-fork, 0.0 s); the fork is tried again at the next compaction ask.');
    expect(forkEndLine('ceiling', 'threw', 0, 'mechanical')).toBe('forward-compaction: the fork wrote no frontier at the ceiling (threw, 0.0 s); the mechanical wake installs.');
  });
});

describe('forkWake: the frontier a fork wrote', () => {
  const frontier = '## Objective\nship\n## Next\nz';
  const opening = '[forward-compaction: frontier] Below is your frontier, brought up to date by forward-compaction from the conversation at this compaction: continue from its ## Next. forward-compaction brings this frontier up to date itself at each compaction: nothing is asked of you for it.';
  const exp = '\nforward-compaction is experimental. If it gave you any trouble, append a short note of what happened to your reply.';
  const tail = (n: number) => Array.from({ length: n }, (_, i) => assistant(`${i}`.repeat(1000), [], `f${i}`));
  const useA = assistant('x'.repeat(4000), [{ id: 'r1', tool: 'Read' }]), answer = results(['r1', 'y'.repeat(4000)]);

  const head = (kept: string) => `${opening}\n\n=== frontier ===\n${frontier}\n=== end of frontier ===\n\n${kept}${exp}`;

  it.each([
    { name: 'a turn end keeps only the final reply', messages: () => [user('a'), ...tail(3), assistant('done')], trailing: 1, askPoint: 67_000, kept: () => [assistant('done')], counts: [1, 4], line: 'Your last message follows, kept verbatim: continue from where they leave off. 4 older messages are not carried (look_back finds an exact detail).' },
    { name: 'a mid-turn ask keeps the last assistant message and its tool results', messages: () => [user('a'), ...tail(10), useA, answer], trailing: 2, askPoint: 67_000, kept: () => [useA, answer], counts: [2, 11], line: 'Your last 2 messages follow, kept verbatim: continue from where they leave off. 11 older messages are not carried (look_back finds an exact detail).' },
    { name: 'a last message over the budget goes with its results, as after a call', messages: () => [user('a'), ...tail(10), useA, answer], trailing: 2, askPoint: 4000, kept: () => [], counts: [0, 13], line: '13 older messages are not carried (look_back finds an exact detail).\n\nContinue from ## Next.' },
  ])('$name', ({ messages, trailing, askPoint, kept, counts, line }) => {
    const wake = forkWake({ ...mainInput(messages()), askPoint, frontier, trailing });
    expect([wake.kept, wake.dropped]).toEqual(counts);
    expect(wake.messages.slice(2)).toEqual(kept());
    expect((wake.messages[1] as BuiltMessage).text).toBe(head(line));
  });

  it('unmeasured, keeps the last assistant message and what follows it; with none trailing, none', () => {
    const messages = [user('a'), ...tail(3), useA, answer];
    expect(forkWake({ ...mainInput(messages), charsPerToken: undefined, frontier, trailing: 2 }).messages.slice(2)).toEqual([useA, answer]);
    const none = forkWake({ ...mainInput(messages), charsPerToken: undefined, frontier, trailing: 0 });
    expect([none.kept, none.dropped]).toEqual([0, 6]);
    expect((none.messages[1] as BuiltMessage).text).toBe(head('6 older messages are not carried (look_back finds an exact detail).\n\nContinue from ## Next.'));
  });

  it('names a missing objective or next with no ask for a call', () => {
    const h = forkWake({ ...mainInput([user('a')]), charsPerToken: undefined, frontier, trailing: 0, missing: ['objective'] }).messages[1] as BuiltMessage;
    expect(h.text).toContain("Your frontier has no objective: re-establish it from the user's messages and the messages below.\n\n");
  });
});

describe('forkUpkeep: no ask for a call while the plugin forks', () => {
  const call = assistant('writing the frontier', [{ id: 't9', tool: 'mcp__forward-compaction__forward_compaction' }]);
  const filler = Array.from({ length: 10 }, (_, i) => assistant(`${i}`.repeat(1000), [], `e${i}`));
  const frontier = '## Objective\nship\n## Next\nz';
  it.each([true, false])('forkUpkeep %s', (forkUpkeep) => {
    const h = (buildWake({ ...mainInput([call, results(['t9', 'ok']), ...filler]), askPoint: 4000, toolUseId: 't9', frontier, missing: ['next'], forkUpkeep }).messages[1] as BuiltMessage).text;
    const none = mechanicalWake({ ...mainInput([user('a')]), reason: { kind: 'ceiling', ceiling: 120_000 }, forkUpkeep }).messages.at(-2) as BuiltMessage;
    const held = mechanicalWake({ ...mainInput([user('a')]), frontier, reason: { kind: 'ceiling', ceiling: 120_000 }, forkUpkeep }).messages.at(-2) as BuiltMessage;
    const upkeep = 'forward-compaction brings this frontier up to date itself at each compaction: nothing is asked of you for it.';
    expect([h.includes(upkeep), h.includes('When a notice next asks for a forward_compaction call'), h.includes('again at your next milestone'), h.includes('in your next forward_compaction call')]).toEqual(forkUpkeep ? [true, false, false, false] : [false, true, true, true]);
    expect([none.text.includes(upkeep), none.text.includes('at your next milestone')]).toEqual([forkUpkeep, !forkUpkeep]);
    expect([held.text.includes(upkeep), held.text.includes('at your next milestone bring the frontier up to date')]).toEqual([forkUpkeep, !forkUpkeep]);
  });
});
