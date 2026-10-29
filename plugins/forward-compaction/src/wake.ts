// The wake: what a compaction installs. [facts] [frontier] [tail…] — the facts and the frontier are built here from typed values,
// the tail is the engine's own messages returned untouched. Pure: files, agents and the clock arrive as inputs.
import { DEFAULT_TOOL, k as kilo } from './nudge.ts';
import { keptSaid, PROMPTS_KEPT } from './ledger.ts';
import { experimental, EXPERIMENTAL_OPENING } from './frontier.ts';
import { ordersSection, type LiftedOrder, type StandingOrder } from './orders.ts';
import type { WakePlan } from './plan.ts';

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
 * Per-section shares of the budget B (D18), design budgets and never measured sizes: what arrived after the frontier a quarter,
 * sibling results a tenth, coordinator notices and the shell commands run a twentieth each; the rest of B goes to the messages
 * kept after the call. The person's newest messages or the brief, the task list, the skills in force (within their own
 * character limits below) and the load files (each within LOAD_FILE_MAX_LINES) are what a woken model most needs, so they
 * are carried outside any share.
 */
const SHARE = { arrived: 0.25, notices: 0.05, siblings: 0.1, commands: 0.05 } as const;
/** The plugin version that builds a wake, named in its facts header so a chat on an old build is visible; tests/layout.test.ts pins it to plugin.json. */
export const PLUGIN_VERSION = '2.2.1';
/** An image the person attached: a built wake message holds only text (`session.compact`'s messages), so each is named, never silently gone. */
const IMAGE = /\[Image #\d+\]/g;
const IMAGE_NOTE = '$& (image not carried: the wake cannot hold images)';
/** The most commands the wake carries, newest first: the recipes a woken party reruns sit in its last few, a glance, not a history. */
export const COMMANDS_KEPT = 20;
/** The most files the Files section lists, newest touch first: a path list stays a glance, as the old carry's trail did. */
export const FILES_MAX = 15;
/** The files a mechanical wake re-reads from disk, newest touch first: Claude Code's own compaction restores its 5 most recent files because it fires uninvited, and so does a wake no frontier chose. */
export const RECENT_FILES_KEPT = 5;
/** The agents section's row cap: a design budget, enough for a coordinator's fleet, never the size of one. */
export const AGENTS_MAX_ROWS = 50;
/** One skill's carried text: Claude Code's own 5,000 tokens a skill after compaction, at its 4 characters a token; a design budget in characters, never a measured token count. */
export const SKILL_MAX_CHARS = 20_000;
/** All carried skills together: Claude Code's own 25,000 tokens for skills after compaction, at its 4 characters a token; a design budget in characters, never a measured token count. */
export const SKILLS_MAX_CHARS = 100_000;
/** What ends a skill cut to SKILL_MAX_CHARS, Claude Code's own marker, verbatim. */
export const SKILL_TRUNCATED = '\n\n[... skill content truncated for compaction; use Read on the skill path if you need the full text]';

/**
 * The skills a wake carries, as Claude Code carries them after its own compaction: newest loaded first, each cut past
 * SKILL_MAX_CHARS to its head and SKILL_TRUNCATED, and together within SKILLS_MAX_CHARS; one that does not fit what is
 * left is skipped and the next, smaller one may still fit. A pinned skill is cut and fitted like the rest.
 */
export function fitSkills<S extends { text: string }>(skills: readonly S[]): { carried: S[]; skipped: S[] } {
  const carried: S[] = [];
  const skipped: S[] = [];
  let left = SKILLS_MAX_CHARS;
  for (const s of skills) {
    const text = s.text.length > SKILL_MAX_CHARS ? s.text.slice(0, SKILL_MAX_CHARS - SKILL_TRUNCATED.length) + SKILL_TRUNCATED : s.text;
    if (text.length > left) skipped.push(s);
    else (left -= text.length), carried.push({ ...s, text });
  }
  return { carried, skipped };
}

/**
 * B = half the ask point, a design budget: half leaves the woken party room to work before its next ask (D18). B bounds the
 * kept tail, not the whole wake: the facts sections' shares (`SHARE`) sum to 0.45×B, and the person's words, the task list, the
 * skills and the load files are carried outside B, so a wake heavy with them keeps no tail and can start at or past its ask point.
 */
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
  person: readonly { at: number; text: string; answer?: string }[];
  /** Person messages the ledger left out because the tail holds them. */
  personInTail?: number;
  notices: readonly { at: number; origin: string; text: string }[];
  /** What reached the party after it stored its frontier and the kept tail lacks (ledger.ts `Facts`); absent on a mechanical wake. */
  arrived?: readonly { at: number; origin: string; text: string }[];
  /** The `agent.spawn` prompt; absent when the agent was spawned before the ledger started. */
  brief?: { text: string };
  received: readonly { at: number; origin: string; text: string }[];
  /** Latest text per skill, newest first. */
  skills: readonly { skill: string; text: string; source?: string; path?: string; keep?: true }[];
  unattributedSkills: readonly { skill: string }[];
  shells?: {
    at: number;
    tasks: readonly { id: string; type: string; status: string; description: string; command?: string }[];
    crons: readonly { id: string; schedule: string; recurring: boolean; prompt: string }[];
  };
  /** Background commands started after `shells` was taken, which it cannot list. */
  backgroundSince?: number;
  /** The files the party's finished calls touched, newest first, and its task list as last set. */
  work?: { files: readonly { path: string; tag: 'R' | 'E' | 'W' }[]; commands?: readonly { command: string; description?: string }[]; tasks: readonly string[] };
  startedAt?: number;
  startReason?: string;
};

