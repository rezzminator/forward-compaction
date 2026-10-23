// The wake: what a compaction installs. [facts] [handoff] [tail…] — the facts and the handoff are built here from typed values,
// the tail is the engine's own messages returned untouched. Pure: files, agents and the clock arrive as inputs.
import { DEFAULT_TOOL } from './nudge.ts';

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

/** Characters per token for the estimate; code runs near 3.5. */
const CHARS_PER_TOKEN = 3.5;
const tokensOf = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);
const charsIn = (tokens: number): number => Math.floor(tokens * CHARS_PER_TOKEN);
const num = (value: number): string => value.toLocaleString('en-US');
const kilo = (tokens: number): string => `${Math.round(tokens / 1000)}k`;
const iso = (at: number): string => new Date(at).toISOString();

/** Per-section shares of the budget B, and the per-file cap (D18). */
const SHARE = { people: 0.25, notices: 0.05, siblings: 0.1, skills: 0.25, files: 0.15 } as const;
export const FILE_MAX_CHARS = 40_000;
export const AGENTS_MAX_ROWS = 50;

/** B = half the ask point: a wake above it would draw the next ask at once (D18). */
export function wakeBudget(askPoint: number): number {
  return Math.floor(0.5 * askPoint);
}

/**
 * The anchor is the last assistant message whose tool uses hold `toolUseId`; the response is the run of assistant
 * messages around it; the user messages right after it whose results all answer that response's calls are its results.
 * `tail` is everything after them, the same objects (handles kept); `siblings` are the response's other calls with
 * their result text. Undefined when the anchor is not in `messages`.
 */
export function splitAtCall<M extends WakeMessage>(messages: readonly M[], toolUseId: string): { tail: M[]; siblings: Sibling[] } | undefined {
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
  return { tail: messages.slice(next), siblings };
}

/** A message's size: its text, its tool inputs and its tool results (a call's own result text is the answer's, counted there). */
function messageTokens(m: WakeMessage): number {
  let chars = m.text.length;
  for (const u of m.toolUses) chars += JSON.stringify(u.input ?? {}).length;
  for (const r of m.toolResults ?? []) chars += (r.text ?? '').length;
  return tokensOf(chars);
}

/**
 * The newest whole messages that fit `budgetTokens`: the oldest are dropped until the rest fits, then any leading user
 * message carrying tool results too, so no result stands without its call. The kept messages are the input objects.
 */
export function fitTail<M extends WakeMessage>(messages: readonly M[], budgetTokens: number): { messages: M[]; dropped: number } {
  let total = messages.reduce((sum, m) => sum + messageTokens(m), 0);
  let from = 0;
  while (from < messages.length && total > budgetTokens) total -= messageTokens(messages[from++]!);
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
    tasks: readonly { id: string; status: string; description: string; command?: string }[];
    crons: readonly { id: string; schedule: string; recurring: boolean; prompt: string }[];
  };
  startedAt?: number;
  startReason?: string;
};

/** A load file, already read by the adapter: its content, or why it could not be read. */
export type WakeFile = { path: string; lines?: string; why: string } & ({ content: string; problem?: undefined } | { problem: string; content?: undefined });
export type AgentRow = { id: string; type: string; status: string; description: string };

type Shared<M> = {
  /** The party's current `e.messages`. */
  messages: readonly M[];
  party: 'main' | 'subagent';
  /** The party's context reading, for the wake's own wording. */
  tokens: number;
  askPoint: number;
  /** `$.clock.now()`, for the age of the shells snapshot. */
  now: number;
  /** The party's facts, leaving out entries already inside `keptTexts` (the kept tail's texts): the tail is fitted around the facts and the facts around the tail. */
  facts: (keptTexts: readonly string[]) => WakeFacts;
  /** `$.agent.list()` rows, or its error; absent, no section. */
  agents?: readonly AgentRow[] | { error: string };
  /** The registered `forward_compaction` name, DEFAULT_TOOL when absent. */
  tool?: string;
};
/** `storedAt`: the context the handoff was written at (`tokens` when absent). */
export type BuildWakeInput<M> = Shared<M> & { toolUseId: string; handoff: string; files?: readonly WakeFile[]; storedAt?: number };
export type MechanicalWakeInput<M> = Shared<M> & { reason: { kind: 'ceiling'; ceiling: number } | { kind: 'reactive' } };

