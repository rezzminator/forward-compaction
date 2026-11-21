// The wake: what a compaction installs. [facts] [frontier] [tail…] — the facts and the frontier are built here from typed values,
// the tail is the engine's own messages returned untouched. Pure: files, agents and the clock arrive as inputs.
import { andList, DEFAULT_TOOL, k as kilo } from './nudge';
import { keptSaid, PROMPTS_KEPT } from './ledger';
import { experimental, EXPERIMENTAL_OPENING } from './frontier';
import { fitSkills, pinned, SKILLS_LISTED_NOTE, SKILLS_MAX_CHARS } from './carry';
import { ordersSection } from './orders';
import { unchangedNote, type Item, type StorageEntry } from './lists';
import { storageSection } from './storage';
import type { WakePlan } from './plan';
import { WAKE_OPENING } from './wake-row';

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
 * kept after the call. The user's newest messages or the brief, the task list, the skills in force (within their own
 * character limits below) and the load files (each within LOAD_FILE_MAX_LINES) are what a woken model most needs, so they
 * are carried outside any share.
 */
const SHARE = { arrived: 0.25, notices: 0.05, siblings: 0.1, commands: 0.05 } as const;
/** The plugin version that builds a wake, named in its facts header so a chat on an old build is visible; tests/layout.test.ts pins it to plugin.json. */
export const PLUGIN_VERSION = '2.3.1';
/** An image the user attached: a built wake message holds only text (`session.compact`'s messages), so each is named, never silently gone. */
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
/**
 * B = half the ask point, a design budget: half leaves the woken party room to work before its next ask (D18). B bounds the
 * kept tail, not the whole wake: the facts sections' shares (`SHARE`) sum to 0.45×B, and the user's words, the task list, the
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
  user: readonly { at: number; text: string; answer?: string }[];
  /** User messages the ledger left out because the tail holds them. */
  userInTail?: number;
  notices: readonly { at: number; origin: string; text: string }[];
  /** What reached the party after it stored its frontier and the kept tail lacks (ledger.ts `Facts`); absent on a mechanical wake. */
  arrived?: readonly { at: number; origin: string; text: string }[];
  /** The `agent.spawn` prompt; absent when the agent was spawned before the ledger started. */
  brief?: { text: string };
  children?: readonly { id: string; subagentType?: string; description?: string }[]; // the agents the party spawned (ledger.ts `Facts`)
  received: readonly { at: number; origin: string; text: string }[];
  /** Latest text per skill, newest first; `keep` pinned, `description` its frontmatter's. */
  skills: readonly { skill: string; text: string; source?: string; path?: string; keep?: true; description?: string }[];
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
export type WakeFile = { path: string; lines?: string; why?: string } & ({ content: string; problem?: undefined } | { problem: string; content?: undefined });
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
  /** The party's live standing orders (lists.ts), and its count of installed compactions, against which each order's rounds unchanged are counted; absent or empty, no section. */
  orders?: readonly Item[]; rounds?: number;
  /** The party's storage folder, absolute, and its listed entries (storage.ts); none listed, no section. */
  storage?: { dir: string; entries: readonly StorageEntry[] };
  /** Plan mode and the plan file, when the party's plan-mode attachments named them; absent, no section. */
  plan?: WakePlan;
  /** The skills and commands this wake carries whole besides the frontmatter-pinned ones: FORWARD_COMPACTION_KEEP_SKILLS (carry.ts `pinned`); every other one is listed. */
  pins?: readonly string[];
  /** The frontier as the plugin holds it, rendered (lists.ts `renderFrontier`): a frontier wake installs it, a mechanical wake shows it as it stands; '' or absent when nothing is held. */
  frontier?: string;
};
/** `missing`: the texts the held frontier lacks (frontier.ts `Applied.missing`), each named in the head. */
export type BuildWakeInput<M> = Shared<M> & { toolUseId: string; frontier: string; files?: readonly WakeFile[]; missing?: readonly string[] };
export type MechanicalWakeInput<M> = Shared<M> & {
  reason: { kind: 'ceiling'; ceiling: number } | { kind: 'reactive' };
  /** The party's newest files, read at install (`recentFiles`); absent or empty, no section. */
  recent?: readonly RecentFile[];
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
  /** For the wake's log rows: the skills carried whole and those listed under `## Skills not carried`, and the storage entries listed. */
  skills: { carried: number; listed: number };
  storage: number;
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

type Rendered = { text: string; sections: number; sizes: Wake<never>['sizes']; carried: string[]; notCarried: string[]; skills: Wake<never>['skills']; storage: number };

/** F: every section with its cap; whole or not, never cut. With no measured ratio no section is capped. */
function renderFacts<M>(input: Shared<M>, facts: WakeFacts, { siblings, files, recent = [], mechanical = false }: Extras): Rendered {
  const B = wakeBudget(input.askPoint);
  const room = (share: number): number => charsIn(B * share, input.charsPerToken);
  const filesCarried: string[] = [];
  const filesNotCarried: string[] = [];
  const sections: Section[] = [];
  const sub = input.party === 'subagent';

  // Above all: the user's standing orders, binding and carried whole, outside every budget.
  const orders = ordersSection(input.orders ?? [], input.rounds);
  if (orders !== undefined) sections.push(section(orders));

  // Then: what the model has not seen, which a notification-driven party would otherwise wait on forever.
  const arrived = facts.arrived ?? [];
  if (arrived.length > 0) {
    const { shown, left } = newestFitting(arrived, (m) => `### ${iso(m.at)} (${m.origin})\n${m.text}`, room(SHARE.arrived));
    sections.push(section(['## Arrived after you wrote your frontier: you have not read these yet', ...(left > 0 ? [`(${left} older not carried; look_back finds them)`] : []), ...shown].join('\n')));
  }

  // Plan mode binds what the party may do, and the plan file is the work's own record: both whole, outside every budget, as Claude Code carries them.
  const plan = input.plan;
  if (plan?.mode) sections.push(section(`## Plan mode\nThe session is in plan mode: plan, never act, until the user approves the plan${plan.path === undefined ? '' : `; your plan file is ${plan.path}`}.`));
  if (plan?.path !== undefined && plan.content !== undefined) sections.push(section(`## Plan file\n${plan.path}\n${plan.content}`));
  else if (plan?.path !== undefined && plan.problem !== undefined) sections.push({ text: `## Plan file\n${plan.path}\n(could not be read: ${plan.problem})`, content: false });

  if (sub) {
    if (facts.brief === undefined) sections.push({ text: '## Your brief\n(not recorded: this agent was spawned before forward-compaction started in this process)', content: false });
    else sections.push(section(`## Your brief\n${facts.brief.text}`));
  } else if (facts.user.length === 0 && (facts.userInTail ?? 0) > 0) {
    sections.push({ text: `## The user's messages\n(all ${facts.userInTail} are in the messages below)`, content: false });
  } else if (facts.user.length === 0) {
    sections.push({ text: `## The user's messages\n(none recorded${facts.startedAt === undefined ? '' : ` since ${iso(facts.startedAt)}`})`, content: false });
  } else {
    const shown = keptSaid(facts.user).map((p) => `### ${iso(p.at)}${p.answer === undefined ? '' : ' (the user answering your question)'}\n${p.text.replace(IMAGE, IMAGE_NOTE)}`);
    const count = facts.user.length;
    const inTail = facts.userInTail ?? 0;
    const left = count - shown.length;
    const answers = facts.user.filter((p) => p.answer !== undefined).length;
    // `recorded`: the count is the plugin's own record, which a restart begins again; the transcript may hold older ones.
    const carried = `${shown.length} of ${count + inTail} recorded${answers === 0 ? '' : `, ${answers} of them answering your questions`}`;
    const notes = [...(left === 0 ? [] : [`the ${left} oldest recorded are not carried: look_back finds them`]), ...(inTail === 0 ? [] : [`${inTail} ${inTail === 1 ? 'is' : 'are'} in the messages below`])];
    const heading = `(${[carried, ...notes].join('; ')})`;
    sections.push(section([`## The user's messages, oldest first ${heading}`, ...shown].join('\n')));
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
  // a pinned skill carried whole within Claude Code's own post-compaction limits, outside B; every other one listed by
  // name, source and description. The tail is fitted after them.
  const whole = (s: WakeFacts['skills'][number]): boolean => pinned(s, input.pins ?? []);
  const from = (s: WakeFacts['skills'][number]): string => `${s.source ?? 'unknown source'}${s.path === undefined ? '' : `, ${s.path}`}`;
  const skills = fitSkills(facts.skills.filter(whole));
  const carriedSkills = skills.carried.map((s) => `### ${s.skill} (${from(s)}, pinned)\n${s.text}`);
  if (carriedSkills.length > 0) sections.push(section(['## Skills in force, as loaded', ...carriedSkills].join('\n')));
  const listed = facts.skills.filter((s) => !whole(s));
  for (const s of listed) notCarried.push(`- ${s.skill} (${from(s)})${s.description === undefined ? '' : `: ${s.description}`}`);
  for (const s of skills.skipped) notCarried.push(`- ${s.skill}: over the ${num(SKILLS_MAX_CHARS)}-character room for skills; call Skill ${s.skill}${s.path === undefined ? '' : ` or Read ${s.path}`} if it applies to you.`);
  for (const s of facts.unattributedSkills) notCarried.push(`- ${s.skill}: loaded in this session by an unidentified party; call Skill ${s.skill} if it applies to you.`);
  if (notCarried.length > 0) sections.push({ text: ['## Skills not carried', SKILLS_LISTED_NOTE, ...notCarried].join('\n'), content: listed.length > 0 });

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
    else {
      const listed = new Set(input.agents.map((a) => a.id));
      const own = input.agents.filter((a) => input.self === undefined || a.parentId === input.self).map((a) => `- ${a.id} ${a.type} ${a.status}: ${a.description}`);
      // A child the list no longer holds may have returned while the frontier was written: named, so its "still running" is not trusted; past the cap the newest stay.
      const gone = (facts.children ?? []).filter((c) => !listed.has(c.id)).map((c) => `- ${[c.id, c.subagentType].filter((x) => x !== undefined).join(' ')} not in the list (finished, stopped or gone)${c.description !== undefined ? `: ${c.description}` : ''}`);
      const rows = [...own.slice(0, AGENTS_MAX_ROWS), ...gone.slice(Math.max(0, gone.length - Math.max(0, AGENTS_MAX_ROWS - own.length)))];
      if (rows.length > 0) sections.push(section(['## Agents, listed at install', ...rows, ...(own.length + gone.length > rows.length ? [`(${own.length + gone.length - rows.length} more not listed)`] : [])].join('\n')));
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

  // the load files not carried, each named once with why
  const dropped: string[] = [];
  if (files.length > 0) {
    // each already cut to LOAD_FILE_MAX_LINES (frontier.ts `sliceFile`); no room and no count cap
    const carried: string[] = [];
    for (const f of files) {
      if (f.problem !== undefined) {
        dropped.push(`- ${f.path}: ${f.problem}`);
        filesNotCarried.push(f.path);
        continue;
      }
      filesCarried.push(f.path);
      carried.push(`### ${f.path}${f.lines === undefined ? '' : ` lines ${f.lines}`}${f.why === undefined ? '' : ` — ${f.why}`}\n${f.content}`);
    }
    if (carried.length > 0) sections.push(section(['## Files you asked to carry', ...carried].join('\n')));
  }
  const storage = input.storage === undefined ? undefined : storageSection(input.storage.dir, input.storage.entries);
  if (storage !== undefined) sections.push(section(storage));
  if (dropped.length > 0) sections.push({ text: ['## Files not carried', ...dropped].join('\n'), content: false });

  if (recent.length > 0) {
    // each already cut to LOAD_FILE_MAX_LINES (frontier.ts `sliceFile`); one that could not be read is named in place
    const blocks = recent.map((f) => {
      (f.problem === undefined ? filesCarried : filesNotCarried).push(f.path);
      return f.problem === undefined ? `### ${f.path}${f.lines === undefined ? '' : ` lines ${f.lines}`}\n${f.content}` : `### ${f.path}\n(not carried: ${f.problem})`;
    });
    sections.push(section(['## Files you were working on, newest first, read at install', ...blocks].join('\n')));
  }

  const resume = facts.startReason === 'resume' && facts.startedAt !== undefined ? [`The ledger started at ${iso(facts.startedAt)} when this process resumed; anything earlier is not recorded.`] : [];
  const head = `${WAKE_OPENING.facts} Your context was compacted by forward-compaction ${PLUGIN_VERSION}. These facts were recorded as they happened, never reconstructed. ${mechanical ? 'You wrote no frontier: the note after these facts says what happened.' : 'Your own frontier follows in the next message.'}`;
  return {
    text: [[head, ...resume].join('\n'), ...sections.map((s) => s.text)].join('\n\n'),
    sections: sections.filter((s) => s.content).length,
    sizes: sections.map((s) => ({ section: s.text.split('\n', 1)[0]!, chars: s.text.length })),
    carried: filesCarried,
    notCarried: filesNotCarried,
    skills: { carried: skills.carried.length, listed: notCarried.length },
    storage: input.storage?.entries.length ?? 0,
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
      skills: f.skills,
      storage: f.storage,
    };
  }
}

/** The head's line on how the next call changes the frontier: by item number, the rest staying. */
export const CHANGES_ONLY = 'In your next forward_compaction call send only changes, by item number; whatever you leave out stays.';
/** The head's clause when standing orders bind: the next step is taken within them. */
const within = (orders: Shared<never>['orders']): string => ((orders?.length ?? 0) > 0 ? ', within the standing orders above' : '');
/** Where a woken party finds what its frontier did not say: the user's messages (main) or its brief. */
const sourceOf = (party: 'main' | 'subagent'): string => (party === 'main' ? "the user's messages" : 'your brief');

/** The wake for a stored call: facts, the held frontier rendered, then every message after the call. A call not in `messages` (compacted by something else, or one with no id) cannot be placed: the frontier is carried with the newest messages that fit, as a mechanical wake keeps them, and the head says so. */
export function buildWake<M extends WakeMessage>(input: BuildWakeInput<M>): Wake<M> {
  const split = splitAtCall(input.messages, input.toolUseId);
  const missing = input.missing ?? [];
  return assemble(input, split?.tail ?? input.messages, { siblings: split?.siblings ?? [], files: input.files ?? [] }, ({ kept, dropped }) => {
    const lines = [`${WAKE_OPENING.frontier} Below is your frontier as forward-compaction holds it: continue from its ## Next${within(input.orders)}. ${CHANGES_ONLY}${unchangedNote(input.frontier, ordersSection(input.orders ?? [], input.rounds))}`, `=== frontier ===\n${input.frontier}\n=== end of frontier ===`];
    if (missing.length > 0) lines.push(`Your frontier has no ${andList(missing)}: re-establish ${missing.length === 1 ? 'it' : 'them'} from ${sourceOf(input.party)} and the messages below, and send ${missing.length === 1 ? 'it' : 'them'} in your next forward_compaction call.`);
    // The receipt's own experimental line moves to the wake's end, where it is read last.
    if (split?.own !== undefined) lines.push(`Your forward_compaction call returned:\n${split.own.split(`\n${EXPERIMENTAL_OPENING}`)[0]}`);
    if (split === undefined) lines.push(`Your forward_compaction call is not in the transcript, so which messages came after it is unknown: ${kept > 0 ? `the newest ${kept} are kept verbatim after this one, some perhaps from before your frontier` : 'none is kept'}${dropped > 0 ? `; ${dropped} older did not fit and are gone (look_back finds an exact detail)` : ''}. Continue from ## Next.`);
    else {
      if (kept > 0) lines.push(`The ${kept} messages after this one are what happened after you wrote it, kept verbatim. Continue from where they leave off.`);
      if (dropped > 0) lines.push(`${dropped} older messages after your frontier did not fit and are gone (look_back finds an exact detail); call ${input.tool ?? DEFAULT_TOOL} again at your next milestone.`);
      if (kept === 0) lines.push('Nothing happened after you wrote it. Continue from ## Next.');
    }
    return experimental(lines.join('\n\n'), input.logDir);
  }, split === undefined ? 'none' : 'all');
}

/** The wake for a party with no frontier: the same facts, then the newest messages of `messages` that fit. */
export function mechanicalWake<M extends WakeMessage>(input: MechanicalWakeInput<M>): Wake<M> {
  const why = input.reason.kind === 'ceiling' ? `, past the ${kilo(input.reason.ceiling)} ceiling` : ', and Claude Code reported your request too long', source = sourceOf(input.party);
  const frontier = input.frontier ?? '', reached = `${WAKE_OPENING.mechanical} Your context reached ${input.tokens === undefined ? 'a size not measured yet' : `${kilo(input.tokens)} tokens`}${why}, and you had not called forward_compaction${frontier === '' ? '' : ' since your last wake'}, so the plugin compacted it mechanically`;
  return assemble(input, input.messages, { siblings: [], files: [], recent: input.recent ?? [], mechanical: true }, ({ kept, dropped }) => experimental(
    frontier === ''
      ? `${reached}: the facts above and your newest ${kept} messages below, kept verbatim; ${dropped} older messages are gone (look_back finds an exact detail). No objective or next step was written. Re-establish them from ${source} and the messages below, then continue${within(input.orders)}; call ${input.tool ?? DEFAULT_TOOL} at your next milestone.`
      : `${reached}: the facts above, your frontier below as forward-compaction holds it, unchanged since your last call, and your newest ${kept} messages after this one, kept verbatim; ${dropped} older messages are gone (look_back finds an exact detail). Continue from where the messages leave off, or from its ## Next${within(input.orders)}; call ${input.tool ?? DEFAULT_TOOL} at your next milestone. ${CHANGES_ONLY}${unchangedNote(frontier, ordersSection(input.orders ?? [], input.rounds))}\n\n=== frontier ===\n${frontier}\n=== end of frontier ===`,
    input.logDir),
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
