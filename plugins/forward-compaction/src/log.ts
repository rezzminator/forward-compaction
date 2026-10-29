// The decision log: one JSONL file per session, appended to on every write.
// Chats share the decisions folder in the plugin log directory, so each session writes its own
// file there; a resumed session appends to the rows it wrote before.
// The level files are the vendored plugin-log library's (./plugin-log.ts); this file keeps only what is this plugin's own.
import { LOCK_FN, runAborted, type PluginLogFields } from './plugin-log.ts';

/** The session's own log path: the session id goes before the extension of `logFile`. */
export function sessionLogPath(logFile: string, sessionId: string): string {
  if (sessionId === '') throw new Error('forward-compaction: empty session id; cannot name the log file');
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  const { head, prefix, suffix } = sessionLogParts(logFile);
  return `${head}${prefix}${safe}${suffix}`;
}

/** What goes before and after the session id in a session's log name, by the rule sessionLogPath names it with. */
function sessionLogParts(logFile: string): { head: string; dir: string; prefix: string; suffix: string } {
  const slash = logFile.lastIndexOf('/');
  const head = logFile.slice(0, slash + 1);
  const dir = slash < 0 ? '.' : slash === 0 ? '/' : logFile.slice(0, slash);
  const name = logFile.slice(slash + 1);
  if (name === '.jsonl') return { head, dir, prefix: '', suffix: '.jsonl' };
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { head, dir, prefix: `${name}.`, suffix: '' };
  return { head, dir, prefix: `${name.slice(0, dot)}.`, suffix: name.slice(dot) };
}

/**
 * Where a script whose every path is absolute runs: `/`, never the session's directory, which can be removed under a
 * live session (a worktree deleted while a chat still stands in it) and then fails every spawn with ENOENT. A relative
 * path keeps the session's directory, the one it is relative to.
 */
export function runCwd(...paths: readonly string[]): { cwd?: string } {
  return paths.length > 0 && paths.every((path) => path.startsWith('/')) ? { cwd: '/' } : {};
}

/** A session's decision log moves aside to `.1` past this size, so no one file grows without end. */
export const DECISION_LOG_CAP_BYTES = 8388608;
/** Old sessions' logs beside this one are deleted past this age or past this count, newest kept. */
export const DECISION_LOG_RETENTION = { days: 14, keep: 200 } as const;

/** Appends the rows on stdin to the session's log under its lock, moving a file past the cap aside first; no row is rewritten. */
export const DECISION_APPEND_SCRIPT = `set -eu
umask 077
path=$1; cap=$2
fail() { printf '%s: %s\\n' "$1" "$2" >&2; exit 1; }
${LOCK_FN}
case $path in /*) ;; *) path=./$path;; esac
dir=\${path%/*}
[ -n "$dir" ] || dir=/
mkdir -p "$dir" || fail "$dir" 'cannot create the log directory'
lock "$path.lock"
if [ -f "$path" ]; then
  bytes=$(wc -c < "$path")
  bytes=$((bytes))
  if [ "$bytes" -gt "$cap" ]; then mv -f "$path" "$path.1"; fi
fi
# An append killed mid-row leaves a torn last line; the rows retried after it start on their own line.
if [ -s "$path" ] && [ -n "$(tail -c 1 "$path")" ]; then printf '\\n' >> "$path"; fi
cat >> "$path"`;

/** The append process for one session log; its rows go on stdin, one per line. */
export function decisionAppendArgv(path: string, cap: number = DECISION_LOG_CAP_BYTES): string[] {
  return ['/bin/sh', '-c', DECISION_APPEND_SCRIPT, 'decision-log', path, String(cap)];
}

/** At most this many unwritten decision rows are held for the next flush; past it the oldest go, counted. */
export const DECISION_HOLD_ROWS = 2_000;

