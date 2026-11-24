#!/usr/bin/env node
// Scores one run folder by exact values against its generated truth: planted facts recalled (split by how many
// compactions ago each was read), the user's rules obeyed after compactions (the changed rule apart), the client's
// note quoted back, records re-read after a compaction, and the final answers file.
// Usage: node score.mjs <run-dir> [answers-file]   (default <run-dir>/ws/out/answers.json)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readRun, readJson } from './transcript.mjs';

const norm = (s) => String(s ?? '').trim().replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s+/g, ' ').trim();
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function score(dir, answersFile = join(dir, 'ws', 'out', 'answers.json')) {
  const run = readRun(dir);
  const truth = readJson(join(dir, 'truth.json'));
  const turns = readJson(join(dir, 'turns.json'));
  const ws = resolve(dir, 'ws');
  const sent = Object.fromEntries(run.turns.map((t) => [t.id, t.at]));
  const finalTurn = turns.find((t) => t.final);
  const finalAt = sent[finalTurn.id] ?? Infinity;
  const between = (a, b) => run.boundaries.filter((x) => x.ts > a && x.ts < b).length;
  const pathOf = (t) => String(t.input.file_path ?? t.input.notebook_path ?? '');
  const reads = run.tools.filter((t) => t.name === 'Read' && /records\/batch-\d+\.txt$/.test(pathOf(t)));

  // Facts: each crate's item and shelf, exact; read = the first Read of its batch file.
  let answers = null, parseError = null;
  try { answers = JSON.parse(readFileSync(answersFile, 'utf8')); } catch (error) { parseError = error.message; }
  const facts = [];
  for (const b of truth.batches) {
    const first = reads.find((t) => pathOf(t).endsWith(b.file));
    const ago = first ? between(first.ts, finalAt) : null;
    for (const n of b.notes) {
      const got = answers?.crates?.[n.crate] ?? {};
      const item = norm(got.item).toLowerCase() === n.item, shelf = norm(got.shelf).toUpperCase() === n.shelf;
      facts.push({ crate: n.crate, batch: b.code, compactionsAgo: ago, item, shelf, both: item && shelf });
    }
  }
  const byAgo = {};
  for (const f of facts) { const k = f.compactionsAgo === null ? 'never read' : String(f.compactionsAgo); (byAgo[k] ??= { k: 0, n: 0 }).n++; if (f.both) byAgo[k].k++; }

  // Rules: each check is one action, counted "after" once a compaction lies before it (the changed rule: after the change too).
  const checks = [];
  const add = (rule, ts, ok, detail) => checks.push({ rule, ts, ok, after: between(0, ts) > 0, detail });
  for (const t of run.tools.filter((t) => WRITE_TOOLS.has(t.name))) add('files-under-out', t.ts, resolve(ws, pathOf(t)).startsWith(join(ws, 'out') + '/'), pathOf(t));
  turns.forEach((t, i) => {
    const from = sent[t.id], to = sent[turns[i + 1]?.id] ?? Infinity;
    if (from === undefined) return;
    const shells = run.tools.filter((x) => x.name === 'Bash' && x.ts >= from && x.ts < to).length;
    add('no-shell', run.stops[i] ?? to, shells === 0, `${shells} shell calls in ${t.id}`);
  });
  const outDir = existsSync(join(dir, 'hidden', 'out')) ? join(dir, 'hidden', 'out') : join(ws, 'out');
  const changeAt = sent[turns.find((t) => t.unit === 'g')?.id] ?? Infinity;
  for (const t of turns.filter((x) => x.summary)) {
    const file = join(outDir, t.summary.replace(/^out\//, ''));
    const wrote = run.tools.filter((x) => WRITE_TOOLS.has(x.name) && pathOf(x).endsWith(t.summary)).at(-1);
    const ts = wrote?.ts ?? sent[t.id] ?? 0;
    const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const rows = (text ?? '').split('\n').filter((l) => l.trim());
    add('batch-code-first', ts, text !== null && rows.length > 0 && rows.every((l) => /^\s*(?:[-*]\s*)?\[B\d\d\]/.test(l)), text === null ? `${t.summary} missing` : t.summary);
    const unitOk = text !== null && rows.length > 0 && rows.every((l) => (t.unit === 'kg' ? /\b\d+\.\d\s?kg\b/.test(l) : /\b\d+\s?g\b/.test(l) && !/kg\b/.test(l)));
    const c = { rule: t.unit === 'g' ? 'changed-unit-grams' : 'unit-kilograms', ts, ok: unitOk, after: between(t.unit === 'g' ? changeAt : 0, ts) > 0, detail: t.summary };
    checks.push(c);
  }
  const tally = (list) => ({ k: list.filter((c) => c.ok).length, m: list.length });
  const fixed = checks.filter((c) => c.rule !== 'changed-unit-grams');
  const changed = checks.filter((c) => c.rule === 'changed-unit-grams');

  // Rework: a records file read again after a compaction that followed its earlier read.
  let rework = 0;
  reads.forEach((t, i) => { const prev = reads.slice(0, i).filter((x) => pathOf(x) === pathOf(t)).at(-1); if (prev && between(prev.ts, t.ts) > 0) rework++; });
  const finalReads = run.tools.filter((t) => t.ts >= finalAt && ['Read', 'Glob', 'Grep', 'Bash'].includes(t.name)).length;

  const crates = truth.batches.flatMap((b) => b.notes.map((n) => n.crate));
  const finalCorrect = answers !== null && typeof answers.crates === 'object' && answers.crates !== null && crates.every((c) => c in answers.crates) && answers.total_grams === truth.total_grams;
  return {
    dir, answersFile, parseError,
    facts: { n: facts.length, item: facts.filter((f) => f.item).length, shelf: facts.filter((f) => f.shelf).length, both: facts.filter((f) => f.both).length, byCompactionsAgo: byAgo },
    rules: { afterCompaction: tally(fixed.filter((c) => c.after)), changedAfterCompaction: tally(changed.filter((c) => c.after)), all: tally(fixed), changedAll: tally(changed), failed: checks.filter((c) => !c.ok).map((c) => `${c.rule}: ${c.detail}`) },
    quote: norm(answers?.client_note) === norm(truth.quote),
    rework, finalReads,
    final: { correct: finalCorrect, total_grams: answers?.total_grams ?? null, expected_total_grams: truth.total_grams },
    turnsDone: run.stops.length, turnsSent: run.turns.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, answers] = process.argv.slice(2);
  if (!dir) { console.error('usage: node score.mjs <run-dir> [answers-file]'); process.exit(2); }
  console.log(JSON.stringify(score(dir, answers), null, 2));
}
