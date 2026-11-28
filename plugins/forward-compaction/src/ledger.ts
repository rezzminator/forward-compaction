// The ledger: typed facts recorded as events happen, reduced by pure functions. Nothing is read from rendered text.

import { workSummary, type WorkFact, type WorkSummary } from './work';

export type PartyKey = 'main' | 'unknown' | `agent:${string}` | `spawn:${string}`;

/** The party an event's `agentId` names: main when there is none. */
export const keyOf = (agentId: unknown): PartyKey => (typeof agentId === 'string' && agentId !== '' ? `agent:${agentId}` : 'main');

/** An event origin's kind, `unknown` when it carries none. */
export const originKind = (origin: unknown): string => (origin !== null && typeof origin === 'object' && typeof (origin as { kind?: unknown }).kind === 'string' ? (origin as { kind: string }).kind : 'unknown');
export type SkillHow = 'skill-tool' | 'typed-command' | 'preload' | 'ambiguous';
export type ShellTask = { id: string; type: string; status: string; description: string; command?: string };
export type CronJob = { id: string; schedule: string; recurring: boolean; prompt: string };

type Base = { seq: number; at: number };
/** `answer`: an answer to the model's AskUserQuestion, `text` the questions with it, `answer` the user's own words alone. */
export type UserEntry = Base & { kind: 'user'; party: 'main'; text: string; command?: string; answer?: string };
export type NoticeEntry = Base & { kind: 'notice'; party: 'main'; origin: string; text: string };
export type ReceivedEntry = Base & { kind: 'received'; party: PartyKey; origin: string; text: string };
export type BriefEntry = Base & {
  kind: 'brief'; party: PartyKey; text: string; description?: string; subagentType?: string; spawnedBy: PartyKey;
};
export type SkillEntry = Base & {
  kind: 'skill'; party: PartyKey; skill: string; text: string; source?: string; path?: string; how: SkillHow; keep?: true;
  /** Its frontmatter's `description` (carry.ts `descriptionOf`): what a wake that lists the skill instead of carrying it says of it. */
  description?: string;
};
export type ShellsEntry = Base & { kind: 'shells'; tasks: ShellTask[]; crons: CronJob[] };
export type WorkEntry = Base & { kind: 'work'; party: PartyKey; fact: WorkFact };
export type LedgerEntry = UserEntry | NoticeEntry | ReceivedEntry | BriefEntry | SkillEntry | ShellsEntry | WorkEntry;
type Without<T, K extends string> = T extends unknown ? Omit<T, K> : never;
export type EntryInput = Without<LedgerEntry, 'seq'>;

export type Ledger = { startedAt?: number; startReason?: string; nextSeq: number; entries: readonly LedgerEntry[] };

/** Prompt origins that are the user typing (composer, a bridge client, the SDK); any other origin is a notice. */
export const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk']);
export function isUserOrigin(kind: string | undefined): boolean {
  return kind !== undefined && PERSON_ORIGINS.has(kind);
}

/**
 * The shells and crons of a Stop event's `background_tasks` and `session_crons`; anything that is not a list is none.
 * A SubagentStop still lists its own sub-agent running: `stopping`, its id, is left out, as it has stopped.
 */
export function shellsOf(e: Record<string, unknown>, stopping?: string): { tasks: ShellTask[]; crons: CronJob[] } {
  const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value : []);
  const tasks = list(e.background_tasks).map((t) => ({ id: String(t.id), type: String(t.type), status: String(t.status), description: String(t.description ?? ''), ...(typeof t.command === 'string' ? { command: t.command } : {}) }));
  const crons = list(e.session_crons).map((c) => ({ id: String(c.id), schedule: String(c.schedule), recurring: c.recurring === true, prompt: String(c.prompt ?? '') }));
  return { tasks: tasks.filter((t) => t.id !== stopping), crons };
}

/** A row appended to a conversation (`session.append`), as far as the ledger reads it. */
type AppendedRow = { door: string; agentId?: string; origin: unknown; message: { isMeta?: true; content: readonly { type: string; [field: string]: unknown }[] } };

/** A row's text as the model reads it: its text blocks, joined by newlines. */
const rowText = (message: AppendedRow['message']): string =>
  message.content.flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n');

/**
 * A row delivered into a running sub-agent (`session.append` door `delivery`: a child agent's return, a coordinator's note) as
 * the received fact, its text the row's text blocks, what the model reads; none for main, whose prompts enteredOf records, or
 * for a row with no text.
 */
export function deliveryOf(e: Omit<AppendedRow, 'door'>, at: number): EntryInput | undefined {
  const text = rowText(e.message);
  if (e.agentId === undefined || e.agentId === '' || text === '') return undefined;
  return { kind: 'received', party: keyOf(e.agentId), origin: originKind(e.origin), text, at };
}

