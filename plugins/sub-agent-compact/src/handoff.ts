import type { ForwardRecord } from './forward-record.ts';
import type { BlockRecord } from './forward-text.ts';

// A handoff is the model's own account of its work, installed in place of the conversation it covers.
// No summarizer runs: the text the model passes is the past it keeps, so the tool and the nudges teach
// what that text must hold, and the install keeps everything the model did after writing it.

/** The tool's short name; the model calls it as `mcp__sub-agent-compact__handoff`. */
export const HANDOFF_TOOL = 'handoff';

/** Below this, a handoff cannot hold the task, what is done and the next step. */
export const HANDOFF_MIN_CHARS = 200;

/** Opens the installed message: how the model, a later install and the brief finder tell it apart. */
export const HANDOFF_OPENING = '[sub-agent-compact: handoff]';

/** Characters per token of the size the model is told. */
const CHARS_PER_TOKEN = 4;

/** A tool result carried beside the handoff is cut past this, with a line saying so. */
const SIBLING_MAX_CHARS = 32_000;

export const HANDOFF_TOOL_DESCRIPTION = [
  'Hand off to yourself: your fields replace your whole conversation so far, and you keep working from them. Everything before this call (messages, files read, tool results, reasoning) leaves your context; the handoff, installed verbatim, is all you will have of it. Nothing summarizes for you, so a detail you leave out is lost and costs a re-read. What you do after this call is kept as it happens.',
  '',
  'Call it once sub-agent-compact has nudged you (earlier is refused), at a clean milestone with work still ahead. Never while the person waits on your answer, and not when only your final answer is left: give that instead.',
  '',
  'Fill the fields while you hold the context, and keep them short: `goal` and `next_step` are required, the rest only when the work needs it. An earlier handoff is replaced too: carry forward what it still needs. Every problem comes back at once, and nothing is stored until none is left.',
].join('\n');

type SchemaProperty = { type: string; description: string; items?: { type: string } };

const list = (description: string): SchemaProperty => ({ type: 'array', items: { type: 'string' }, description });

/** The tool's typed input: the fields the model fills while it still holds the context. */
export const HANDOFF_INPUT_SCHEMA: { type: 'object'; properties: Record<string, SchemaProperty>; required: string[]; additionalProperties: false } = {
  type: 'object',
  properties: {
    goal: { type: 'string', description: "The person's ask or your brief's, with every value it fixed verbatim: names, numbers, paths, code words." },
    next_step: { type: 'string', description: 'The exact first action after the reset, concrete enough to start without reading anything.' },
    done_verified: list('What is done, each with its evidence: result, test verdict, commit id.'),
    in_flight: list('Running, uncommitted or awaited: agents, jobs, edits.'),
    files: list('path:line anchors to reopen, never contents.'),
    decisions: list('Rulings taken and options rejected, with why.'),
    dead_ends: list('Tried and failed: do not retry.'),
    standing_rules: list('Rules and constraints that still bind.'),
    notes: { type: 'string', description: 'Anything else, briefly.' },
    load_on_wake: list('Skills or commands to load after the reset, by name; one that cannot be found refuses the call.'),
  },
  required: ['goal', 'next_step'],
  additionalProperties: false,
};

