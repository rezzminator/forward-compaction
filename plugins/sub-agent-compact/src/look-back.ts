// Recovery is bounded to one party's pre-compaction prefix. Only the adapter does I/O.
export const LOOK_BACK_TOOL = 'look_back';
export const LOOK_BACK_DESCRIPTION = 'Recover an exact detail — when you need an error text, code snippet, value, or what the user said from before your latest compaction. Searches only your own transcript’s part you no longer hold. Each call tells the person what was missed. Returns numbered snippets or a whole entry; failures say why, no matches suggests other words. Example: {why:"lost error",query:"connection refused"}.';
export const LOOK_BACK_HINT = 'Need an exact detail from before this handoff? look_back finds it.';
export const LOOK_BACK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    why: { type: 'string', description: 'What compaction lost that you need; trimmed to 120 characters, longer marked [cut].' },
    query: { type: 'string', description: 'All words must appear, case-insensitive, in one entry. Double quotes keep a phrase whole.' },
    entry: { type: 'integer', minimum: 1, description: 'Line number from a look_back result to fetch whole, before the latest compaction.' },
  },
  required: ['why'], anyOf: [{ required: ['query'] }, { required: ['entry'] }], additionalProperties: false,
};
export type LookBackArgs = { why: string; query?: string; entry?: number; terms: string[]; error?: string };
export type LookBackResult = { text: string; hits?: number; error?: string };
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
export function parseLookBack(input: Record<string, unknown>): LookBackArgs {
  let why = typeof input.why === 'string' ? oneLine(input.why) : '';
  if (why.length > 120) why = why.slice(0, 115) + '[cut]';
  const args: LookBackArgs = { why: why || '[missing why]', terms: [] };
  if (typeof input.query === 'string') args.query = input.query.trim();
  if (typeof input.entry === 'number') args.entry = input.entry;
  const bad = Object.keys(input).find((key) => !['why', 'query', 'entry'].includes(key));
  if (bad) args.error = `unknown argument ${bad}`;
  else if (!why) args.error = 'why is required and must be a nonempty string';
  else if (input.entry !== undefined && (!Number.isSafeInteger(input.entry) || Number(input.entry) < 1)) args.error = 'entry must be a positive integer';
  else if (input.query !== undefined && typeof input.query !== 'string') args.error = 'query must be a string';
  else if (args.entry === undefined) {
    if (args.query === undefined) args.error = 'query or entry is required';
    else {
      // A newline inside a phrase would turn grep -e into OR patterns; refuse it.
      const pieces = args.query.match(/"[^"\r\n]*"|[^\s"]+/g) ?? [];
      if ((args.query.match(/"/g)?.length ?? 0) % 2 !== 0) args.error = 'query has an unclosed quote';
      else if (args.query.includes('\0') || /"[^"\n]*[\r\n]/.test(args.query)) args.error = 'query terms must not contain NUL or newlines';
      else args.terms = pieces.map((s) => s.startsWith('"') ? s.slice(1, -1) : s).filter(Boolean);
      if (!args.error && args.terms.length === 0) args.error = 'query must contain at least one word or quoted phrase';
    }
  }
  return args;
}

const COMPLETE = '\n[look-back-complete]\n';
const finish = `; printf '\\n[look-back-complete]\\n'`;
// POSIX pipelines lose upstream status. Report each failure even without stderr;
// grep's rc=1 alone means no matches, not an error.
const checked = `checked() { empty="$1"; shift; "$@"; rc=$?; if [ "$rc" -ne 0 ] && ! { [ "$empty" = 1 ] && [ "$rc" -eq 1 ]; }; then printf 'look-back subprocess failed (exit %s): %s\\n' "$rc" "$*" >&2; return "$rc"; fi; }; `;
const prefix = 'checked 0 sed -n "1,$(($2 - 1))p" "$1"';
/** The script contains only fixed code and argument indexes; values stay in argv. */
export function searchArgv(file: string, boundary: number, terms: readonly string[]): string[] {
  const filters = terms.map((_, i) => `checked 1 grep -a ${i === 0 ? '-n ' : ''}-i -F -e "\${${i + 3}}"`);
  return ['sh', '-c', `${checked}${prefix} | ${filters.join(' | ')} | checked 0 tail -n 200${finish}`, 'sh', file, String(boundary), ...terms];
}
// Filter candidate lines while streaming: nested tool input is not a boundary.
// Track JSON depth outside strings; escaped quotes/braces must not change it.
const topLevelBoundary = String.raw`checked 0 awk '
  {
    depth = 0; quoted = 0; escaped = 0
    for (i = 1; i <= length($0); i++) {
      c = substr($0, i, 1)
      if (quoted) {
        if (escaped) escaped = 0
        else if (c == "\\") escaped = 1
        else if (c == "\"") quoted = 0
      } else {
        if (depth == 1 && substr($0, i) ~ /^"subtype":"compact_boundary"/) { print; break }
        if (c == "\"") quoted = 1
        else if (c == "{" || c == "[") depth++
        else if (c == "}" || c == "]") depth--
      }
    }
  }'`;
