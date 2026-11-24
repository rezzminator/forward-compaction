// Main's frontier written by a fork (FORWARD_COMPACTION_MAIN_FORK): when one is due, the prompt `$.model.fork` is sent,
// how its reply is read as one forward_compaction call, what a failure falls back to, and the rows that record it.
// Pure: the adapter awaits the fork and hands its reply in.
import { FORWARD_INPUT_SCHEMA } from './frontier';
import { repairJson } from './repair';
import { doneEarlierLine, itemLines, LISTS, num, type DoneWake, type Held, type StorageEntry } from './lists';
import type { Action, Trigger } from './decide';
import type { WakeMessage } from './kept';

/** A notice the main chat would have read: its decision row and its text (nudge.ts `noticeFor`'s `sent`). */
export type ForkNotice = { row: Record<string, unknown>; text: string };
/** Where a fork is tried: a nudge level, main's finish point at its turn end, or the ceiling before its mechanical wake. */
export type ForkPoint = number | 'finish' | 'ceiling';
/** A fork due since main's last install: the point that made it due and the notice main reads instead when it fails. */
export type ForkDue = { point: number | 'finish'; notice: ForkNotice };

/** The fork due in place of a notice sent now: a nudge's level, else main's finish notice. */
export const forkDueOf = (sent: ForkNotice): ForkDue => ({ point: sent.row.event === 'nudge' && typeof sent.row.level === 'number' ? sent.row.level : 'finish', notice: sent });

/**
 * Whether this ask forks, and at which point; undefined leaves the ask to today's decision. The plugin's own ask (main's
 * turn end) forks for any due point; an automatic ask only for a due nudge level, as the finish point waits for the turn
 * end; the ceiling's mechanical wake is tried as a fork first whether or not one is due. A stored call that compacts
 * installs with no fork; a reactive ask (the request too long), a manual one and a precompute never fork.
 */
export function forkPoint({ trigger, action, due }: { trigger: Trigger; action: Action; due?: ForkDue }): ForkPoint | undefined {
  if (action.action === 'mechanical') return action.why === 'ceiling' ? 'ceiling' : undefined;
  if (due === undefined) return undefined;
  if (trigger === 'plugin' && action.action === 'next' && action.why === 'plugin') return due.point;
  if (trigger === 'auto' && action.action === 'skip' && action.why === 'waiting' && typeof due.point === 'number') return due.point;
  return undefined;
}

/** Why a fork wrote no frontier: the result's own reason, a reply with no JSON object in it, a call that threw, or a reply the store did not take. */
export type ForkFailure = 'nothing-to-fork' | 'aborted' | 'api-error' | 'empty-reply' | 'no-json' | 'threw' | 'store-failed';

/**
 * What a failed fork does to the ask: `retry` skips it and the fork stays due for the next ask (nothing was forked, or
 * the turn's abort cut it); `notice` skips it and main reads the notice it would have read; `mechanical` lets the
 * ceiling's mechanical wake install, as the ceiling never waits.
 */
export function forkFailure(point: ForkPoint, failure: ForkFailure): 'retry' | 'notice' | 'mechanical' {
  if (point === 'ceiling') return 'mechanical';
  return failure === 'nothing-to-fork' || failure === 'aborted' ? 'retry' : 'notice';
}

/** The reply read as a call's arguments, with a note for each way it was read; or why it holds none. */
export type ForkReply = { ok: true; args: Record<string, unknown>; notes: string[] } | { ok: false; error: string };

/** The first top-level `{…}` of `text`, strings read whole; to the text's end when it never closes. Hand-written: a scan for the matching brace, which JSON.parse cannot find in text around it. */
function firstObject(text: string): { at: number; end: number } | undefined {
  const at = text.indexOf('{');
  if (at < 0) return undefined;
  let depth = 0, inString = false;
  for (let i = at; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return { at, end: i + 1 };
  }
  return { at, end: text.length };
}