function k(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

/** Why a free-text handoff (the earlier tool's input, a `<handoff>` marker) cannot be stored, or undefined when it can. */
export function handoffProblem(text: unknown): string | undefined {
  const missing = 'Not stored: `handoff` must hold the task with its fixed values, what is done, the facts the rest needs and the next step.';
  if (typeof text !== 'string' || text.trim() === '') return missing;
  const length = text.trim().length;
  if (length < HANDOFF_MIN_CHARS) return `${missing} Yours is ${length} characters; everything before this call is replaced by it, so write it out in full.`;
  if (length > HANDOFF_MAX_CHARS) return `Not stored: your handoff is ${length} characters and the most stored is ${HANDOFF_MAX_CHARS} (about ${k(HANDOFF_MAX_CHARS / CHARS_PER_TOKEN)} tokens). Keep the task, the next step and the anchors to reopen; drop what a re-read costs less than.`;
  return undefined;
}

/**
 * Why a party's handoff is refused before its text is read, or undefined when
 * it may hand off: a Haiku agent and a loop no policy governs run on Claude
 * Code's own compaction point, and below the first nudge point a handoff
 * throws away more working context than it saves (no reading never refuses).
 */
export function handoffRefusal({ haiku, unlisted, tokens, nudgeStart }: { haiku: boolean; unlisted: boolean; tokens: number | undefined; nudgeStart: number }): string | undefined {
  if (haiku) return 'Not stored: handoffs are off for Haiku agents; Claude Code compacts them at its own point. Keep working.';
  if (unlisted) return 'Not stored: sub-agent-compact does not govern this loop; Claude Code compacts it at its own point. Keep working.';
  if (tokens === undefined || tokens >= nudgeStart) return undefined;
  return `Not stored: your context is ${k(tokens)}, below ${k(nudgeStart)}, the first point sub-agent-compact nudges you at. Keep working; you will be told when a handoff pays.`;
}

const MARKER = /(?<!`)<handoff>([\s\S]*?)<\/handoff>(?!`)/;

/** The handoff a model wrote between `<handoff>` tags in its visible text; undefined without them, empty, or quoted in backticks. */
export function handoffMarker(answer: string): string | undefined {
  const text = MARKER.exec(answer)?.[1]?.trim();
  return text ? text : undefined;
}

/**
 * The handoff of a sub-agent whose tool allowlist leaves out the tool. Only a
 * response that also calls a tool counts: one without a tool call ends the
 * agent's run. The main chat has the tool, and its text may relay a
 * sub-agent's answer, so its markers never count.
 */
export function handoffMarkerRequest({ answer, toolCalls, main }: { answer: string; toolCalls: number; main: boolean }): string | undefined {
  if (main || toolCalls === 0) return undefined;
  return handoffMarker(answer);
}

/** The handoff of a sub-agent that stopped on a lone marker: its stop is refused once, so it carries on. */
export function handoffStopRequest({ lastMessage, continued }: { lastMessage: string | undefined; continued: boolean }): string | undefined {
  if (continued || lastMessage === undefined) return undefined;
  return handoffMarker(lastMessage);
}

/** The block reason a sub-agent reads when its stop on a handoff marker is refused. */
export const CONTINUE_AFTER_HANDOFF =
  'sub-agent-compact: handoff stored. You are not done: your task continues. At your next compaction point your handoff replaces everything before it; carry on from its next step.';

export type HandoffNudgeInput = {
  tokens: number;
  /** 0 for the first nudge. */
  level: number;
  /** The forced point, in tokens. */
  autoCompact: number;
  main: boolean;
  /** The handoff tool's full name; undefined when it is not registered. */
  toolName: string | undefined;
  /** The party's first reading, taken on the session's first request: about what a handoff cuts each request back to; unknown leaves the claim out. */
  firstReading: number | undefined;
};

/**
 * What the model reads after a tool result once its context passes a nudge
 * point, with the handoff tool on. Undefined for the main chat without the
 * tool: it has no other way to hand off, so it is not told to.
 */
export function handoffNudgeText({ tokens, level, autoCompact, main, toolName, firstReading }: HandoffNudgeInput): string | undefined {
  if (main && toolName === undefined) return undefined;
  const marker = 'write <handoff>your handoff</handoff> in a response that also makes your next tool call, never alone, because a response without a tool call ends your run';
  const how = main
    ? `Call ${toolName} with the fields filled.`
    : toolName === undefined
      ? `Your handoff tool is not available, so ${marker}.`
      : `Call ${toolName} with the fields filled if you have that tool; otherwise ${marker}.`;
  const cut = firstReading !== undefined && firstReading < tokens ? `, cutting each later request to about ${k(firstReading)} plus your handoff` : '';
  return [
    `sub-agent-compact: your context is ${k(tokens)} tokens, and every request re-sends all of it.`,
    ...(main ? ['The person steers this chat: when they are waiting on an answer or asked you not to hand off, finish their ask first and never hand off while they wait.'] : []),
    'If only your final answer is left, give it and do not hand off.',
    level > 0 ? `Nudge ${level + 1}: with more work still ahead, make the handoff your next call, before any other tool.` : 'With more work still ahead, hand off now: once the result above closes a step, make the handoff your next call, before any other tool.',
    how,
    `The handoff replaces your whole context, verbatim, as your only memory of the work so far${cut}.`,
    'Keep it short: `goal` (the task, every value it fixed verbatim) and `next_step` (your exact next step) are required; add only what would otherwise be read again: verified results, decisions, dead ends, file:line anchors, what is in flight. Carry forward what an earlier handoff still needs.',
    `Compaction is forced at ${k(autoCompact)} whether you hand off or not.`,
  ].join(' ');
}

/**
 * The handoff tool's reply once the handoff is stored. It says when the
 * install happens: the main chat's at the end of its turn, a sub-agent's at
 * Claude Code's next compaction ask, and nothing if the run ends first.
 */
export function handoffStoredText({ chars, main = false, askPoint }: { chars: number; main?: boolean; askPoint?: number }): string {
  const size = `${HANDOFF_STORED_PREFIX} (${k(Math.ceil(chars / CHARS_PER_TOKEN))} tokens).`;
  const when = main
    ? "It replaces everything before this call when this turn ends, or at Claude Code's next compaction ask if that comes first"
    : askPoint === undefined
      ? "It replaces everything before this call at Claude Code's next compaction ask; if your run ends before that ask, nothing is installed"
      : `It replaces everything before this call at Claude Code's next compaction ask, at about ${k(askPoint)} tokens; if your run ends before that, nothing is installed`;
  return `${size} ${when}; what you do after this call is kept as it happens. Carry on with your next step. To change it, call the tool again: the latest handoff is the one installed.`;
}

/** What the main chat's model reads beside the person's prompt that cancelled its stored handoff. */
export function handoffDisarmedText(): string {
  return "sub-agent-compact: the person's message cancelled the handoff you stored; it will not be installed. Answer them, and do not hand off again until their ask is done.";
}


/** Largest handoff the plugin stores: about 3k tokens; a handoff is the shortest account that lets the work go on. */
export const HANDOFF_MAX_CHARS = 12_000;

/** What every stored handoff's tool reply starts with: how a later install finds the call in the transcript. */
export const HANDOFF_STORED_PREFIX = 'Handoff stored';

export type HandoffParse = { text: string; loads: string[] } | { problem: string };

const GOAL_MIN = 20;
const GOAL_MAX = 3_000;
const NEXT_MAX = 1_000;
const NOTES_MAX = 1_500;
const ITEM_MAX = 500;
const LIST_MAX = 12;
/** Most skills or commands one handoff names to load. */
export const LOADS_MAX = 8;
/**
 * What a skill or command is called: no path separator, and every `:`-separated
 * segment (a directory once a command name is read as a path) starts alphanumeric,
 * so no segment is `..` and a name can never leave the directories it is read from.
 */
export const WAKE_NAME = /^(?=.{1,100}$)[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

const FIELD_KEYS = ['goal', 'next_step', 'done_verified', 'in_flight', 'files', 'decisions', 'dead_ends', 'standing_rules', 'notes', 'load_on_wake', 'handoff'] as const;

/** Rendered sections in the order the woken model reads them; the next step is last, the freshest thing read. */
const SECTIONS: readonly { key: string; label: string }[] = [
  { key: 'standing_rules', label: 'Standing rules' },
  { key: 'done_verified', label: 'Done (verified)' },
  { key: 'decisions', label: 'Decisions' },
  { key: 'dead_ends', label: 'Dead ends (do not retry)' },
  { key: 'files', label: 'Files' },
  { key: 'in_flight', label: 'In flight' },
];

/** A list field's items: an array of strings or newline-separated lines (a leading dash dropped); a problem when it is neither. */
function listItems(name: string, value: unknown, problems: string[], max = LIST_MAX): string[] {
  if (value === undefined || value === null) return [];
  let items: unknown[];
  if (typeof value === 'string') items = value.split('\n').map((line) => line.replace(/^\s*[-*•]\s+/, ''));
  else if (Array.isArray(value)) items = value;
  else {
    problems.push(`\`${name}\` must be a list of strings, not ${typeof value}.`);
    return [];
  }
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') {
      problems.push(`\`${name}\` must be a list of strings; one item is ${typeof item}.`);
      return [];
    }
    if (item.trim() !== '') out.push(item.trim());
  }
  if (out.length > max) problems.push(`\`${name}\` lists ${out.length} items; the most is ${max}. Keep what the work needs.`);
  return out;
}

