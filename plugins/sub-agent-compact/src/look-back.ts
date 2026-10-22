// Recovery is bounded to one party's pre-compaction prefix. Only the adapter does I/O.
export const LOOK_BACK_TOOL = 'look_back';
export const LOOK_BACK_DESCRIPTION = 'Recover an exact detail — when you need an error text, code snippet, value, or what the user said from before your latest compaction. Searches only your own transcript’s part you no longer hold. Each call tells the person what you looked up. Returns numbered snippets or a whole entry; failures say why, no matches suggests other words. Example: {query:"connection refused"}.';
export const LOOK_BACK_HINT = 'Need an exact detail from before this handoff? look_back finds it.';
export const LOOK_BACK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Case-insensitive words; entries holding the most of them rank first, then newest. Double quotes keep a phrase whole; \\" is a literal quote.' },
    entry: { type: 'integer', minimum: 1, description: 'Line number from a look_back result to fetch whole, before the latest compaction.' },
  },
  // Query-or-entry is parseLookBack's check, not the schema's: a client sending `entry: null` beside a query is not refused.
  additionalProperties: false,
};
export type LookBackArgs = { query?: string; entry?: number; terms: string[]; error?: string };
/** `input`: the error is the caller's input (a bad argument, an entry it cannot fetch), not a plugin fault. */
export type LookBackResult = { text: string; hits?: number; error?: string; input?: true };
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
/**
 * The search terms of a query's pieces: a quoted phrase as typed; a bare word without the punctuation prose wraps
 * around it (`(KEY` → `KEY`, `review.md)` → `review.md`), its inner punctuation kept; each term once, case aside.
 */