/** A load file, already read by the adapter: its content, or why it could not be read. */
export type WakeFile = { path: string; lines?: string; why: string } & ({ content: string; problem?: undefined } | { problem: string; content?: undefined });
/** One of the party's newest files, read by the adapter at a mechanical install (frontier.ts `sliceFile`): its content, or why it could not be read. */
export type RecentFile = { path: string; lines?: string } & ({ content: string; problem?: undefined } | { problem: string; content?: undefined });

/** The paths a mechanical wake re-reads: the RECENT_FILES_KEPT newest the party touched (`WakeFacts.work.files`, newest first, one row a path). */
export function recentFiles(files: readonly { path: string }[]): string[] {
  return files.slice(0, RECENT_FILES_KEPT).map((f) => f.path);
}
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
  /** The party's standing orders, and the orders lifted since its last install, shown once; absent or empty, no section. */
  orders?: { standing: readonly StandingOrder[]; lifted?: readonly LiftedOrder[] };
  /** Plan mode and the plan file, when the party's plan-mode attachments named them; absent, no section. */
  plan?: WakePlan;
};
export type BuildWakeInput<M> = Shared<M> & { toolUseId: string; frontier: string; files?: readonly WakeFile[] };
export type MechanicalWakeInput<M> = Shared<M> & {
  reason: { kind: 'ceiling'; ceiling: number } | { kind: 'reactive' };
  /** The party's newest files, read at install (`recentFiles`); absent or empty, no section. */
  recent?: readonly RecentFile[];
  /** The required sections the party's stored frontier lacks, which is why it never installed; absent when none was stored. */
  incomplete?: readonly string[];
};

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

type Extras = { siblings: readonly Sibling[]; files: readonly WakeFile[]; recent?: readonly RecentFile[]; mechanical?: boolean };

type Rendered = { text: string; sections: number; sizes: Wake<never>['sizes']; carried: string[]; notCarried: string[] };