function textField(name: string, value: unknown, problems: string[], { min, max, required }: { min: number; max: number; required: boolean }): string {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) problems.push(`\`${name}\` is required.`);
    return '';
  }
  if (typeof value !== 'string') {
    problems.push(`\`${name}\` must be a string, not ${typeof value}.`);
    return '';
  }
  const text = value.trim();
  if (text.length < min) problems.push(`\`${name}\` is ${text.length} characters; it needs at least ${min}.`);
  if (text.length > max) problems.push(`\`${name}\` is ${text.length} characters; the most is ${max}.`);
  return text;
}

/**
 * The stored text for a handoff tool call's input, with the names it asks
 * to have loaded, or every problem with it at once. The earlier tool's free
 * text (`handoff`) is still taken, with the old length rules.
 */
export function parseHandoff(input: Record<string, unknown>): HandoffParse {
  const typed = input.goal !== undefined || input.next_step !== undefined;
  if (!typed && typeof input.handoff === 'string') {
    const problem = handoffProblem(input.handoff);
    return problem === undefined ? { text: input.handoff.trim(), loads: [] } : { problem };
  }
  const problems: string[] = [];
  for (const key of Object.keys(input)) if (!(FIELD_KEYS as readonly string[]).includes(key)) problems.push(`\`${key}\` is not a field of this tool.`);
  const goal = textField('goal', input.goal, problems, { min: GOAL_MIN, max: GOAL_MAX, required: true });
  const next = textField('next_step', input.next_step, problems, { min: GOAL_MIN, max: NEXT_MAX, required: true });
  const notes = textField('notes', input.notes, problems, { min: 0, max: NOTES_MAX, required: false });
  const lists = new Map<string, string[]>();
  for (const { key } of SECTIONS) {
    const items = listItems(key, input[key], problems);
    for (const item of items) if (item.length > ITEM_MAX) problems.push(`\`${key}\` has an item of ${item.length} characters; the most is ${ITEM_MAX}.`);
    lists.set(key, items);
  }
  const loads: string[] = [];
  for (const raw of listItems('load_on_wake', input.load_on_wake, problems, LOADS_MAX)) {
    const name = raw.startsWith('/') ? raw.slice(1) : raw;
    if (!WAKE_NAME.test(name)) problems.push(`\`load_on_wake\` entry ${JSON.stringify(raw)} is not a skill or command name.`);
    else if (!loads.includes(name)) loads.push(name);
  }
  if (problems.length > 0) return { problem: `Not stored: ${problems.join(' ')}` };
  const parts = [`**Goal**\n${goal}`];
  for (const { key, label } of SECTIONS) {
    const items = lists.get(key) ?? [];
    if (items.length > 0) parts.push(`**${label}**\n${items.map((item) => `- ${item}`).join('\n')}`);
  }
  if (notes !== '') parts.push(`**Notes**\n${notes}`);
  parts.push(`**Next step**\n${next}`);
  const text = parts.join('\n\n');
  if (text.length > HANDOFF_MAX_CHARS) {
    return { problem: `Not stored: the handoff is ${text.length} characters and the most stored is ${HANDOFF_MAX_CHARS} (about ${k(HANDOFF_MAX_CHARS / CHARS_PER_TOKEN)} tokens). Cut what a re-read costs less than: keep the anchors, not the contents.` };
  }
  return { text, loads };
}

