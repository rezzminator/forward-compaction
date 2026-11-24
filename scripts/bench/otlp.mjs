#!/usr/bin/env node
// A local OTLP/HTTP JSON receiver: Claude Code's telemetry log events (one `api_request` per API request, the
// compaction summarizer's too, with its tokens and duration) are appended, one exported record per line, to a
// file. Hand-written on node:http: the benchmark takes no dependency and needs only the JSON body as sent.
// Only `api_request` and `api_error` records are kept, each with only the attributes in KEEP: no account or
// organization identity leaves the export.
// Usage: node otlp.mjs <out.jsonl> <port-file>   (listens on 127.0.0.1, a free port, written to <port-file>)
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [out, portFile] = process.argv.slice(2);
if (!out || !portFile) { console.error('usage: node otlp.mjs <out.jsonl> <port-file>'); process.exit(2); }

/** OTLP's AnyValue as a plain value. */
const value = (v) => (v == null ? null : 'stringValue' in v ? v.stringValue : 'intValue' in v ? Number(v.intValue) : 'doubleValue' in v ? v.doubleValue : 'boolValue' in v ? v.boolValue : JSON.stringify(v));
const KEEP = new Set(['event.name', 'event.timestamp', 'event.sequence', 'prompt.id', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cache_creation_5m_tokens', 'cache_creation_1h_tokens', 'cost_usd', 'duration_ms', 'ttft_ms', 'request_id', 'speed', 'query_source', 'effort', 'error', 'status_code', 'attempt']);
const EVENTS = new Set(['claude_code.api_request', 'claude_code.api_error']);
const attrs = (list) => Object.fromEntries((list ?? []).filter((a) => KEEP.has(a.key)).map((a) => [a.key, value(a.value)]));

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      for (const rl of body.resourceLogs ?? []) for (const sl of rl.scopeLogs ?? []) for (const r of sl.logRecords ?? []) {
        if (!EVENTS.has(value(r.body))) continue;
        appendFileSync(out, JSON.stringify({ ts: Number(BigInt(r.timeUnixNano ?? r.observedTimeUnixNano ?? 0) / 1_000_000n), body: value(r.body), ...attrs(r.attributes) }) + '\n');
      }
    } catch (error) {
      appendFileSync(out, JSON.stringify({ receiverError: error.message, path: req.url }) + '\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
server.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port)));
