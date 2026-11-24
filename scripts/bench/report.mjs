#!/usr/bin/env node
// Reads every metered and scored run under <out-dir>/{arm}/run-{seed}/ and writes one results JSON (numbers only,
// no path or name) and prints the README's benchmark table in Markdown, one column per arm.
// Usage: node report.mjs <out-dir> [results-file=<out-dir>/results.json]
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './transcript.mjs';

export function stat(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { median: null, p90: null, n: 0 };
  const mid = v.length / 2;
  const median = v.length % 2 ? v[Math.floor(mid)] : (v[mid - 1] + v[mid]) / 2;
  return { median, p90: v[Math.ceil(0.9 * v.length) - 1], n: v.length }; // p90 by nearest rank
}

export function collect(out) {
  const arms = {};
  for (const arm of readdirSync(out, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const run of readdirSync(join(out, arm.name)).filter((d) => d.startsWith('run-')).sort()) {
      const dir = join(out, arm.name, run);
      if (!existsSync(join(dir, 'meter.json')) || !existsSync(join(dir, 'score.json'))) continue;
      (arms[arm.name] ??= []).push({ meter: readJson(join(dir, 'meter.json')), score: readJson(join(dir, 'score.json')) });
    }
  }
  return arms;
}

export function summarize(runs) {
  const comps = runs.flatMap((r) => r.meter.compactions);
  const sumK = (f) => runs.reduce((s, r) => s + f(r).k, 0), sumM = (f) => runs.reduce((s, r) => s + f(r).m, 0);
  const sumFacts = (key) => runs.reduce((s, r) => s + r.score.facts[key], 0);
  const ago = {};
  for (const r of runs) for (const [k, v] of Object.entries(r.score.facts.byCompactionsAgo)) { (ago[k] ??= { k: 0, n: 0 }).k += v.k; ago[k].n += v.n; }
  return {
    runs: runs.length,
    compactionKinds: comps.reduce((o, c) => ((o[c.kind] = (o[c.kind] ?? 0) + 1), o), {}),
    compaction: {
      stallSeconds: stat(comps.map((c) => (c.stallMs == null ? null : c.stallMs / 1000))),
      contextRead: stat(comps.map((c) => c.contextRead)),
      contextAfter: stat(comps.map((c) => c.contextAfter)),
      boundaryPreTokens: stat(comps.map((c) => c.boundary.preTokens)),
      boundaryPostTokens: stat(comps.map((c) => c.boundary.postTokens)),
      tokensWritten: stat(comps.map((c) => c.written)),
      costUsd: stat(comps.map((c) => c.cost)),
    },
    run: {
      wallMinutes: stat(runs.map((r) => r.meter.run.wallMs / 60000)),
      requests: stat(runs.map((r) => r.meter.run.requests)),
      compactions: stat(runs.map((r) => r.meter.run.compactions)),
      inputTokens: stat(runs.map((r) => r.meter.run.tokens.input)),
      cacheReadTokens: stat(runs.map((r) => r.meter.run.tokens.cacheRead)),
      cacheWriteTokens: stat(runs.map((r) => r.meter.run.tokens.cacheWrite)),
      outputTokens: stat(runs.map((r) => r.meter.run.tokens.output)),
      costUsd: stat(runs.map((r) => r.meter.run.cost_usd)),
    },
    survived: {
      // An item is asked for in every summary; a shelf stands in the same ledger note and is asked for only at the end.
      items: { k: sumFacts('item'), n: sumFacts('n') },
      shelves: { k: sumFacts('shelf'), n: sumFacts('n') },
      facts: { k: sumFacts('both'), n: sumFacts('n') },
      factsByCompactionsAgo: ago,
      rulesAfterCompaction: { k: sumK((r) => r.score.rules.afterCompaction), m: sumM((r) => r.score.rules.afterCompaction) },
      changedRuleAfterCompaction: { k: sumK((r) => r.score.rules.changedAfterCompaction), m: sumM((r) => r.score.rules.changedAfterCompaction) },
      quoteVerbatim: { k: runs.filter((r) => r.score.quote).length, n: runs.length },
      rework: stat(runs.map((r) => r.score.rework)),
      finalCorrect: { k: runs.filter((r) => r.score.final.correct).length, n: runs.length },
    },
    perRun: runs.map((r) => ({ seed: r.meter.seed, compactions: r.meter.run.compactions, costUsd: r.meter.run.cost_usd, items: r.score.facts.item, shelves: r.score.facts.shelf, facts: r.score.facts.both, factsN: r.score.facts.n, quote: r.score.quote, final: r.score.final.correct, rework: r.score.rework })),
  };
}