/** Keys the tool.call event carries beside the tool's arguments. */
const EVENT_KEYS = new Set(['tool', 'tool_use_id', 'agentId']);

/**
 * The input of a handoff tool call: every argument at the event's top level
 * (a key that is not a field included, so the check names it) or, when none
 * is there, the event's `input`.
 */
export function handoffInputOf(e: Record<string, unknown>): Record<string, unknown> {
  const top: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(e)) if (!EVENT_KEYS.has(key) && key !== 'input' && value !== undefined) top[key] = value;
  if (Object.keys(top).length > 0) return top;
  const nested = e.input;
  return nested !== null && typeof nested === 'object' && !Array.isArray(nested) ? (nested as Record<string, unknown>) : {};
}

/**
 * The last handoff the transcript shows stored and not yet installed: the
 * call to the tool whose reply says it was stored. An install or a summary
 * replaces the transcript, so a stored call still standing in it was never
 * installed (the plugin lost it across a reload or a resume). A person's
 * message after the call cancelled it, as it does a handoff the plugin holds;
 * a message the harness wrote (a task notification, a reminder) did not.
 */
export function recoverHandoff(messages: readonly HandoffMessage[], toolName: string): ArmedHandoff | undefined {
  const replies = new Map<string, string>();
  for (const m of messages) for (const r of m.toolResults ?? []) replies.set(r.tool_use_id, r.text ?? '');
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && (m.toolResults ?? []).length === 0 && m.text.trim() !== '' && !isHarnessText(m.text)) return undefined;
    if (m.role !== 'assistant') continue;
    for (const use of [...m.toolUses].reverse()) {
      if (use.tool !== toolName) continue;
      if (!(replies.get(use.tool_use_id) ?? use.text ?? '').startsWith(HANDOFF_STORED_PREFIX)) continue;
      // The latest stored call replaced every earlier one: if it no longer reads, none is recovered.
      const parsed = parseHandoff(handoffInputOf(use.input !== null && typeof use.input === 'object' ? (use.input as Record<string, unknown>) : {}));
      return 'text' in parsed ? { text: parsed.text, anchor: { toolUseId: use.tool_use_id }, loads: parsed.loads } : undefined;
    }
  }
  return undefined;
}

