// The engine's own messages a wake hands back untouched: a sub-agent's start, first (`keptStart`), and what came after
// the frontier's call (`splitAtCall`), the newest of it that fits (`fitTail`). Pure: the messages arrive as values.
import { WAKE_OPENING } from './wake-row';

/** A message in `session.compact`'s shape; a SessionMessage fits. */
export type WakeMessage = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: readonly { tool_use_id: string; tool?: string; input?: unknown; text?: string }[];
  toolResults?: readonly { tool_use_id: string; text?: string }[];
  handle?: string;
};

/** A message this module builds; no handle, so the engine reads it as built. */
export type BuiltMessage = { role: 'user' | 'assistant'; text: string; toolUses: [] };

export type Sibling = { tool: string; input: unknown; text: string };

/** The assistant line that ends a kept start: one constant text, so the engine's own copy of it is known again at the next compaction. */
export const START_END = 'My context was compacted here. What follows is the record of my work and my frontier as forward-compaction holds them.';

/**
 * A sub-agent's start: the user messages its transcript opens with (its brief; what the engine attached to a message
 * stays with it) and the assistant line that ends them, the engine's own once a wake has installed it. Handed back first
 * and by handle, the start is the same request prefix after every compaction, so each one after the first reads it from
 * the prompt cache; without it the engine sends its instructions and listings again and they are written anew. The line
 * is there because the engine marks the prompt cache at an assistant message: what a wake builds has to follow one.
 * Undefined for a transcript that opens any other way: with a wake built without a start, or a message with no handle.
 */
export function keptStart<M extends WakeMessage>(messages: readonly M[]): { start: M[]; end: M | BuiltMessage } | undefined {
  const openings: readonly string[] = Object.values(WAKE_OPENING);
  const leads = (m: M): boolean => m.role === 'user' && m.handle !== undefined && (m.toolResults?.length ?? 0) === 0 && !openings.some((opening) => m.text.startsWith(opening));
  let lead = 0;
  while (lead < messages.length && leads(messages[lead]!)) lead++;
  if (lead === 0) return undefined;
  const next = messages[lead];
  const own = next !== undefined && next.role === 'assistant' && next.handle !== undefined && next.text === START_END && next.toolUses.length === 0;
  return { start: messages.slice(0, lead), end: own ? next : { role: 'assistant', text: START_END, toolUses: [] } };
}

/** Characters to tokens, only ever at the party's measured ratio (`charsPerToken` in window.ts), never at a fixed one. */
export const tokensOf = (chars: number, ratio: number): number => Math.ceil(chars / ratio);

/**
 * The anchor is the last assistant message whose tool uses hold `toolUseId`; the response is the run of assistant
 * messages around it; the user messages right after it whose results all answer that response's calls are its results.
 * `tail` is everything after them, the same objects (handles kept); `siblings` are the response's other calls with
 * their result text; `own` is the call's own result (its receipt and experimental line), which the tail no longer holds.
 * Undefined when the anchor is not in `messages`.
 */
export function splitAtCall<M extends WakeMessage>(messages: readonly M[], toolUseId: string): { tail: M[]; siblings: Sibling[]; own?: string } | undefined {
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant' && m.toolUses.some((u) => u.tool_use_id === toolUseId)) {
      at = i;
      break;
    }
  }
  if (at < 0) return undefined;
  let first = at;
  while (first > 0 && messages[first - 1]!.role === 'assistant') first--;
  let last = at;
  while (last + 1 < messages.length && messages[last + 1]!.role === 'assistant') last++;
  const uses = messages.slice(first, last + 1).flatMap((m) => m.toolUses);
  const ids = new Set(uses.map((u) => u.tool_use_id));
  const results = new Map<string, string>();
  let next = last + 1;
  while (next < messages.length) {
    const m = messages[next]!;
    const answers = m.toolResults ?? [];
    if (m.role !== 'user' || answers.length === 0 || !answers.every((r) => ids.has(r.tool_use_id))) break;
    for (const r of answers) results.set(r.tool_use_id, r.text ?? '');
    next++;
  }
  const siblings = uses
    .filter((u) => u.tool_use_id !== toolUseId)
    .map((u) => ({ tool: u.tool ?? 'tool', input: u.input, text: results.get(u.tool_use_id) ?? u.text ?? '(no result recorded)' }));
  const own = results.get(toolUseId);
  return { tail: messages.slice(next), siblings, ...(own !== undefined ? { own } : {}) };
}

/** A message's size at `ratio` characters a token: its text, its tool inputs and its tool results (a call's own result text is the answer's, counted there). */
export function messageTokens(m: WakeMessage, ratio: number): number {
  let chars = m.text.length;
  for (const u of m.toolUses) chars += JSON.stringify(u.input ?? {}).length;
  for (const r of m.toolResults ?? []) chars += (r.text ?? '').length;
  return tokensOf(chars, ratio);
}

/**
 * The newest whole messages that fit `budgetTokens`: the oldest are dropped until the rest fits, then any leading user
 * message carrying tool results too, so no result stands without its call. The kept messages are the input objects.
 */
export function fitTail<M extends WakeMessage>(messages: readonly M[], budgetTokens: number, ratio: number): { messages: M[]; dropped: number } {
  let total = messages.reduce((sum, m) => sum + messageTokens(m, ratio), 0);
  let from = 0;
  while (from < messages.length && total > budgetTokens) total -= messageTokens(messages[from++]!, ratio);
  while (from < messages.length && messages[from]!.role === 'user' && (messages[from]!.toolResults?.length ?? 0) > 0) from++;
  return { messages: messages.slice(from), dropped: from };
}

/** Every text a kept message holds, for the facts to leave out what the tail already says. */
export function keptTexts(kept: readonly WakeMessage[]): string[] {
  return kept.flatMap((m) => [m.text, ...m.toolUses.map((u) => u.text ?? ''), ...(m.toolResults ?? []).map((r) => r.text ?? '')]).filter((t) => t !== '');
}
