import type { ArmedHandoff } from './handoff.ts';
import { nudgeLevel } from './nudge.ts';

/**
 * Per-party state, keyed "main" or by agent id: the first and the last context
 * reading, the focus or the handoff its model armed (one at a time, the latest
 * wins), the last nudge level sent, and whether its stop on a marker was refused.
 */
export class Parties {
  private readonly readings = new Map<string, number>();
  private readonly firstReadings = new Map<string, number>();
  private readonly focuses = new Map<string, string>();
  private readonly handoffs = new Map<string, ArmedHandoff>();
  private readonly levels = new Map<string, number>();
  private readonly refused = new Set<string>();
  private readonly notices = new Map<string, string[]>();
  private readonly held = new Set<string>();

  reading(key: string): number | undefined {
    return this.readings.get(key);
  }

  /**
   * Records a reading. `fresh` says the reading came from the session's first
   * request; only such a reading can become the first reading. A plugin
   * reloaded mid-session reads its first at a late request, which is no base.
   */
  read(key: string, tokens: number, fresh = true): void {
    this.readings.set(key, tokens);
    this.held.delete(key);
    if (fresh && !this.firstReadings.has(key)) this.firstReadings.set(key, tokens);
  }

  /** The party's first reading when it came from the session's first request: its system prompt, tools and first message, about what a handoff cuts it back to. */
  firstReading(key: string): number | undefined {
    return this.firstReadings.get(key);
  }

  armed(key: string): string | undefined {
    return this.focuses.get(key);
  }

  arm(key: string, focus: string): void {
    this.handoffs.delete(key);
    this.focuses.set(key, focus);
  }

  handoff(key: string): ArmedHandoff | undefined {
    return this.handoffs.get(key);
  }

  armHandoff(key: string, handoff: ArmedHandoff): void {
    this.focuses.delete(key);
    this.handoffs.set(key, handoff);
  }

  /**
   * Drops an armed focus or handoff without a compaction: the person cancelled
   * it, or the compaction it armed did not finish. The nudges already sent stay
   * sent, so none repeats at once. True when one was armed.
   */
  disarm(key: string): boolean {
    const focus = this.focuses.delete(key);
    const handoff = this.handoffs.delete(key);
    return focus || handoff;
  }

  /** Queues a line the party's model reads on its next tool result (the main chat, on its next prompt); a line already waiting is not queued twice. */
  notify(key: string, line: string): void {
    const queued = this.notices.get(key);
    if (queued) {
      if (!queued.includes(line)) queued.push(line);
    }
    else this.notices.set(key, [line]);
  }

  /** The queued lines, emptied. A compaction does not clear them: a notice about it is read after it. */
  takeNotices(key: string): string[] {
    const queued = this.notices.get(key) ?? [];
    this.notices.delete(key);
    return queued;
  }

  /** An automatic ask of the party was held: until its next reading, the request that hold let through is unanswered. */
  heldAsk(key: string): void {
    this.held.add(key);
  }

  /** True while no response came since the party's last held automatic ask. */
  unanswered(key: string): boolean {
    return this.held.has(key);
  }

  /** A response answered the party's held ask without a reading (a step with no usage that asks for tools): its next automatic ask is held again. */
  answered(key: string): void {
    this.held.delete(key);
  }

  /** The party's turn ended: an interrupt or an API error answered the held ask, so the next turn's ask is held again. */
  turnEnded(key: string): void {
    this.held.delete(key);
  }

  continued(key: string): boolean {
    return this.refused.has(key);
  }

  markContinued(key: string): void {
    this.refused.add(key);
  }

  /** The nudge level owed at the last reading, recorded as sent; undefined when none is owed or the party is armed or holds a handoff. */
  nudgeDue(key: string, start: number, every: number): number | undefined {
    const tokens = this.readings.get(key);
    if (tokens === undefined || this.focuses.has(key) || this.handoffs.has(key)) return undefined;
    const level = nudgeLevel(tokens, start, every);
    if (level < 0 || level <= (this.levels.get(key) ?? -1)) return undefined;
    this.levels.set(key, level);
    return level;
  }

  /** The party starts over as if new: a /clear or a resume ended the conversation it held. */
  forget(key: string): void {
    for (const map of [this.readings, this.firstReadings, this.focuses, this.handoffs, this.levels, this.notices]) map.delete(key);
    this.refused.delete(key);
    this.held.delete(key);
  }

  /**
   * After a compaction ran: the reading becomes the size after it (0 when none
   * was reported), so a tool call that lands before the next response reads no
   * stale figure; the armed focus, the nudges and the refused stop start over.
   */
  compacted(key: string, tokensAfter: number | undefined): void {
    this.readings.set(key, tokensAfter ?? 0);
    this.focuses.delete(key);
    this.handoffs.delete(key);
    this.levels.delete(key);
    this.refused.delete(key);
    this.held.delete(key);
  }
}

/** A request counts as the session's first when it is step 0 of a turn that carries at most this many messages (the prompt and its context lines). */
export const FRESH_MAX_MESSAGES = 3;

/**
 * Whether a request is the session's first, the only one whose reading is the
 * base a handoff cuts back to. A sub-agent's first request is step 0 of a
 * short turn. The main chat's is that and also its first prompt: after a CLI
 * compaction its first step a reloaded plugin sees is also short (a summary
 * and the prompt), but the session has sent many prompts. An unknown prompt count is not first.
 */
export function isFirstRequest(args: { index?: number; messageCount?: number; main: boolean; turns?: number }): boolean {
  if (args.index !== 0 || typeof args.messageCount !== 'number' || args.messageCount > FRESH_MAX_MESSAGES) return false;
  return args.main ? args.turns === 1 : true;
}
