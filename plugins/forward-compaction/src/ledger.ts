// The ledger: typed facts recorded as events happen, reduced by pure functions. Nothing is read from rendered text.

export type PartyKey = 'main' | 'unknown' | `agent:${string}` | `spawn:${string}`;

/** The party an event's `agentId` names: main when there is none. */
export const keyOf = (agentId: unknown): PartyKey => (typeof agentId === 'string' && agentId !== '' ? `agent:${agentId}` : 'main');

/** An event origin's kind, `unknown` when it carries none. */
export const originKind = (origin: unknown): string => (origin !== null && typeof origin === 'object' && typeof (origin as { kind?: unknown }).kind === 'string' ? (origin as { kind: string }).kind : 'unknown');
export type SkillHow = 'skill-tool' | 'typed-command' | 'preload' | 'ambiguous';
export type ShellTask = { id: string; type: string; status: string; description: string; command?: string };
export type CronJob = { id: string; schedule: string; recurring: boolean; prompt: string };

type Base = { seq: number; at: number };
export type PersonEntry = Base & { kind: 'person'; party: 'main'; text: string; command?: string };
export type NoticeEntry = Base & { kind: 'notice'; party: 'main'; origin: string; text: string };
export type ReceivedEntry = Base & { kind: 'received'; party: PartyKey; origin: string; text: string };
export type BriefEntry = Base & {
  kind: 'brief'; party: PartyKey; text: string; description?: string; subagentType?: string; spawnedBy: PartyKey;
};
export type SkillEntry = Base & {
  kind: 'skill'; party: PartyKey; skill: string; text: string; source?: string; path?: string; how: SkillHow;
};
export type ShellsEntry = Base & { kind: 'shells'; tasks: ShellTask[]; crons: CronJob[] };
export type LedgerEntry = PersonEntry | NoticeEntry | ReceivedEntry | BriefEntry | SkillEntry | ShellsEntry;
type Without<T, K extends string> = T extends unknown ? Omit<T, K> : never;
export type EntryInput = Without<LedgerEntry, 'seq'>;

export type Ledger = { startedAt?: number; startReason?: string; nextSeq: number; entries: readonly LedgerEntry[] };

/** Prompt origins that are the person typing (composer, a bridge client, the SDK); any other origin is a notice. */
export const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk']);
export function isPersonOrigin(kind: string | undefined): boolean {
  return kind !== undefined && PERSON_ORIGINS.has(kind);
}

/** The shells and crons of a Stop event's `background_tasks` and `session_crons`; anything that is not a list is none. */
export function shellsOf(e: Record<string, unknown>): { tasks: ShellTask[]; crons: CronJob[] } {
  const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value : []);
  const tasks = list(e.background_tasks).map((t) => ({ id: String(t.id), type: String(t.type), status: String(t.status), description: String(t.description ?? ''), ...(typeof t.command === 'string' ? { command: t.command } : {}) }));
  const crons = list(e.session_crons).map((c) => ({ id: String(c.id), schedule: String(c.schedule), recurring: c.recurring === true, prompt: String(c.prompt ?? '') }));
  return { tasks, crons };
}

export function newLedger(): Ledger {
  return { nextSeq: 1, entries: [] };
}

/** Records when and why the process's ledger started (session.start); entries are kept. */
export function markStart(ledger: Ledger, at: number, reason: string): Ledger {
  return { ...ledger, startedAt: at, startReason: reason };
}

/** Appends an entry numbered in ledger order; a shells entry replaces the previous one. Returns a new ledger. */
export function addEntry(ledger: Ledger, entry: EntryInput): Ledger {
  const kept = entry.kind === 'shells' ? ledger.entries.filter((e) => e.kind !== 'shells') : ledger.entries;
  return { ...ledger, nextSeq: ledger.nextSeq + 1, entries: [...kept, { ...entry, seq: ledger.nextSeq } as LedgerEntry] };
}

/** The most of the person's messages kept for a wake and across a plugin reload: the newest ten, the owner's ruling. */
export const PERSON_KEPT = 10;

/** The person's newest PERSON_KEPT messages, oldest first, as `$.state` keeps them. */
export function personKept(ledger: Ledger): { at: number; text: string; command?: string }[] {
  return ledger.entries.filter((e): e is PersonEntry => e.kind === 'person').slice(-PERSON_KEPT).map(({ at, text, command }) => ({ at, text, ...(command !== undefined ? { command } : {}) }));
}