/** What is wrong with the shape of a compaction event's transcript, or undefined: Claude Code versions may change it, and an install reads exactly this. */
export function transcriptShapeProblem(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return `the transcript is not a list (${typeof messages})`;
  for (let i = 0; i < messages.length; i++) {
    const m: unknown = messages[i];
    if (m === null || typeof m !== 'object') return `message ${i} is not an object`;
    const { role, text, toolUses, toolResults } = m as Record<string, unknown>;
    if (role !== 'user' && role !== 'assistant') return `message ${i} has role ${JSON.stringify(role)}, expected user or assistant`;
    if (typeof text !== 'string') return `message ${i} has no text string`;
    if (!Array.isArray(toolUses)) return `message ${i} has no toolUses list`;
    if (toolResults !== undefined && !Array.isArray(toolResults)) return `message ${i} has toolResults that is not a list`;
  }
  return undefined;
}

export type HandoffNoticeKind = 'recovered' | 'skipped' | 'fallback' | 'manual' | 'marker-stored' | 'marker-refused' | 'shape';

/** A line the model reads on its next tool result about what became of its handoff. */
export function handoffNotice(kind: HandoffNoticeKind, detail = ''): string {
  const head = 'sub-agent-compact: ';
  switch (kind) {
    case 'recovered':
      return `${head}your handoff was recovered from your transcript, where its tool call stood stored (the plugin no longer held it), and installed.`;
    case 'skipped':
      return `${head}the compaction that was to install your handoff was skipped (${detail}); your handoff is still stored and installs at the next compaction.`;
    case 'fallback':
      return `${head}your handoff could not be installed verbatim (${detail}); the compaction falls back to a summary that keeps it, and if that is skipped your handoff stays stored. Re-read what you need.`;
    case 'shape':
      return `${head}the transcript Claude Code sent has a shape this plugin does not read (${detail}); your handoff could not be installed verbatim, so a summary that keeps it is used. Re-read what you need.`;
    case 'manual':
      return `${head}the person ran /compact: your stored handoff was dropped and a summary ran instead. Re-read what you need.`;
    case 'marker-stored':
      return `${head}your <handoff> marker was stored (${detail}); it replaces everything before that response at Claude Code's next compaction ask, and if your run ends first, nothing is installed. Carry on.`;
    case 'marker-refused':
      return `${head}your <handoff> marker was refused. ${detail}`;
  }
}

