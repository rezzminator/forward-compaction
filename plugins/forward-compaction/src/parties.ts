import type { Landing } from './wake';
import { ignoredBy, type RatioBase } from './window';
import type { PlanSeen } from './plan';
import type { LoadFile } from './frontier';
import { emptyHeld, renderFrontier, roundPassed, type Held, type Item, type StorageEntry } from './lists';
import type { PartyFiles } from './disk';
import { storageDir } from './storage';
import type { SubagentWindow } from './options';
import { roomAbove, type NudgeMarks } from './nudge';
import type { ForkDue, ForkNotice } from './fork';

/** A `forward_compaction` call since the party's last wake, held until a door installs the frontier: the frontier itself is the party's held lists (`PartyState.held`), rendered at the wake. */
export type StoredFrontier = {
  loadFiles: LoadFile[];
  /** The `forward_compaction` call that stored it: the anchor `splitAtCall` finds in the messages. */
  toolUseId: string;
  /** The party's last reading when it stored the frontier; absent when it had none (none since an install). */
  storedAtTokens?: number;
  /** The ledger's next seq when it was stored: what the ledger records for the party from it, the model never saw (ledger.ts `factsFor` `since`). */
  since: number;
  /** Store order across all parties. */
  seq: number;
  /** Whether a door installs it (`Parties.compacts`): a call made before the party's context reached where a notice goes only changes its held frontier, and nothing compacts. */
  compacts: boolean;
  /** The call arrived broken or left the frontier without its objective or next (frontier.ts `callWaits`): one automatic ask is held before it installs (decide.ts `decide`), and `waited` ends the wait. */
  waits?: boolean;
};

/** What the party's last `session.compact` ask ended in (the decision row's `decision`). */
export type AskDecision = 'skip' | 'install' | 'mechanical' | 'native' | 'pass' | 'foreign' | 'dropped' | 'error';

/** What the plugin does with a party: manage it, leave it to Claude Code (its model is on the ignore list), or not yet know. */
export type Judgement = 'managed' | 'ignored' | 'unknown';

/** What a party is judged by: whether main's max context is known (set, or its window read), and the ignore list (`FORWARD_COMPACTION_IGNORE_MODELS`). */
export type Judging = { mainKnown: boolean; ignore: readonly string[] };

/** The decision row `ignore`: a party's ignore judgement, written when first made and each time it changes, with the list entry its model matched. */
export type IgnoreRow = { event: 'ignore'; party: string; label: string; model: string | null; judged: Judgement; matched: string | null };

/** The decision row `window`: the max context a sub-agent is measured against, where it came from and the ceiling it gives, written when first known and each time it changes; `unknown` says why its model's window is not known, and the max context is then the fallback. */
export type WindowRow = { event: 'window'; party: string; label: string; model: string; ceiling: number } & SubagentWindow;

export type PartyState = {
  /** "main" or "agent:{id}". */
  key: string;
  /** What screen lines call the party: "main", or "{subagentType} {agentId first 6}". */
  label: string;
  model?: string;
  /** The agent type a sub-agent was spawned as (`$.agent.list()`'s `type`, `agent.spawn`'s `subagentType`); main has none. */
  type?: string;
  /** The measured context of the party's last completed request; none from an install until its next reading. */
  reading?: number;
  /** The ratio base (window.ts `charsPerToken`), taken at the party's first reading in its live window; none from any compaction of it until its next reading. */
  base?: RatioBase;
  /** Failed or denied reads of the window for the base since one last succeeded; the next is tried at request `baseRetryAt`, the gap doubling each miss. */
  baseMisses?: number;
  baseRetryAt?: number;
  /** An installed wake whose landed line waits for the party's first reading after it. */
  landing?: Landing;
  stored?: StoredFrontier;
  /** The party's frontier as the plugin holds it, loaded from its files at first touch in this process (disk.ts); absent until then. */
  held?: Held;
  /** The party's files, and what waits to be written to them. */
  files?: PartyFiles;
  /** The party's `forward_compaction` call being applied: the next one waits for it, so each applies on the one before. */
  calling?: Promise<unknown>;
  lastDecision?: AskDecision;
  /** False from a skip until a request completes: the next ask is then a prompt too long (D8). */
  answeredSinceSkip: boolean;
  /** The highest nudge level delivered, or absorbed after an install, since the last install. */
  nudgeLevel: number;
  /** True from an install until the party's next reading, whose nudge level is then absorbed silently. */
  absorbNext: boolean;
  /** The party's floor after its last install (`Held.floor`): its next nudge waits until the context has grown by its room past it (nudge.ts `roomAbove`). */
  wokeAt?: number;
  /** The reading the party's last nudge went out at, since its last install: the next one waits until the context has grown by `every` past it. */
  nudgedAt?: number;
  /** The nudges delivered since the last install: the count a nudge's wording goes by (nudge.ts `nudgeText`). */
  nudges: number;
  /** The finish notice went out since the last install (`finishDue`). */
  finishTold: boolean;
  /** The party's completed requests. */
  requests: number;
  installs: number;
  /** An install happened in the party's current turn: the turn-end door (P1) does not fire again. */
  installedThisTurn: boolean;
  /** The judgement last returned by `judged`. */
  judged?: Judgement;
  /** The max context, source and unknown reason of the last window row returned for the party (`windowed`). */
  windowed?: string;
  /** Plan mode and the plan file, as the party's last plan-mode attachment named them (plan.ts `planFrom`). */
  plan?: PlanSeen;
  /** FORWARD_COMPACTION_MAIN_FORK: the fork due since main's last install, in place of the notice it holds (fork.ts `forkDueOf`). */
  forkDue?: ForkDue;
  /** The notice a failed fork leaves main to read with its next tool result (fork.ts `forkFailure`). */
  forkNotice?: ForkNotice;
};