/** The ledger with the person's messages kept before a plugin reload put back, when it has none of its own yet; anything not a message is left out. */
export function restorePerson(ledger: Ledger, kept: unknown): Ledger {
  if (!Array.isArray(kept) || ledger.entries.some((e) => e.kind === 'person')) return ledger;
  const valid = kept.filter((p): p is { at: number; text: string; command?: unknown } => p !== null && typeof p === 'object' && typeof p.at === 'number' && typeof p.text === 'string');
  return valid.slice(-PERSON_KEPT).reduce((l, p) => addEntry(l, { kind: 'person', party: 'main', at: p.at, text: p.text, ...(typeof p.command === 'string' ? { command: p.command } : {}) }), ledger);
}

/** A preload skill is first filed under `spawn:{tool_use_id}`; once the spawn returns, it belongs to the child. */
export function resolveSpawn(ledger: Ledger, toolUseId: string, agentId: string): Ledger {
  const from = `spawn:${toolUseId}`;
  const entries = ledger.entries.map((e) => (e.kind === 'skill' && e.party === from ? { ...e, party: `agent:${agentId}` as const } : e));
  return { ...ledger, entries };
}

export type SkillAttribution = { party: PartyKey; how: SkillHow };

/** D5: which party loaded a skill, from the typed events around skill.prompt (the event carries no agentId). */
export function attributeSkill(input: {
  inFlightSkills: readonly { party: PartyKey; tool_use_id: string }[];
  pendingCommand: string | undefined;
  pendingSpawns: ReadonlySet<string>;
  skill: string;
}): SkillAttribution {
  const { inFlightSkills, pendingCommand, pendingSpawns, skill } = input;
  const [only] = inFlightSkills;
  if (inFlightSkills.length === 1 && only) return { party: only.party, how: 'skill-tool' };
  if (inFlightSkills.length === 0) {
    const command = pendingCommand?.replace(/^\//, '');
    if (command !== undefined && (command === skill || command.endsWith(`:${skill}`))) return { party: 'main', how: 'typed-command' };
    const [spawn] = pendingSpawns;
    if (pendingSpawns.size === 1 && spawn !== undefined) return { party: `spawn:${spawn}`, how: 'preload' };
  }
  return { party: 'unknown', how: 'ambiguous' };
}

export type Facts = {
  person: PersonEntry[];
  /** Person messages left out because the kept tail already holds them. */
  personInTail: number;
  notices: NoticeEntry[];
  brief?: BriefEntry;
  received: ReceivedEntry[];
  skills: SkillEntry[];
  unattributedSkills: SkillEntry[];
  shells?: ShellsEntry;
  startedAt?: number;
  startReason?: string;
};

const latestPerSkill = (skills: SkillEntry[]): SkillEntry[] => {
  const seen = new Set<string>();
  return skills.filter((s) => (seen.has(s.skill) ? false : (seen.add(s.skill), true)));
};

/** What the wake records for a party. Text already in a kept tail message (equal or contained) is left out. */
export function factsFor(ledger: Ledger, party: PartyKey, opts: { keptTexts: readonly string[] }): Facts {
  const fresh = <T extends { text: string }>(e: T): boolean =>
    e.text === '' || !opts.keptTexts.some((kept) => kept.includes(e.text));
  const entries = ledger.entries;
  const mine = <K extends LedgerEntry['kind']>(kind: K, who: PartyKey): Extract<LedgerEntry, { kind: K }>[] =>
    entries.filter((e): e is Extract<LedgerEntry, { kind: K }> => e.kind === kind && 'party' in e && e.party === who);
  // Latest text per skill name wins before the kept filter: an older version is stale, not "already there".
  const newestFirst = (who: PartyKey) => latestPerSkill(mine('skill', who).reverse());
  const carried = new Set(newestFirst(party).map((s) => s.skill));
  const person = mine('person', party);
  const kept = person.filter(fresh);
  return {
    person: kept,
    personInTail: person.length - kept.length,
    notices: mine('notice', party).filter(fresh),
    brief: mine('brief', party).filter(fresh).at(-1),
    received: mine('received', party).filter(fresh),
    skills: newestFirst(party).filter(fresh),
    unattributedSkills: newestFirst('unknown').filter((s) => !carried.has(s.skill)).filter(fresh),
    shells: entries.find((e): e is ShellsEntry => e.kind === 'shells'),
    startedAt: ledger.startedAt,
    startReason: ledger.startReason,
  };
}
