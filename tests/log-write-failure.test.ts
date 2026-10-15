import { describe, expect, it } from 'vitest';
import { register } from '../plugins/sub-agent-compact/hooks/sub-agent-compact.ts';
import { optionVars } from './option-env.ts';

// A log directory that cannot be written fails every flush the same way. The person is told once per
// distinct failure, not on every row, while every hook keeps deciding as if the log were fine.

type AnyHook = (...args: any[]) => any;

function engine(writeError: () => Error) {
  const hooks = new Map<string, AnyHook>();
  const shown: string[] = [];
  const $ = {
    session: {
      id: async () => 'session-1',
      turns: async () => 1,
      cwd: async () => '/nowhere',
      usage: async () => ({ context: { tokens: 0, window: 1_000_000 } }),
      messages: async () => [],
      compact: async () => ({}),
    },
    env: { get: async (name: string) => optionVars({ logFile: '/logs/decisions.jsonl' })[name] },
    settings: { read: async () => ({}) },
    fs: {
      exists: async () => false,
      read: async () => '',
      write: async () => {},
      list: async () => [],
    },
    // The append script's failure: its first stderr line is the reason.
    process: {
      run: async (argv: string[]) => argv[3] === 'decision-log' ? { exitCode: 1, stdout: '', stderr: `${writeError().message}\n` } : { exitCode: 0, stdout: '', stderr: '' },
    },
    clock: { after: (ms: number, fn: () => void) => ({ cancel: () => clearTimeout(setTimeout(fn, ms)) }) },
    ui: { log: (line: string) => void shown.push(line) },
    agent: { list: async () => [] },
    tool: { register: async (spec: { name: string }) => ({ tool: `mcp__sub-agent-compact__${spec.name}` }) },
  };
  register(((event: string, hook: AnyHook) => void hooks.set(event, hook)) as never, {} as never);
  const dispatch = (event: string, e: unknown, impl: (e: any) => any): any => {
    const next = Object.assign((input: unknown) => impl(input), { signal: new AbortController().signal });
    const hook = hooks.get(event);
    return hook ? hook($, e, next) : impl(e);
  };
  return {
    shown,
    start: () => dispatch('session.start', {}, async () => ({})),
    ask: async () => {
      const result = await dispatch('session.compact', { trigger: 'auto', messages: [{ role: 'user', text: 'go', toolUses: [], handle: 'm0' }] }, async () => ({
        messages: [{ role: 'user', text: 'summary', toolUses: [] }],
        tokensAfter: 9_000,
      }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      return result;
    },
  };
}

const failures = (shown: string[]) => shown.filter((line) => line.includes('writing the decision log'));

describe('a decision log that cannot be written, through the adapter', () => {
  it('tells the person once for the same failure across many rows', async () => {
    const cc = engine(() => new Error('EACCES: permission denied'));
    await cc.start();
    for (let i = 0; i < 4; i++) await cc.ask();
    expect(failures(cc.shown)).toEqual(['writing the decision log for /logs/decisions.jsonl failed: EACCES: permission denied']);
  });

  it('tells the person once when the same failure carries a varying number', async () => {
    let size = 4_194_304;
    const cc = engine(() => new Error(`EFBIG: ${size++} bytes, over the 4 MiB limit`));
    await cc.start();
    for (let i = 0; i < 4; i++) await cc.ask();
    expect(failures(cc.shown)).toEqual(['writing the decision log for /logs/decisions.jsonl failed: EFBIG: 4194304 bytes, over the 4 MiB limit']);
  });

  it('tells the person again when the failure is a different one', async () => {
    let n = 0;
    const cc = engine(() => new Error(n++ < 2 ? 'EACCES: permission denied' : 'ENOSPC: no space left'));
    await cc.start();
    for (let i = 0; i < 6; i++) await cc.ask();
    expect(failures(cc.shown)).toEqual([
      'writing the decision log for /logs/decisions.jsonl failed: EACCES: permission denied',
      'writing the decision log for /logs/decisions.jsonl failed: ENOSPC: no space left',
    ]);
  });
});