export function boundaryArgv(file: string): string[] {
  return ['sh', '-c', `${checked}checked 1 grep -a -n '"subtype":"compact_boundary"' "$1" | ${topLevelBoundary} | checked 0 tail -n 1${finish}`, 'sh', file];
}
export function entryArgv(file: string, entry: number): string[] {
  return ['sh', '-c', `${checked}checked 0 sed -n "\${2}{s/^/\${2}:/;p;q;}" "$1"${finish}`, 'sh', file, String(entry)];
}
export function namesArgv(file: string, boundary: number, ids: readonly string[]): string[] {
  if (ids.some((id) => /[\r\n\0]/.test(id))) throw new Error('tool result id contains NUL or newline');
  const filters = ids.map((_, i) => `-e "\${${i + 3}}"`).join(' ');
  return ['sh', '-c', `${checked}${prefix} | checked 1 grep -a -n '"tool_use"' | checked 1 grep -a -F ${filters} | checked 0 tail -n 200${finish}`, 'sh', file, String(boundary), ...ids];
}
export function processOutput(out: { exitCode: number; stdout: string; stderr: string }, stage: string, framed = false): string {
  // POSIX sh reports tail's status, not upstream grep/sed: stderr is also a failure.
  if (out.exitCode !== 0 || out.stderr.trim()) throw new Error(`${stage}: ${out.stderr.trim() || `exit ${out.exitCode}`}`);
  if (!framed) return out.stdout;
  if (!out.stdout.endsWith(COMPLETE)) throw new Error(`${stage}: missing completion marker; output may be truncated`);
  return out.stdout.slice(0, -COMPLETE.length);
}
export function boundaryLine(stdout: string): number | undefined {
  for (const line of stdout.trim().split('\n').reverse()) {
    if (!line) continue;
    const match = line.match(/^(\d+):([\s\S]*)$/);
    const n = Number(match?.[1]);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('invalid compaction boundary output');
    let data: unknown;
    try { data = JSON.parse(match![2]!); }
    catch { throw new Error('invalid compaction boundary JSON'); }
    if (object(data)?.subtype === 'compact_boundary') return n;
  }
  return undefined;
}

