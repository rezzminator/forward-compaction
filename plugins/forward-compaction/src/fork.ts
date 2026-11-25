// Main's frontier written by a fork (FORWARD_COMPACTION_MAIN_FORK) at one point only: a /compact the user types in an
// idle main chat. Whether main is idle, the prompt `$.model.fork` is sent, how its reply is read as one forward_compaction
// call, and the rows and lines that record it. Pure: the adapter awaits the fork and hands its reply in.
import { FORWARD_INPUT_SCHEMA } from './frontier';
import { repairJson } from './repair';
import { doneEarlierLine, itemLines, LISTS, num, type DoneWake, type Held, type StorageEntry } from './lists';
import type { WakeMessage } from './kept';

/**
 * Whether main's turn has ended, read from the transcript's tail: its newest assistant message holds no tool call and no
 * tool result follows it. A transcript with no assistant message has nothing to fork.
 */
export function forkIdle(messages: readonly WakeMessage[]): boolean {
  let last = messages.length - 1;
  while (last >= 0 && messages[last]!.role !== 'assistant' && (messages[last]!.toolResults ?? []).length === 0) last--;
  return last >= 0 && messages[last]!.role === 'assistant' && messages[last]!.toolUses.length === 0;
}

/** Why a fork wrote no frontier: the result's own reason, a reply with no JSON object in it, a call that rejected or threw, a reply the store did not take, or a Claude Code without `$.model.fork`. */
export type ForkFailure = 'nothing-to-fork' | 'aborted' | 'api-error' | 'empty-reply' | 'no-json' | 'threw' | 'store-failed' | 'no-fork';

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

/** How many messages main's last assistant run and every message after it are: what the wake keeps after the fork's call, as it keeps the messages after a model's call. */
export function forkTrailing(messages: readonly WakeMessage[]): number {
  let last = messages.length - 1;
  while (last >= 0 && messages[last]!.role !== 'assistant') last--;
  if (last < 0) return 0;
  while (last > 0 && messages[last - 1]!.role === 'assistant') last--;
  return messages.length - last;
}

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

/** Where the turn stands at a typed /compact: main is idle. */
const FORK_STAND = "The turn has ended: that last message was sent to the user as it stands, and the next thing to arrive is the user's next message.";

/** `schema`: the tool's input schema the fields section is generated from, the registered tool's own by default; `instructions`: the text the user typed after /compact. */
export type ForkPromptInput = { held: Held; done?: DoneWake; storage: readonly StorageEntry[]; tool: string; schema?: SchemaNode; instructions?: string };

/** The prompt `$.model.fork` is sent, and each section's characters for the debug row. */
export function forkPrompt({ held, done, storage, tool, schema, instructions }: ForkPromptInput): { text: string; sizes: Record<string, number> } {
  const frontier = storedFrontier(held, done);
  const files = storage.length === 0 ? 'none' : storage.map((entry) => `- ${entry.name}: ${entry.description}`).join('\n');
  const typed = instructions?.trim() ?? '';
  const fields = forkFields(schema).join('\n');
  const sections = [
    '[forward-compaction: write the frontier]',
    `This conversation is about to be compacted. Everything above this message is dropped except its last assistant message; the work continues from the frontier alone, beside the user's own messages and standing orders, which the plugin carries verbatim. ${FORK_STAND} Bring the frontier below up to this moment, so the work continues with nothing lost.`,
    ...(typed === '' ? [] : [`The user typed this with /compact: ${typed}`]),
    `Reply with one JSON object and nothing else: the arguments of one \`${tool}\` call, as that tool takes them. No tool runs here; the plugin stores your reply as that call.`,
    `## The frontier as stored now\n\n${frontier}`,
    `## Storage files\n\n${files}`,
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
  return { text, sizes: { chars: text.length, frontier: frontier.length, storage: files.length, typed: typed.length, fields: fields.length } };
}

/** A fork's usage as its row keeps it, every count the API gave, null where it gave none. */
export type ForkUsage = { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | null | undefined;

export type ForkRowInput = {
  outcome: 'applied' | ForkFailure; ms: number; effort?: string; usage?: ForkUsage;
  promptChars: number; replyChars?: number; trailing: number; notes?: readonly string[]; status?: number | null; error?: string;
};

/** The `fork` decision row: how the fork at a typed /compact ended, its wall time, the effort sent and the reply's usage whole. */
export function forkRow(input: ForkRowInput): Record<string, unknown> {
  const u = input.usage ?? undefined;
  return {
    event: 'fork', party: 'main', trigger: 'manual', outcome: input.outcome, ms: input.ms, effort: input.effort ?? null,
    usage: u === undefined ? null : { input: u.input_tokens ?? null, cacheRead: u.cache_read_input_tokens ?? null, cacheWritten: u.cache_creation_input_tokens ?? null, output: u.output_tokens ?? null },
    promptChars: input.promptChars, replyChars: input.replyChars ?? null, trailing: input.trailing,
    ...(input.notes !== undefined && input.notes.length > 0 ? { notes: [...input.notes] } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}), ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

/** The line said when a fork starts. */
export const forkStartLine = (tokens: number | undefined): string => `forward-compaction: /compact${tokens === undefined ? '' : ` at ${num(tokens)} tokens`}: a fork is writing main's frontier.`;

/** The line said when a fork ends: the frontier written, or why not, that Claude Code's own compaction ran instead and, `dropped`, that main's stored frontier that compacts was dropped: the failure's one screen line. */
export function forkEndLine(outcome: 'applied' | ForkFailure, ms: number, dropped = false): string {
  const took = `${(ms / 1000).toFixed(1)} s`;
  if (outcome === 'applied') return `forward-compaction: /compact: the fork wrote main's frontier in ${took}; it installs now.`;
  return `forward-compaction: /compact: the fork wrote no frontier (${outcome}, ${took}); Claude Code's own compaction ran instead${dropped ? " and main's stored frontier was dropped" : ''}.`;
}
