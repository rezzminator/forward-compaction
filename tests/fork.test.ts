import { describe, expect, it } from 'vitest';
import { forkEndLine, forkFields, forkIdle, forkPrompt, forkReply, forkRow, forkStartLine, forkTrailing } from '../plugins/forward-compaction/src/fork.ts';
import { emptyHeld, type Held } from '../plugins/forward-compaction/src/lists.ts';
import { assistant, results, user, type Msg } from './fakes/messages.ts';
import { forkWake, type WakeFacts } from '../plugins/forward-compaction/src/wake.ts';
import type { BuiltMessage } from '../plugins/forward-compaction/src/kept.ts';

const noFacts: WakeFacts = { user: [], notices: [], received: [], skills: [], unattributedSkills: [] };
// 3.5 characters a token stands in for the ratio the adapter measures (window.ts `charsPerToken`).
const mainInput = (messages: Msg[]) => ({ tokens: 41_200, askPoint: 67_000, now: Date.UTC(2026, 9, 23, 10, 1, 0), charsPerToken: 3.5, messages, party: 'main' as const, facts: () => noFacts });

describe('forkIdle: whether main\'s turn has ended', () => {
  it.each([
    ['the last answer holds no tool call', [user('go'), assistant('one', [{ id: 'a', tool: 'Read' }]), results(['a', 'x']), assistant('done')], true],
    ['a user message after the last answer', [user('go'), assistant('done'), user('local command output')], true],
    ['a tool call without its result', [user('go'), assistant('reading', [{ id: 'a', tool: 'Read' }])], false],
    ['a tool result the model has not answered', [user('go'), assistant('reading', [{ id: 'a', tool: 'Read' }]), results(['a', 'x'])], false],
    ['no assistant message', [user('go')], false],
    ['no message', [], false],
  ] as [string, Msg[], boolean][])('%s', (_name, messages, want) => {
    expect(forkIdle(messages)).toBe(want);
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

describe('forkTrailing: main\'s last assistant run and what follows it', () => {
  it.each([
    ['a turn end: the last answer', [user('go'), assistant('one', [{ id: 'a', tool: 'Read' }]), results(['a', 'old']), assistant('two'), assistant('done')], 2],
    ['a user message after it counts in', [user('go'), assistant('done'), user('later')], 2],
    ['no assistant message: nothing trails', [user('go')], 0],
  ] as [string, Msg[], number][])('%s', (_name, messages, want) => {
    expect(forkTrailing(messages)).toBe(want);
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

const REPLY = 'Reply with one JSON object and nothing else: the arguments of one `t` call, as that tool takes them. No tool runs here; the plugin stores your reply as that call.';

describe('forkPrompt (golden)', () => {
  const held: Held = emptyHeld();
  held.objective = 'Ship the parser.';
  held.lists.orders.items = [{ id: 1, text: 'Never push.' }];
  held.lists.done.items = [{ id: 1, text: 'Old step.' }, { id: 2, text: 'Tests pass.', round: 1 }];
  held.lists.remaining.items = [{ id: 3, text: 'Write the docs.' }];
  const schema = { properties: { next: { description: 'The next step.' } } };

  it('a typed /compact: the turn-end stand, the frontier numbered, done split, storage listed, the fields from the schema', () => {
    const { text, sizes } = forkPrompt({ held, done: { shown: [held.lists.done.items[1]!], earlier: [held.lists.done.items[0]!], path: '/state/done-earlier.md' }, storage: [{ name: 'plan.md', description: 'the plan' }], tool: 'forward_compaction', schema });
    expect(text).toBe(`[forward-compaction: write the frontier]

This conversation is about to be compacted. Everything above this message is dropped except its last assistant message; the work continues from the frontier alone, beside the user's own messages and standing orders, which the plugin carries verbatim. The turn has ended: that last message was sent to the user as it stands, and the next thing to arrive is the user's next message. Bring the frontier below up to this moment, so the work continues with nothing lost.

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

## The call's fields

- \`next\`: The next step.

${HOW}`);
    expect(sizes).toEqual({ chars: 2464, frontier: 421, storage: 19, typed: 0, fields: 24 });
  });

  it.each([
    ['text typed after /compact: one paragraph after the stand', '  keep the parser numbers  ', ['The user typed this with /compact: keep the parser numbers', REPLY]],
    ['blank typed text: nothing added', '  ', [REPLY]],
    ['no typed text: nothing added', undefined, [REPLY]],
  ])('%s', (_name, instructions, after) => {
    const { text, sizes } = forkPrompt({ held: emptyHeld(), storage: [], tool: 't', schema, ...(instructions !== undefined ? { instructions } : {}) });
    const paragraphs = text.split('\n\n');
    expect(paragraphs[1]).toBe("This conversation is about to be compacted. Everything above this message is dropped except its last assistant message; the work continues from the frontier alone, beside the user's own messages and standing orders, which the plugin carries verbatim. The turn has ended: that last message was sent to the user as it stands, and the next thing to arrive is the user's next message. Bring the frontier below up to this moment, so the work continues with nothing lost.");
    expect(paragraphs.slice(2, 2 + after.length)).toEqual(after);
    expect(sizes.typed).toBe(instructions?.trim().length ?? 0);
    expect(text).toContain('## Storage files\n\nnone\n\n## The call\'s fields');
  });
});

describe('forkRow and its lines', () => {
  it("keeps the reply's usage whole and the failure's status and error", () => {
    expect(forkRow({ outcome: 'applied', ms: 4200, effort: 'low', usage: { input_tokens: 3, output_tokens: 900, cache_read_input_tokens: 64_000, cache_creation_input_tokens: 12 }, promptChars: 5000, replyChars: 1800, trailing: 3, notes: ['fenced'] }))
      .toEqual({ event: 'fork', party: 'main', trigger: 'manual', outcome: 'applied', ms: 4200, effort: 'low', usage: { input: 3, cacheRead: 64_000, cacheWritten: 12, output: 900 }, promptChars: 5000, replyChars: 1800, trailing: 3, notes: ['fenced'] });
    expect(forkRow({ outcome: 'api-error', ms: 10, promptChars: 5000, trailing: 1, status: null, error: 'invalid_request' }))
      .toEqual({ event: 'fork', party: 'main', trigger: 'manual', outcome: 'api-error', ms: 10, effort: null, usage: null, promptChars: 5000, replyChars: null, trailing: 1, status: null, error: 'invalid_request' });
  });
  it('says when the fork starts and how it ended, naming /compact', () => {
    expect(forkStartLine(64_000)).toBe("forward-compaction: /compact at 64,000 tokens: a fork is writing main's frontier.");
    expect(forkStartLine(undefined)).toBe("forward-compaction: /compact: a fork is writing main's frontier.");
    expect(forkEndLine('applied', 4200)).toBe("forward-compaction: /compact: the fork wrote main's frontier in 4.2 s; it installs now.");
    expect(forkEndLine('no-json', 900)).toBe("forward-compaction: /compact: the fork wrote no frontier (no-json, 0.9 s); Claude Code's own compaction ran instead.");
    expect(forkEndLine('api-error', 1500, true)).toBe("forward-compaction: /compact: the fork wrote no frontier (api-error, 1.5 s); Claude Code's own compaction ran instead and main's stored frontier was dropped.");
  });
});

describe('forkWake: the frontier a fork wrote', () => {
  const frontier = '## Objective\nship\n## Next\nz';
  const opening = '[forward-compaction: frontier] Below is your frontier, brought up to date by forward-compaction from the conversation at this compaction: continue from its ## Next. When a notice next asks for a forward_compaction call, send only changes, by item number; whatever you leave out stays.';
  const exp = '\nforward-compaction is experimental. If it gave you any trouble, append a short note of what happened to your reply.';
  const tail = (n: number) => Array.from({ length: n }, (_, i) => assistant(`${i}`.repeat(1000), [], `f${i}`));
  const useA = assistant('x'.repeat(4000), [{ id: 'r1', tool: 'Read' }]), answer = results(['r1', 'y'.repeat(4000)]);

  const head = (kept: string) => `${opening}\n\n=== frontier ===\n${frontier}\n=== end of frontier ===\n\n${kept}${exp}`;

  it.each([
    { name: 'a turn end keeps only the final reply', messages: () => [user('a'), ...tail(3), assistant('done')], trailing: 1, askPoint: 67_000, kept: () => [assistant('done')], counts: [1, 4], line: 'Your last message follows, kept verbatim: continue from where they leave off. 4 older messages are not carried (look_back finds an exact detail).' },
    { name: 'keeps the last assistant message and what follows it', messages: () => [user('a'), ...tail(10), useA, answer], trailing: 2, askPoint: 67_000, kept: () => [useA, answer], counts: [2, 11], line: 'Your last 2 messages follow, kept verbatim: continue from where they leave off. 11 older messages are not carried (look_back finds an exact detail).' },
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

  it('names a missing objective or next and asks for it in the next call', () => {
    const h = forkWake({ ...mainInput([user('a')]), charsPerToken: undefined, frontier, trailing: 0, missing: ['objective'] }).messages[1] as BuiltMessage;
    expect(h.text).toContain("Your frontier has no objective: re-establish it from the user's messages and the messages below, and send it in your next forward_compaction call.\n\n");
  });
});