/**
 * Where main's finish notice goes: a reading (`tokens`) of `start` or more that has grown by `every` past the party's
 * floor (`Held.floor`, which a restart keeps). A compaction sooner frees next to nothing: the context it leaves is the
 * floor again.
 */
const finishReached = (state: PartyState, tokens: number, start: number, every: number): boolean => tokens >= start && (state.held?.floor === undefined || tokens >= state.held.floor + every);

/** Per-party state, memory only, keyed "main" or "agent:{id}". A party is created on first touch. */
export class Parties {
  private readonly states = new Map<string, PartyState>();
  private seq = 0;

  /** The party's state, created with defaults when new. */
  get(key: string): PartyState {
    let state = this.states.get(key);
    if (!state) {
      state = { key, label: key, answeredSinceSkip: true, nudgeLevel: 0, absorbNext: false, nudges: 0, finishTold: false, requests: 0, installs: 0, installedThisTurn: false };
      this.states.set(key, state);
    }
    return state;
  }

  /** Sets what is named; a step that names no model keeps the one known, so its judgement never falls back to unknown. */
  describe(key: string, patch: { label?: string; model?: string; type?: string }): void {
    Object.assign(this.get(key), Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  }

  /** Whether the party is a sub-agent spawned as one of `types`. */
  typed(key: string, types: readonly string[]): boolean {
    const type = this.get(key).type;
    return type !== undefined && types.includes(type);
  }

  /** The ignore-list entry the party's model matches: the plugin leaves it to Claude Code. Undefined while its model is not known. */
  ignored(key: string, ignore: readonly string[]): string | undefined {
    return ignoredBy(this.get(key).model, ignore);
  }

  /**
   * Main's max context is not known: `FORWARD_COMPACTION_MAIN_MAX_CONTEXT` is unset and Claude Code has not reported its
   * window yet. Main then gets no nudge and no ceiling. A sub-agent always has one: `FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT`, else its model's, else the fallback (options.ts `subagentWindow`).
   */
  windowUnknown(key: string, mainKnown: boolean): boolean {
    return key === 'main' && !mainKnown;
  }

  /** The party's judgement as known now: `ignored`, a party whose model no step has named, and `windowUnknown`, in one word. */
  judgement(key: string, { mainKnown, ignore }: Judging): Judgement {
    if (this.ignored(key, ignore) !== undefined) return 'ignored';
    if (this.get(key).model === undefined) return 'unknown'; // no step has named its model: the list cannot judge it yet
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

  /** The window row when the party's max context, its source or the reason it is unknown is new or has changed since the last row returned for the party; undefined while it holds, and before a step has named the party's model. */
  windowed(key: string, window: SubagentWindow, ceiling: number): WindowRow | undefined {
    const state = this.get(key);
    const windowed = `${window.maxContext} ${window.source} ${window.unknown ?? ''}`;
    if (state.model === undefined || state.windowed === windowed) return undefined;
    state.windowed = windowed;
    return { event: 'window', party: key, label: state.label, model: state.model, ...window, ceiling };
  }

  /** Records the party's call, the latest winning; returns the one it follows. */
  store(key: string, frontier: Omit<StoredFrontier, 'seq'>): StoredFrontier | undefined {
    const state = this.get(key);
    const replaced = state.stored;
    state.stored = { ...frontier, seq: ++this.seq };
    return replaced;
  }

  /** The judgement and model `$.state` kept for the party before a plugin reload, when usable; what this process already knows wins. */
  restoreJudged(key: string, kept: unknown): void {
    if (typeof kept !== 'object' || kept === null) return;
    const { judged, model } = kept as Record<string, unknown>;
    if (judged !== 'managed' && judged !== 'ignored' && judged !== 'unknown') return;
    const state = this.get(key);
    state.judged ??= judged;
    if (typeof model === 'string') state.model ??= model;
  }

  /** The one ask held for the party's stored call that waits (`StoredFrontier.waits`) has passed: the next ask installs it. A party never seen gains no state. */
  waited(key: string): void {
    const stored = this.states.get(key)?.stored;
    if (stored !== undefined) stored.waits = false;
  }

  /** Removes the party's stored frontier and returns it; a party never seen gains no state. */
  takeStored(key: string): StoredFrontier | undefined {
    const state = this.states.get(key);
    const stored = state?.stored;
    if (state) state.stored = undefined;
    return stored;
  }

  /**
   * A completed request's reading and its nudge level; that request also answers a held ask. The first reading after
   * an install is the party's floor plus what it kept: its level is absorbed, so the next nudge goes only past it.
   * The party's first reading ever, its first after an install and any reading below its floor (a compaction this
   * plugin did not make) is its new floor (`Held.floor`), due in its file. After an install the floor settles at the
   * second reading, as the larger of the two: only the second request carries what Claude Code sends back after a
   * compaction (its skill, tool and agent listings). A reading below a settled floor also starts the notices over, as
   * an install does: its level is absorbed, the next nudge is the first again, the finish notice is owed again, and
   * a woken party's room is measured from it.
   * Returns the landing that reading measures, taken: its line is due now.
   */
  read(key: string, tokens: number, level = 0): Landing | undefined {
    const state = this.get(key);
    const landing = state.landing;
    state.reading = tokens;
    state.landing = undefined;
    const first = state.absorbNext, floor = state.held?.floor;
    const second = !first && state.held?.settling === true;
    const fell = !first && !second && floor !== undefined && tokens < floor;
    if (first || second || floor === undefined || fell) {
      const held: Held = { ...(state.held ?? emptyHeld()), floor: second ? Math.max(floor ?? 0, tokens) : tokens };
      if (first) held.settling = true;
      else delete held.settling;
      state.held = held;
      state.files?.changed('floor');
    }
    if (fell) Object.assign(state, { nudgeLevel: level, nudges: 0, nudgedAt: undefined, finishTold: false, ...(state.wokeAt === undefined ? {} : { wokeAt: tokens }) });
    if (second && state.wokeAt !== undefined) state.wokeAt = state.held!.floor;
    if (first) {
      state.absorbNext = false;
      state.nudgeLevel = Math.max(state.nudgeLevel, level);
      state.wokeAt = tokens;
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

  /** The ask follows a skip with no completed request between: Claude Code reports the request too long, not a fresh ask (D8). */
  reactive(key: string): boolean {
    const state = this.states.get(key);
    return state?.lastDecision === 'skip' && !state.answeredSinceSkip;
  }

  /**
   * Whether a nudge goes out now, recorded as sent: once per level while no call waits to install. None goes between an
   * install and the party's next reading: until then no size is measured. After a wake none goes until the reading
   * (`tokens`) has grown by the party's room (nudge.ts `roomAbove`) past the first one after it: a wake lands
   * near or above the nudge start, and a nudge a few thousand tokens later makes the party compact in a loop. None
   * goes within `every` of the last one either: a nudge held back past a level boundary is not followed by the next level's.
   */
  nudgeDue(key: string, level: number, tokens?: number, marks?: NudgeMarks): boolean {
    const state = this.get(key);
    if (state.stored?.compacts === true || state.absorbNext || level <= state.nudgeLevel) return false;
    if (tokens !== undefined && marks !== undefined) {
      if (state.wokeAt !== undefined && tokens < state.wokeAt + roomAbove(state.wokeAt, marks)) return false;
      if (state.nudgedAt !== undefined && tokens < state.nudgedAt + marks.every) return false;
    }
    state.nudgeLevel = level;
    state.nudgedAt = tokens;
    state.nudges += 1;
    return true;
  }

  /**
   * Whether the finish notice goes out now, recorded as sent: once since the party's last install, at a reading
   * (`tokens`) of `start` or more, while no call waits to install and no nudge has gone, as a nudge's first wordings carry
   * the finish rule themselves, and only where `finishReached` holds.
   */
  finishDue(key: string, tokens: number, start: number, every: number): boolean {
    const state = this.get(key);
    if (state.finishTold || state.nudges > 0 || state.stored?.compacts === true || state.absorbNext || !finishReached(state, tokens, start, every)) return false;
    state.finishTold = true;
    return true;
  }

  /**
   * Whether a call from the party compacts: only once its context (`tokens`, its last reading) has reached where a
   * notice goes since its last install: main's finish notice (`finishReached`), or a nudge (`level` 1 or more and,
   * after a wake, grown by the party's room past the floor the wake left). Before that a call only changes the
   * party's held frontier: a compaction writes the whole context again, which costs more than a small context
   * saves, and a party that keeps its frontier current would compact at every step. A woken party with no reading
   * since has grown nothing. Not judged, so its call compacts: a party no notice can reach (no `marks`: its window
   * unknown, or its model on the ignore list) and one with no reading yet (a process just started). `always`: a
   * sub-agent whose definition picks the moment (its type is on the host's list) compacts at any size once it has a
   * reading since its last wake.
   */
  compacts(key: string, tokens: number | undefined, level = 0, marks?: NudgeMarks & { finish?: number; always?: true }): boolean {
    const state = this.get(key);
    if (marks === undefined) return true;
    if (state.absorbNext) return false;
    if (tokens === undefined || marks.always === true) return true;
    if (marks.finish !== undefined && finishReached(state, tokens, marks.finish, marks.every)) return true;
    return level > 0 && (state.wokeAt === undefined || tokens >= state.wokeAt + roomAbove(state.wokeAt, marks));
  }

  /**
   * A compaction installed: the frontier goes, the nudges and the finish notice start over from the next reading's level, and no reading
   * stands until the next request measures one, whose landing line then goes out. A party holding any item has passed one more round: its count
   * moves, due in its file. Returns a landing still waiting from an earlier install.
   */
  installed(key: string, landing?: Landing): Landing | undefined {
    const earlier = this.get(key).landing;
    Object.assign(this.get(key), {
      stored: undefined,
      forkDue: undefined,
      forkNotice: undefined,
      lastDecision: 'install',
      answeredSinceSkip: true,
      nudgeLevel: 0,
      nudges: 0,
      finishTold: false,
      absorbNext: true,
      wokeAt: undefined,
      nudgedAt: undefined,
      reading: undefined,
      base: undefined,
      landing,
      installedThisTurn: true,
    });
    const state = this.get(key), passed = state.held === undefined ? undefined : roundPassed(state.held);
    state.installs += 1;
    if (passed !== state.held) (state.held = passed), state.files?.changed('rounds');
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

/** What a wake shows of a party's held frontier: its live orders, its storage listing (with no files, none) and its lists rendered, done split at `doneMaxChars` when done-earlier.md holds its earlier items (disk.ts `doneWake`), else whole. The rendering is noted in the party's files (disk.ts `wakeRendered`): done-earlier.md gives up an item only once the party has read a wake that shows it. */
export function heldShown(party: { held?: Held; files?: PartyFiles }, doneMaxChars: number): { orders: Item[]; rounds: number; storage?: { dir: string; entries: StorageEntry[] }; frontier: string } {
  const held = party.held ?? emptyHeld(), done = party.files?.doneWake(held, doneMaxChars), frontier = renderFrontier(held, done);
  party.files?.wakeRendered(frontier, done);
  return { orders: held.lists.orders.items, rounds: held.rounds ?? 0, ...(party.files !== undefined ? { storage: { dir: storageDir(party.files), entries: held.storage } } : {}), frontier };
}