/** F: every section with its cap; whole or not, never cut. With no measured ratio no section is capped. */
function renderFacts<M>(input: Shared<M>, facts: WakeFacts, { siblings, files, recent = [], mechanical = false }: Extras): Rendered {
  const B = wakeBudget(input.askPoint);
  const room = (share: number): number => charsIn(B * share, input.charsPerToken);
  const filesCarried: string[] = [];
  const filesNotCarried: string[] = [];
  const sections: Section[] = [];
  const sub = input.party === 'subagent';

  // Above all: the person's standing orders, binding and carried whole, outside every budget.
  const orders = ordersSection(input.orders?.standing ?? [], input.orders?.lifted ?? []);
  if (orders !== undefined) sections.push(section(orders));

  // Then: what the model has not seen, which a notification-driven party would otherwise wait on forever.
  const arrived = facts.arrived ?? [];
  if (arrived.length > 0) {
    const { shown, left } = newestFitting(arrived, (m) => `### ${iso(m.at)} (${m.origin})\n${m.text}`, room(SHARE.arrived));
    sections.push(section(['## Arrived after you wrote your frontier: you have not read these yet', ...(left > 0 ? [`(${left} older not carried; look_back finds them)`] : []), ...shown].join('\n')));
  }

  // Plan mode binds what the party may do, and the plan file is the work's own record: both whole, outside every budget, as Claude Code carries them.
  const plan = input.plan;
  if (plan?.mode) sections.push(section(`## Plan mode\nThe session is in plan mode: plan, never act, until the person approves the plan${plan.path === undefined ? '' : `; your plan file is ${plan.path}`}.`));
  if (plan?.path !== undefined && plan.content !== undefined) sections.push(section(`## Plan file\n${plan.path}\n${plan.content}`));
  else if (plan?.path !== undefined && plan.problem !== undefined) sections.push({ text: `## Plan file\n${plan.path}\n(could not be read: ${plan.problem})`, content: false });

  if (sub) {
    if (facts.brief === undefined) sections.push({ text: '## Your brief\n(not recorded: this agent was spawned before forward-compaction started in this process)', content: false });
    else sections.push(section(`## Your brief\n${facts.brief.text}`));
  } else if (facts.person.length === 0 && (facts.personInTail ?? 0) > 0) {
    sections.push({ text: `## The person's messages\n(all ${facts.personInTail} are in the messages below)`, content: false });
  } else if (facts.person.length === 0) {
    sections.push({ text: `## The person's messages\n(none recorded${facts.startedAt === undefined ? '' : ` since ${iso(facts.startedAt)}`})`, content: false });
  } else {
    const shown = keptSaid(facts.person).map((p) => `### ${iso(p.at)}${p.answer === undefined ? '' : ' (the person answering your question)'}\n${p.text.replace(IMAGE, IMAGE_NOTE)}`);
    const count = facts.person.length;
    const inTail = facts.personInTail ?? 0;
    const left = count - shown.length;
    const answers = facts.person.filter((p) => p.answer !== undefined).length;
    // `recorded`: the count is the plugin's own record, which a restart begins again; the transcript may hold older ones.
    const carried = `${shown.length} of ${count + inTail} recorded${answers === 0 ? '' : `, ${answers} of them answering your questions`}`;
    const notes = [...(left === 0 ? [] : [`the ${left} oldest recorded are not carried: look_back finds them`]), ...(inTail === 0 ? [] : [`${inTail} ${inTail === 1 ? 'is' : 'are'} in the messages below`])];
    const heading = `(${[carried, ...notes].join('; ')})`;
    sections.push(section([`## The person's messages, oldest first ${heading}`, ...shown].join('\n')));
  }

  const inbox = sub ? { entries: facts.received, title: 'Messages delivered to you' } : { entries: facts.notices, title: 'Notifications delivered to you' };
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
    sections.push(section(['## Results of the calls you made beside the frontier', ...rows].join('\n')));
  }

  const notCarried: string[] = [];
  // the skills within Claude Code's own post-compaction limits, outside B; the tail is fitted after them
  const skills = fitSkills(facts.skills);
  const carriedSkills = skills.carried.map((s) => `### ${s.skill} (${s.source ?? 'unknown source'}${s.path === undefined ? '' : `, ${s.path}`}${s.keep ? ', pinned: never dropped' : ''})\n${s.text}`);
  if (carriedSkills.length > 0) sections.push(section(['## Skills in force, as loaded (one you no longer need: name it in drop_skills on two frontiers in a row)', ...carriedSkills].join('\n')));
  for (const s of skills.skipped) notCarried.push(`- ${s.skill}: over the ${num(SKILLS_MAX_CHARS)}-character room for skills; call Skill ${s.skill}${s.path === undefined ? '' : ` or Read ${s.path}`} if it applies to you.`);
  for (const s of facts.unattributedSkills) notCarried.push(`- ${s.skill}: loaded in this session by an unidentified party; call Skill ${s.skill} if it applies to you.`);
  if (notCarried.length > 0) sections.push({ text: ['## Skills not carried', ...notCarried].join('\n'), content: false });

  const work = facts.work;
  if (work !== undefined && work.files.length > 0) {
    const more = work.files.length - FILES_MAX;
    sections.push(section(['## Files touched, newest first (R read, E edited, W written)', ...work.files.slice(0, FILES_MAX).map((f) => `${f.tag} ${f.path}`), ...(more > 0 ? [`(${more} older not listed)`] : [])].join('\n')));
  }
  if (work?.commands !== undefined && work.commands.length > 0) {
    const kept = work.commands.slice(0, COMMANDS_KEPT); // newest first; fitted from the newest, the older left out named
    const { shown, left } = newestFitting([...kept].reverse(), (c) => `### ${c.description ?? '(no description)'}\n${c.command}`, room(SHARE.commands));
    const out = left + work.commands.length - kept.length;
    sections.push(section([`## Shell commands you ran, newest first${out > 0 ? ` (${out} older not carried; look_back finds them)` : ''}`, ...shown.reverse()].join('\n')));
  }
  if (work !== undefined && work.tasks.length > 0) sections.push(section(['## Tasks, as last set', ...work.tasks].join('\n'))); // whole, never fitted

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
    const since = facts.backgroundSince ?? 0;
    const header = `## Background shells and crons (session-wide, from the Stop event ${age(input.now - facts.shells.at)} before install${since === 0 ? '' : `; ${since} background command${since === 1 ? '' : 's'} started since ${since === 1 ? 'is' : 'are'} not in this list`})`;
    sections.push({ text: [header, ...(rows.length > 0 ? rows : ['(none running)'])].join('\n'), content: rows.length > 0 });
  }

  if (files.length > 0) {
    // each already cut to LOAD_FILE_MAX_LINES (frontier.ts `sliceFile`); no room and no count cap
    const carried: string[] = [];
    const dropped: string[] = [];
    for (const f of files) {
      if (f.problem !== undefined) {
        dropped.push(`- ${f.path}: ${f.problem}`);
        filesNotCarried.push(f.path);
        continue;
      }
      filesCarried.push(f.path);
      carried.push(`### ${f.path}${f.lines === undefined ? '' : ` lines ${f.lines}`} — ${f.why}\n${f.content}`);
    }
    if (carried.length > 0) sections.push(section(['## Files you asked to carry', ...carried].join('\n')));
    if (dropped.length > 0) sections.push({ text: ['## Files not carried', ...dropped].join('\n'), content: false });
  }

  if (recent.length > 0) {
    // each already cut to LOAD_FILE_MAX_LINES (frontier.ts `sliceFile`); one that could not be read is named in place
    const blocks = recent.map((f) => {
      (f.problem === undefined ? filesCarried : filesNotCarried).push(f.path);
      return f.problem === undefined ? `### ${f.path}${f.lines === undefined ? '' : ` lines ${f.lines}`}\n${f.content}` : `### ${f.path}\n(not carried: ${f.problem})`;
    });
    sections.push(section(['## Files you were working on, newest first, read at install', ...blocks].join('\n')));
  }

  const resume = facts.startReason === 'resume' && facts.startedAt !== undefined ? [`The ledger started at ${iso(facts.startedAt)} when this process resumed; anything earlier is not recorded.`] : [];
  const head = `[forward-compaction: facts] Your context was compacted by forward-compaction ${PLUGIN_VERSION}. These facts were recorded as they happened, never reconstructed. ${mechanical ? 'You wrote no frontier: the note after these facts says what happened.' : 'Your own frontier follows in the next message.'}`;
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
 * frontier's call) or none is (a mechanical wake's earlier tail).
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