function queryTerms(pieces: readonly string[]): string[] {
  const out: string[] = [];
  for (const piece of pieces) {
    const term = piece.startsWith('"') ? piece.slice(1, -1).replace(/\\"/g, '"') : piece.replace(/\\"/g, '"').replace(/^[([{<'`,;]+/, '').replace(/[)\]}>'`,;:!?.]+$/, '');
    if (term !== '' && !out.some((t) => t.toLowerCase() === term.toLowerCase())) out.push(term);
  }
  return out;
}

export function parseLookBack(raw: Record<string, unknown>): LookBackArgs {
  // A null query or entry is absent: clients send unset optional fields as null.
  const input = Object.fromEntries(Object.entries(raw).filter(([key, value]) => !(value === null && (key === 'query' || key === 'entry'))));
  const args: LookBackArgs = { terms: [] };
  if (typeof input.query === 'string') args.query = input.query.trim();
  if (typeof input.entry === 'number') args.entry = input.entry;
  const bad = Object.keys(input).find((key) => !['query', 'entry'].includes(key));
  if (bad) args.error = `unknown argument ${bad}`;
  else if (input.entry !== undefined && (!Number.isSafeInteger(input.entry) || Number(input.entry) < 1)) args.error = 'entry must be a positive integer';
  else if (input.query !== undefined && typeof input.query !== 'string') args.error = 'query must be a string';
  else if (args.entry === undefined) {
    if (args.query === undefined) args.error = 'query or entry is required';
    else {
      // A backslash-escaped quote is a literal quote character, never a phrase delimiter; any other backslash is literal.
      // A newline inside a phrase would turn grep -e into OR patterns; refuse it.
      const pieces = args.query.match(/"(?:\\"|\\(?!")|[^"\\\r\n])*"|(?:\\"|\\(?!")|[^\s"\\])+/g) ?? [];
      const delimiters = args.query.replace(/\\"/g, '');
      if ((delimiters.match(/"/g)?.length ?? 0) % 2 !== 0) args.error = 'query has an unclosed quote';
      else if (args.query.includes('\0') || /"[^"\n]*[\r\n]/.test(delimiters)) args.error = 'query terms must not contain NUL or newlines';
      else args.terms = queryTerms(pieces);
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
/**
 * The script contains only fixed code and argument indexes; values stay in argv. grep reads the raw JSONL line, where a
 * term sits as typed (a tool input's own JSON structure) or in the form JSON writes a string value (a quote as \", a
 * backslash as \\): a term whose two forms differ goes to grep as both; searchResults matches the decoded text.
 */
export function searchArgv(file: string, boundary: number, terms: readonly string[]): string[] {
  const forms = terms.map((term) => [...new Set([term, JSON.stringify(term).slice(1, -1)])]);
  const refs = forms.flat().map((_, i) => `"\${${i + 3}}"`);
  // The term each form belongs to, as fixed numbers: awk counts a line's terms, not its forms.
  const groups = forms.flatMap((f, i) => f.map(() => i + 1)).join(' ');
  return ['sh', '-c', `${checked}${prefix} | ${STRIP_IMAGES} | checked 1 grep -a -n -i -F ${refs.map((r) => `-e ${r}`).join(' ')} | checked 0 awk -v groups='${groups}' '${RANK}' ${refs.join(' ')} | checked 0 env LC_ALL=C sort -t: -k1,1nr -k2,2nr | ${BUDGET} | checked 0 env LC_ALL=C sort -t: -k2,2n | checked 0 cut -d: -f2-${finish}`, 'sh', file, String(boundary), ...forms.flat()];
}
/**
 * `$.process.run` keeps 4,194,304 characters of output (Claude Code 2.1.307) and cuts the rest, the completion marker with it.
 * An image's base64 holds nothing to search: emptied, its entry still reads as an image block. The best 200 lines go on
 * while they fit 3,000,000 bytes; every line is read, so no stage upstream is cut off mid-write.
 */
const STRIP_IMAGES = `checked 0 sed -E 's|"data":"[A-Za-z0-9+/=]{200,}"|"data":""|g'`;
const BUDGET = `checked 0 env LC_ALL=C awk '{ n += length($0) + 1; if (NR > 200 || (NR > 1 && n > 3000000)) next; print }'`;
/**
 * Prefixes each `grep -n` line with how many terms it holds, case aside; the forms come as operands, taken in BEGIN and
 * never read as files, so a term like `a=b` is never an assignment. The most-matching 200, newest first among equals, go on.
 */
const RANK = String.raw`BEGIN { n = split(groups, g, " "); for (i = 1; i <= n; i++) { f[i] = tolower(ARGV[i]); delete ARGV[i] } }
{ line = tolower($0); c = 0; split("", seen); for (i = 1; i <= n; i++) if (!(g[i] in seen) && index(line, f[i]) > 0) { seen[g[i]] = 1; c++ } print c ":" $0 }`;
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
    // A tool search's result names the tools it loaded.
    if (b.type === 'tool_reference') {
      const name = typeof b.tool_name === 'string' ? b.tool_name : typeof b.name === 'string' ? b.name : undefined;
      if (name !== undefined) return [`[tool ${name}]`];
    }
    const kind = typeof b.type === 'string' ? b.type : 'unknown';
    // An image or a document is known and holds no text to search: a note, not a failure.
    const note = kind === 'image' || kind === 'document' ? `${kind} block` : `unsupported ${kind} block`;
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
    if (r?.type === 'attachment') return attachmentEntry(e, object(r.attachment));
    if (r?.type === 'queue-operation' && r.operation === 'enqueue' && typeof r.content === 'string') { e.kind = 'queued prompt'; e.text = r.content; return e; }
    if (typeof r?.type === 'string' && (BOOKKEEPING.has(r.type) || (r.type === 'system' && typeof r.content !== 'string'))) {
      e.kind = 'bookkeeping'; e.text = r.type; return e;
    }
    if (r?.type === 'system' && typeof r.content === 'string') { e.kind = 'system'; e.text = r.content; return e; }
    if (r?.type === 'summary' && typeof r.summary === 'string') { e.kind = 'summary'; e.text = r.summary; return e; }
    if (!msg || !['user', 'assistant'].includes(String(role))) {
      e.kind = 'unknown'; e.text = `[unsupported entry type ${String(role)}]`; e.warnings.push(e.text.slice(1, -1)); return e;
    }
    e.kind = String(role);
    e.text = readable(msg.content, e.uses, e.results, e.warnings);
    if (e.uses.length) e.kind = `tool ${e.uses.map((u) => u.name).join(', ')}`;
    return e;
  });
}
/**
 * Entry types Claude Code writes for its own bookkeeping, never part of the conversation (read off 2.1.300 transcripts):
 * a queue operation other than an enqueued prompt (a dequeue, removal or pop repeats or empties it), a copy of a request
 * sent, titles, modes, links, file history and cost. Skipped without a note; a `system` entry without text is too.
 */
const BOOKKEEPING = new Set([
  'queue-operation', 'api-request', 'api-request-blob', 'api-request-shape', 'last-prompt', 'mode', 'permission-mode',
  'atis-latch', 'ai-title', 'custom-title', 'agent-name', 'bridge-session', 'history-suppression', 'frame-link', 'pr-link',
  'file-history-snapshot', 'file-history-delta', 'cost-state', 'artifact-comment-monitor', 'artifact-autoreact-ledger',
]);
/**
 * An `attachment` entry: what Claude Code put into the conversation beside the messages. A task notification (a child's
 * result) is a `queued_command` whose `commandMode` is `task-notification`; its text is `prompt`. Others carry `content`
 * (a string or a list of strings) or `text`. One with none of these (engine records such as a prompt snapshot, or a
 * file whose text is nested) is shown raw, its JSON verbatim, so nothing it holds is hidden.
 */
function attachmentEntry(e: LookBackEntry, a: Record<string, unknown> | undefined): LookBackEntry {
  const type = typeof a?.type === 'string' ? a.type : 'unknown';
  const content = a?.content;
  const text = typeof a?.prompt === 'string' ? a.prompt
    : typeof content === 'string' ? content
    : Array.isArray(content) && content.every((item) => typeof item === 'string') ? content.join('\n')
    : typeof a?.text === 'string' ? a.text
    : undefined;
  if (text === undefined) {
    e.kind = `attachment ${type} raw`; e.text = JSON.stringify(a ?? null); return e;
  }
  e.kind = a?.commandMode === 'task-notification' ? 'task-notification' : `attachment ${type}`;
  e.text = text;
  return e;
}
/** A warning that leaves an entry, or part of one, unread: a failure the caller sees, not a routine note. */
const unread = (warning: string): boolean => warning.startsWith('unsupported');
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
  const lower = text.toLowerCase();
  const first = terms.map((t) => lower.indexOf(t.toLowerCase())).find((at) => at >= 0) ?? -1;
  const start = Math.max(0, Math.min(Math.max(0, text.length - 400), first - 200));
  const end = start + 400;
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
// A tool call's text shows its input as JSON, a quote in a value as \": a term holding the quote itself matches it there too.
const unescaped = (text: string): string => text.replace(/\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (m) => JSON.parse(`"${m}"`) as string);
/**
 * The matches, those holding the most terms first, then newest; the party's own calls of `demote` (its forward handoff, whose fields restate what it
 * searches for) and their results rank below every other hit. An entry left unread is the result's error, hits still shown.
 */
export function searchResults(entries: readonly LookBackEntry[], terms: readonly string[], boundary: number, names: Record<string, string> = {}, demote?: string): LookBackResult {
  const candidates = entries.filter((e) => e.line < boundary && e.kind !== 'bookkeeping');
  const own = (e: LookBackEntry): boolean => demote !== undefined && (e.uses.some((u) => u.name === demote) || e.results.some((id) => names[id] === demote));
  // Ranked by how many terms an entry holds, so a query of many words finds the entry that holds most of them.
  const held = new Map(candidates.map((e) => { const text = e.text.toLowerCase(), plain = unescaped(text); return [e, terms.filter((term) => text.includes(term.toLowerCase()) || plain.includes(term.toLowerCase())).length] as const; }));
  const count = (e: LookBackEntry): number => held.get(e) ?? 0;
  const matches = candidates
    .filter((e) => count(e) > 0)
    .sort((a, b) => Number(own(a)) - Number(own(b)) || count(b) - count(a) || b.line - a.line);
  const notes = [...new Set(candidates.flatMap((e) => e.warnings.map((w) => `#${e.line}: ${w}`)))].join('\n');
  const out: string[] = [];
  for (const e of matches) {
    if (out.length === 20) break;
    const part = count(e) < terms.length ? `  (${count(e)} of ${terms.length} terms)` : '';
    const hit = `${header(e, names)}${part}\n${snippet(e.text, terms.filter((t) => e.text.toLowerCase().includes(t.toLowerCase()) || unescaped(e.text.toLowerCase()).includes(t.toLowerCase())))}`;
    // Reserve room for the footer and unsupported-shape report within the total cap.
    if ([...out, hit].join('\n\n').length + Math.min(notes.length, 1000) + 120 > 12_000) break;
    out.push(hit);
  }
  const more = matches.length - out.length;
  let rendered = out.join('\n\n');
  if (matches.length === 0) {
    const query = terms.join(', ');
    const echo = query.length > 10_000 ? query.slice(0, 10_000) + '[query cut]' : query;
    rendered = `No entry before the compaction at line ${boundary} matches: ${echo}\nTry other words.`;
  } else if (terms.length > 1 && matches.every((e) => count(e) < terms.length)) rendered = `No entry holds every term (${terms.join(', ')}); these hold the most:\n\n${rendered}`;
  if (notes) rendered += `\n${notes.slice(0, 1000)}${notes.length > 1000 ? '\n[unsupported-shape report cut]' : ''}`;
  if (more) rendered += `\n${more} more matches: quote a phrase or use rarer words to narrow it, or fetch one with entry`;
  const failed = candidates.flatMap((e) => e.warnings.filter(unread).map((w) => `#${e.line}: ${w}`));
  const unreadEntries = new Set(failed.map((f) => f.split(':')[0])).size;
  const error = failed.length === 0 ? undefined : `${unreadEntries} ${unreadEntries === 1 ? 'entry' : 'entries'} could not be read: ${[...new Set(failed)].slice(0, 5).join('; ')}${failed.length > 5 ? '; …' : ''}`;
  return { text: rendered, hits: out.length, ...(error ? { error } : {}) };
}
export function entryResult(entries: readonly LookBackEntry[], n: number, boundary: number, names: Record<string, string> = {}): LookBackResult {
  const error = n >= boundary ? `entry ${n} is at or after the compaction at line ${boundary}, so already in context` : undefined;
  if (error) return { text: error, error, input: true };
  const e = entries.find((e) => e.line === n);
  if (!e) { const error = `entry ${n} was not found in the transcript`; return { text: error, error, input: true }; }
  if (e.kind === 'bookkeeping') {
    const error = `entry ${n} is Claude Code bookkeeping (${e.text}), not part of the conversation`;
    return { text: error, error, input: true };
  }
  if (e.kind === 'unknown') {
    const error = `entry ${n} could not be read: ${e.warnings.join(', ')}`;
    return { text: error, error };
  }
  const text = e.text.slice(0, 24_000) + (e.text.length > 24_000 ? `\n[cut at 24k of ${e.text.length} chars]` : '');
  return { text: `${header(e, names)}\n${text}` };
}
export function manualTranscriptCall(tool: string, input: Record<string, unknown>, session: string, agentId?: string): boolean {
  if (!['Read', 'Grep', 'Bash'].includes(tool)) return false;
  const name = agentId === undefined ? `${session}.jsonl` : `agent-${agentId}.jsonl`;
  const literal = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_.-])${literal}($|[^A-Za-z0-9_.-])`).test(JSON.stringify(input));
}
export function lookBackNotice(label: string, args: Pick<LookBackArgs, 'query' | 'entry'>, result: { hits?: number; error?: string }): string {
  const query = oneLine(args.query ?? '');
  const asked = args.entry !== undefined ? `entry ${args.entry}` : args.query !== undefined ? `query ${query.length > 120 ? query.slice(0, 115) + '[cut]' : query}` : 'no query or entry';
  const outcome = result.error ? `failed: ${oneLine(result.error)}` : args.entry !== undefined ? '' : `${result.hits ?? 0} hits`;
  return `look back (${oneLine(label)}): ${asked}${outcome ? ` — ${outcome}` : ''}`;
}