/** What a failed append's line says of its rows: kept for the next write unless it is the last one (session end), and the oldest the hold let go. */
export function keptRowsText(rows: number, dropped: number, last: boolean, hold: number = DECISION_HOLD_ROWS): string {
  const kept = last ? '' : `; its ${rows} ${rows === 1 ? 'row is' : 'rows are'} kept and written with the next`;
  const gone = dropped > 0 ? `${last ? ';' : ', and'} the ${dropped} oldest held ${dropped === 1 ? 'row was' : 'rows were'} dropped past the ${hold}-row hold` : '';
  return `${kept}${gone}`;
}

/**
 * A failed decision-log write's line, and its once-per-failure key: numbers dropped, so a failure whose text carries a varying
 * size is said once; the first drop past the hold is told even when its failure already was (the session-end line counts all).
 */
export function decisionFailure(named: string, error: unknown, last: boolean): { line: string; key: string; quiet: boolean } {
  const cause = error instanceof Error ? error.message : String(error);
  const failed = `forward-compaction: writing the decision log for ${named} failed: ${cause}`;
  const kept = error instanceof DecisionWriteError ? keptRowsText(error.rows, error.dropped, last) : '';
  // quiet: an abandoned dispatch's run lost nothing, its rows wait for the next flush; at session end or past the hold they are lost, and said.
  const quiet = !last && runAborted(cause) && !(error instanceof DecisionWriteError && error.dropped > 0);
  return { line: `${failed}${kept}`, key: `${failed}${error instanceof DecisionWriteError && error.dropped > 0 ? ' (hold)' : ''}`.replace(/\d+/g, '#'), quiet };
}

/** The session-end line for the decision rows no append wrote: those still held, and those the hold dropped. */
export function rowsLostLine(i: { path: string; held: number; dropped: number; error: string; hold?: number }): string {
  const n = i.held + i.dropped;
  const gone = i.dropped > 0 ? ` (${i.dropped} of them dropped past the ${i.hold ?? DECISION_HOLD_ROWS}-row hold)` : '';
  return `forward-compaction: ${n} decision ${n === 1 ? 'row was' : 'rows were'} not written to ${i.path}${gone}: ${i.error}`;
}

/**
 * The session-end report: the line for what the end bound cut off, and the rows no append wrote. The held rows are lost
 * only when the bound did not cut the end flush that tried them (else the cut counts them); the hold's drops always are.
 */
export function endReport(i: { timedOut: boolean; boundMs: number; decisionRows: number; levelRows: number; held: number; dropped: number; error: string; path: string; hold?: number }): { cut?: string; lost?: { line: string; rows: number; dropped: number; error: string } } {
  const count = (n: number, log: string) => (n > 0 ? [`${n} ${log} ${n === 1 ? 'row' : 'rows'}`] : []);
  const parts = [...count(i.decisionRows, 'decision'), ...count(i.levelRows, 'level')];
  const cut = i.timedOut ? `forward-compaction: the session-end bound (${i.boundMs} ms) ran out ${parts.length > 0 ? `before the logs were written; ${parts.join(' and ')} may be lost` : 'while the log writes were finishing; no row was in flight'}` : undefined;
  const held = i.timedOut ? 0 : i.held;
  const rows = held + i.dropped;
  const lost = rows > 0 ? { line: rowsLostLine({ path: i.path, held, dropped: i.dropped, error: i.error, hold: i.hold }), rows, dropped: i.dropped, error: i.error } : undefined;
  return { ...(cut !== undefined ? { cut } : {}), ...(lost !== undefined ? { lost } : {}) };
}

const HEX = '[0-9a-fA-F]';
/** Only a name whose session part is a session id's shape is ever deleted: a file beside the log that is not one of its sessions stays. */
const SESSION_ID = [8, 4, 4, 4, 12].map((n) => HEX.repeat(n)).join('-');

/**
 * Deletes the sessions' logs of one logFile past the age, then past the newest count (the session's own among them), never the
 * session's own; each with its `.1`. Only a file whose first line is a decision row is one: another tool's `<uuid>.jsonl` stays.
 * One `find` reads every age, never one per file (a process per file took past 15 s under load); only each file deleted costs an `rm`.
 */
