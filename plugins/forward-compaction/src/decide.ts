export type Trigger = 'manual' | 'auto' | 'plugin' | 'precompute';

const TRIGGERS: readonly Trigger[] = ['auto', 'manual', 'plugin', 'precompute'];

/** The trigger when the plugin knows it; undefined for any other value a newer Claude Code may send. */
export function knownTrigger(trigger: unknown): Trigger | undefined {
  return TRIGGERS.find((known) => known === trigger);
}

/** The context a response was answered over: uncached input plus cache reads and writes. */
export function contextTokens(usage: {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
} | null | undefined): number | undefined {
  if (!usage || typeof usage.input_tokens !== 'number') return undefined;
  return usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

type TranscriptMessage = {
  text?: string;
  toolUses?: readonly { tool_use_id: string; input?: unknown; text?: string }[];
  toolResults?: readonly { tool_use_id: string; text?: string }[];
};

/** Characters per token for the estimate; code runs near 3.5. */
export const CHARS_PER_TOKEN = 3.5;

/**
 * A rough token count: of a character count, or of a transcript in `session.compact`'s shape (message text,
 * tool inputs and each tool result once; a result the transcript carries both on the call and on the answer
 * is counted once). A transcript leaves out the system prompt and tool definitions, so it runs below the true context.
 */
export function estimateTokens(input: number | readonly TranscriptMessage[]): number {
  if (typeof input === 'number') return Math.ceil(input / CHARS_PER_TOKEN);
  let chars = 0;
  const answered = new Set<string>();
  for (const message of input) for (const result of message.toolResults ?? []) answered.add(result.tool_use_id);
  for (const message of input) {
    chars += message.text?.length ?? 0;
    for (const use of message.toolUses ?? []) {
      chars += JSON.stringify(use.input ?? {}).length;
      if (!answered.has(use.tool_use_id)) chars += use.text?.length ?? 0;
    }
    for (const result of message.toolResults ?? []) chars += result.text?.length ?? 0;
  }
  return estimateTokens(chars);
}

/**
 * A party's context now. The last response's usage lags by one step: the tool results that came back since are
 * not in it, and one step of parallel reads can add 100k tokens. The transcript estimate sees them, so the
 * larger of the two is taken. A party with no reading yet gets the estimate alone; an empty transcript has none.
 */
export function currentTokens(lastResponse: number | undefined, messages: readonly TranscriptMessage[]): number | undefined {
  const estimate = estimateTokens(messages);
  if (lastResponse === undefined) return estimate > 0 ? estimate : undefined;
  return Math.max(lastResponse, estimate);
}

export type PartyKind = 'main' | 'subagent' | 'foreign';

export type DecideInput = {
  trigger: Trigger;
  party: PartyKind;
  /** A handoff is stored and its `forward_compaction` call is in `e.messages`. */
  stored?: boolean;
  /** A handoff is stored but its call is not in `e.messages`: something else compacted the party since. */
  storedMissing?: boolean;
  /** The party's current context (currentTokens); undefined when neither a reading nor an estimate exists. */
  tokens?: number;
  /** The context at which a party with no handoff gets a mechanical wake. Left out, it is never reached. */
  ceiling?: number;
  /** `parties.reactive`: the ask follows a skip with no completed request, so Claude Code found the request too long (D8). */
  reactive?: boolean;
  /** `FORWARD_COMPACTION_CEILING_NATIVE`: at the ceiling, Claude Code's own summary runs. */
  ceilingNative?: boolean;
  /** Screen name of the party: "main", or "{subagentType} {agentId first 6}". */
  label?: string;
};

/** The decision row's `decision` for the action. */
export type Action =
  | { action: 'next'; decision: 'native' | 'pass' | 'foreign'; why: 'manual' | 'plugin' | 'foreign' | 'ceiling' | 'reactive'; dropStored?: true }
  | { action: 'skip'; decision: 'skip'; why: 'precompute' | 'waiting'; reason: string; nudge?: 'now'; dropStored?: true }
  | { action: 'install'; decision: 'install'; why: 'stored' }
  | { action: 'mechanical'; decision: 'mechanical'; why: 'ceiling' | 'reactive'; dropStored?: true };

/**
 * One `session.compact` ask (rows C1-C10 of the decision table). A manual ask runs Claude Code's own summary and
 * drops the stored handoff; a precompute is skipped; a handoff stored for main installs at a plugin request
 * (the turn-end door) and for any party at an automatic ask. With nothing stored an automatic ask is held until
 * the ceiling, or at once when it follows a held ask unanswered (the request was too long), and then the party
 * gets a mechanical wake, or Claude Code's own summary when the ceiling is native. A foreign party (the engine's own
 * fork) is never ours. A stored handoff whose call left the transcript is dropped, and the ask goes on as if none were stored.
 */
export function decide({ trigger, party, stored = false, storedMissing = false, tokens, ceiling = Number.POSITIVE_INFINITY, reactive = false, ceilingNative = false, label = 'main' }: DecideInput): Action {
  const drop = storedMissing ? ({ dropStored: true } as const) : {};
  if (trigger === 'manual') return { action: 'next', decision: 'native', why: 'manual', dropStored: true };
  if (trigger === 'precompute') return { action: 'skip', decision: 'skip', why: 'precompute', reason: 'forward-compaction: precompute is never used' };
  if (trigger === 'plugin') {
    if (party === 'main' && stored) return { action: 'install', decision: 'install', why: 'stored' };
    return { action: 'next', decision: 'pass', why: 'plugin', ...(party === 'main' ? drop : {}) };
  }
  if (party === 'foreign') return { action: 'next', decision: 'foreign', why: 'foreign' };
  if (stored) return { action: 'install', decision: 'install', why: 'stored' };
  const atCeiling = tokens !== undefined && tokens >= ceiling;
  if (atCeiling || reactive) {
    const why = atCeiling ? 'ceiling' : 'reactive';
    if (ceilingNative) return { action: 'next', decision: 'native', why, ...drop };
    return { action: 'mechanical', decision: 'mechanical', why, ...drop };
  }
  return { action: 'skip', decision: 'skip', why: 'waiting', reason: `forward-compaction: waiting for ${label}'s handoff`, nudge: 'now', ...drop };
}

export type TurnEndInput = {
  main: boolean;
  /** `turn.complete`'s reason. */
  reason: string;
  /** A handoff is stored for the party. */
  stored: boolean;
  /** `parties.get(key).installedThisTurn`. */
  installedThisTurn: boolean;
};

export type TurnEnd = { compact: true } | { compact: false; why: 'not-main' | 'not-answered' | 'nothing-stored' | 'installed-this-turn' };

/** Row P1: whether main's turn end calls `$.session.compact()`. Everything else keeps the handoff stored for the next door. */
export function turnEndDoor({ main, reason, stored, installedThisTurn }: TurnEndInput): TurnEnd {
  if (!main) return { compact: false, why: 'not-main' };
  if (reason !== 'answer') return { compact: false, why: 'not-answered' };
  if (!stored) return { compact: false, why: 'nothing-stored' };
  if (installedThisTurn) return { compact: false, why: 'installed-this-turn' };
  return { compact: true };
}
