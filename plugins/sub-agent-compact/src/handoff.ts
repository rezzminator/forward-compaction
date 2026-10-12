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
  'Hand off to yourself: the text you pass in `handoff` replaces your whole conversation so far, and you keep working from it. Everything before this call (the messages, every file you read, every tool result, your reasoning) leaves your context; your handoff, installed verbatim, is all you will have of it. Nothing summarizes for you, so a detail you leave out is lost and costs a re-read. What you do after this call is kept as it happens.',
  '',
  'Call it once sub-agent-compact has nudged you (earlier is refused), at a clean milestone with work still ahead. Never while the person waits on your answer, and not when only your final answer is left: give that instead.',
  '',
  'Write it for yourself with no memory of this conversation, complete enough that you never re-open what you already read:',
  "- the task in the person's or your brief's own words, and every value it fixed, verbatim: names, numbers, paths, code words, constraints",
  '- what is done, with its evidence: results, figures, test verdicts, commit ids',
  '- the facts the remaining work uses, verbatim where the wording matters: quotes, signatures, commands and their output, each with its file:line',
  '- decisions taken and options rejected, with why',
  '- what is in flight (agents running, results awaited) and what is left, in order',
  '- the next step, concrete enough to start without reading anything first',
].join('\n');

export const HANDOFF_INPUT_DESCRIPTION =
  'Your complete handoff. It becomes your only memory of the work so far, installed exactly as written: everything the remaining work needs, verbatim where exact (values, quotes, figures, paths with lines), and the next step.';

function k(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

/** Why a handoff cannot be stored, or undefined when it can. */
export function handoffProblem(text: unknown): string | undefined {
  const missing = 'Not stored: `handoff` must hold the task with its fixed values, what is done, the facts the rest needs and the next step.';
  if (typeof text !== 'string' || text.trim() === '') return missing;
  const length = text.trim().length;
  if (length < HANDOFF_MIN_CHARS) return `${missing} Yours is ${length} characters; everything before this call is replaced by it, so write it out in full.`;
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
  /** The handoff tool's full name. */
  toolName: string;
  /** The party's first reading: about what a handoff cuts each request back to; unknown leaves the estimate out. */
  firstReading: number | undefined;
};

/** What the model reads after a tool result once its context passes a nudge point, with the handoff tool on. */
export function handoffNudgeText({ tokens, level, autoCompact, main, toolName, firstReading }: HandoffNudgeInput): string {
  const how = main
    ? `Call ${toolName} with a complete handoff.`
    : `Call ${toolName} with a complete handoff if you have that tool; otherwise write <handoff>your handoff</handoff> in a response that also makes your next tool call, never alone, because a response without a tool call ends your run.`;
  const cut = firstReading !== undefined && firstReading < tokens ? `, cutting each later request to about ${k(firstReading)} plus your handoff` : '';
  return [
    `sub-agent-compact: your context is ${k(tokens)} tokens, and every request re-sends all of it.`,
    ...(main ? ['The person steers this chat: when they are waiting on an answer or asked you not to hand off, finish their ask first and never hand off while they wait.'] : []),
    'If only your final answer is left, give it and do not hand off.',
    level > 0 ? `Nudge ${level + 1}: with more work still ahead, make the handoff your next call, before any other tool.` : 'With more work still ahead, hand off now: once the result above closes a step, make the handoff your next call, before any other tool.',
    how,
    `The handoff replaces your whole context, verbatim, as your only memory of the work so far${cut}.`,
    'Put in everything the rest of the work needs, so nothing has to be read again: the task and every value it fixed, verbatim; what is done, with evidence; the facts, quotes and file:line anchors you will use; decisions and rejected options; what is in flight and what is left; the next step.',
    `Compaction is forced at ${k(autoCompact)} whether you hand off or not.`,
  ].join(' ');
}

/** The handoff tool's reply once the handoff is stored. */
export function handoffStoredText({ chars }: { chars: number }): string {
  return `Handoff stored (${k(Math.ceil(chars / CHARS_PER_TOKEN))} tokens). At your next compaction point, usually before your next request, it replaces everything before this call; what you do after this call is kept as it happens. Carry on with your next step. To change it, call the tool again: the latest handoff is the one installed.`;
}

/** What the main chat's model reads beside the person's prompt that cancelled its stored handoff. */
export function handoffDisarmedText(): string {
  return "sub-agent-compact: the person's message cancelled the handoff you stored; it will not be installed. Answer them, and do not hand off again until their ask is done.";
}

/** Where the handoff was written: the tool call that carried it, or the response that carried its marker. */
export type HandoffAnchor = { toolUseId: string } | { marker: true };

export type ArmedHandoff = { text: string; anchor: HandoffAnchor };

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

/** The installed message: what it is, the handoff verbatim, the results the handoff could not include, and whether its aftermath follows. */
function framedHandoff(text: string, siblings: readonly Sibling[], extras: readonly string[], tail: number): string {
  const parts = [
    `${HANDOFF_OPENING} Your context was reset. Below is the handoff you wrote with the handoff tool right before the reset: it is now your whole memory of the work up to that point. The earlier messages, file contents and tool results are gone, and nothing else was kept or summarized. Treat what it records as known and do not re-read it; open a file again only for something it does not hold.`,
    `=== handoff ===\n${text}\n=== end of handoff ===`,
  ];
  if (siblings.length > 0) {
    parts.push(
      [
        'Results of the tool calls you made in the same response as the handoff, which it could not include:',
        ...siblings.map((s) => `--- ${s.tool} ${JSON.stringify(s.input ?? {})} ---\n${cut(s.text)}`),
      ].join('\n'),
    );
  }
  if (extras.length > 0) parts.push(`Delivered with those results:\n${extras.join('\n')}`);
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
 * are carried as text inside the framed message, since their own call leaves
 * with the response. Undefined when the anchor is not in the transcript.
 */
export function installHandoff<M extends HandoffMessage>(
  input: readonly M[],
  { text, anchor, brief }: { text: string; anchor: HandoffAnchor; brief?: string },
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
  const framed = { role: 'user', text: framedHandoff(text, siblings, extras, tail.length), toolUses: [] } as HandoffMessage as M;
  const seated = brief === undefined ? [] : [{ role: 'user', text: brief, toolUses: [] } as HandoffMessage as M];
  return { messages: [...seated, framed, ...tail], tail: tail.length, siblings: siblings.length };
}
