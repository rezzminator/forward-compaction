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

/** A party's reading: the context its response was answered over plus that response's own output, which the next request carries too. */
export function readingTokens(usage: ({ output_tokens?: number } & NonNullable<Parameters<typeof contextTokens>[0]>) | null | undefined): number | undefined {
  const context = contextTokens(usage);
  return context === undefined ? undefined : context + (typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0);
}

export type PartyKind = 'main' | 'subagent' | 'foreign';

export type DecideInput = {
  trigger: Trigger;
  party: PartyKind;
  /** A handoff is stored and its `forward_compaction` call is in `e.messages`. */
  stored?: boolean;
  /** A handoff is stored but its call is not in `e.messages`: something else compacted the party since. */
  storedMissing?: boolean;
  /** The party's last reading; undefined when it has none (none yet, or none since an install): no ceiling is reached then. */
  tokens?: number;
  /** The context at which a party with no handoff gets a mechanical wake. Left out, it is never reached. */
  ceiling?: number;
  /** `parties.reactive`: the ask follows a skip with no completed request, so Claude Code found the request too long (D8). */
  reactive?: boolean;
  /** `FORWARD_COMPACTION_CEILING_NATIVE`: at the ceiling, Claude Code's own summary runs. */
  ceilingNative?: boolean;
  /** Screen name of the party: "main", or "{subagentType} {agentId first 6}". */
  label?: string;
  /** `Parties.ignored`: the party's model is on the ignore list: it takes no handoff, and its asks are held until its ceiling. */
  ignored?: boolean;
  /** `Parties.windowUnknown`: the party's ceiling is not known, so it is never reached; a reactive ask stays mechanical. */
  windowUnknown?: boolean;
};

/** The decision row's `decision` for the action. */
export type Action =
  | { action: 'next'; decision: 'native' | 'pass' | 'foreign'; why: 'manual' | 'plugin' | 'foreign' | 'ceiling' | 'reactive'; dropStored?: true }
  | { action: 'skip'; decision: 'skip'; why: 'precompute' | 'waiting' | 'no-reading' | 'ignored-model'; reason: string; dropStored?: true }
  | { action: 'install'; decision: 'install'; why: 'stored' }
  | { action: 'mechanical'; decision: 'mechanical'; why: 'ceiling' | 'reactive'; dropStored?: true };

/**
 * One `session.compact` ask (rows C1-C10 of the decision table). A manual ask runs Claude Code's own summary and
 * drops the stored handoff; a precompute is skipped; a handoff stored for main installs at a plugin request
 * (the turn-end door) and for any party at an automatic ask. With nothing stored an automatic ask is held until
 * the ceiling, or at once when it follows a held ask unanswered (the request was too long), and then the party
 * gets a mechanical wake, or Claude Code's own summary when the ceiling is native. A foreign party (the engine's own
 * fork) is never ours: its automatic ask passes. A party whose model is on the ignore list stores nothing, so its ask is
 * held as `ignored-model` until the ceiling. An automatic ask from any other party with no reading and nothing stored is
 * held as `no-reading`: the next reading decides. A stored handoff whose call left the transcript is dropped, and the ask goes on as if none were stored.
 */
export function decide({ trigger, party, stored = false, storedMissing = false, tokens, ceiling = Number.POSITIVE_INFINITY, reactive = false, ceilingNative = false, label = 'main', ignored = false, windowUnknown = false }: DecideInput): Action {
  const drop = storedMissing ? ({ dropStored: true } as const) : {};
  if (trigger === 'manual') return { action: 'next', decision: 'native', why: 'manual', dropStored: true };
  if (trigger === 'precompute') return { action: 'skip', decision: 'skip', why: 'precompute', reason: 'forward-compaction: precompute is never used' };
  if (trigger === 'plugin') {
    if (party === 'main' && stored) return { action: 'install', decision: 'install', why: 'stored' };
    return { action: 'next', decision: 'pass', why: 'plugin', ...(party === 'main' ? drop : {}) };
  }
  if (party === 'foreign') return { action: 'next', decision: 'foreign', why: 'foreign' };
  if (stored && !ignored) return { action: 'install', decision: 'install', why: 'stored' };
  const atCeiling = !windowUnknown && tokens !== undefined && tokens >= ceiling;
  if (atCeiling || reactive) {
    const why = atCeiling ? 'ceiling' : 'reactive';
    if (ceilingNative) return { action: 'next', decision: 'native', why, ...drop };
    return { action: 'mechanical', decision: 'mechanical', why, ...drop };
  }
  if (ignored) return { action: 'skip', decision: 'skip', why: 'ignored-model', reason: `forward-compaction: holding Claude Code's compaction for ${label}: its model is on the ignore list, so it is compacted mechanically at its ceiling`, ...drop };
  if (tokens === undefined) return { action: 'skip', decision: 'skip', why: 'no-reading', reason: `forward-compaction: holding Claude Code's compaction for ${label}: it has no reading yet, and its next reading decides`, ...drop };
  return { action: 'skip', decision: 'skip', why: 'waiting', reason: `forward-compaction: holding Claude Code's compaction for ${label} until its handoff is stored or the ceiling is reached`, ...drop };
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