type ToolUse = { id: string; name: string };
export type LookBackEntry = { line: number; time: string; kind: string; text: string; uses: ToolUse[]; results: string[]; warnings: string[] };
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
function readable(content: unknown, uses: ToolUse[], results: string[], warnings: string[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) { warnings.push('unsupported content shape'); return '[unsupported content shape]'; }
  return content.flatMap((value) => {
    const b = object(value);
    if (!b) { warnings.push('unsupported content block'); return ['[unsupported content block]']; }
    if (b.type === 'thinking' || b.type === 'redacted_thinking') return [];
    if (b.type === 'text' && typeof b.text === 'string') return [b.text];
    if (b.type === 'tool_use') {
      const name = typeof b.name === 'string' ? b.name : '[unknown tool]';
      if (typeof b.id === 'string') uses.push({ id: b.id, name });
      return [`${name} ${JSON.stringify(b.input ?? {})}`];
    }
    if (b.type === 'tool_result') {
      if (typeof b.tool_use_id === 'string') results.push(b.tool_use_id);
      else { results.push('[missing id]'); warnings.push('tool result has no tool_use_id'); }
      return [readable(b.content, uses, [], warnings)];
    }
    const kind = typeof b.type === 'string' ? b.type : 'unknown';
    const note = kind === 'image' ? 'image block' : `unsupported ${kind} block`;
    warnings.push(note); return [`[${note}]`];
  }).join('\n');
}
export function parseEntries(stdout: string): LookBackEntry[] {
  return stdout.split('\n').filter(Boolean).map((line) => {
    const m = line.match(/^(\d+):([\s\S]*)$/);
    if (!m || !Number.isSafeInteger(Number(m[1])) || Number(m[1]) < 1) throw new Error('invalid numbered transcript output');
    const e: LookBackEntry = { line: Number(m[1]), time: 'unknown time', kind: 'raw', text: m[2]!, uses: [], results: [], warnings: [] };
    let data: unknown;
    try { data = JSON.parse(m[2]!); }
    catch { return e; } // Malformed JSON is deliberately readable raw text (R4).
    const r = object(data);
    const msg = object(r?.message);
    const role = r?.type ?? msg?.role;
    if (typeof r?.timestamp === 'string' && Number.isFinite(Date.parse(r.timestamp))) e.time = new Date(r.timestamp).toISOString().slice(0, 16).replace('T', ' ');
    if (!msg || !['user', 'assistant'].includes(String(role))) {
      e.kind = 'unknown'; e.text = `[unsupported entry type ${String(role)}]`; e.warnings.push(e.text.slice(1, -1)); return e;
    }
    e.kind = String(role);
    e.text = readable(msg.content, e.uses, e.results, e.warnings);
    if (e.uses.length) e.kind = `tool ${e.uses.map((u) => u.name).join(', ')}`;
    return e;
  });
}
export function toolNames(entries: readonly LookBackEntry[]): Record<string, string> {
  return Object.fromEntries(entries.flatMap((e) => e.uses.map((u) => [u.id, u.name])));
}
export function resultIds(entries: readonly LookBackEntry[]): string[] {
  return [...new Set(entries.flatMap((e) => e.results))];
}
function header(e: LookBackEntry, names: Record<string, string>): string {
  const kind = e.results.length ? `result of ${e.results.map((id) => Object.hasOwn(names, id) ? names[id] : `unknown tool ${id}`).join(', ')}` : e.kind;
  return `#${e.line}  ${e.time}  ${oneLine(kind)}`;
}
export function snippet(text: string, terms: readonly string[]): string {
  const first = text.toLowerCase().indexOf((terms[0] ?? '').toLowerCase());
  const start = Math.max(0, Math.min(Math.max(0, text.length - 400), first - 200));
  const end = start + 400;
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
export function searchResults(entries: readonly LookBackEntry[], terms: readonly string[], boundary: number, names: Record<string, string> = {}): LookBackResult {
  const candidates = entries.filter((e) => e.line < boundary);
  const matches = candidates.filter((e) => terms.every((term) => e.text.toLowerCase().includes(term.toLowerCase()))).sort((a, b) => b.line - a.line);
  const notes = [...new Set(candidates.flatMap((e) => e.warnings.map((w) => `#${e.line}: ${w}`)))].join('\n');
  const out: string[] = [];
  for (const e of matches) {
    if (out.length === 20) break;
    const hit = `${header(e, names)}\n${snippet(e.text, terms)}`;
    // Reserve room for the footer and unsupported-shape report within the total cap.
    if ([...out, hit].join('\n\n').length + Math.min(notes.length, 1000) + 120 > 12_000) break;
    out.push(hit);
  }
  const more = matches.length - out.length;
  let rendered = out.join('\n\n');
  if (matches.length === 0) {
    const query = terms.join(', ');
    const echo = query.length > 10_000 ? query.slice(0, 10_000) + '[query cut]' : query;
    rendered = `No entry before the compaction at line ${boundary} matches: ${echo}\nTry fewer or other words.`;
  }
  if (notes) rendered += `\n${notes.slice(0, 1000)}${notes.length > 1000 ? '\n[unsupported-shape report cut]' : ''}`;
  if (more) rendered += `\n${more} more matches: narrow the query, or fetch one with entry`;
  return { text: rendered, hits: out.length };
}
export function entryResult(entries: readonly LookBackEntry[], n: number, boundary: number, names: Record<string, string> = {}): LookBackResult {
  const error = n >= boundary ? `entry ${n} is at or after the compaction at line ${boundary}, so already in context` : undefined;
  if (error) return { text: error, error };
  const e = entries.find((e) => e.line === n);
  if (!e) { const error = `entry ${n} was not found in the transcript`; return { text: error, error }; }
  const text = e.text.slice(0, 24_000) + (e.text.length > 24_000 ? `\n[cut at 24k of ${e.text.length} chars]` : '');
  return { text: `${header(e, names)}\n${text}` };
}
export function manualTranscriptCall(tool: string, input: Record<string, unknown>, session: string, agentId?: string): boolean {
  if (!['Read', 'Grep', 'Bash'].includes(tool)) return false;
  const name = agentId === undefined ? `${session}.jsonl` : `agent-${agentId}.jsonl`;
  const literal = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_.-])${literal}($|[^A-Za-z0-9_.-])`).test(JSON.stringify(input));
}
export function lookBackNotice(label: string, args: Pick<LookBackArgs, 'why' | 'entry'>, result: { hits?: number; error?: string }): string {
  const outcome = result.error ? `failed: ${oneLine(result.error)}` : args.entry !== undefined ? `entry ${args.entry}` : `${result.hits ?? 0} hits`;
  return `look back (${oneLine(label)}): ${args.why} — ${outcome}`;
}
