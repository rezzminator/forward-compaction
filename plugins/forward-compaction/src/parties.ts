import type { Landing } from './wake.ts';
import { ignoredBy, type RatioBase } from './window.ts';
import { GATE_STEPS } from './nudge.ts';
import { keptOrders, type LiftedOrder, type StandingOrder } from './orders.ts';

/** A file the model asked the wake to carry (the tool's `load_files` entry). */
export type LoadFile = { path: string; lines?: string; why: string };

/** A handoff the model wrote, held in memory until a door installs it. */
export type StoredHandoff = {
  text: string;
  loadFiles: LoadFile[];
  /** The `forward_compaction` call that stored it: the anchor `splitAtCall` finds in the messages. */
  toolUseId: string;
  /** The party's last reading when it stored the handoff; absent when it had none (none since an install). */
  storedAtTokens?: number;
  /** The ledger's next seq when it was stored: what the ledger records for the party from it, the model never saw (ledger.ts `factsFor` `since`). */
  since: number;
  /** The standing orders it carried (the tool's `standing_orders`). */
  standingOrders?: StandingOrder[];
  /** The orders lifted since the last install: its own `lifted`, plus a replaced handoff's still unshown, each shown once in its wake. */
  lifted?: LiftedOrder[];
  /** Store order across all parties. */
  seq: number;
};

/** What the party's last `session.compact` ask ended in (the decision row's `decision`). */
export type AskDecision = 'skip' | 'install' | 'mechanical' | 'native' | 'pass' | 'foreign' | 'dropped' | 'error';

/** What the plugin does with a party: manage it, leave it to Claude Code (its model is on the ignore list), or not yet know. */
export type Judgement = 'managed' | 'ignored' | 'unknown';

/** What a party is judged by: whether main's max context is known (set, or its window read), and the ignore list (`FORWARD_COMPACTION_IGNORE_MODELS`). */
export type Judging = { mainKnown: boolean; ignore: readonly string[] };

/** The decision row `ignore`: a party's ignore judgement, written when first made and each time it changes, with the list entry its model matched. */
export type IgnoreRow = { event: 'ignore'; party: string; label: string; model: string | null; judged: Judgement; matched: string | null };

export type PartyState = {
  /** "main" or "agent:{id}". */
  key: string;
  /** What screen lines call the party: "main", or "{subagentType} {agentId first 6}". */
  label: string;
  model?: string;
  /** The measured context of the party's last completed request; none from an install until its next reading. */
  reading?: number;
  /** The ratio base (window.ts `charsPerToken`), taken at the party's first reading in its live window; none from any compaction of it until its next reading. */
  base?: RatioBase;
  /** Failed or denied reads of the window for the base since one last succeeded; the next is tried at request `baseRetryAt`, the gap doubling each miss. */
  baseMisses?: number;
  baseRetryAt?: number;
  /** An installed wake whose landed line waits for the party's first reading after it. */
  landing?: Landing;
  stored?: StoredHandoff;
  /** The standing orders of the party's last stored handoff: the next handoff carries or lifts each; an install or a dropped handoff keeps them. */
  orders?: StandingOrder[];
  lastDecision?: AskDecision;
  /** False from a skip until a request completes: the next ask is then a prompt too long (D8). */
  answeredSinceSkip: boolean;
  /** The highest nudge level delivered, or absorbed after an install, since the last install. */
  nudgeLevel: number;
  /** True from an install until the party's next reading, whose nudge level is then absorbed silently. */
  absorbNext: boolean;
  /** The nudge level from which the party's calls wait for its handoff (nudge.ts `gated`): GATE_STEPS past its first nudge since the last install; absent until that nudge. */
  gateLevel?: number;
  /** The party's completed requests: a gated call's request is told from a later one by it. */
  requests: number;
  /** The request whose calls the gate refused since the last install (`gateAnswer`). */
  gateRequest?: number;
  /** The gate let the party's calls run since the last install: it answered a refused request with no handoff. */
  gateOpen?: boolean;
  installs: number;
  /** An install happened in the party's current turn: the turn-end door (P1) does not fire again. */
  installedThisTurn: boolean;
  /** The loaded, unpinned names the last stored handoff's drop_skills asked once: the next handoff naming one again drops it. */
  dropAsked: string[];
  /** The judgement last returned by `judged`. */
  judged?: Judgement;
};