export type Wake<M> = {
  /** [F, H, ...tail]: H is the last message built here; the tail is the input objects. */
  messages: (BuiltMessage | M)[];
  /** F sections that hold content. */
  facts: number;
  kept: number;
  dropped: number;
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

type Extras = { siblings: readonly Sibling[]; files: readonly WakeFile[] };

/** F: every section with its cap; whole or not, never cut. */
function renderFacts<M>(input: Shared<M>, facts: WakeFacts, { siblings, files }: Extras): { text: string; sections: number } {
  const B = wakeBudget(input.askPoint);
  const room = (share: number): number => charsIn(B * share);
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
    const { shown, left } = newestFitting(facts.person, (p) => `### ${iso(p.at)}\n${p.text}`, room(SHARE.people));
    const count = facts.person.length;
    const heading = left === 0 ? `(${shown.length} of ${count})` : `(${shown.length} of ${count}; the ${left} oldest are not carried: look_back finds them)`;
    sections.push(section([`## The person's messages, oldest first ${heading}`, ...shown].join('\n')));
  }

  const inbox = sub ? { entries: facts.received, title: 'Messages from your coordinator' } : { entries: facts.notices, title: 'Notifications delivered to you' };
  if (inbox.entries.length > 0) {
    const { shown, left } = newestFitting(inbox.entries, (m) => `### ${iso(m.at)} (${m.origin})\n${m.text}`, room(SHARE.notices));
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

  if (input.agents !== undefined) {
    if (!Array.isArray(input.agents)) sections.push({ text: `## Agents\n(could not be listed: ${(input.agents as { error: string }).error})`, content: false });
    else if (input.agents.length > 0) {
      const rows = (input.agents as readonly AgentRow[]).slice(0, AGENTS_MAX_ROWS).map((a) => `- ${a.id} ${a.type} ${a.status}: ${a.description}`);
      const more = input.agents.length - AGENTS_MAX_ROWS;
      sections.push(section(['## Agents, listed at install', ...rows, ...(more > 0 ? [`(${more} more not listed)`] : [])].join('\n')));
    }
  }

  if (facts.shells === undefined) sections.push({ text: '## Background shells and crons\n(unknown: no Stop event yet in this process)', content: false });
  else {
    const rows = [
      ...facts.shells.tasks.map((t) => `- shell ${t.id} ${t.status}: ${t.command ?? t.description}`),
      ...facts.shells.crons.map((c) => `- cron ${c.id} ${c.schedule}${c.recurring ? ' recurring' : ''}: ${c.prompt}`),
    ];
    const header = `## Background shells and crons (session-wide, from the Stop event ${age(input.now - facts.shells.at)} before install)`;
    sections.push({ text: [header, ...(rows.length > 0 ? rows : ['(none running)'])].join('\n'), content: rows.length > 0 });
  }

  if (files.length > 0) {
    let left = room(SHARE.files);
    const carried: string[] = [];
    const dropped: string[] = [];
    for (const f of files) {
      if (f.problem !== undefined) {
        dropped.push(`- ${f.path}: ${f.problem}`);
        continue;
      }
      const block = `### ${f.path}${f.lines === undefined ? '' : ` lines ${f.lines}`} — ${f.why}\n${f.content}`;
      if (f.content.length > FILE_MAX_CHARS || block.length + 1 > left) dropped.push(`- ${f.path}: ${num(f.content.length)} characters, over the room left`);
      else {
        left -= block.length + 1;
        carried.push(block);
      }
    }
    if (carried.length > 0) sections.push(section(['## Files you asked to carry', ...carried].join('\n')));
    if (dropped.length > 0) sections.push({ text: ['## Files not carried', ...dropped].join('\n'), content: false });
  }

  const resume = facts.startReason === 'resume' && facts.startedAt !== undefined ? [`The ledger started at ${iso(facts.startedAt)} when this process resumed; anything earlier is not recorded.`] : [];
  const head = '[forward-compaction: facts] Your context was compacted by forward-compaction. These facts were recorded as they happened, never reconstructed. Your own handoff follows in the next message.';
  return { text: [[head, ...resume].join('\n'), ...sections.map((s) => s.text)].join('\n\n'), sections: sections.filter((s) => s.content).length };
}

/** Every text a kept message holds, for the facts to leave out what the tail already says. */
function keptTexts(kept: readonly WakeMessage[]): string[] {
  return kept.flatMap((m) => [m.text, ...m.toolUses.map((u) => u.text ?? ''), ...(m.toolResults ?? []).map((r) => r.text ?? '')]).filter((t) => t !== '');
}

/**
 * [F, ...H, ...tail] around a head text: the tail is fitted to what the facts and the head leave of the budget, and the
 * facts are rendered against the tail kept, so each is sized for the other (the tail is only ever shrunk, so this ends).
 */
function assemble<M extends WakeMessage>(
  input: Shared<M>,
  candidates: readonly M[],
  extras: Extras,
  head: (counts: { kept: number; dropped: number }) => string,
): Wake<M> {
  const B = wakeBudget(input.askPoint);
  const longest = head({ kept: Math.max(1, candidates.length), dropped: Math.max(1, candidates.length) }).length;
  let kept: readonly M[] = candidates;
  for (;;) {
    const f = renderFacts(input, input.facts(keptTexts(kept)), extras);
    const fit = fitTail(candidates, B - tokensOf(f.text.length) - tokensOf(longest));
    // only a smaller fit is taken: facts can shrink with the tail, and a fit growing back would loop forever
    if (fit.messages.length < kept.length) {
      kept = fit.messages;
      continue;
    }
    const counts = { kept: kept.length, dropped: candidates.length - kept.length };
    return {
      messages: [{ role: 'user', text: f.text, toolUses: [] }, { role: 'user', text: head(counts), toolUses: [] }, ...kept],
      facts: f.sections,
      ...counts,
    };
  }
}

/** The wake for a stored handoff: facts, the handoff verbatim, then every message after the `forward_compaction` call. Throws when the call is not in `messages`. */
export function buildWake<M extends WakeMessage>(input: BuildWakeInput<M>): Wake<M> {
  const split = splitAtCall(input.messages, input.toolUseId);
  if (split === undefined) throw new Error(`forward-compaction: call ${input.toolUseId} is not in the transcript to compact`);
  return assemble(input, split.tail, { siblings: split.siblings, files: input.files ?? [] }, ({ kept, dropped }) => {
    const lines = [
      `[forward-compaction: handoff] Below is the handoff you wrote with forward_compaction at ${kilo(input.storedAt ?? input.tokens)} tokens. It is your frontier: continue from its ## Next.`,
      `=== handoff ===\n${input.handoff}\n=== end of handoff ===`,
    ];
    if (kept > 0) lines.push(`The ${kept} messages after this one are what happened after you wrote it, kept verbatim. Continue from where they leave off.`);
    if (dropped > 0) lines.push(`${dropped} older messages after your handoff did not fit and are gone (look_back finds an exact detail); call ${input.tool ?? DEFAULT_TOOL} again at your next milestone.`);
    if (kept === 0) lines.push('Nothing happened after you wrote it. Continue from ## Next.');
    return lines.join('\n\n');
  });
}

/** The wake for a party with no handoff: the same facts, then the newest messages of `messages` that fit. */
export function mechanicalWake<M extends WakeMessage>(input: MechanicalWakeInput<M>): Wake<M> {
  const why = input.reason.kind === 'ceiling' ? `, past the ${kilo(input.reason.ceiling)} ceiling` : ', and Claude Code reported your request too long';
  const source = input.party === 'main' ? "the person's messages" : 'your brief';
  return assemble(input, input.messages, { siblings: [], files: [] }, ({ kept, dropped }) =>
    `[forward-compaction: no frontier written by the model] Your context reached ${kilo(input.tokens)} tokens${why}, and you had not called forward_compaction, so the plugin compacted it mechanically: the facts above and your newest ${kept} messages below, kept verbatim; ${dropped} older messages are gone (look_back finds an exact detail). No objective or next step was written. Re-establish them from ${source} and the messages below, then continue; call ${input.tool ?? DEFAULT_TOOL} at your next milestone.`,
  );
}

/** The screen line for an installed handoff (always shown). */
export function landedLine(input: { label: string; before: number; after: number; chars: number; facts: number; kept: number; dropped: number }): string {
  const dropped = input.dropped > 0 ? `, ${input.dropped} dropped` : '';
  return `forward-compaction: ${input.label} handoff landed — ${kilo(input.before)} → ${kilo(input.after)} tokens; frontier ${num(input.chars)} characters, ${input.facts} facts, ${input.kept} messages kept verbatim${dropped}.`;
}

/** The screen line for an installed mechanical wake. */
export function mechanicalLine(input: { label: string; tokens: number; ceiling: number; before: number; after: number }): string {
  return `forward-compaction: ${input.label} had no handoff at ${kilo(input.tokens)} (ceiling ${kilo(input.ceiling)}) — mechanical wake installed, ${kilo(input.before)} → ${kilo(input.after)}.`;
}
