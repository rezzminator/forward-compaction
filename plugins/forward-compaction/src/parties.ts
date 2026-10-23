/** A file the model asked the wake to carry (the tool's `load_files` entry). */
export type LoadFile = { path: string; lines?: string; why: string };

/** A handoff the model wrote, held in memory until a door installs it. */
export type StoredHandoff = {
  text: string;
  loadFiles: LoadFile[];
  /** The `forward_compaction` call that stored it: the anchor `splitAtCall` finds in the messages. */
  toolUseId: string;
  /** The party's reading when it stored the handoff. */
  storedAtTokens: number;
  /** Store order across all parties. */
  seq: number;
};

/** What the party's last `session.compact` ask ended in (the decision row's `decision`). */
export type AskDecision = 'skip' | 'install' | 'mechanical' | 'native' | 'pass' | 'foreign' | 'dropped' | 'error';

export type PartyState = {
  /** "main" or "agent:{id}". */
  key: string;
  /** What screen lines call the party: "main", or "{subagentType} {agentId first 6}". */
  label: string;
  model?: string;
  modelWin: number;
  /** The context of the party's last completed request. */
  reading?: number;
  stored?: StoredHandoff;
  lastDecision?: AskDecision;
  /** False from a skip until a request completes: the next ask is then a prompt too long (D8). */
  answeredSinceSkip: boolean;
  /** True from the first held ask until the next install: the nudge says "now". */
  askHeld: boolean;
  /** The highest nudge level delivered since the last install. */
  nudgeLevel: number;
  /** The "now" wording was delivered since the first held ask. */
  nudgedNow: boolean;
  installs: number;
  /** An install happened in the party's current turn: the turn-end door (P1) does not fire again. */
  installedThisTurn: boolean;
};

/** Per-party state, memory only, keyed "main" or "agent:{id}". A party is created on first touch. */
export class Parties {
  private readonly states = new Map<string, PartyState>();
  private seq = 0;

  constructor(private readonly defaultWindow = 200_000) {}

  /** The party's state, created with defaults when new. */
  get(key: string): PartyState {
    let state = this.states.get(key);
    if (!state) {
      state = { key, label: key, modelWin: this.defaultWindow, answeredSinceSkip: true, askHeld: false, nudgeLevel: 0, nudgedNow: false, installs: 0, installedThisTurn: false };
      this.states.set(key, state);
    }
    return state;
  }

  describe(key: string, patch: { label?: string; model?: string; modelWin?: number }): void {
    Object.assign(this.get(key), patch);
  }

  /** Stores the party's handoff, the latest winning; returns the one it replaced. */
  store(key: string, handoff: Omit<StoredHandoff, 'seq'>): StoredHandoff | undefined {
    const state = this.get(key);
    const replaced = state.stored;
    state.stored = { ...handoff, seq: ++this.seq };
    return replaced;
  }

  /** Removes the party's stored handoff and returns it; a party never seen gains no state. */
  takeStored(key: string): StoredHandoff | undefined {
    const state = this.states.get(key);
    const stored = state?.stored;
    if (state) state.stored = undefined;
    return stored;
  }

  /** A completed request's reading; that request also answers a held ask. */
  read(key: string, tokens: number): void {
    this.get(key).reading = tokens;
    this.answered(key);
  }

  /** What the party's ask ended in. A skip marks the ask held: the nudge turns "now", and the next ask is reactive until a request completes. */
  asked(key: string, decision: AskDecision): void {
    const state = this.get(key);
    state.lastDecision = decision;
    if (decision === 'skip') {
      state.answeredSinceSkip = false;
      state.askHeld = true;
    }
  }

  /** A request completed (with or without a usage reading). */
  answered(key: string): void {
    this.get(key).answeredSinceSkip = true;
  }

  /** The ask follows a skip with no completed request between: Claude Code reports the request too long, not a fresh ask (D8). */
  reactive(key: string): boolean {
    const state = this.states.get(key);
    return state?.lastDecision === 'skip' && !state.answeredSinceSkip;
  }

  /**
   * Whether a nudge goes out now, recorded as sent: once per level while nothing is stored, plus once after
   * the first held ask, whose level may already have been delivered as "soon".
   */
  nudgeDue(key: string, level: number): boolean {
    const state = this.get(key);
    if (state.stored) return false;
    const now = state.askHeld && !state.nudgedNow;
    if (level <= state.nudgeLevel && !now) return false;
    state.nudgeLevel = Math.max(state.nudgeLevel, level);
    if (state.askHeld) state.nudgedNow = true;
    return true;
  }

  /** A compaction installed: the handoff goes, the nudges start over, the reading is the size after it. */
  installed(key: string, tokensAfter: number): void {
    Object.assign(this.get(key), {
      stored: undefined,
      lastDecision: 'install',
      answeredSinceSkip: true,
      askHeld: false,
      nudgeLevel: 0,
      nudgedNow: false,
      reading: tokensAfter,
      installedThisTurn: true,
    });
    this.get(key).installs += 1;
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