const k = (x) => (x == null ? '–' : x >= 1000 ? `${(x / 1000).toFixed(1)}k` : String(Math.round(x)));
const cell = (s, f) => (s.n === 0 ? '–' : `${f(s.median)} (${f(s.p90)})`);
const usd = (x) => `$${x.toFixed(x < 1 ? 3 : 2)}`;

export function table(results) {
  const names = Object.keys(results.arms);
  const row = (label, f) => `| ${label} | ${names.map((n) => f(results.arms[n])).join(' | ')} |`;
  return [
    `| Median (p90) | ${names.join(' | ')} |`,
    `| --- | ${names.map(() => '---').join(' | ')} |`,
    row('Runs · compactions', (a) => `${a.runs} · ${Object.entries(a.compactionKinds).map(([kind, n]) => `${n} ${kind}`).join(', ')}`),
    row('Time one compaction stalls the chat', (a) => cell(a.compaction.stallSeconds, (x) => `${x.toFixed(1)} s`)),
    row('Context when it started', (a) => cell(a.compaction.boundaryPreTokens, k)),
    row('Context left after', (a) => cell(a.compaction.contextAfter, k)),
    row('Tokens written per compaction', (a) => cell(a.compaction.tokensWritten, k)),
    row('Cost of one compaction', (a) => cell(a.compaction.costUsd, usd)),
    row('Whole run: wall time', (a) => cell(a.run.wallMinutes, (x) => `${x.toFixed(1)} min`)),
    row('Whole run: requests · compactions', (a) => `${cell(a.run.requests, k)} · ${cell(a.run.compactions, k)}`),
    row('Whole run: input · cache read · cache write · output (medians only)', (a) => [a.run.inputTokens, a.run.cacheReadTokens, a.run.cacheWriteTokens, a.run.outputTokens].map((s) => k(s.median)).join(' · ')),
    row('Whole run: cost', (a) => cell(a.run.costUsd, usd)),
    row('Crate items recalled at the end (asked for in every summary)', (a) => `${a.survived.items.k} of ${a.survived.items.n}`),
    row('Crate shelves recalled at the end (in the files, asked for only at the end)', (a) => `${a.survived.shelves.k} of ${a.survived.shelves.n}`),
    row('… item and shelf both, by compactions since read', (a) => Object.entries(a.survived.factsByCompactionsAgo).sort(([x], [y]) => Number(x) - Number(y)).map(([g, v]) => `${g}: ${v.k}/${v.n}`).join(', ')),
    row("User's rules obeyed after a compaction", (a) => `${a.survived.rulesAfterCompaction.k} of ${a.survived.rulesAfterCompaction.m}`),
    row('Changed rule obeyed after a compaction', (a) => `${a.survived.changedRuleAfterCompaction.k} of ${a.survived.changedRuleAfterCompaction.m}`),
    row('User message quoted back verbatim', (a) => `${a.survived.quoteVerbatim.k} of ${a.survived.quoteVerbatim.n} runs`),
    row('Files re-read after a compaction', (a) => cell(a.survived.rework, k)),
    row('Final answers file: every crate named, total weight right', (a) => `${a.survived.finalCorrect.k} of ${a.survived.finalCorrect.n} runs`),
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [out, file] = process.argv.slice(2);
  if (!out) { console.error('usage: node report.mjs <out-dir> [results-file]'); process.exit(2); }
  const arms = collect(out);
  if (Object.keys(arms).length === 0) { console.error(`report: no metered and scored run under ${out}`); process.exit(1); }
  const any = Object.values(arms)[0][0].meter;
  const results = { claudeCode: any.claude, model: any.model, prices: any.prices, arms: Object.fromEntries(Object.entries(arms).map(([n, r]) => [n, summarize(r)])) };
  writeFileSync(file ?? join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(table(results));
  console.log(`\nPrices, USD per million tokens (${any.prices.key}): input ${any.prices.input}, output ${any.prices.output}, cache read ${any.prices.cacheRead}, cache write ${any.prices.cacheWrite5m} (5 min) / ${any.prices.cacheWrite1h} (1 h).`);
}