/** The line the person reads for an install: sizes before and after, and a warning when most of the context was kept. */
export function installLine({ label, before, after, tail, recovered }: { label: string; before: number | undefined; after: number; tail: number; recovered: boolean }): { line: string; warn: boolean } {
  const warn = before !== undefined && after >= before / 2;
  const line =
    `sub-agent-compact: installed the handoff of ${label}: ${before === undefined ? 'unknown' : k(before)} -> ${k(after)} tokens` +
    `${tail > 0 ? `, ${tail} later messages kept` : ''}${recovered ? ' (recovered from the transcript)' : ''}` +
    `${warn ? '; most of the context stayed (the work after the handoff call is kept whole), so the cut is small' : ''}`;
  return { line, warn };
}

/** Where the handoff was written: the tool call that carried it, or the response that carried its marker. */
export type HandoffAnchor = { toolUseId: string } | { marker: true };

/** What a stored forward handoff keeps for its install: where its files are and the blocks its text holds. */
/** A forward handoff's own data; `dir` absent when its files were not saved. */
export type ForwardMeta = { seq: number; dir?: string; blocks: readonly BlockRecord[]; record: ForwardRecord };

export type ArmedHandoff = { text: string; anchor: HandoffAnchor; loads?: string[]; forward?: ForwardMeta };

/** The parts of a transcript message an install reads (the plugin API's SessionMessage satisfies it). */
export type HandoffMessage = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: readonly { tool_use_id: string; tool?: string; input?: unknown; text?: string }[];
  toolResults?: readonly { tool_use_id: string; text?: string }[];
  handle?: string;
};

type Sibling = { tool: string; input: unknown; text: string };

function cut(text: string): string {
  if (text.length <= SIBLING_MAX_CHARS) return text;
  return `${text.slice(0, SIBLING_MAX_CHARS)}\n[sub-agent-compact: cut at ${SIBLING_MAX_CHARS} of ${text.length} characters]`;
}

/** The results of the calls made beside the handoff and the text delivered with them, one part each; none when there were none. */
function besideParts(siblings: readonly Sibling[], extras: readonly string[]): string[] {
  const parts: string[] = [];
  if (siblings.length > 0) {
    parts.push(
      [
        'Results of the tool calls you made in the same response as the handoff, which it could not include:',
        ...siblings.map((s) => `--- ${s.tool} ${JSON.stringify(s.input ?? {})} ---\n${cut(s.text)}`),
      ].join('\n'),
    );
  }
  if (extras.length > 0) parts.push(`Delivered with those results:\n${extras.join('\n')}`);
  return parts;
}

/** The installed message: what it is, the handoff verbatim, the results the handoff could not include, and whether its aftermath follows. */
function framedHandoff(text: string, siblings: readonly Sibling[], extras: readonly string[], tail: number): string {
  const parts = [
    `${HANDOFF_OPENING} Your context was reset. Below is the handoff you wrote with the handoff tool right before the reset: it is now your whole memory of the work up to that point. The earlier messages, file contents and tool results are gone, and nothing else was kept or summarized. Treat what it records as known and do not re-read it; open a file again only for something it does not hold.`,
    `=== handoff ===\n${text}\n=== end of handoff ===`,
  ];
  parts.push(...besideParts(siblings, extras));
  parts.push(tail > 0 ? 'What you did after writing it follows as it happened: continue from where it leaves off.' : 'Continue from its next step.');
  return parts.join('\n\n');
}

