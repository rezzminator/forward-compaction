// The decision log: one JSONL file per session, appended to on every write.
// Chats share the configured logFile option, so each session writes its own
// file beside it; a resumed session appends to the rows it wrote before.

/** The session's own log path: the session id goes before the extension of `logFile`. */
export function sessionLogPath(logFile: string, sessionId: string): string {
  if (sessionId === '') throw new Error('sub-agent-compact: empty session id; cannot name the log file');
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  const slash = logFile.lastIndexOf('/');
  const dir = logFile.slice(0, slash + 1);
  const name = logFile.slice(slash + 1);
  if (name === '.jsonl') return `${dir}${safe}.jsonl`;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${dir}${name}.${safe}`;
  return `${dir}${name.slice(0, dot)}.${safe}${name.slice(dot)}`;
}

/** The file's rows followed by `rows`, blank lines dropped, the newest `cap` kept. */
export function appendRows(existing: string, rows: string[], cap: number): string {
  const all = [...existing.split('\n').filter((line) => line.trim() !== ''), ...rows];
  return all.slice(-cap).join('\n') + '\n';
}

export type PluginLogLevel = 'error' | 'warning' | 'info';
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
case "$dir" in -*) dir=./$dir;; esac
fail() { printf '%s: %s\\n' "$1" "$2" >&2; exit 1; }
[ ! -L "$dir" ] || fail "$dir" 'refusing log directory symlink'
mkdir -p -- "$dir"
[ -w "$dir" ] || fail "$dir" 'log directory is not writable'
chmod 700 "$dir"
for name in errors.jsonl warnings.jsonl info.jsonl; do
  for owned in "$dir/$name" "$dir/$name.1"; do
    [ ! -L "$owned" ] || fail "$owned" 'refusing level file symlink'
    if [ -e "$owned" ]; then
      [ -r "$owned" ] && [ -w "$owned" ] || fail "$owned" 'level file is not readable and writable'
      chmod 600 "$owned"
    fi
  done
done
cap() {
  if [ -f "$1" ]; then
    bytes=$(wc -c < "$1") || exit 1
    if [ "$bytes" -gt ${PLUGIN_LOG_CAP_BYTES} ]; then mv -f -- "$1" "$1.1" || exit 1; return 0; fi
  fi
  return 1
}
capped() {
  msg='level file exceeded ${PLUGIN_LOG_CAP_BYTES} bytes; moved aside'
  detail=$(printf '{"file":"%s"}' "$1")
  truncated=false
  while :; do
    notice=$(printf '{"ts":"%s","plugin":"%s","level":"warning","event":"log-capped","msg":"%s","where":"src/log.ts#APPEND_SCRIPT"%s,"detail":%s}' "$ts" "$plugin" "$msg" "$session" "$detail")
    bytes=$(printf '%s\\n' "$notice" | wc -c) || exit 1
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
  if (event === 'session.compact') event = row.why === 'error' ? 'compact-error' : row.why === 'handoff-waits' ? 'handoff-waits-skipped' : row.why === 'haiku-hold' ? 'haiku-hold' : event;
  if (event === 'turn.complete' && row.error !== undefined) event = 'turn-complete-error';
  const errors = ['tool-register-failed', 'look-back-manual-error', 'brief-error', 'compact-error', 'turn-complete-error', 'hook-threw'];
  const warnings = ['warning', 'option-error', 'resolve-error', 'handoff-invalid', 'forward-invalid', 'forward-unchecked', 'handoff-fallback', 'compact-unseen', 'handoff-waits-skipped', 'haiku-hold'];
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