export const RETENTION_SCRIPT = `set -eu
dir=$1; prefix=$2; suffix=$3; days=$4; keep=$5; self=$6
case $dir in /*) ;; *) dir=./$dir;; esac
[ -d "$dir" ] || exit 0
cd "$dir"
named() {
  case $1 in "$prefix"*"$suffix") ;; *) return 1;; esac
  id=\${1#"$prefix"}; id=\${id%"$suffix"}
  case $id in ${SESSION_ID}) ;; *) return 1;; esac
}
file() { [ -f "./$1" ] && ours "$1"; }
ours() { IFS= read -r first < "./$1" || return 1; case $first in '{"ts":"'*'","event":"'*) ;; *) return 1;; esac; }
# One find lists every entry past the age, a symlink by its own; old() looks a name up in it, so no process runs per file.
# An entry another session removes mid-listing makes find exit 1: the names it printed stand, the rest read as not old.
nl='
'
olds=$(find . -maxdepth 1 -mmin +$((days * 1440)) -print) || :
old() { case "$nl$olds$nl" in *"$nl./$1$nl"*) return 0;; esac; return 1; }
kept=1
ls -t . | while IFS= read -r name; do
  [ "$name" != "$self" ] && named "$name" && file "$name" || continue
  if [ "$kept" -lt "$keep" ] && ! old "$name"; then kept=$((kept + 1)); continue; fi
  rm -f "./$name" "./$name.1"
done
# A rotated half whose session file is gone goes by its own age.
ls . | while IFS= read -r name; do
  case $name in *.1) ;; *) continue;; esac
  base=\${name%.1}
  [ "$base" != "$self" ] && named "$base" && [ ! -e "./$base" ] && file "$name" || continue
  if old "$name"; then rm -f "./$name"; fi
done`;

/** The retention process for `logFile`'s sessions, sparing the session's own `sessionPath`. */
export function retentionArgv(logFile: string, sessionPath: string, policy: { days: number; keep: number } = DECISION_LOG_RETENTION): string[] {
  const { dir, prefix, suffix } = sessionLogParts(logFile);
  return ['/bin/sh', '-c', RETENTION_SCRIPT, 'decision-retention', dir, prefix, suffix, String(policy.days), String(policy.keep), sessionPath.slice(sessionPath.lastIndexOf('/') + 1)];
}

type DecisionRow = Record<string, unknown>;
type SkipStreak = { party: unknown; trigger: unknown; count: number; from?: unknown; to?: unknown; firstTokens?: unknown; lastTokens?: unknown };

/**
 * Skips fold (C2, C9): a party whose compaction is held on every request writes the first `compact` skip row of a
 * streak and counts the rest, closed as one `skips` row at the party's next compaction decision, every
 * `every` folded skips, and at session end. Every other row passes as it came.
 */
export class SkipFold {
  private readonly open = new Map<string, SkipStreak>();
  constructor(private readonly every = 100) {}

  /** The rows to write for `row` (stamped with its `ts`), in order. */
  add(row: DecisionRow): DecisionRow[] {
    if (row.event !== 'compact') return [row];
    const owner = String(row.party);
    if (row.decision !== 'skip') return [...this.close(owner), row];
    const key = `${owner}\u0000${String(row.trigger)}`;
    const streak = this.open.get(key);
    if (streak === undefined) {
      this.open.set(key, { party: row.party, trigger: row.trigger, count: 0 });
      return [row];
    }
    if (streak.count === 0) { streak.from = row.ts; streak.firstTokens = row.tokens; }
    streak.count++;
    streak.to = row.ts;
    streak.lastTokens = row.tokens;
    if (streak.count < this.every) return [];
    const out = summary(streak);
    streak.count = 0;
    return [out];
  }