/** The head's clause when standing orders bind: the next step is taken within them. */
const within = (orders: Shared<never>['orders']): string => ((orders?.standing.length ?? 0) > 0 ? ', within the standing orders above' : '');

/** The wake for a stored frontier: facts, the frontier verbatim, then every message after the `forward_compaction` call. Throws when the call is not in `messages`. */
export function buildWake<M extends WakeMessage>(input: BuildWakeInput<M>): Wake<M> {
  const split = splitAtCall(input.messages, input.toolUseId);
  if (split === undefined) throw new Error(`forward-compaction: call ${input.toolUseId} is not in the transcript to compact`);
  return assemble(input, split.tail, { siblings: split.siblings, files: input.files ?? [] }, ({ kept, dropped }) => {
    const lines = [
      `[forward-compaction: frontier] Below is the frontier you wrote with forward_compaction: continue from its ## Next${within(input.orders)}.`,
      `=== frontier ===\n${input.frontier}\n=== end of frontier ===`,
    ];
    // The receipt's own experimental line moves to the wake's end, where it is read last.
    if (split.own !== undefined) lines.push(`Your forward_compaction call returned:\n${split.own.split(`\n${EXPERIMENTAL_OPENING}`)[0]}`);
    if (kept > 0) lines.push(`The ${kept} messages after this one are what happened after you wrote it, kept verbatim. Continue from where they leave off.`);
    if (dropped > 0) lines.push(`${dropped} older messages after your frontier did not fit and are gone (look_back finds an exact detail); call ${input.tool ?? DEFAULT_TOOL} again at your next milestone.`);
    if (kept === 0) lines.push('Nothing happened after you wrote it. Continue from ## Next.');
    return experimental(lines.join('\n\n'), input.logDir);
  }, 'all');
}

