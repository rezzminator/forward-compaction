#!/usr/bin/env node
// Meters one run folder from its records alone: each compaction (its stall, context before and after, tokens
// written, cost) and the whole run (wall time, requests, tokens by kind, cost). Usage and durations come from the
// API requests otlp.mjs received (otel.jsonl), the compaction from its transcript boundary; each figure names its source.
// Usage: node meter.mjs <run-dir>   env: BENCH_PRICES (a prices.json-shaped file; default ./prices.json)
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRun, readJson } from './transcript.mjs';

const here = dirname(fileURLToPath(import.meta.url));
/** The query source of the chat's own requests; a native compaction's summarizer runs under a source naming `compact`. */
export const MAIN_SOURCE = 'repl_main_thread';
/** How far a frontier call's record may sit after the end of the request that wrote it (the tool runs after the stream ends). */
const CALL_SLACK_MS = 30_000;
/** How far a stored row may sit after the boundary it belongs to: a fork's store is logged inside the compaction ask, tens of ms either side of the boundary's own timestamp. */
const STORE_SLACK_MS = 2_000;

export function pricesFor(model, table) {
  const key = Object.keys(table.models).filter((k) => model?.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  if (!key) throw new Error(`meter: no price for model ${model} in the prices table (add it, or set BENCH_PRICES)`);
  return { key, ...table.models[key] };
}

/** USD of one request; a cache write the record does not split by TTL is priced as the 5-minute write. */
export function cost(u, p) {
  const w1h = u.cacheWrite1h ?? 0, w5m = u.cacheWrite5m ?? u.cacheWrite - w1h;
  return (u.input * p.input + u.cacheRead * p.cacheRead + w5m * p.cacheWrite5m + w1h * p.cacheWrite1h + u.output * p.output) / 1e6;
}
/** USD of what a request after a compaction pays to rebuild its cache: its uncached input and its cache write. */
const rebuildCost = (u, p) => (u ? cost({ ...u, cacheRead: 0, output: 0 }, p) : 0);
const context = (u) => (u ? u.input + u.cacheRead + u.cacheWrite : null);

export function meter(dir, table) {
  if (!existsSync(join(dir, 'otel.jsonl'))) throw new Error(`meter: ${dir}/otel.jsonl missing: the run recorded no API request, so nothing can be metered`);
  const run = readRun(dir);
  const { requests, tools, boundaries, stored } = run;
  const main = requests.filter((r) => r.source === MAIN_SOURCE);
  const model = main[0]?.model;
  if (!model) throw new Error(`meter: ${dir}/otel.jsonl holds no ${MAIN_SOURCE} request`);
  const p = pricesFor(model, table);
  const isFrontier = (t) => /(^|__)forward_compaction$/.test(t.name);
  // Each forward_compaction call: the plugin's stored row, else the transcript's tool_use (one call seen by both counts once).
  const calls = stored.map((s) => ({ ts: s.ts, writer: s.writer }));
  for (const t of tools.filter(isFrontier)) if (!calls.some((c) => Math.abs(c.ts - t.ts) < 3000)) calls.push({ ts: t.ts, writer: 'model' });
  calls.sort((a, b) => a.ts - b.ts);
  // The request that wrote a call: main's own request for the model's call; for a fork's (`$.model.fork`, whose request runs
  // under a source of its own), the last request outside main's thread and any summarizer that ended before the store.
  const writerOf = (c) => (c.writer === 'fork' ? requests.filter((r) => r.source !== MAIN_SOURCE && !/compact/i.test(r.source ?? '')) : main).filter((r) => r.end <= c.ts + 1000 && r.end > c.ts - CALL_SLACK_MS).at(-1);
  // A request whose model the prices table lacks is left out of every cost and named, never a reason to meter nothing.
  const unpriced = new Set();
  const priced = (r) => { try { return cost(r, pricesFor(r.model, table)); } catch { unpriced.add(r.model ?? 'unknown'); return 0; } };
  const compactions = boundaries.map((b, i) => {
    const since = i === 0 ? 0 : boundaries[i - 1].ts + STORE_SLACK_MS;
    const after = main.find((r) => r.start > b.ts);
    const mine = calls.filter((c) => c.ts > since && c.ts <= b.ts + STORE_SLACK_MS);
    const frontier = [...new Set(mine.map(writerOf).filter(Boolean))];
    // A fork's request is awaited inside the compaction ask, so the boundary's own duration already holds it.
    const inside = mine.some((c) => c.writer === 'fork');
    const summarizer = requests.filter((r) => /compact/i.test(r.source ?? '') && r.end >= b.ts - (b.durationMs ?? 0) - 5000 && r.end <= b.ts + 5000);
    const kind = frontier.length > 0 ? 'frontier' : summarizer.length > 0 ? 'native' : 'mechanical';
    const row = {
      at: b.ts, trigger: b.trigger ?? null, kind,
      boundary: { preTokens: b.preTokens ?? null, postTokens: b.postTokens ?? null, durationMs: b.durationMs ?? null },
      contextAfter: context(after), contextAfterSource: 'the first main request after the boundary: input + cache read + cache write',
      afterCacheWrite: after?.cacheWrite ?? null,
    };
    const made = kind === 'frontier' ? frontier : summarizer;
    row.requests = made.length;
    row.stallMs = kind === 'frontier' && !inside ? made.reduce((s, r) => s + (r.durationMs ?? 0), 0) + (b.durationMs ?? 0) : b.durationMs ?? null;
    row.stallSource = kind === 'frontier' && !inside ? 'duration_ms of the requests that wrote the frontier + compact_boundary durationMs (the install)' : inside ? 'compact_boundary durationMs (the fork request runs inside it)' : 'compact_boundary durationMs';
    row.contextRead = made.reduce((s, r) => s + context(r), 0);
    row.written = made.reduce((s, r) => s + r.output, 0);
    row.writtenSource = kind === 'mechanical' ? 'mechanical wake: no request writes it' : `output_tokens of the ${kind === 'frontier' ? 'frontier' : 'summarizer'} requests`;
    row.cost = made.reduce((s, r) => s + priced(r), 0) + rebuildCost(after, p);
    row.costSource = `usage of the ${kind === 'frontier' ? 'frontier' : kind === 'native' ? 'summarizer' : 'no'} requests + uncached input and cache write of the first main request after`;
    return row;
  });
  const sum = (f) => requests.reduce((s, r) => s + f(r), 0);
  // Every request at its own model's prices: Claude Code's side requests (a title, a classifier) run on other models.
  const start = run.turns[0]?.at ?? requests[0]?.start, end = run.stops.at(-1) ?? requests.at(-1)?.end;
  const bySource = {};
  for (const r of requests) bySource[r.source ?? 'unknown'] = (bySource[r.source ?? 'unknown'] ?? 0) + 1;
  return {
    arm: run.info.arm, seed: run.info.seed, claude: run.info.claude, model, effort: main[0]?.effort ?? null, prices: p,
    compactions,
    run: {
      wallMs: end - start, wallSource: 'driver turns.log first send to the last Stop hook mark',
      requests: requests.length, requestsBySource: bySource, compactions: boundaries.length, turnsDone: run.stops.length, turnsSent: run.turns.length,
      tokens: { input: sum((r) => r.input), cacheRead: sum((r) => r.cacheRead), cacheWrite: sum((r) => r.cacheWrite), output: sum((r) => r.output) },
      cost_usd: sum(priced), costSource: "every api_request priced at its model's row of the prices table", unpricedModels: [...unpriced],
      reportedUsd: sum((r) => r.reportedUsd ?? 0), reportedSource: "Claude Code's own cost_usd, summed (a cross-check)",
      apiErrors: run.apiErrors.length + run.requestErrors.length, apiErrorSample: [...run.apiErrors.map((e) => e.text), ...run.requestErrors.map((e) => e.error)].slice(0, 3),
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node meter.mjs <run-dir>'); process.exit(2); }
  console.log(JSON.stringify(meter(dir, readJson(process.env.BENCH_PRICES || join(here, 'prices.json'))), null, 2));
}
