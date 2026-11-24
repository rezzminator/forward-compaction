// Reads one run folder's records: the main chain of transcript.jsonl (tool calls, compact boundaries), the API
// requests otlp.mjs received (otel.jsonl: every request's usage and duration, the summarizer's and one the
// transcript never wrote included), the plugin's `stored` rows, the driver's turns.log and the Stop hook's
// stops.txt. Pure reads; meter.mjs and score.mjs both start here.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ms = (ts) => new Date(ts).getTime();
const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()) : []);

export function readRun(dir) {
  const rows = [];
  for (const [i, l] of lines(join(dir, 'transcript.jsonl')).entries()) {
    try { rows.push({ line: i + 1, ...JSON.parse(l) }); } catch (error) { throw new Error(`${dir}/transcript.jsonl:${i + 1}: ${error.message}`); }
  }
  const main = rows.filter((r) => r.isSidechain !== true && r.timestamp);
  const tools = [];
  for (const r of main) {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    for (const c of r.message.content) if (c.type === 'tool_use') tools.push({ ts: ms(r.timestamp), line: r.line, id: c.id, name: c.name, input: c.input ?? {}, message: r.message.id });
  }
  const boundaries = main.filter((r) => r.type === 'system' && r.subtype === 'compact_boundary').map((r) => ({ ts: ms(r.timestamp), line: r.line, ...r.compactMetadata }));
  const requests = lines(join(dir, 'otel.jsonl')).map((l) => JSON.parse(l)).filter((e) => e['event.name'] === 'api_request').map((e) => ({
    end: e.ts, start: e.ts - (e.duration_ms ?? 0), durationMs: e.duration_ms ?? null, source: e.query_source ?? null, model: e.model, effort: e.effort ?? null,
    input: e.input_tokens ?? 0, cacheRead: e.cache_read_tokens ?? 0, cacheWrite: e.cache_creation_tokens ?? 0,
    cacheWrite5m: e.cache_creation_5m_tokens ?? null, cacheWrite1h: e.cache_creation_1h_tokens ?? null, output: e.output_tokens ?? 0, reportedUsd: e.cost_usd ?? null,
  })).sort((a, b) => a.end - b.end);
  const requestErrors = lines(join(dir, 'otel.jsonl')).map((l) => JSON.parse(l)).filter((e) => e['event.name'] === 'api_error').map((e) => ({ ts: e.ts, error: String(e.error ?? '').slice(0, 200), status: e.status_code ?? null }));
  // The plugin's own record of each forward_compaction call, written even when the transcript lost the call's row; `writer` `fork` is a frontier `$.model.fork` wrote.
  const stored = lines(join(dir, 'logs', 'forward-compaction', 'debug.jsonl')).map((l) => JSON.parse(l)).filter((r) => (r.detail?.event ?? r.event) === 'stored' && r.detail?.party === 'main').map((r) => ({ ts: ms(r.ts), compacts: r.detail.compacts ?? null, writer: r.detail.writer ?? 'model' }));
  const apiErrors = main.filter((r) => r.isApiErrorMessage === true).map((r) => ({ ts: ms(r.timestamp), text: JSON.stringify(r.message?.content ?? '').slice(0, 200) }));
  const turns = lines(join(dir, 'turns.log')).map((l) => { const [id, at] = l.split(' '); return { id, at: Number(at) }; });
  const stops = lines(join(dir, 'stops.txt')).map(Number);
  return { rows, main, requests, requestErrors, stored, tools, boundaries, apiErrors, turns, stops, info: JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) };
}

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
