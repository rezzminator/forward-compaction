import type { Parties } from './parties';
import { storageDir } from './storage';
import { frontierSize, type Held } from './lists';

/** The tool's name as the installed copy registered it; a `-dev` copy's differs. */
export const DEFAULT_TOOL = 'mcp__forward-compaction__forward_compaction';

/** A token size for model-facing and screen text: thousands as `51k`, a million or more as `1M` or `1.5M`. */
export function k(tokens: number): string {
  const thousands = Math.round(tokens / 1000);
  return thousands < 1000 ? `${thousands}k` : `${Math.round(tokens / 100_000) / 10}M`;
}

/** Names as prose: `a`, `a and b`, `a, b and c`. */
export function andList(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** 0 below `start`, 1 at it, and one more per `every` tokens past it. */
export function nudgeLevel(tokens: number, start: number, every: number): number {
  if (tokens < start) return 0;
  return 1 + Math.floor((tokens - start) / Math.max(1, every));
}

/** What a nudge is timed by above a floor, in tokens: the room (the party's working room, else as much as its nudge start), the growth between nudges and the ceiling. */
export type NudgeMarks = { room: number; every: number; ceiling: number };

/**
 * The growth a party gets above a floor (its first reading ever, or its first after a compaction) before its next
 * nudge: its room, held to two `every` below its ceiling so a nudge still comes before the mechanical wake, and
 * never under one `every`.
 */
export function roomAbove(floor: number, { room, every, ceiling }: NudgeMarks): number {
  return Math.max(every, Math.min(room, ceiling - 2 * every - floor));
}

/** Whether a nudge at `tokens` is the party's last: the next one waits one `every` of growth, and that reaches the ceiling. */
export function lastNudge(tokens: number, every: number, ceiling: number): boolean {
  return tokens + every >= ceiling;
}

export type NudgeInput = {
  /** The party's last measured reading. */
  tokens: number;
  /** The registered `forward_compaction` name; DEFAULT_TOOL when absent. */
  tool?: string;
  /** Main's first notices carry the finish rule, a sub-agent's when it may skip; main when absent. */
  party?: 'main' | 'subagent';
  /** The count of nudges the party has received since its last compaction, this one included; 1 when absent. */
  notice?: number;
  /** No later nudge comes before the ceiling (`lastNudge`). */
  last?: boolean;
  /** The party's storage folder, absolute; absent when the run keeps no files. */
  storage?: string;
  /** The party holds a frontier already (`holds`): the notice asks for its changes by item number, else for a first frontier; false when absent. */
  held?: boolean;
};

/** What a frontier call sends and where each kind of material goes, the same words in every notice of a cycle: a party holding a frontier sends its changes, with the upkeep its lists need, one holding none its first; storage names its folder when the party has one, so the model writes a file there once and lists it by name. */
const args = (held: boolean, storage?: string): string =>
  `${held ? 'with only what changed since your last frontier, by item number: remove what is finished, lifted or wrong, edit what changed, add what is new' : 'with objective, next and what the rest of the work needs added to orders, decisions, done, remaining and findings'}; what only a later step reads goes in storage (${storage === undefined ? 'its value in storage.add' : `write it as a .md file in ${storage}/, then storage.add its name and description`}); load_files only what the next step reads, a long file by its line range`;

/** The first notices leave the timing to the party, so they close on its exception: main's on the end of the whole work, a sub-agent's, whose context ends with its report, on when it may skip. Later notices carry none. */
const FINISH_RULE = 'If the whole work finishes first, call it before the final report, with the finished steps removed from remaining, next "write the final report", and all the report needs added to done and findings: the compaction can land before your next request, and the report is then written from the frontier.';
const SKIP_RULES = ['Skip it if all your work ends within a few calls.', 'Skip it only if your work ends within a few calls.', 'Skip it only if the step in hand is your last.'];

/** A notice's words by its count, each firmer than the one before. The first three time the call between two steps: a compaction drops what the party has read, so a step cut in two is read twice. From the seventh on only the count of unanswered notices changes. */
function nudgeBody(notice: number, size: string, call: string): string {
  switch (notice) {
    case 1: return `context ${size} and increasing. A compaction drops what you have read, so reading done just before one is done twice: once the step in hand has its result saved and checked, and before you read for the next step, call ${call}.`;
    case 2: return `context ${size}, and every request re-sends all of it. As soon as the step in hand has its result saved and checked, and before any reading for the next step, call ${call}.`;
    case 3: return `context ${size}. Start no new step and read nothing new: save the work in hand, then call ${call}. What later steps need travels in the frontier and storage.`;
    case 4: return `context ${size}. Compact now: your next call is ${call}. An unfinished step goes in remaining and next: a frontier needs no finished step.`;
    case 5: return `context ${size}. Nothing ahead needs this context: the frontier, storage and load_files carry what you will use, and look_back finds any exact old detail. Stop and call ${call}.`;
    case 6: return `context ${size}, ${notice - 1} notices unanswered. Leave the work where it stands, finished or not, and call ${call}.`;
    default: return `context ${size}, ${notice - 1} notices unanswered. Call ${call}, and nothing else: all other work waits for the wake.`;
  }
}

/**
 * What the model reads after a tool result once its context passes a nudge point: its size and a call for a frontier,
 * worded by how many notices the party has had since its last compaction, so no two read alike and each is firmer
 * than the one before. The last one before the ceiling says what the plugin does next. It names no window and no
 * ceiling, and shows no list: a party holding a frontier still has its wake's numbered lists in its context.
 */
export function nudgeText({ tokens, tool = DEFAULT_TOOL, party = 'main', notice = 1, last = false, storage, held = false }: NudgeInput): string {
  const size = k(tokens), call = `${tool} ${args(held, storage)}`, count = Math.max(1, Math.floor(notice));
  const said = last
    ? `context ${size}. Last notice: the plugin compacts this context itself before another comes, with no frontier from you, and you wake on its recorded facts alone. To wake on your own account of the work, call ${call} now.`
    : [nudgeBody(count, size, call), ...(count > SKIP_RULES.length ? [] : [party === 'main' ? FINISH_RULE : SKIP_RULES[count - 1]])].join(' ');
  return `forward-compaction: ${said} No such tool? Carry on.`;
}

/** Whether a party holds a frontier: any live item, an objective or a next. */
export const holds = (held: Held | undefined): boolean => held !== undefined && frontierSize(held).chars > 0;

/**
 * What main reads once, with a tool result, when its context passes the finish start before any nudge: nothing to do
 * now, and a frontier at the end of the whole work, before the final report, so the user's reply meets a small context.
 */
export function finishText({ tokens, tool = DEFAULT_TOOL }: Pick<NudgeInput, 'tokens' | 'tool'>): string {
  return `forward-compaction: context ${k(tokens)}. Nothing to do yet. When the whole work is finished, call ${tool} before the final report, so the user's reply meets a small context: the finished steps removed from remaining, next "write the final report", and all the report needs added to done and findings, as the compaction can land before your next request and the report is then written from the frontier. No such tool? Carry on.`;
}

/**
 * The marks a notice is decided by, in tokens (window.ts `Marks`): the context at which the party's nudges start,
 * the room after each wake as large; `room`, only when the user set one, the working room above the party's floor
 * at which they start instead, after a wake too. Only main has a finish start.
 */
export type NoticeMarks = { start: number; every: number; ceiling: number; room?: number; finish?: number };

/** The context at which a party's nudges start: its nudge start; with a working room set, that room (`roomAbove`) above its floor instead. */
export function nudgeStart(floor: number, marks: NoticeMarks): number {
  return marks.room === undefined ? marks.start : floor + roomAbove(floor, { room: marks.room, every: marks.every, ceiling: marks.ceiling });
}

export type Notice = {
  /** The party's nudge level at its reading; 0 with no reading or no marks. */
  level: number;
  /** Why no nudge goes out; absent when one does. */
  withheld?: 'no-reading' | 'window-unknown' | 'below-start' | 'ignored-model' | 'not-due';
  /** What goes out, a nudge or the finish notice: its decision row and the text the tool result carries. Absent when nothing does. */
  sent?: { row: Record<string, unknown>; text: string };
};

/**
 * What a tool result carries for the party at its reading (`tokens`), recorded on the party as sent. Past its nudge
 * start (`nudgeStart`; with a working room, from its floor, a party with none yet at its floor) with nothing stored, the nudge, once per
 * level, worded by its count since the party's last compaction, the last one before the ceiling as the last notice.
 * With no nudge due, a party with a finish start reads the finish notice, once; an ignored model reads neither.
 */
export function noticeFor(parties: Parties, key: string, tokens: number | undefined, marks: NoticeMarks | undefined, ignore: readonly string[], tool?: string): Notice {
  if (tokens === undefined || marks === undefined) return { level: 0, withheld: tokens === undefined ? 'no-reading' : 'window-unknown' };
  const start = nudgeStart(parties.get(key).held?.floor ?? tokens, marks);
  const level = nudgeLevel(tokens, start, marks.every), ignored = parties.ignored(key, ignore) !== undefined;
  const withheld = level === 0 ? 'below-start' : ignored ? 'ignored-model' : !parties.nudgeDue(key, level, tokens, { room: marks.room ?? marks.start, every: marks.every, ceiling: marks.ceiling }) ? 'not-due' : undefined;
  if (withheld === undefined) {
    const { nudges: notice, files, held } = parties.get(key), last = lastNudge(tokens, marks.every, marks.ceiling);
    return { level, sent: { row: { event: 'nudge', party: key, level, notice, last, tokens, start, every: marks.every }, text: nudgeText({ tokens, tool, party: key === 'main' ? 'main' : 'subagent', notice, last, held: holds(held), ...(files !== undefined ? { storage: storageDir(files) } : {}) }) } };
  }
  if (ignored || marks.finish === undefined || !parties.finishDue(key, tokens, marks.finish, marks.every)) return { level, withheld };
  return { level, withheld, sent: { row: { event: 'finish-notice', party: key, tokens, start: marks.finish }, text: finishText({ tokens, tool }) } };
}