/** The wake for a party with no frontier: the same facts, then the newest messages of `messages` that fit. */
export function mechanicalWake<M extends WakeMessage>(input: MechanicalWakeInput<M>): Wake<M> {
  const why = input.reason.kind === 'ceiling' ? `, past the ${kilo(input.reason.ceiling)} ceiling` : ', and Claude Code reported your request too long';
  const source = input.party === 'main' ? "the person's messages" : 'your brief';
  const missing = input.incomplete ?? [];
  const call = missing.length === 0 ? 'you had not called forward_compaction, so' : `your last forward_compaction call was missing ${missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}`}, so it never installed and`;
  return assemble(input, input.messages, { siblings: [], files: [], recent: input.recent ?? [], mechanical: true }, ({ kept, dropped }) => experimental(
    `[forward-compaction: no frontier written by the model] Your context reached ${input.tokens === undefined ? 'a size not measured yet' : `${kilo(input.tokens)} tokens`}${why}, and ${call} the plugin compacted it mechanically: the facts above and your newest ${kept} messages below, kept verbatim; ${dropped} older messages are gone (look_back finds an exact detail). No objective or next step was written. Re-establish them from ${source} and the messages below, then continue${within(input.orders)}; call ${input.tool ?? DEFAULT_TOOL} at your next milestone.`, input.logDir),
  'none');
}

/** An installed wake whose landed line waits for the party's first reading after it: what the line says, `before` the last reading before the install. */
export type Landing = { label: string; before?: number } & ({ kind: 'frontier'; chars: number; facts: number; kept: number; dropped: number } | { kind: 'mechanical'; tokens?: number; ceiling: number });

/** The measured sizes: the last reading before the install and the first after it; one never read is said as unknown, never estimated. */
function measured(before: number | undefined, after: number | undefined): string {
  const unknown = after === undefined ? ' (it ended before a request after the install measured it)' : ', measured';
  return `${before === undefined ? 'unknown' : kilo(before)} → ${after === undefined ? 'unknown' : kilo(after)} context${before === undefined && after !== undefined ? ' (no reading before the install), measured after' : unknown}`;
}

/** The landed line for an installed wake (an info row, never on screen), at the party's first reading after it (`after`), or at its end with `after` unknown. */
export function landedLine(l: Landing, after?: number): string {
  if (l.kind === 'mechanical') return `forward-compaction: ${l.label} had no frontier at ${l.tokens === undefined ? 'an unmeasured size (no reading yet)' : kilo(l.tokens)} (ceiling ${kilo(l.ceiling)}) — mechanical wake installed, ${measured(l.before, after)}.`;
  return `forward-compaction: ${l.label} frontier landed — ${measured(l.before, after)}; ${num(l.chars)} characters, ${l.facts} facts, ${l.kept} messages kept verbatim${l.dropped > 0 ? `, ${l.dropped} dropped` : ''}.`;
}