/** A prompt the user submitted (prompt.submit), held until it enters main's conversation. */
export type Submitted = { text: string; command?: string };

/** The most submissions held at once, a design budget: one pulled back from the queue is held until newer ones push it out. */
export const SUBMITTED_HELD = 10;

/** The held submissions with `s` added, the newest SUBMITTED_HELD. */
export function holdSubmitted(held: readonly Submitted[], s: Submitted): Submitted[] {
  // shortcut: a pull-back's queue row is its enqueue's, and its one other sign, a prompt.change of origin `engine` with its text, is not shown to be a pull-back's alone, so a pulled-back prompt is held until SUBMITTED_HELD newer ones push it out; upgrade when Claude Code names the pull-back.
  return [...held, s].slice(-SUBMITTED_HELD);
}

/**
 * Whether a row appended to main's conversation is a prompt of the user's entering it (`session.append`), as its user fact,
 * and the submissions still held. A prompt typed while main is idle, or queued behind a running turn and taken at its end,
 * enters at door `prompt` as its own text; one queued and delivered into the running turn enters at door `delivery`, its text
 * a paragraph of Claude Code's reminder (its own lines, a blank line after); a slash command enters at door `command`, naming
 * `<command-name>/{name}</command-name>`. The held submission it is (the longest text, the newest on a tie) gives the fact
 * its words and is let go; a prompt or delivery none is held for (one a plugin reload forgot) is its row's text as the model
 * reads it, a delivery's reminder whole. Every fact is at `now`, when the row entered, so the ledger's order is its time's. A row of a sub-agent or of anyone but the person, a meta prompt, a command none is held for or a
 * row with no text is none: a submission is said once it entered, so one pulled back from the queue, or still waiting, never is.
 */
export function enteredOf(held: readonly Submitted[], row: AppendedRow, now: number): { entry?: EntryInput; held: Submitted[] } {
  const none = { held: [...held] };
  if (keyOf(row.agentId) !== 'main' || !isUserOrigin(originKind(row.origin)) || (row.door === 'prompt' && row.message.isMeta === true)) return none;
  const text = rowText(row.message);
  const is = (s: Submitted): boolean => {
    if (row.door === 'command') return s.command !== undefined && text.includes(`<command-name>/${s.command}</command-name>`);
    if (s.command !== undefined) return false;
    return row.door === 'prompt' ? text === s.text : row.door === 'delivery' && s.text !== '' && text.includes(`\n${s.text}\n\n`);
  };
  const found = held.reduce((best, s, i) => (is(s) && (best < 0 || s.text.length >= held[best]!.text.length) ? i : best), -1);
  if (found < 0) return (row.door === 'prompt' || row.door === 'delivery') && text !== '' ? { entry: { kind: 'user', party: 'main', at: now, text }, held: [...held] } : none;
  const s = held[found]!;
  return { entry: { kind: 'user', party: 'main', at: now, text: s.text, ...(s.command !== undefined ? { command: s.command } : {}) }, held: held.filter((_, i) => i !== found) };
}

/**
 * The message a sub-agent's later run begins with (`turn.start`: what woke it) as the received fact; none when it is empty, or
 * when the party's newest received fact is that text as a resume, which agent.spawn recorded already.
 */