/** The fork's reply as the arguments of one forward_compaction call: its first top-level object, a code fence or prose around it noted, broken JSON read through repair.ts `repairJson`, the door a model's broken argument goes through. */
export function forkReply(text: string): ForkReply {
  const found = firstObject(text);
  if (found === undefined) return { ok: false, error: 'the reply holds no JSON object' };
  const before = text.slice(0, found.at).trim(), after = text.slice(found.end).trim(), body = text.slice(found.at, found.end), notes: string[] = [];
  if (/^```[\w-]*$/.test(before) && after === '```') notes.push('fenced');
  else if (before !== '' || after !== '') notes.push('prose-around');
  let args: unknown;
  try {
    args = JSON.parse(body);
  } catch {
    args = repairJson('reply', body)?.own; // undefined when no reading parses
    if (args !== undefined) notes.push('repaired');
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return { ok: false, error: args === undefined ? 'the reply\'s JSON does not parse, repaired or not' : 'the reply\'s JSON is no object' };
  return { ok: true, args: args as Record<string, unknown>, notes };
}

/** One tool result the conversation's last request has not sent yet. */
export type ForkResult = { tool: string; id: string; text: string };

/**
 * The messages the working model has not answered: its last assistant run, from `from`, and every message after it,
 * and the results of that run's calls, which the fork cannot see, as it reads main's last request and its response.
 * `from` is the messages' length when no assistant message is in them.
 */
export function forkTrailing(messages: readonly WakeMessage[]): { from: number; results: ForkResult[] } {
  let last = messages.length - 1;
  while (last >= 0 && messages[last]!.role !== 'assistant') last--;
  if (last < 0) return { from: messages.length, results: [] };
  let from = last;
  while (from > 0 && messages[from - 1]!.role === 'assistant') from--;
  const tools = new Map(messages.slice(from, last + 1).flatMap((m) => m.toolUses.map((u) => [u.tool_use_id, u.tool ?? 'tool'] as const)));
  const results = messages.slice(last + 1).flatMap((m) => (m.role === 'user' ? m.toolResults ?? [] : [])).filter((r) => tools.has(r.tool_use_id)).map((r) => ({ tool: tools.get(r.tool_use_id)!, id: r.tool_use_id, text: r.text ?? '' }));
  return { from, results };
}

/** A design budget, never a measured size: the characters of one unsent tool result the prompt carries, so one long Read cannot crowd out the frontier; the wake keeps the result whole. */
export const FORK_RESULT_MAX_CHARS = 8_000;

/** A JSON schema node as far as the fields section reads it. */
export type SchemaNode = { description?: string; properties?: Readonly<Record<string, SchemaNode>>; items?: SchemaNode };

/** One line per described field of `schema`, `- \`name\`: description`, nested fields indented under theirs: the tool's own words, never retyped. */
export function forkFields(schema: SchemaNode = FORWARD_INPUT_SCHEMA as SchemaNode, depth = 0): string[] {
  const properties = schema.properties ?? schema.items?.properties ?? {};
  return Object.entries(properties).flatMap(([name, node]) => [...(node.description === undefined ? [] : [`${'  '.repeat(depth)}- \`${name}\`: ${node.description}`]), ...forkFields(node, depth + 1)]);
}

/** The frontier as stored, every text and list under its name, items numbered as a wake shows them, `done` split as the wake splits it. */
function storedFrontier(held: Held, done: DoneWake | undefined): string {
  const block = (name: string, lines: readonly string[]): string => `### ${name}\n${lines.length === 0 ? '(empty)' : lines.join('\n')}`;
  const texts = (['objective', 'next'] as const).map((name) => block(name, held[name] === undefined ? [] : [held[name]!]));
  const lists = LISTS.map((name) => {
    const list = held.lists[name];
    if (name !== 'done' || done === undefined || done.earlier.length === 0) return block(name, itemLines(list));
    return block(name, [doneEarlierLine(done.earlier, done.path), ...itemLines({ ...list, items: done.shown })]);
  });
  return [...texts, ...lists].join('\n\n');
}

/** Where the turn stands: at main's turn end (the plugin's own ask, for any due point) it has ended and its last message reached the user; at an automatic ask (a nudge level or the ceiling) it is still running. */
export function forkStand(ended: boolean): string {
  return ended
    ? 'The turn has ended: that last message was sent to the user as it stands, and the next thing to arrive is the user\'s next message.'
    : 'The turn is still running: that last message\'s tool calls have their results below.';
}

/** `schema`: the tool's input schema the fields section is generated from, the registered tool's own by default; `ended`: the ask is main's turn end. */
export type ForkPromptInput = { held: Held; done?: DoneWake; storage: readonly StorageEntry[]; results: readonly ForkResult[]; tool: string; schema?: SchemaNode; ended: boolean };

/** The prompt `$.model.fork` is sent, and each section's characters for the debug row. */
export function forkPrompt({ held, done, storage, results, tool, schema, ended }: ForkPromptInput): { text: string; sizes: Record<string, number> } {
  const frontier = storedFrontier(held, done);
  const files = storage.length === 0 ? 'none' : storage.map((entry) => `- ${entry.name}: ${entry.description}`).join('\n');
  const cut = (text: string): string => (text.length <= FORK_RESULT_MAX_CHARS ? text : `${text.slice(0, FORK_RESULT_MAX_CHARS)}\n[cut: ${num(FORK_RESULT_MAX_CHARS)} of ${num(text.length)} characters shown]`);
  const unsent = results.map((r) => `### ${r.tool} (${r.id})\n${cut(r.text)}`).join('\n\n');
  const fields = forkFields(schema).join('\n');
  const sections = [
    '[forward-compaction: write the frontier]',
    `This conversation is about to be compacted. Everything above this message is dropped except its last assistant message; the work continues from the frontier alone, beside the user's own messages and standing orders, which the plugin carries verbatim. ${forkStand(ended)} Bring the frontier below up to this moment, so the work continues with nothing lost.`,
    `Reply with one JSON object and nothing else: the arguments of one \`${tool}\` call, as that tool takes them. No tool runs here; the plugin stores your reply as that call.`,
    `## The frontier as stored now\n\n${frontier}`,
    `## Storage files\n\n${files}`,
    ...(results.length === 0 ? [] : [`## Tool results after the conversation above\n\nThe conversation above ends at its last tool calls. These are their results, which it does not show: count them in.\n\n${unsent}`]),
    `## The call's fields\n\n${fields}`,
    [
      '## How to write it',
      '',
      '- Send changes only: `add` new items; `remove` and `edit` by the numbers shown above. What you leave out stays as it is.',
      '- Clean as you go: remove each `remaining` step that is finished, replaced or listed twice, each `blocked` question the user answered, each `findings` item the rest of the work no longer needs. A finished step becomes one `done` item saying how it was verified.',
      '- `next` every time: the first action after the wake, exact enough to take with nothing else in view. When a step was in progress, name it and what it waits for: a running agent or command by its name or id, a file half edited.',
      '- Keep what cannot be found again: a ruling or number the user gave, a decision of your own with its reason, an error text, a command that worked, an id or path the next steps need. For what a file or a command holds, name the path or the command instead of copying it.',
      "- The user's words stay the user's words: a ruling goes to `decisions`, a rule that binds the rest of the work to `orders`, quoted as given. Add no order the user did not give.",
      '- Write only what the conversation shows: a result not seen is not recorded as done.',
    ].join('\n'),
    "The reply is one JSON object, the call's arguments, and nothing else.",
  ];
  const text = sections.join('\n\n');
  return { text, sizes: { chars: text.length, frontier: frontier.length, storage: files.length, results: unsent.length, fields: fields.length } };
}

/** A fork's usage as its row keeps it, every count the API gave, null where it gave none. */
export type ForkUsage = { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | null | undefined;

export type ForkRowInput = {
  point: ForkPoint; outcome: 'applied' | ForkFailure; ms: number; effort?: string; usage?: ForkUsage;
  promptChars: number; replyChars?: number; trailing: number; notes?: readonly string[]; status?: number | null; error?: string;
};

/** The `fork` decision row: main's due point, how the fork ended, its wall time, the effort sent and the reply's usage whole. */
export function forkRow(input: ForkRowInput): Record<string, unknown> {
  const u = input.usage ?? undefined;
  return {
    event: 'fork', party: 'main', point: input.point, outcome: input.outcome, ms: input.ms, effort: input.effort ?? null,
    usage: u === undefined ? null : { input: u.input_tokens ?? null, cacheRead: u.cache_read_input_tokens ?? null, cacheWritten: u.cache_creation_input_tokens ?? null, output: u.output_tokens ?? null },
    promptChars: input.promptChars, replyChars: input.replyChars ?? null, trailing: input.trailing,
    ...(input.notes !== undefined && input.notes.length > 0 ? { notes: [...input.notes] } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}), ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

/** Where a point is said: a nudge level by its number, the finish point and the ceiling by name. */
const pointSaid = (point: ForkPoint): string => (typeof point === 'number' ? `nudge level ${point}` : point === 'finish' ? 'the finish point' : 'the ceiling');

/** The line said when a fork starts. */
export const forkStartLine = (point: ForkPoint, tokens: number | undefined): string => `forward-compaction: main reached ${pointSaid(point)}${tokens === undefined ? '' : ` at ${num(tokens)} tokens`}; a fork is writing its frontier.`;

/** The line said when a fork ends: the frontier written, or why not and what main gets instead. */
export function forkEndLine(point: ForkPoint, outcome: 'applied' | ForkFailure, ms: number, then?: 'retry' | 'notice' | 'mechanical'): string {
  const took = `${(ms / 1000).toFixed(1)} s`;
  if (outcome === 'applied') return `forward-compaction: the fork wrote main's frontier in ${took}; it installs now.`;
  const instead = then === 'retry' ? 'the fork is tried again at the next compaction ask' : then === 'mechanical' ? 'the mechanical wake installs' : `main reads the ${point === 'finish' ? 'finish notice' : 'nudge'} instead`;
  return `forward-compaction: the fork wrote no frontier at ${pointSaid(point)} (${outcome}, ${took}); ${instead}.`;
}