  /** Every open streak's `skips` row: the session is ending. */
  drain(): DecisionRow[] {
    const out = [...this.open.values()].filter((streak) => streak.count > 0).map(summary);
    this.open.clear();
    return out;
  }

  private close(owner: string): DecisionRow[] {
    const out: DecisionRow[] = [];
    for (const [key, streak] of this.open) {
      if (!key.startsWith(`${owner}\u0000`)) continue;
      if (streak.count > 0) out.push(summary(streak));
      this.open.delete(key);
    }
    return out;
  }
}

function summary(streak: SkipStreak): DecisionRow {
  return { ts: streak.to, event: 'skips', party: streak.party, trigger: streak.trigger, count: streak.count, from: streak.from, to: streak.to, firstTokens: streak.firstTokens, lastTokens: streak.lastTokens };
}

/** Unexpected API values are reported by shape, never by their transcript bodies. */
export function pluginLogDiagnostic(text: string): string {
  return text.replace(/transcript: unreadable \([\[{"][\s\S]*\)/, 'transcript: unreadable (unexpected API shape)')
    .replace(/messages: [\[{"][\s\S]*?(?=; its install is unchecked|$)/, 'messages: unexpected API shape');
}

/** Decision rows that are never level rows: `say` writes its own line, and a plugin-log failure would recurse into the failing log. */
const NO_LEVEL_ROW = ['said', 'plugin-log-failed'];

/** Every decision event enters the level files, errors and warnings at their levels and the rest at info; never a whole decision or tool input. */
export function pluginLogEvent(row: Record<string, unknown>): Omit<PluginLogFields, 'plugin' | 'session'> | undefined {
  row = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'string' ? pluginLogDiagnostic(value) : value]));
  let event = String(row.event);
  if (NO_LEVEL_ROW.includes(event)) return undefined;
  if (event === 'compact' && row.decision === 'error') event = 'compact-error';
  const errors = ['option-error', 'tool-register-failed', 'look-back-manual-error', 'compact-error', 'turn-end-rejected'];
  const warnings = ['decision-retention-failed', 'unseen-compaction', 'compact-window', 'ceiling-below-ask'];
  const level = errors.includes(event) ? 'error' : warnings.includes(event) ? 'warning' : 'info';
  const detail: Record<string, unknown> = {};
  for (const key of ['party', 'type', 'tool', 'tries', 'seq', 'why', 'tokens', 'chars', 'files', 'before', 'after', 'held', 'error', 'problem', 'dir', 'level', 'decision', 'trigger', 'count', 'from', 'to', 'firstTokens', 'lastTokens', 'label', 'model', 'judged', 'matched']) {
    const value = row[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) detail[key] = value;
  }
  const skips = event === 'skips' && typeof row.count === 'number' ? `${row.count} more held compaction asks folded` : undefined;
  const msg = [row.line, row.error, row.problem, row.detail, skips, row.reason, row.why].find((value) => typeof value === 'string');
  return { level, event, msg: typeof msg === 'string' ? msg : event.replace(/-/g, ' '), where: `hooks/forward-compaction.ts#${typeof row.where === 'string' ? row.where : 'record'}`, detail, ...(event === 'skips' && typeof row.ts === 'string' ? { ts: row.ts } : {}) };
}

/** The debug row of a hook entry: the hook, the party its `agentId` names, and the trigger, model and tool the event carries (null where none). */
export function hookRow(hook: string, e: unknown): Record<string, unknown> {
  const ev = (e !== null && typeof e === 'object' ? e : {}) as Record<string, unknown>;
  const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
  return { hook, party: text(ev.agentId) === null ? 'main' : `agent:${ev.agentId as string}`, trigger: text(ev.trigger), model: text(ev.model), tool: text(ev.tool) };
}

/** A failed decision-log append whose rows went back to the queue: how many, and how many old ones the hold let go. */
export class DecisionWriteError extends Error {
  constructor(cause: string, readonly rows: number, readonly dropped: number) { super(cause); }
}
