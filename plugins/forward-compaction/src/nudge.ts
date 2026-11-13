import type { Parties } from './parties.ts';

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
};

/** The sections a frontier call names, the same words in every notice. */
const ARGS = 'with objective, decisions, done, remaining and next, and in load_files the files you will read again';

/** The first notices leave the timing to the party, so they close on its exception: main's on the end of the whole work, a sub-agent's, whose context ends with its report, on when it may skip. Later notices carry none. */
const FINISH_RULE = 'If the whole work finishes first, call it before the final report, with remaining "none", next "write the final report" and all the report needs in done and findings: the compaction can land before your next request, and the report is then written from the frontier.';
const SKIP_RULES = ['Skip it if all your work ends within a few calls.', 'Skip it only if your work ends within a few calls.', 'Skip it only if the step in hand is your last.'];

/** A notice's words by its count, each firmer than the one before; from the seventh on only the count of unanswered notices changes. */
function nudgeBody(notice: number, size: string, call: string): string {
  switch (notice) {
    case 1: return `context ${size} and increasing. At your first milestone, call ${call}. A step that needs all of this context may reach its own milestone first.`;
    case 2: return `context ${size}, and every request re-sends all of it. At the end of the step in hand, call ${call}: that is your milestone.`;
    case 3: return `context ${size}. Start no new step: finish the one in hand, then call ${call}. What later steps need travels in the frontier and load_files.`;
    case 4: return `context ${size}. Compact now: your next call is ${call}. An unfinished step goes in remaining and next: a frontier needs no finished step.`;
    case 5: return `context ${size}. Nothing ahead needs this context: the frontier and load_files carry what you will use, and look_back finds any exact old detail. Stop and call ${call}.`;
    case 6: return `context ${size}, ${notice - 1} notices unanswered. Leave the work where it stands, finished or not, and call ${call}.`;
    default: return `context ${size}, ${notice - 1} notices unanswered. Call ${call}, and nothing else: all other work waits for the wake.`;
  }
}

/**
 * What the model reads after a tool result once its context passes a nudge point: its size and a call for a frontier,
 * worded by how many notices the party has had since its last compaction, so no two read alike and each is firmer
 * than the one before. The last one before the ceiling says what the plugin does next. It names no window and no ceiling.
 */
export function nudgeText({ tokens, tool = DEFAULT_TOOL, party = 'main', notice = 1, last = false }: NudgeInput): string {
  const size = k(tokens), call = `${tool} ${ARGS}`, count = Math.max(1, Math.floor(notice));
  const said = last
    ? `context ${size}. Last notice: the plugin compacts this context itself before another comes, with no frontier from you, and you wake on its recorded facts alone. To wake on your own account of the work, call ${call} now.`
    : [nudgeBody(count, size, call), ...(count > SKIP_RULES.length ? [] : [party === 'main' ? FINISH_RULE : SKIP_RULES[count - 1]])].join(' ');
  return `forward-compaction: ${said} No such tool? Carry on.`;
}

/**
 * What main reads once, with a tool result, when its context passes the finish start before any nudge: nothing to do
 * now, and a frontier at the end of the whole work, before the final report, so the person's reply meets a small context.
 */
export function finishText({ tokens, tool = DEFAULT_TOOL }: Pick<NudgeInput, 'tokens' | 'tool'>): string {
  return `forward-compaction: context ${k(tokens)}. Nothing to do yet. When the whole work is finished, call ${tool} before the final report, so the person's reply meets a small context: objective, decisions, done, remaining "none" and next "write the final report", with all the report needs in done and findings, as the compaction can land before your next request and the report is then written from the frontier. No such tool? Carry on.`;
}

/** The marks a notice is decided by, in tokens (window.ts `Marks`); only main has a finish start. */
export type NoticeMarks = { start: number; every: number; ceiling: number; finish?: number };

export type Notice = {
  /** The party's nudge level at its reading; 0 with no reading or no marks. */
  level: number;
  /** Why no nudge goes out; absent when one does. */
  withheld?: 'no-reading' | 'window-unknown' | 'below-start' | 'ignored-model' | 'not-due';
  /** What goes out, a nudge or the finish notice: its decision row and the text the tool result carries. Absent when nothing does. */
  sent?: { row: Record<string, unknown>; text: string };
};

/**
 * What a tool result carries for the party at its reading (`tokens`), recorded on the party as sent. Past a nudge
 * point with nothing stored, the nudge, once per level, worded by its count since the party's last compaction, the
 * last one before the ceiling as the last notice. With no nudge due, a party with a finish start reads the finish
 * notice, once; an ignored model reads neither.
 */
export function noticeFor(parties: Parties, key: string, tokens: number | undefined, marks: NoticeMarks | undefined, ignore: readonly string[], tool?: string): Notice {
  if (tokens === undefined || marks === undefined) return { level: 0, withheld: tokens === undefined ? 'no-reading' : 'window-unknown' };
  const level = nudgeLevel(tokens, marks.start, marks.every), ignored = parties.ignored(key, ignore) !== undefined;
  const withheld = level === 0 ? 'below-start' : ignored ? 'ignored-model' : !parties.nudgeDue(key, level, tokens, marks) ? 'not-due' : undefined;
  if (withheld === undefined) {
    const notice = parties.get(key).nudges, last = lastNudge(tokens, marks.every, marks.ceiling);
    return { level, sent: { row: { event: 'nudge', party: key, level, notice, last, tokens, start: marks.start, every: marks.every }, text: nudgeText({ tokens, tool, party: key === 'main' ? 'main' : 'subagent', notice, last }) } };
  }
  if (ignored || marks.finish === undefined || !parties.finishDue(key, tokens, marks.finish, marks.every)) return { level, withheld };
  return { level, withheld, sent: { row: { event: 'finish-notice', party: key, tokens, start: marks.finish }, text: finishText({ tokens, tool }) } };
}