/**
 * The conversation a handoff leaves: a sub-agent's brief first when given,
 * then the framed handoff, then every message after the response that wrote
 * it, kept whole with its handle. A response can be split over several
 * assistant messages, one per content block; the run of them around the
 * anchor is that response, and the user messages right after it that answer
 * its tool calls are its results. Results of calls made beside the handoff
 * are carried as text inside the framed message, or in a message of their
 * own before a text the caller frames itself, since their own call leaves
 * with the response. Undefined when the anchor is not in the transcript.
 */
export function installHandoff<M extends HandoffMessage>(
  input: readonly M[],
  { text, anchor, brief, frame }: { text: string; anchor: HandoffAnchor; brief?: string; frame?: (text: string) => string },
): { messages: M[]; tail: number; siblings: number } | undefined {
  const isAnchor = (m: M): boolean =>
    m.role === 'assistant' && ('toolUseId' in anchor ? m.toolUses.some((u) => u.tool_use_id === anchor.toolUseId) : handoffMarker(m.text) !== undefined);
  let at = -1;
  for (let i = input.length - 1; i >= 0; i--) {
    if (isAnchor(input[i]!)) {
      at = i;
      break;
    }
  }
  if (at < 0) return undefined;
  let first = at;
  while (first > 0 && input[first - 1]!.role === 'assistant') first--;
  let last = at;
  while (last + 1 < input.length && input[last + 1]!.role === 'assistant') last++;
  const uses = input.slice(first, last + 1).flatMap((m) => m.toolUses);
  const ids = new Set(uses.map((u) => u.tool_use_id));
  const results = new Map<string, string>();
  const extras: string[] = [];
  let next = last + 1;
  while (next < input.length) {
    const m = input[next]!;
    const answers = m.toolResults ?? [];
    if (m.role !== 'user' || answers.length === 0 || !answers.every((r) => ids.has(r.tool_use_id))) break;
    for (const r of answers) results.set(r.tool_use_id, r.text ?? '');
    if (m.text.trim() !== '') extras.push(m.text.trim());
    next++;
  }
  const own = 'toolUseId' in anchor ? anchor.toolUseId : undefined;
  const siblings: Sibling[] = uses
    .filter((u) => u.tool_use_id !== own)
    .map((u) => ({ tool: u.tool ?? 'tool', input: u.input, text: results.get(u.tool_use_id) ?? u.text ?? '(no result recorded)' }));
  const tail = input.slice(next);
  const framed = { role: 'user', text: frame ? frame(text) : framedHandoff(text, siblings, extras, tail.length), toolUses: [] } as HandoffMessage as M;
  const seated = brief === undefined ? [] : [{ role: 'user', text: brief, toolUses: [] } as HandoffMessage as M];
  // A self-framed text is installed untouched, so what was made beside it goes in a message of its own, before it: the text stays the freshest read.
  const beside = frame ? besideParts(siblings, extras) : [];
  const carried = beside.length === 0 ? [] : [{ role: 'user', text: [HANDOFF_OPENING, ...beside].join('\n\n'), toolUses: [] } as HandoffMessage as M];
  return { messages: [...seated, ...carried, framed, ...tail], tail: tail.length, siblings: siblings.length };
}

/** The blocks the harness itself puts in a user message: a finished background task, a reminder, a local command's output. */
const HARNESS_BLOCK = /^\s*<(task-notification|system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|teammate-message|user-prompt-submit-hook)(?:\s[^>]*)?>[\s\S]*?<\/\1>/;
const LOCAL_COMMAND_CAVEAT = /^\s*Caveat: The messages below were generated by the user while running local commands\.[^\n]*/;

/**
 * Whether a user-side message was written by the harness and not by a person:
 * the text opens with an installed handoff, or is nothing but closed harness
 * blocks. A block that never closes, or any text beside one, is a person's,
 * as is an interrupt: the doubt always falls toward the person, whose word
 * cancels a stored handoff.
 */
export function isHarnessText(text: string): boolean {
  if (text.startsWith(HANDOFF_OPENING)) return true;
  let rest = text;
  for (;;) {
    const next = rest.replace(HARNESS_BLOCK, '').replace(LOCAL_COMMAND_CAVEAT, '');
    if (next === rest) break;
    rest = next;
  }
  return rest !== text && rest.trim() === '';
}
