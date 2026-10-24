// The wake: what a compaction installs. [facts] [handoff] [tail…] — the facts and the handoff are built here from typed values,
// the tail is the engine's own messages returned untouched. Pure: files, agents and the clock arrive as inputs.
import { DEFAULT_TOOL, k as kilo } from './nudge.ts';
import { loadFilesRoom } from './window.ts';
import { PROMPTS_KEPT } from './ledger.ts';
import { experimental, EXPERIMENTAL_OPENING } from './handoff.ts';

/** A message in `session.compact`'s shape; a SessionMessage fits. */
export type WakeMessage = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: readonly { tool_use_id: string; tool?: string; input?: unknown; text?: string }[];
  toolResults?: readonly { tool_use_id: string; text?: string }[];
  handle?: string;
};

/** A message this module builds; no handle, so the engine reads it as built. */
export type BuiltMessage = { role: 'user'; text: string; toolUses: [] };

export type Sibling = { tool: string; input: unknown; text: string };

// Characters and tokens convert only at the party's measured ratio (`charsPerToken` in window.ts), never at a fixed one.
const tokensOf = (chars: number, ratio: number): number => Math.ceil(chars / ratio);
const charsIn = (tokens: number, ratio: number | undefined): number => (ratio === undefined ? Number.POSITIVE_INFINITY : Math.floor(tokens * ratio));
const num = (value: number): string => value.toLocaleString('en-US');
const iso = (at: number): string => new Date(at).toISOString();

/**
 * Per-section shares of the budget B (D18), design budgets and never measured sizes: the person's words or the brief and the
 * skills in force are what a woken model most needs (a quarter each), sibling results a tenth, coordinator notices a
 * twentieth; the rest of B goes to the messages kept after the call. Load files have their own room, `loadFilesRoom`.
 */
const SHARE = { people: 0.25, notices: 0.05, siblings: 0.1, skills: 0.25, tasks: 0.05 } as const;
/** The most files the Files section lists, newest touch first: a path list stays a glance, as the old carry's trail did. */
export const FILES_MAX = 15;
/** The agents section's row cap: a design budget, enough for a coordinator's fleet, never the size of one. */
export const AGENTS_MAX_ROWS = 50;