/** Per-party state, memory only, keyed "main" or "agent:{id}". A party is created on first touch. */
export class Parties {
  private readonly states = new Map<string, PartyState>();
  private seq = 0;

  /** The party's state, created with defaults when new. */
  get(key: string): PartyState {
    let state = this.states.get(key);
    if (!state) {
      state = { key, label: key, answeredSinceSkip: true, nudgeLevel: 0, absorbNext: false, requests: 0, installs: 0, installedThisTurn: false, dropAsked: [] };
      this.states.set(key, state);
    }
    return state;
  }

  describe(key: string, patch: { label?: string; model?: string }): void {
    Object.assign(this.get(key), patch);
  }

  /** The ignore-list entry the party's model matches: the plugin leaves it to Claude Code. Undefined while its model is not known. */
  ignored(key: string, ignore: readonly string[]): string | undefined {
    return ignoredBy(this.get(key).model, ignore);
  }

  /**
   * Main's max context is not known: `FORWARD_COMPACTION_MAIN_MAX_CONTEXT` is unset and Claude Code has not reported its
   * window yet. Main then gets no nudge and no ceiling. A sub-agent's is always known: `FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT`.
   */
  windowUnknown(key: string, mainKnown: boolean): boolean {
    return key === 'main' && !mainKnown;
  }

  /** The party's judgement as known now: `ignored`, a sub-agent whose model no step has named, and `windowUnknown`, in one word. */
  judgement(key: string, { mainKnown, ignore }: Judging): Judgement {
    if (this.ignored(key, ignore) !== undefined) return 'ignored';
    if (key !== 'main' && this.get(key).model === undefined) return 'unknown'; // no step has named its model: the list cannot judge it yet
    return this.windowUnknown(key, mainKnown) ? 'unknown' : 'managed';
  }

  /** The ignore row when the judgement is new or has changed since the last row returned for the party; undefined while it holds. */
  judged(key: string, judging: Judging): IgnoreRow | undefined {
    const state = this.get(key);
    const judged = this.judgement(key, judging);
    if (state.judged === judged) return undefined;
    state.judged = judged;
    return { event: 'ignore', party: key, label: state.label, model: state.model ?? null, judged, matched: this.ignored(key, judging.ignore) ?? null };
  }

  /** Stores the party's handoff, the latest winning; returns the one it replaced. */
  store(key: string, handoff: Omit<StoredHandoff, 'seq'>): StoredHandoff | undefined {
    const state = this.get(key);
    const replaced = state.stored;
    const standing = handoff.standingOrders ?? [];
    const unshown = (replaced?.lifted ?? []).filter((l) => !standing.some((o) => o.order === l.order)); // an order carried again is no longer lifted
    state.stored = { ...handoff, lifted: [...unshown, ...(handoff.lifted ?? [])], seq: ++this.seq };
    state.orders = [...standing];
    return replaced;
  }

  /** The orders `$.state` kept for the party before a plugin reload, when usable; a handoff stored in this process wins, and nothing kept adds no party. */
  restoreOrders(key: string, kept: unknown): void {
    const orders = keptOrders(kept);
    if (orders !== undefined) this.get(key).orders ??= orders;
  }

  /** Removes the party's stored handoff and returns it; a party never seen gains no state. */
  takeStored(key: string): StoredHandoff | undefined {
    const state = this.states.get(key);
    const stored = state?.stored;
    if (state) state.stored = undefined;
    return stored;
  }

  /**
   * A completed request's reading and its nudge level; that request also answers a held ask. The first reading after
   * an install is the party's floor plus what it kept: its level is absorbed, so the next nudge goes only past it.
   * Returns the landing that reading measures, taken: its line is due now.
   */
  read(key: string, tokens: number, level = 0): Landing | undefined {
    const state = this.get(key);
    const landing = state.landing;
    state.reading = tokens;
    state.landing = undefined;
    if (state.absorbNext) {
      state.absorbNext = false;
      state.nudgeLevel = Math.max(state.nudgeLevel, level);
    }
    this.answered(key);
    return landing;
  }

