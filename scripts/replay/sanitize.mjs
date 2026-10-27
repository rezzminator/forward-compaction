#!/usr/bin/env node
// Joins the recorder's row files into one fixture with nothing identifying left in it (spec § Tests, replay gate 4):
// the home directory → /HOME, the account name → user, every session id → zeros, every email address →
// user@example.invalid, consistently across inputs and outputs. Then every string of every row is checked on its
// decoded value; a host path, the account name or an address that survives fails the run, naming the row.
// Usage: node sanitize.mjs <rows-dir> [--out <file.jsonl[.gz]>] [--home <dir>]...
//   default out: tests/fixtures/replay/{version}/session.jsonl.gz, {version} from the recorded session.version().
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ZERO_SESSION = '00000000-0000-0000-0000-000000000000';
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const SAFE_EMAIL = 'user@example.invalid';
/** The backstop's pattern, wider than EMAIL (any non-ASCII local part, any punctuation an address may hold): what it finds and EMAIL missed fails the run. */
const ANY_EMAIL = /[^\s"'`<>()[\]{},;:@\\]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The rows in seq order, each part file joined; a missing seq or part is an error naming it. */
export function readRows(dir) {
  const parts = new Map();
  for (const name of readdirSync(dir)) {
    const m = /^(\d{6,})\.json(?:\.(\d+)of(\d+))?$/.exec(name);
    if (!m) continue;
    const seq = Number(m[1]);
    const entry = parts.get(seq) ?? { n: m[3] ? Number(m[3]) : 1, texts: [] };
    entry.texts[m[2] ? Number(m[2]) - 1 : 0] = readFileSync(join(dir, name), 'utf8');
    parts.set(seq, entry);
  }
  const errors = [];
  const rows = [];
  const last = Math.max(0, ...parts.keys());
  for (let seq = 1; seq <= last; seq++) {
    const entry = parts.get(seq);
    if (!entry) { errors.push(`row ${seq} missing`); continue; }
    const absent = Array.from({ length: entry.n }, (_, k) => k).filter((k) => entry.texts[k] === undefined);
    if (absent.length > 0) { errors.push(`row ${seq} missing part ${absent.map((k) => k + 1).join(', ')} of ${entry.n}`); continue; }
    try {
      rows.push(JSON.parse(entry.texts.join('')));
    } catch (error) {
      errors.push(`row ${seq} is not JSON: ${error.message}`);
    }
  }
  if (last === 0) errors.push(`no rows in ${dir}`);
  return { rows, errors };
}

/** What identifies the host in these rows: home directories, account names, session ids. */
export function identities(rows, extraHomes = []) {
  const homes = new Set(extraHomes.filter(Boolean));
  const sessions = new Set();
  for (const row of rows) {
    if (row.phase !== 'call' || row.error !== undefined) continue;
    if (row.path === 'env.get' && row.args?.[0] === 'HOME' && typeof row.result === 'string' && row.result) homes.add(row.result);
    if (row.path === 'session.id' && typeof row.result === 'string' && row.result) sessions.add(row.result);
  }
  const names = new Set([...homes].map((h) => basename(h)).filter((n) => n && n !== 'HOME' && n !== 'user' && n !== 'root'));
  return { homes: [...homes].filter((h) => h !== '/HOME'), names: [...names], sessions: [...sessions].filter((s) => s !== ZERO_SESSION) };
}

/** The replacements on a row's JSON text, longest home first so a nested home is never half replaced. */
export function replacer({ homes, names, sessions }) {
  const rules = [
    ...sessions.map((s) => [new RegExp(escape(s), 'g'), ZERO_SESSION]),
    ...[...homes].sort((a, b) => b.length - a.length).map((h) => [new RegExp(escape(h), 'g'), '/HOME']),
    [EMAIL, SAFE_EMAIL],
    ...names.map((n) => [new RegExp(`\\b${escape(n)}\\b`, 'gi'), 'user']),
  ];
  return (text) => rules.reduce((t, [re, to]) => t.replace(re, (hit) => (hit === SAFE_EMAIL ? hit : to)), text);
}

/** Every string a row holds, decoded (keys included), so an escaped form the text replacer missed is still seen. */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); strings(v, out); }
  return out;
}

/** What still identifies the host in one sanitized row, or nothing. */
export function leaks(row, { names }) {
  const found = new Set();
  for (const s of strings(row)) {
    for (const m of s.matchAll(/\/(?:(?:home|Users|var\/home)\/([^/\s"'`]+)|root\/)/g)) found.add(`host path /…/${m[1] ?? 'root'}`);
    for (const m of s.matchAll(ANY_EMAIL)) if (!m[0].endsWith(SAFE_EMAIL)) found.add('an email address');
    for (const n of names) if (new RegExp(`\\b${escape(n)}\\b`, 'i').test(s)) found.add('the account name');
  }
  return [...found];
}

export function sanitize(rows, extraHomes = []) {
  const ids = identities(rows, extraHomes);
  const replace = replacer(ids);
  const errors = [];
  const out = rows.map((row) => JSON.parse(replace(JSON.stringify(row))));
  for (const row of out) {
    const found = leaks(row, ids);
    if (found.length > 0) errors.push(`row ${row.seq}: ${found.join(', ')} survives sanitizing`);
  }
  return { rows: out, errors };
}

function main(argv) {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
  let dir;
  let out;
  const homes = [process.env.HOME];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--home') homes.push(argv[++i]);
    else dir ??= argv[i];
  }
  if (!dir || !existsSync(dir)) {
    console.error('usage: node sanitize.mjs <rows-dir> [--out <file.jsonl[.gz]>] [--home <dir>]...');
    return 2;
  }
  const read = readRows(dir);
  const version = read.rows.find((r) => r.phase === 'version');
  if (version?.error !== undefined) read.errors.push(`row ${version.seq}: ${version.error.message}`);
  if (!version && read.rows.length > 0) read.errors.push('no version row: the recording never saw session.start');
  const clean = sanitize(read.rows, homes);
  const errors = [...read.errors, ...clean.errors];
  if (errors.length > 0) {
    for (const line of errors) console.error(`sanitize: ${line}`);
    return 1;
  }
  out ??= join(repo, 'tests/fixtures/replay', String(version?.result?.version), 'session.jsonl.gz');
  const text = clean.rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, out.endsWith('.gz') ? gzipSync(text) : text);
  console.log(`sanitize: ${clean.rows.length} rows -> ${out}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