/** B = half the ask point, a design budget: a wake above it would draw the next ask at once, and half leaves the woken party room to work before it (D18). */
export function wakeBudget(askPoint: number): number {
  return Math.floor(0.5 * askPoint);
}

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
function messageTokens(m: WakeMessage, ratio: number): number {
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

/** What the ledger gives for a party (ledger.ts `Facts` fits); only what the wake renders. */
export type WakeFacts = {
  person: readonly { at: number; text: string }[];
  /** Person messages the ledger left out because the tail holds them. */
  personInTail?: number;
  notices: readonly { at: number; origin: string; text: string }[];
  /** The `agent.spawn` prompt; absent when the agent was spawned before the ledger started. */
  brief?: { text: string };
  received: readonly { at: number; origin: string; text: string }[];
  /** Latest text per skill, newest first. */
  skills: readonly { skill: string; text: string; source?: string; path?: string }[];
  unattributedSkills: readonly { skill: string }[];
  shells?: {
    at: number;
    tasks: readonly { id: string; type: string; status: string; description: string; command?: string }[];
    crons: readonly { id: string; schedule: string; recurring: boolean; prompt: string }[];
  };
  /** The files the party's finished calls touched, newest first, and its task list as last set. */
  work?: { files: readonly { path: string; tag: 'R' | 'E' | 'W' }[]; tasks: readonly string[] };
  startedAt?: number;
  startReason?: string;
};

/** A load file, already read by the adapter: its content, or why it could not be read. */
export type WakeFile = { path: string; lines?: string; why: string } & ({ content: string; problem?: undefined } | { problem: string; content?: undefined });
export type AgentRow = { id: string; type: string; status: string; description: string; parentId?: string };

type Shared<M> = {
  /** The party's current `e.messages`. */
  messages: readonly M[];
  party: 'main' | 'subagent';
  /** The party's context reading, for the wake's own wording; undefined when it has none. */
  tokens?: number;
  askPoint: number;
  /** The party's measured characters per token (window.ts `charsPerToken`); undefined while unmeasured: then nothing is fitted, see `assemble`. */
  charsPerToken?: number;
  /** `$.clock.now()`, for the age of the shells snapshot. */
  now: number;
  /** The party's facts, leaving out entries already inside `keptTexts` (the kept tail's texts): the tail is fitted around the facts and the facts around the tail. */
  facts: (keptTexts: readonly string[]) => WakeFacts;
  /** The woken sub-agent's id: its wake lists only the agents it spawned, and leaves it out of the background tasks. Absent for main, whose wake lists every agent. */
  self?: string;
  /** `$.agent.list()` rows, or its error; absent, no section. */
  agents?: readonly AgentRow[] | { error: string };
  /** The registered `forward_compaction` name, DEFAULT_TOOL when absent. */
  tool?: string;
  /** The level-log directory, where the issues file the wake's last line names lives. */
  logDir?: string;
};
/** `maxContext`: the party's max context, whose `loadFilesRoom` the files are carried in. */
export type BuildWakeInput<M> = Shared<M> & { toolUseId: string; handoff: string; files?: readonly WakeFile[]; maxContext?: number };
export type MechanicalWakeInput<M> = Shared<M> & { reason: { kind: 'ceiling'; ceiling: number } | { kind: 'reactive' } };

export type Wake<M> = {
  /** [F, H, ...tail]: H is the last message built here; the tail is the input objects. */
  messages: (BuiltMessage | M)[];
  /** F sections that hold content. */
  facts: number;
  kept: number;
  dropped: number;
  /** For the debug row: each F section's heading and characters, the head's characters, and the load files carried and not. */
  sizes: { section: string; chars: number }[];
  headChars: number;
  carried: string[];
  notCarried: string[];
};

type Section = { text: string; content: boolean };
const section = (text: string): Section => ({ text, content: true });

/** Entries newest first while they fit, rendered oldest first; the older ones left are counted. */
function newestFitting<T>(entries: readonly T[], render: (entry: T) => string, room: number): { shown: string[]; left: number } {
  const shown: string[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const block = render(entries[i]!);
    if (used + block.length + 1 > room) return { shown: shown.reverse(), left: i + 1 };
    shown.push(block);
    used += block.length + 1;
  }
  return { shown: shown.reverse(), left: 0 };
}

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

type Extras = { siblings: readonly Sibling[]; files: readonly WakeFile[]; fileRoom: number };

type Rendered = { text: string; sections: number; sizes: Wake<never>['sizes']; carried: string[]; notCarried: string[] };

/** F: every section with its cap; whole or not, never cut. With no measured ratio no section is capped. */
function renderFacts<M>(input: Shared<M>, facts: WakeFacts, { siblings, files, fileRoom }: Extras): Rendered {
  const B = wakeBudget(input.askPoint);
  const room = (share: number): number => charsIn(B * share, input.charsPerToken);
  const filesCarried: string[] = [];
  const filesNotCarried: string[] = [];
  const sections: Section[] = [];
  const sub = input.party === 'subagent';

  if (sub) {
    const cap = room(SHARE.people);
    if (facts.brief === undefined) sections.push({ text: '## Your brief\n(not recorded: this agent was spawned before forward-compaction started in this process)', content: false });
    else if (facts.brief.text.length > cap) sections.push({ text: `## Your brief\n(not carried: ${num(facts.brief.text.length)} characters, over the ${num(cap)}-character room; look_back finds it)`, content: false });
    else sections.push(section(`## Your brief\n${facts.brief.text}`));
  } else if (facts.person.length === 0 && (facts.personInTail ?? 0) > 0) {
    sections.push({ text: `## The person's messages\n(all ${facts.personInTail} are in the messages below)`, content: false });
  } else if (facts.person.length === 0) {
    sections.push({ text: `## The person's messages\n(none recorded${facts.startedAt === undefined ? '' : ` since ${iso(facts.startedAt)}`})`, content: false });
  } else {
    const { shown } = newestFitting(facts.person.slice(-PROMPTS_KEPT), (p) => `### ${iso(p.at)}\n${p.text}`, room(SHARE.people));
    const count = facts.person.length;
    const left = count - shown.length;
    const heading = left === 0 ? `(${shown.length} of ${count})` : `(${shown.length} of ${count}; the ${left} oldest are not carried: look_back finds them)`;
    sections.push(section([`## The person's messages, oldest first ${heading}`, ...shown].join('\n')));
  }

  const inbox = sub ? { entries: facts.received, title: 'Messages from your coordinator' } : { entries: facts.notices, title: 'Notifications delivered to you' };
  if (inbox.entries.length > 0) {
    const { shown } = newestFitting(sub ? inbox.entries.slice(-PROMPTS_KEPT) : inbox.entries, (m) => `### ${iso(m.at)} (${m.origin})\n${m.text}`, room(SHARE.notices));
    const left = inbox.entries.length - shown.length;
    sections.push(section([`## ${inbox.title}`, ...(left > 0 ? [`(${left} older not carried)`] : []), ...shown].join('\n')));
  }

  if (siblings.length > 0) {
    let left = room(SHARE.siblings);
    const rows = siblings.map((s) => {
      const block = `### ${s.tool} ${JSON.stringify(s.input ?? {})}\n${s.text}`;
      if (block.length + 1 > left) return `- ${s.tool}: result not carried (${num(s.text.length)} characters)`;
      left -= block.length + 1;
      return block;
    });
    sections.push(section(['## Results of the calls you made beside the handoff', ...rows].join('\n')));
  }

  const notCarried: string[] = [];
  const carriedSkills: string[] = [];
  let skillRoom = room(SHARE.skills);
  for (const s of facts.skills) {
    const block = `### ${s.skill} (${s.source ?? 'unknown source'}${s.path === undefined ? '' : `, ${s.path}`})\n${s.text}`;
    if (block.length + 1 > skillRoom) notCarried.push(`- ${s.skill}: over the skill room (${num(s.text.length)} characters); call Skill ${s.skill} to load it again.`);
    else {
      skillRoom -= block.length + 1;
      carriedSkills.push(block);
    }
  }
  if (carriedSkills.length > 0) sections.push(section(['## Skills in force, as loaded', ...carriedSkills].join('\n')));
  for (const s of facts.unattributedSkills) notCarried.push(`- ${s.skill}: loaded in this session by an unidentified party; call Skill ${s.skill} if it applies to you.`);
  if (notCarried.length > 0) sections.push({ text: ['## Skills not carried', ...notCarried].join('\n'), content: false });

  const work = facts.work;
  if (work !== undefined && work.files.length > 0) {
    const more = work.files.length - FILES_MAX;
    sections.push(section(['## Files touched, newest first (R read, E edited, W written)', ...work.files.slice(0, FILES_MAX).map((f) => `${f.tag} ${f.path}`), ...(more > 0 ? [`(${more} older not listed)`] : [])].join('\n')));
  }
  if (work !== undefined && work.tasks.length > 0) {
    const text = ['## Tasks, as last set', ...work.tasks].join('\n');
    const cap = room(SHARE.tasks);
    sections.push(text.length <= cap ? section(text) : { text: `## Tasks\n(not carried: ${num(text.length)} characters, over the ${num(cap)}-character room; look_back finds them)`, content: false });
  }

  if (input.agents !== undefined) {
    if (!Array.isArray(input.agents)) sections.push({ text: `## Agents\n(could not be listed: ${(input.agents as { error: string }).error})`, content: false });
    else if (input.agents.some((a) => input.self === undefined || a.parentId === input.self)) {
      const others = input.agents.filter((a) => input.self === undefined || a.parentId === input.self);
      const rows = others.slice(0, AGENTS_MAX_ROWS).map((a) => `- ${a.id} ${a.type} ${a.status}: ${a.description}`);
      const more = others.length - AGENTS_MAX_ROWS;
      sections.push(section(['## Agents, listed at install', ...rows, ...(more > 0 ? [`(${more} more not listed)`] : [])].join('\n')));
    }
  }

  if (facts.shells === undefined) sections.push({ text: '## Background shells and crons\n(unknown: no Stop event yet in this process)', content: false });
  else {
    const rows = [
      ...facts.shells.tasks.filter((t) => t.id !== input.self).map((t) => `- ${t.type} ${t.id} ${t.status}: ${t.command ?? t.description}`),
      ...facts.shells.crons.map((c) => `- cron ${c.id} ${c.schedule}${c.recurring ? ' recurring' : ''}: ${c.prompt}`),
    ];
    const header = `## Background shells and crons (session-wide, from the Stop event ${age(input.now - facts.shells.at)} before install)`;
    sections.push({ text: [header, ...(rows.length > 0 ? rows : ['(none running)'])].join('\n'), content: rows.length > 0 });
  }

  if (files.length > 0) {
    let left = fileRoom; // the content alone counts, as the store-time check (`loadRoomRefusal`) counts it
    const carried: string[] = [];
    const dropped: string[] = [];
    for (const f of files) {
      if (f.problem !== undefined) {
        dropped.push(`- ${f.path}: ${f.problem}`);
        filesNotCarried.push(f.path);
        continue;
      }
      if (f.content.length > left) (dropped.push(`- ${f.path}: ${num(f.content.length)} characters, over the room left`), filesNotCarried.push(f.path));
      else {
        left -= f.content.length;
        filesCarried.push(f.path);
        carried.push(`### ${f.path}${f.lines === undefined ? '' : ` lines ${f.lines}`} — ${f.why}\n${f.content}`);
      }
    }
    if (carried.length > 0) sections.push(section(['## Files you asked to carry', ...carried].join('\n')));
    if (dropped.length > 0) sections.push({ text: ['## Files not carried', ...dropped].join('\n'), content: false });
  }

  const resume = facts.startReason === 'resume' && facts.startedAt !== undefined ? [`The ledger started at ${iso(facts.startedAt)} when this process resumed; anything earlier is not recorded.`] : [];
  const head = '[forward-compaction: facts] Your context was compacted by forward-compaction. These facts were recorded as they happened, never reconstructed. Your own handoff follows in the next message.';
  return {
    text: [[head, ...resume].join('\n'), ...sections.map((s) => s.text)].join('\n\n'),
    sections: sections.filter((s) => s.content).length,
    sizes: sections.map((s) => ({ section: s.text.split('\n', 1)[0]!, chars: s.text.length })),
    carried: filesCarried,
    notCarried: filesNotCarried,
  };
}

/** Every text a kept message holds, for the facts to leave out what the tail already says. */
function keptTexts(kept: readonly WakeMessage[]): string[] {
  return kept.flatMap((m) => [m.text, ...m.toolUses.map((u) => u.text ?? ''), ...(m.toolResults ?? []).map((r) => r.text ?? '')]).filter((t) => t !== '');
}

/**
 * [F, ...H, ...tail] around a head text: the tail is fitted to what the facts and the head leave of the budget, and the
 * facts are rendered against the tail kept, so each is sized for the other (the tail is only ever shrunk, so this ends).
 * With no measured ratio nothing is fitted: `unmeasured` says whether every candidate is kept (the messages after a
 * handoff's call) or none is (a mechanical wake's earlier tail).
 */
function assemble<M extends WakeMessage>(
  input: Shared<M>,
  candidates: readonly M[],
  extras: Extras,
  head: (counts: { kept: number; dropped: number }) => string,
  unmeasured: 'all' | 'none',
): Wake<M> {
  const B = wakeBudget(input.askPoint);
  const ratio = input.charsPerToken;
  const longest = head({ kept: Math.max(1, candidates.length), dropped: Math.max(1, candidates.length) }).length;
  let kept: readonly M[] = candidates;
  for (;;) {
    const f = renderFacts(input, input.facts(keptTexts(kept)), extras);
    const fit = ratio === undefined ? { messages: unmeasured === 'all' ? [...candidates] : [] } : fitTail(candidates, B - tokensOf(f.text.length, ratio) - tokensOf(longest, ratio), ratio);
    // only a smaller fit is taken: facts can shrink with the tail, and a fit growing back would loop forever
    if (fit.messages.length < kept.length) {
      kept = fit.messages;
      continue;
    }
    const counts = { kept: kept.length, dropped: candidates.length - kept.length };
    const text = head(counts);
    return {
      messages: [{ role: 'user', text: f.text, toolUses: [] }, { role: 'user', text, toolUses: [] }, ...kept],
      facts: f.sections,
      ...counts,
      sizes: f.sizes,
      headChars: text.length,
      carried: f.carried,
      notCarried: f.notCarried,
    };
  }
}

/** The wake for a stored handoff: facts, the handoff verbatim, then every message after the `forward_compaction` call. Throws when the call is not in `messages`. */
export function buildWake<M extends WakeMessage>(input: BuildWakeInput<M>): Wake<M> {
  const split = splitAtCall(input.messages, input.toolUseId);
  if (split === undefined) throw new Error(`forward-compaction: call ${input.toolUseId} is not in the transcript to compact`);
  return assemble(input, split.tail, { siblings: split.siblings, files: input.files ?? [], fileRoom: loadFilesRoom(input.maxContext ?? 0, input.charsPerToken) }, ({ kept, dropped }) => {
    const lines = [
      '[forward-compaction: handoff] Below is the handoff you wrote with forward_compaction. It is your frontier: continue from its ## Next.',
      `=== handoff ===\n${input.handoff}\n=== end of handoff ===`,
    ];
    // The receipt's own experimental line moves to the wake's end, where it is read last.
    if (split.own !== undefined) lines.push(`Your forward_compaction call returned:\n${split.own.split(`\n${EXPERIMENTAL_OPENING}`)[0]}`);
    if (kept > 0) lines.push(`The ${kept} messages after this one are what happened after you wrote it, kept verbatim. Continue from where they leave off.`);
    if (dropped > 0) lines.push(`${dropped} older messages after your handoff did not fit and are gone (look_back finds an exact detail); call ${input.tool ?? DEFAULT_TOOL} again at your next milestone.`);
    if (kept === 0) lines.push('Nothing happened after you wrote it. Continue from ## Next.');
    return experimental(lines.join('\n\n'), input.logDir);
  }, 'all');
}

/** The wake for a party with no handoff: the same facts, then the newest messages of `messages` that fit. */
export function mechanicalWake<M extends WakeMessage>(input: MechanicalWakeInput<M>): Wake<M> {
  const why = input.reason.kind === 'ceiling' ? `, past the ${kilo(input.reason.ceiling)} ceiling` : ', and Claude Code reported your request too long';
  const source = input.party === 'main' ? "the person's messages" : 'your brief';
  return assemble(input, input.messages, { siblings: [], files: [], fileRoom: 0 }, ({ kept, dropped }) => experimental(
    `[forward-compaction: no frontier written by the model] Your context reached ${input.tokens === undefined ? 'a size not measured yet' : `${kilo(input.tokens)} tokens`}${why}, and you had not called forward_compaction, so the plugin compacted it mechanically: the facts above and your newest ${kept} messages below, kept verbatim; ${dropped} older messages are gone (look_back finds an exact detail). No objective or next step was written. Re-establish them from ${source} and the messages below, then continue; call ${input.tool ?? DEFAULT_TOOL} at your next milestone.`, input.logDir),
  'none');
}

/** An installed wake whose landed line waits for the party's first reading after it: what the line says, `before` the last reading before the install. */
export type Landing = { label: string; before?: number } & ({ kind: 'handoff'; chars: number; facts: number; kept: number; dropped: number } | { kind: 'mechanical'; tokens?: number; ceiling: number });

/** The measured sizes: the last reading before the install and the first after it; one never read is said as unknown, never estimated. */
function measured(before: number | undefined, after: number | undefined): string {
  const unknown = after === undefined ? ' (it ended before a request after the install measured it)' : ', measured';
  return `${before === undefined ? 'unknown' : kilo(before)} → ${after === undefined ? 'unknown' : kilo(after)} context${before === undefined && after !== undefined ? ' (no reading before the install), measured after' : unknown}`;
}

/** The screen line for an installed wake (always shown), at the party's first reading after it (`after`), or at its end with `after` unknown. */
export function landedLine(l: Landing, after?: number): string {
  if (l.kind === 'mechanical') return `forward-compaction: ${l.label} had no handoff at ${l.tokens === undefined ? 'an unmeasured size (no reading yet)' : kilo(l.tokens)} (ceiling ${kilo(l.ceiling)}) — mechanical wake installed, ${measured(l.before, after)}.`;
  return `forward-compaction: ${l.label} handoff landed — ${measured(l.before, after)}; frontier ${num(l.chars)} characters, ${l.facts} facts, ${l.kept} messages kept verbatim${l.dropped > 0 ? `, ${l.dropped} dropped` : ''}.`;
}