export function runStartOf(ledger: Ledger, party: PartyKey, text: string, at: number): EntryInput | undefined {
  const last = [...ledger.entries].reverse().find((e): e is ReceivedEntry => e.kind === 'received' && e.party === party);
  if (text === '' || (last?.origin === 'resume' && last.text === text)) return undefined;
  return { kind: 'received', party, origin: 'run-start', text, at };
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

/** The most prompts a party keeps, for its wake and across a plugin reload: the user's messages (main) or its coordinator's (a sub-agent, its brief besides), the newest ten, the owner's ruling. */
export const PROMPTS_KEPT = 10;

/** The messages kept, oldest first: the newest PROMPTS_KEPT typed and every answer to a question however old, a ruling the work rests on (the owner's ruling, 2026-10-28). */
export function keptSaid<T extends object>(said: readonly T[]): T[] {
  const answer = (p: T): boolean => 'answer' in p && p.answer !== undefined;
  const typed = new Set(said.filter((p) => !answer(p)).slice(-PROMPTS_KEPT));
  return said.filter((p) => answer(p) || typed.has(p));
}

/** A prompt as `$.state` keeps it: a ledger entry without its seq and party. */
export type KeptPrompt = { kind: 'user' | 'received' | 'brief'; at: number; text: string; command?: string; answer?: string; origin?: string; description?: string; subagentType?: string; spawnedBy?: string };
type PromptEntry = UserEntry | ReceivedEntry | BriefEntry;
const isPrompt = (e: LedgerEntry, party: PartyKey): e is PromptEntry => (e.kind === 'user' || e.kind === 'received' || e.kind === 'brief') && e.party === party;
const promptKey = (p: { kind: string; at: number; text: string }): string => `${p.kind}\u0000${p.at}\u0000${p.text}`;

/** A party's prompts to keep, oldest first: main's newest PROMPTS_KEPT messages; a sub-agent's brief and its coordinator's newest PROMPTS_KEPT. */
export function promptsKept(ledger: Ledger, party: PartyKey): KeptPrompt[] {
  const mine = ledger.entries.filter((e): e is PromptEntry => isPrompt(e, party));
  const brief = mine.filter((e) => e.kind === 'brief').slice(-1);
  const said = keptSaid(mine.filter((e) => e.kind !== 'brief'));
  return [...brief, ...said].map(({ seq: _seq, party: _party, ...kept }) => kept as KeptPrompt);
}

/** The ledger with a party's kept prompts put back ahead of its own, each only once and a brief only when it has none; anything not a prompt of that party's kind is left out. */
export function restorePrompts(ledger: Ledger, party: PartyKey, kept: unknown): Ledger {
  if (!Array.isArray(kept)) return ledger;
  const own = ledger.entries.filter((e): e is PromptEntry => isPrompt(e, party));
  const seen = new Set(own.map(promptKey));
  const kinds = party === 'main' ? ['user'] : ['brief', 'received'];
  const hasBrief = own.some((e) => e.kind === 'brief');
  const back = kept.map((p) => (p !== null && typeof p === 'object' && (p as { kind?: unknown }).kind === 'person' ? { ...p, kind: 'user' } : p)) // the build before this one saved the user's messages as kind 'person'
    .filter((p): p is KeptPrompt => p !== null && typeof p === 'object' && kinds.includes(p.kind) && typeof p.at === 'number' && typeof p.text === 'string')
    .filter((p) => !seen.has(promptKey(p)) && !(p.kind === 'brief' && hasBrief));
  if (back.length === 0) return ledger;
  const restored = back.map((p, i) => ({ ...p, party, seq: ledger.nextSeq + i, ...(p.kind === 'brief' ? { spawnedBy: (p.spawnedBy ?? 'unknown') as PartyKey } : {}), ...(p.kind === 'received' ? { origin: p.origin ?? 'unknown' } : {}) }) as LedgerEntry);
  return { ...ledger, nextSeq: ledger.nextSeq + back.length, entries: [...restored, ...ledger.entries] };
}

const latestPerSkill = (skills: SkillEntry[]): SkillEntry[] => {
  const seen = new Set<string>();
  return skills.filter((s) => (seen.has(s.skill) ? false : (seen.add(s.skill), true)));
};

/** A skill as `$.state` keeps it: a skill entry without its seq and party. */
export type KeptSkill = { at: number; skill: string; text: string; how: SkillHow; source?: string; path?: string; keep?: true; description?: string };

/** A party's skills to keep: the latest text of each skill it loaded, oldest first. */
export function skillsKept(ledger: Ledger, party: PartyKey): KeptSkill[] {
  const mine = ledger.entries.filter((e): e is SkillEntry => e.kind === 'skill' && e.party === party);
  return latestPerSkill(mine.reverse()).reverse().map(({ seq: _seq, party: _party, kind: _kind, ...kept }) => kept);
}

/** The ledger with a party's kept skills put back ahead of its own, each only when the party has not loaded it since; anything not a skill is left out. */
export function restoreSkills(ledger: Ledger, party: PartyKey, kept: unknown): Ledger {
  if (!Array.isArray(kept)) return ledger;
  const own = new Set(ledger.entries.filter((e): e is SkillEntry => e.kind === 'skill' && e.party === party).map((e) => e.skill));
  const back = kept.filter((s): s is KeptSkill => s !== null && typeof s === 'object' && typeof s.at === 'number' && typeof s.skill === 'string' && typeof s.text === 'string' && !own.has(s.skill));
  if (back.length === 0) return ledger;
  const restored = back.map((s, i) => ({ ...s, how: typeof s.how === 'string' ? s.how : 'ambiguous', kind: 'skill', party, seq: ledger.nextSeq + i }) as SkillEntry);
  return { ...ledger, nextSeq: ledger.nextSeq + back.length, entries: [...restored, ...ledger.entries] };
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
  user: UserEntry[];
  /** User messages left out because the kept tail already holds them. */
  userInTail: number;
  notices: NoticeEntry[];
  /** Every delivery to the party recorded from seq `since` (its frontier stored) that the kept tail does not hold, oldest first: the model wrote its frontier without them. Left out of user, notices and received. */
  arrived: { at: number; origin: string; text: string }[];
  brief?: BriefEntry;
  /** The agents the party spawned, from their briefs, oldest first, each once with its latest description: the wake names one `$.agent.list` no longer lists. */
  children: { id: string; subagentType?: string; description?: string }[];
  received: ReceivedEntry[];
  skills: SkillEntry[];
  unattributedSkills: SkillEntry[];
  /** The newest Stop event's tasks and crons; a sub-agent's holds only the tasks tied to it: a shell whose command it ran, an agent it spawned. */
  shells?: ShellsEntry;
  /** A sub-agent's only: the session's other tasks and crons, itself left out, which nothing ties to it. */
  otherTasks?: number;
  /** Background commands started after `shells` was taken, a running shell the snapshot cannot list: any party's for main, its own for a sub-agent. */
  backgroundSince: number;
  /** The files the party's calls touched and its task list, from its finished tool calls. */
  work: WorkSummary;
  startedAt?: number;
  startReason?: string;
};

/** What the wake records for a party. Text already in a kept tail message (equal or contained) is left out. */
export function factsFor(ledger: Ledger, party: PartyKey, opts: { keptTexts: readonly string[]; /** A ledger seq: deliveries from it on are `arrived`. */ since?: number }): Facts {
  const fresh = <T extends { text: string }>(e: T): boolean =>
    e.text === '' || !opts.keptTexts.some((kept) => kept.includes(e.text));
  const before = (e: { seq: number }): boolean => opts.since === undefined || e.seq < opts.since;
  const entries = ledger.entries;
  const mine = <K extends LedgerEntry['kind']>(kind: K, who: PartyKey): Extract<LedgerEntry, { kind: K }>[] =>
    entries.filter((e): e is Extract<LedgerEntry, { kind: K }> => e.kind === kind && 'party' in e && e.party === who);
  // Latest text per skill name wins before the kept filter: an older version is stale, not "already there".
  const newestFirst = (who: PartyKey) => latestPerSkill(mine('skill', who).reverse());
  const carried = new Set(newestFirst(party).map((s) => s.skill));
  const delivered = entries.filter((e): e is UserEntry | NoticeEntry | ReceivedEntry => (e.kind === 'user' || e.kind === 'notice' || e.kind === 'received') && e.party === party);
  const arrived = delivered.filter((e) => !before(e) && e.text !== '' && fresh(e)).map((e) => ({ at: e.at, origin: e.kind === 'user' ? 'user' : e.origin, text: e.text }));
  const user = mine('user', party).filter(before);
  const kept = user.filter(fresh);
  const snapshot = entries.find((e): e is ShellsEntry => e.kind === 'shells');
  const children = new Map<string, Facts['children'][number]>();
  for (const e of entries) {
    if (e.kind !== 'brief' || e.spawnedBy !== party || !e.party.startsWith('agent:')) continue; // a `spawn:` party never got its id
    const id = e.party.slice('agent:'.length);
    children.set(id, { id, ...(e.subagentType !== undefined ? { subagentType: e.subagentType } : {}), ...(e.description !== undefined ? { description: e.description } : {}) });
  }
  // The snapshot is session-wide. A sub-agent is given the tasks tied to it (a Stop event names a shell by the command its call sent) and a count of the rest.
  const self = party.startsWith('agent:') ? party.slice('agent:'.length) : undefined;
  let shells = snapshot, otherTasks: number | undefined;
  if (self !== undefined && snapshot !== undefined) {
    const ran = new Set(mine('work', party).flatMap((e) => (e.fact.kind === 'command' ? [e.fact.command] : [])));
    const tasks = snapshot.tasks.filter((t) => (t.command !== undefined && ran.has(t.command)) || children.has(t.id));
    shells = { ...snapshot, tasks, crons: [] };
    otherTasks = snapshot.tasks.filter((t) => t.id !== self).length - tasks.length + snapshot.crons.length;
  }
  return {
    user: kept,
    userInTail: user.length - kept.length,
    notices: mine('notice', party).filter(before).filter(fresh),
    arrived,
    brief: mine('brief', party).filter(fresh).at(-1),
    children: [...children.values()],
    received: mine('received', party).filter(before).filter(fresh),
    skills: newestFirst(party).filter(fresh),
    unattributedSkills: newestFirst('unknown').filter((s) => !carried.has(s.skill)).filter(fresh),
    shells,
    ...(otherTasks !== undefined ? { otherTasks } : {}),
    backgroundSince: snapshot === undefined ? 0 : entries.filter((e) => e.kind === 'work' && (self === undefined || e.party === party) && e.fact.kind === 'command' && e.fact.background === true && e.at > snapshot.at).length,
    work: workSummary(mine('work', party).map((e) => e.fact)),
    startedAt: ledger.startedAt,
    startReason: ledger.startReason,
  };
}
