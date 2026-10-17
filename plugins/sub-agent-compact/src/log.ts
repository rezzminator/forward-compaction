// The decision log: one JSONL file per session, appended to on every write.
// Chats share the configured logFile option, so each session writes its own
// file beside it; a resumed session appends to the rows it wrote before.

/** The session's own log path: the session id goes before the extension of `logFile`. */
export function sessionLogPath(logFile: string, sessionId: string): string {
  if (sessionId === '') throw new Error('sub-agent-compact: empty session id; cannot name the log file');
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

/** A session's decision log moves aside to `.1` past this size, so no one file grows without end. */
export const DECISION_LOG_CAP_BYTES = 8388608;
/** Old sessions' logs beside this one are deleted past this age or past this count, newest kept. */
export const DECISION_LOG_RETENTION = { days: 14, keep: 200 } as const;

/**
 * A directory lock born with its holder's token (`pid epoch`) in `$lock/pid`: staged under a private name and
 * renamed into place, so the lock never exists without its token. A lock whose holder is gone, or whose token is
 * older than a minute (no append takes that long), is broken; a live one is waited on for about five seconds.
 * Breaking and releasing first claim the token by renaming `$lock/pid` to a private name: only one mover wins that
 * rename, and the claimer removes the lock only when the token it took is the one it saw stale (or its own), so no
 * waiter removes a lock another has since broken and taken, and a holder outlived by an age break never removes its
 * successor's lock.
 */
const LOCK_FN = `lk_claim() {
  lk_c="$lk_lock/pid.claim.$$"
  mv "$lk_lock/pid" "$lk_c" 2>/dev/null || return 1
  if [ "$(cat "$lk_c" 2>/dev/null)" = "$1" ]; then
    lk_gone="$lk_lock.dead.$$"
    rm -rf "$lk_gone"
    mv "$lk_lock" "$lk_gone" 2>/dev/null || return 1
    rm -rf "$lk_gone" 2>/dev/null || :
    return 0
  fi
  mv "$lk_c" "$lk_lock/pid" 2>/dev/null || :
  return 1
}
lock() {
  lk_lock=$1; tries=0
  lk_token="$$ $(date +%s)"
  lk_stage="$lk_lock.$$"
  while :; do
    rm -rf "$lk_stage"
    mkdir "$lk_stage" || fail "$lk_stage" 'cannot create the lock directory'
    printf '%s\\n' "$lk_token" > "$lk_stage/pid"
    if [ ! -e "$lk_lock" ] && mv "$lk_stage" "$lk_lock" 2>/dev/null && [ "$(cat "$lk_lock/pid" 2>/dev/null)" = "$lk_token" ]; then break; fi
    # mv onto a lock that appeared meanwhile moves the stage into it.
    rm -rf "$lk_stage" "$lk_lock/\${lk_stage##*/}"
    tries=$((tries + 1))
    [ "$tries" -le 100 ] || fail "$lk_lock" 'lock held by another writer'
    holder=$(cat "$lk_lock/pid" 2>/dev/null) || holder=
    if [ -n "$holder" ] && { ! kill -0 "\${holder%% *}" 2>/dev/null || [ -n "$(find "$lk_lock/pid" -mmin +1 2>/dev/null)" ]; }; then
      lk_claim "$holder" || :
      continue
    fi
    sleep 0.05
  done
  trap 'lk_claim "$lk_token" || :' EXIT
  trap 'exit 1' HUP INT TERM
}`;

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

/** A failed append's batch goes back to the front of the queue, order kept, for the next flush; past the hold the oldest go. Returns how many went. */
export function requeueRows(pending: string[], rows: readonly string[], hold: number = DECISION_HOLD_ROWS): number {
  pending.unshift(...rows);
  const dropped = Math.max(0, pending.length - hold);
  if (dropped > 0) pending.splice(0, dropped);
  return dropped;
}

/** What a failed append's line says of its rows: kept for the next write unless it is the last one (session end), and the oldest the hold let go. */
export function keptRowsText(rows: number, dropped: number, last: boolean, hold: number = DECISION_HOLD_ROWS): string {
  const kept = last ? '' : `; its ${rows} ${rows === 1 ? 'row is' : 'rows are'} kept and written with the next`;
  const gone = dropped > 0 ? `${last ? ';' : ', and'} the ${dropped} oldest held ${dropped === 1 ? 'row was' : 'rows were'} dropped past the ${hold}-row hold` : '';
  return `${kept}${gone}`;
}

/** The session-end line for the decision rows no append wrote: those still held, and those the hold dropped. */
export function rowsLostLine(i: { path: string; held: number; dropped: number; error: string; hold?: number }): string {
  const n = i.held + i.dropped;
  const gone = i.dropped > 0 ? ` (${i.dropped} of them dropped past the ${i.hold ?? DECISION_HOLD_ROWS}-row hold)` : '';
  return `sub-agent-compact: ${n} decision ${n === 1 ? 'row was' : 'rows were'} not written to ${i.path}${gone}: ${i.error}`;
}

/**
 * The session-end report: the line for what the end bound cut off, and the rows no append wrote. The held rows are lost
 * only when the bound did not cut the end flush that tried them (else the cut counts them); the hold's drops always are.
 */
export function endReport(i: { timedOut: boolean; boundMs: number; decisionRows: number; levelRows: number; held: number; dropped: number; error: string; path: string; hold?: number }): { cut?: string; lost?: { line: string; rows: number; dropped: number; error: string } } {
  const count = (n: number, log: string) => (n > 0 ? [`${n} ${log} ${n === 1 ? 'row' : 'rows'}`] : []);
  const parts = [...count(i.decisionRows, 'decision'), ...count(i.levelRows, 'level')];
  const cut = i.timedOut ? `sub-agent-compact: the session-end bound (${i.boundMs} ms) ran out ${parts.length > 0 ? `before the logs were written; ${parts.join(' and ')} may be lost` : 'while the log writes were finishing; no row was in flight'}` : undefined;
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
type SkipStreak = { party: unknown; agentId: unknown; type: unknown; trigger: unknown; count: number; from?: unknown; to?: unknown; firstTokens?: unknown; lastTokens?: unknown; limit?: unknown };

/**
 * Routine skips fold: a party asked to compact below its point on every request writes the first skip of a
 * streak and counts the rest, closed as one `skips` row at the party's next compaction decision, every
 * `every` folded skips, and at session end. Every other row passes as it came.
 */
export class SkipFold {
  private readonly open = new Map<string, SkipStreak>();
  constructor(private readonly every = 100) {}

  /** The rows to write for `row` (stamped with its `ts`), in order. */
  add(row: DecisionRow): DecisionRow[] {
    if (row.event !== 'session.compact') return [row];
    const owner = String(row.agentId ?? 'main');
    if (row.decision !== 'skip' || row.why !== undefined) return [...this.close(owner), row];
    const key = `${owner}\u0000${String(row.trigger)}`;
    const streak = this.open.get(key);
    if (streak === undefined) {
      this.open.set(key, { party: row.party, agentId: row.agentId, type: row.type, trigger: row.trigger, count: 0 });
      return [row];
    }
    if (streak.count === 0) { streak.from = row.ts; streak.firstTokens = row.tokens; }
    streak.count++;
    streak.to = row.ts;
    streak.lastTokens = row.tokens;
    streak.limit = row.limit;
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
  return { ts: streak.to, event: 'skips', party: streak.party, agentId: streak.agentId, type: streak.type, trigger: streak.trigger, count: streak.count, from: streak.from, to: streak.to, firstTokens: streak.firstTokens, lastTokens: streak.lastTokens, limit: streak.limit };
}

export type PluginLogLevel = 'error' | 'warning' | 'info';

/** Errors always show; warnings and info show only when logging is unavailable or failing. */
export function noticeOnScreen({ level, decisionLog, pluginLog, logOff }: { level: PluginLogLevel; decisionLog: boolean; pluginLog: boolean; logOff?: boolean }): boolean {
  return level === 'error' || logOff === true || (!decisionLog && !pluginLog);
}
export type PluginLogFields = { plugin: string; level: PluginLogLevel; event: string; msg: string; where: string; session?: string; detail?: Record<string, unknown> };
export const PLUGIN_LOG_CAP_BYTES = 20971520;
export const ROW_MAX_BYTES = 4096;

/** Resolve the level directory without changing the decision-log option. */
export function pluginLogDir(override: string | undefined, home: string | undefined, plugin: string): string | undefined {
  const base = override || (home ? `${home.replace(/\/+$/, '')}/.local/state` : undefined);
  return base === undefined ? undefined : `${base.replace(/\/+$/, '')}/${plugin}${override ? '' : '/logs'}`;
}

/** Byte count in UTF-8, available in the function-hook sandbox without Node. */
function pluginLogBytes(text: string): number {
  let bytes = 0;
  for (const char of text) { const point = char.codePointAt(0)!; bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4; }
  return bytes;
}

/** Unexpected API values are reported by shape, never by their transcript bodies. */
function pluginLogDiagnostic(text: string): string {
  return text.replace(/transcript: unreadable \([\[{"][\s\S]*\)/, 'transcript: unreadable (unexpected API shape)')
    .replace(/messages: [\[{"][\s\S]*?(?=; its install is unchecked|$)/, 'messages: unexpected API shape');
}

/** Format the supplied epoch only; the adapter owns the clock. */
function pluginLogTimestamp(nowMs: number): string {
  if (!Number.isFinite(nowMs) || Math.abs(nowMs) > 8640000000000000) throw new RangeError('invalid plugin log timestamp');
  const epoch = Math.trunc(nowMs);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    calendar: 'gregory', numberingSystem: 'latn', timeZone: 'UTC', hourCycle: 'h23',
    era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(epoch).map(({ type, value }) => [type, value]));
  const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year);
  const isoYear = year >= 0 && year <= 9999 ? String(year).padStart(4, '0') : `${year < 0 ? '-' : '+'}${String(Math.abs(year)).padStart(6, '0')}`;
  const ms = String(((epoch % 1000) + 1000) % 1000).padStart(3, '0');
  return `${isoYear}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${ms}Z`;
}

/** Ordered JSONL, bounded after serialization (including escapes and newline). */
export function levelRow(fields: PluginLogFields, nowMs: number): string {
  const row: PluginLogFields & { ts: string } = { ts: pluginLogTimestamp(nowMs), plugin: fields.plugin, level: fields.level, event: fields.event, msg: pluginLogDiagnostic(fields.msg), where: fields.where, ...(fields.session ? { session: fields.session } : {}), ...(fields.detail !== undefined ? { detail: fields.detail } : {}) };
  const serialize = () => `${JSON.stringify(row)}\n`;
  let text = serialize();
  const bytes = pluginLogBytes(text);
  if (bytes <= ROW_MAX_BYTES) return text;
  row.detail = { truncated: true, bytes };
  const chars = Array.from(row.msg);
  let low = 0; let high = chars.length;
  while (low < high) {
    const at = Math.ceil((low + high) / 2);
    row.msg = chars.slice(0, at).join('');
    if (pluginLogBytes(serialize()) <= ROW_MAX_BYTES) low = at; else high = at - 1;
  }
  row.msg = chars.slice(0, low).join('');
  text = serialize();
  if (pluginLogBytes(text) > ROW_MAX_BYTES) throw new Error('plugin log row metadata exceeds 4096 bytes');
  return text;
}

/** Positional arguments only; each builtin printf appends one complete row. */
export const APPEND_SCRIPT = `set -eu
umask 077
dir=$1; plugin=$2; shift 2
fail() { printf '%s: %s\\n' "$1" "$2" >&2; exit 1; }
# No operand starts with '-': a relative directory is passed as ./dir, so no command reads it as an option.
case $dir in /*) ;; *) dir=./$dir;; esac
mkdir -p "$dir" || fail "$dir" 'cannot create the log directory'
${LOCK_FN}
# Cap, rotation and append happen under one lock: two writers never both move a full file aside.
lock "$dir/.lock"
cap() {
  if [ -f "$1" ]; then
    bytes=$(wc -c < "$1") || exit 1
    bytes=$((bytes))
    if [ "$bytes" -gt ${PLUGIN_LOG_CAP_BYTES} ]; then mv -f "$1" "$1.1" || exit 1; return 0; fi
  fi
  return 1
}
capped() {
  msg='level file exceeded ${PLUGIN_LOG_CAP_BYTES} bytes; moved aside'
  detail=$(printf '{"file":"%s"}' "$1")
  truncated=false
  while :; do
    notice=$(printf '{"ts":"%s","plugin":"%s","level":"warning","event":"log-capped","msg":"%s","where":"src/log.ts#APPEND_SCRIPT"%s,"detail":%s}' "$ts" "$plugin" "$msg" "$session" "$detail")
    # BSD wc pads its count with spaces, which would land in the row: arithmetic expansion drops them.
    bytes=$(printf '%s\\n' "$notice" | wc -c) || exit 1
    bytes=$((bytes))
    [ "$bytes" -gt ${ROW_MAX_BYTES} ] || break
    if [ "$truncated" = false ]; then
      detail=$(printf '{"truncated":true,"bytes":%s}' "$bytes"); truncated=true
    else
      [ -n "$msg" ] || fail "$dir/warnings.jsonl" 'cap warning metadata exceeds ${ROW_MAX_BYTES} bytes'
      msg=\${msg%?}
    fi
  done
  printf '%s\\n' "$notice" >> "$dir/warnings.jsonl"
}
while [ "$#" -gt 0 ]; do
  file=$1; row=$2; shift 2
  case "$file" in errors.jsonl|warnings.jsonl|info.jsonl) ;; *) printf '%s: invalid level file: %s\\n' "$dir" "$file" >&2; exit 2;; esac
  ts=\${row#*\\"ts\\":\\"}; ts=\${ts%%\\"*}
  header=\${row%?}; header=\${header%?}; header=\${header%%,\\"detail\\":*}
  case "$header" in *',"session":'*) session=',"session":'\${header##*,\\"session\\":};; *) session=;; esac
  path=$dir/$file
  if cap "$path"; then
    if [ "$file" != warnings.jsonl ] && cap "$dir/warnings.jsonl"; then capped warnings.jsonl; fi
    capped "$file"
  fi
  printf '%s' "$row" >> "$path"
done`;

/** One process receives at most 64 file/row pairs. */
export function appendArgv(dir: string, plugin: string, rows: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let at = 0; at < rows.length; at += 64) {
    const pairs = rows.slice(at, at + 64).flatMap((row) => {
      const level: unknown = JSON.parse(row).level;
      const file = level === 'error' ? 'errors.jsonl' : level === 'warning' ? 'warnings.jsonl' : level === 'info' ? 'info.jsonl' : undefined;
      if (file === undefined) throw new Error(`plugin log invalid level: ${String(level)}`);
      return [file, row];
    });
    batches.push(['/bin/sh', '-c', APPEND_SCRIPT, 'plugin-log', dir, plugin, ...pairs]);
  }
  return batches;
}

type PluginLogRun = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
export type FlushResult = { dropped: number; error?: string };

/** Serialized append batches; a success rearms the once-per-failing-streak notice. */
export class PluginLogQueue {
  private rows: string[] = [];
  private writing: Promise<unknown> = Promise.resolve();
  private failing = false;
  constructor(private readonly dir: string, private readonly plugin: string) {}
  add(row: string): void { this.rows.push(row); }
  flush(run: PluginLogRun): Promise<FlushResult> {
    const rows = this.rows.splice(0);
    const pending = this.writing.then(async (): Promise<FlushResult> => {
      if (rows.length === 0) return { dropped: 0 };
      let written = 0;
      try {
        for (const argv of appendArgv(this.dir, this.plugin, rows)) {
          const out = await run(argv);
          if (out.exitCode !== 0) throw new Error(out.stderr.split('\n')[0]?.trim() || `exit ${out.exitCode}`);
          written += (argv.length - 6) / 2;
          this.failing = false;
        }
        return { dropped: 0 };
      } catch (error) {
        const report = !this.failing;
        this.failing = true;
        return { dropped: rows.length - written, ...(report ? { error: error instanceof Error ? error.message : String(error) } : {}) };
      }
    });
    this.writing = pending;
    return pending;
  }
}

/** Only diagnostics enter the level files; never copy a whole decision or tool input. */
export function pluginLogEvent(row: Record<string, unknown>): Omit<PluginLogFields, 'plugin' | 'session'> | undefined {
  row = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'string' ? pluginLogDiagnostic(value) : value]));
  let event = String(row.event);
  if (event === 'session.compact') event = row.why === 'error' ? 'compact-error' : row.why === 'handoff-waits' ? 'handoff-waits-skipped' : event;
  if (event === 'turn.complete' && row.error !== undefined) event = 'turn-complete-error';
  const errors = ['error', 'brief-error', 'option-error', 'forward-unchecked', 'handoff-fallback', 'tool-register-failed', 'look-back-manual-error', 'compact-error', 'turn-complete-error', 'hook-threw'];
  const warnings = ['warning', 'decision-retention-failed', 'resolve-error', 'handoff-invalid', 'forward-invalid', 'compact-unseen', 'handoff-waits-skipped'];
  const infos = ['handoff-refused', 'arm-refused', 'forward-refused', 'stop-refused'];
  const level = errors.includes(event) ? 'error' : warnings.includes(event) ? 'warning' : infos.includes(event) ? 'info' : undefined;
  if (level === undefined) return undefined;
  const detail: Record<string, unknown> = {};
  for (const key of ['party', 'type', 'tool', 'tries', 'seq', 'why', 'tokens', 'chars', 'before', 'after', 'held', 'error', 'problem', 'dir']) {
    const value = row[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) detail[key] = value;
  }
  const msg = [row.line, row.error, row.problem, row.detail, row.why].find((value) => typeof value === 'string');
  return { level, event, msg: typeof msg === 'string' ? msg : event.replace(/-/g, ' '), where: 'hooks/sub-agent-compact.ts#record', detail };
}
