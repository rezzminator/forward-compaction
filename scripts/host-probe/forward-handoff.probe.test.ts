import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

// Probe of an installed copy: load its hooks module with no options and
// SUB_AGENT_COMPACT_FORWARD_HANDOFF_TOOL=1 alone, start a session, and report whether
// forward_handoff was registered. Not part of `npm test`; run from the repo root:
//   SUB_AGENT_COMPACT_PROBE_DIR=<installed plugin directory> npx vitest run --dir scripts/host-probe

type AnyHook = (...args: any[]) => any;

const dir = process.env.SUB_AGENT_COMPACT_PROBE_DIR;

it('the installed copy registers forward_handoff from SUB_AGENT_COMPACT_FORWARD_HANDOFF_TOOL=1 alone', async () => {
  if (!dir) throw new Error('SUB_AGENT_COMPACT_PROBE_DIR must name the plugin directory (the one holding hooks/sub-agent-compact.ts)');
  const { register } = (await import(pathToFileURL(join(dir, 'hooks/sub-agent-compact.ts')).href)) as { register: (on: AnyHook, options: Record<string, unknown>) => void };
  const hooks = new Map<string, AnyHook>();
  const registered: string[] = [];
  const screen: string[] = [];
  const vars: Record<string, string> = { SUB_AGENT_COMPACT_FORWARD_HANDOFF_TOOL: '1', HOME: '/probe-home' };
  const $ = {
    session: { id: async () => 'probe', cwd: async () => '/probe', usage: async () => ({ context: { tokens: 0, window: 1_000_000 } }) },
    env: { get: async (name: string) => vars[name] },
    fs: { exists: async () => false, read: async () => '', write: async () => {}, list: async () => [], stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0, isLink: false }) },
    process: { run: async () => ({ exitCode: 1, stdout: '', stderr: '' }) },
    clock: { now: async () => Date.now(), after: (ms: number, fn: () => void) => ({ cancel: clearTimeout.bind(null, setTimeout(fn, ms)) }) },
    ui: { log: (line: string) => void screen.push(line) },
    agent: { list: async () => [] },
    tool: { register: async (spec: { name: string }) => (registered.push(spec.name), { tool: `mcp__sub-agent-compact__${spec.name}` }) },
  };
  register((event: string, hook: AnyHook) => void hooks.set(event, hook), {});
  const next = Object.assign(async () => ({}), { signal: new AbortController().signal });
  await hooks.get('session.start')!($, {}, next);
  process.stdout.write(`HOST-PROBE ${dir}: forward_handoff registered=${registered.includes('forward_handoff')} tools=${registered.sort().join(',')}\n`);
  expect(registered).toContain('forward_handoff');
});
