function k(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

export type Trigger = 'manual' | 'auto' | 'plugin' | 'precompute';

export type DecideInput = {
  trigger: Trigger;
  /** "main", or the sub-agent's type. */
  label: string;
  limit: number;
  /** The party's current context tokens; undefined when neither a usage reading nor a trusted transcript estimate could be taken (currentTokens). */
  tokens: number | undefined;
  /** False when automatic compaction is off for this party; default true. */
  enabled?: boolean;
  /** The focus the party's model gave when it asked to compact itself; absent when it has not asked. */
  armed?: string;
  /** True for an engine loop missing from `$.agent.list()`: no policy governs it. */
  unlisted?: boolean;
  /** True for a Haiku loop: Claude Code asks it at its own point, whatever the plugin's limit. */
  haiku?: boolean;
};

export type Decision =
  | { action: 'pass'; why: 'requested' | 'self' | 'at-limit' | 'no-reading' | 'unlisted' | 'haiku' }
  | { action: 'skip'; reason: string };

/**
 * One compaction request: a person's or plugin's always passes, and so does an
 * automatic one once the party's model asked to compact itself. Otherwise an
 * automatic one is held for a party with automatic compaction off, and while
 * the party is below its limit. A party with no count at all (neither a usage
 * reading nor a transcript estimate) is never held while enabled, and
 * an engine loop the session does not list (a fork of its own) is never held.
 */
export function decide({ trigger, label, limit, tokens, enabled = true, armed, unlisted = false, haiku = false }: DecideInput): Decision {
  if (trigger === 'manual' || trigger === 'plugin') return { action: 'pass', why: 'requested' };
  if (unlisted) return { action: 'pass', why: 'unlisted' };
  // Claude Code asks a Haiku loop near 51k whatever the plugin's limit; holding that ask would run it into its window.
  if (haiku) return { action: 'pass', why: 'haiku' };
  if (armed !== undefined) return { action: 'pass', why: 'self' };
  if (!enabled) return { action: 'skip', reason: `${label}: auto-compact off` };
  if (tokens === undefined || !Number.isFinite(tokens)) return { action: 'pass', why: 'no-reading' };
  if (tokens >= limit) return { action: 'pass', why: 'at-limit' };
  // Claude Code draws this reason as a notice on every hold ("not compacted · main 311k/600k"), so it stays short.
  return { action: 'skip', reason: `${label} ${k(tokens)}/${k(limit)}` };
}

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
const CHARS_PER_TOKEN = 3.5;

/**
 * A rough token count of a transcript in `session.compact`'s shape: message
 * text, tool inputs and each tool result once (a result the transcript
 * carries both on the call and on the answer is counted once). It leaves out
 * the system prompt and tool definitions, so it runs below the true context.
 */
export function estimateTranscript(messages: readonly TranscriptMessage[]): number {
  let chars = 0;
  const answered = new Set<string>();
  for (const message of messages) for (const result of message.toolResults ?? []) answered.add(result.tool_use_id);
  for (const message of messages) {
    chars += message.text?.length ?? 0;
    for (const use of message.toolUses ?? []) {
      chars += JSON.stringify(use.input ?? {}).length;
      if (!answered.has(use.tool_use_id)) chars += use.text?.length ?? 0;
    }
    for (const result of message.toolResults ?? []) chars += result.text?.length ?? 0;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * A party's context now. The last response's usage lags by one step: the
 * tool results that came back since are not in it, and one step of parallel
 * reads can add 100k tokens. The transcript estimate sees them, so the larger
 * of the two is taken. A party that has not answered yet has no usage reading
 * (a sub-agent resumed from its transcript is asked to compact first): the
 * estimate stands alone, for its first ask only. Asked again (`askedBefore`)
 * with still no reading, the request after that ask got no response, as a
 * prompt too long gets none: the estimate, which runs below the true context
 * and is set against a limit sized without the party's model, is not trusted
 * twice. Neither a reading nor a trusted estimate gives undefined.
 */
export function currentTokens(lastResponse: number | undefined, messages: readonly TranscriptMessage[], askedBefore = false): number | undefined {
  if (lastResponse === undefined) {
    if (askedBefore) return undefined;
    const estimate = estimateTranscript(messages);
    return estimate > 0 ? estimate : undefined;
  }
  return Math.max(lastResponse, estimateTranscript(messages));
}

/** A prompt origin that is the person: at the terminal, over Remote Control, or the SDK host's own turn. */
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk']);

/**
 * Whether a submitted prompt comes from the person driving the session, whose
 * message cancels a self-compaction the model armed. A notification, a peer,
 * a schedule, a plugin or a channel the engine cannot attest never cancels it.
 */
export function personPrompt(origin: { kind: string } | undefined): boolean {
  return origin !== undefined && PERSON_ORIGINS.has(origin.kind);
}

/**
 * How a compaction the plugin let through ended: `compacted` once it ran;
 * `unfinished` when it was skipped beneath, interrupted or failed, so the
 * focus armed for it is dropped rather than firing on the next request;
 * `precompute` for a precompute, which installs nothing and leaves the arm for
 * the compaction it prepares.
 */
export function compactionEnd({ trigger, skipped, aborted }: { trigger: Trigger; skipped: boolean; aborted: boolean }): 'compacted' | 'unfinished' | 'precompute' {
  if (trigger === 'precompute') return 'precompute';
  return skipped || aborted ? 'unfinished' : 'compacted';
}