  /** Takes the landing still waiting for a reading (the party ends), or undefined; a party never seen gains no state. */
  takeLanding(key: string): Landing | undefined {
    const state = this.states.get(key);
    const landing = state?.landing;
    if (state) state.landing = undefined;
    return landing;
  }

  /** Every party's waiting landing, taken (the session ends). */
  takeLandings(): [string, Landing][] {
    return [...this.states.keys()].flatMap((key) => {
      const landing = this.takeLanding(key);
      return landing === undefined ? [] : [[key, landing] as [string, Landing]];
    });
  }

  /** What the party's ask ended in. A skip makes the next ask reactive until a request completes; a compaction left to Claude Code (native, pass) ends the ratio base. */
  asked(key: string, decision: AskDecision): void {
    const state = this.get(key);
    state.lastDecision = decision;
    if (decision === 'skip') state.answeredSinceSkip = false;
    if (decision === 'native' || decision === 'pass') state.base = undefined;
  }

  /** Sets the party's ratio base, or ends it (an unseen compaction): the next reading takes a new one. A party forgotten meanwhile gains no state. */
  rebase(key: string, base: RatioBase | undefined): void {
    const state = this.states.get(key);
    if (state) Object.assign(state, { base, baseMisses: undefined, baseRetryAt: undefined });
  }
  /** A read of the window for the base was denied or failed: the next is tried only after a gap that doubles each miss. */
  baseMissed(key: string): void {
    const state = this.get(key);
    state.baseMisses = (state.baseMisses ?? 0) + 1;
    state.baseRetryAt = state.requests + 2 ** state.baseMisses;
  }

  /** A new turn of the party: an ask held before it ended with the old turn, so the next ask is a fresh one, never a request too long. */
  newTurn(key: string): void {
    const state = this.states.get(key);
    if (state) state.answeredSinceSkip = true;
  }

  /** A request completed (with or without a usage reading). */
  answered(key: string): void {
    const state = this.get(key);
    state.answeredSinceSkip = true;
    state.requests += 1;
  }

  /**
   * What a gated call gets: refused while it belongs to the request that met the gate (its parallel calls too), let
   * run from any later one, `opens` the first time. No API names a sub-agent's tools: one whose list lacks the handoff
   * tool answers the refusal with another call, and would otherwise wait forever; its ceiling's mechanical wake stays.
   */
  gateAnswer(key: string): 'refuse' | 'opens' | 'open' {
    const state = this.get(key);
    state.gateRequest ??= state.requests;
    if (state.gateRequest === state.requests) return 'refuse';
    if (state.gateOpen) return 'open';
    state.gateOpen = true;
    return 'opens';
  }

  /** The ask follows a skip with no completed request between: Claude Code reports the request too long, not a fresh ask (D8). */
  reactive(key: string): boolean {
    const state = this.states.get(key);
    return state?.lastDecision === 'skip' && !state.answeredSinceSkip;
  }

  /**
   * Whether a nudge goes out now, recorded as sent: once per level while nothing is stored. None goes between an
   * install and the party's next reading: until then no size is measured.
   */
  nudgeDue(key: string, level: number): boolean {
    const state = this.get(key);
    if (state.stored || state.absorbNext || level <= state.nudgeLevel) return false;
    state.nudgeLevel = level;
    state.gateLevel ??= level + GATE_STEPS;
    return true;
  }

  /**
   * A compaction installed: the handoff goes, the nudges start over from the next reading's level, and no reading
   * stands until the next request measures one, whose landing line then goes out. Returns a landing still waiting from an earlier install.
   */
  installed(key: string, landing?: Landing): Landing | undefined {
    const earlier = this.get(key).landing;
    Object.assign(this.get(key), {
      stored: undefined,
      lastDecision: 'install',
      answeredSinceSkip: true,
      nudgeLevel: 0,
      absorbNext: true,
      gateLevel: undefined,
      gateRequest: undefined,
      gateOpen: undefined,
      reading: undefined,
      base: undefined,
      landing,
      installedThisTurn: true,
    });
    this.get(key).installs += 1;
    return earlier;
  }

  /** The party's turn ended. */
  turnEnded(key: string): void {
    this.get(key).installedThisTurn = false;
  }

  /** The party starts over as if never seen: its agent finished, or the conversation was cleared. */
  forget(key: string): void {
    this.states.delete(key);
  }
}
