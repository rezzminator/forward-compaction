import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeEngine, usage } from './fakes/engine.ts';

// A decision log that cannot be written fails every append the same way. The person is told once per distinct
// failure, not on every row, while every hook keeps deciding as if the log were fine.

type Fake = ReturnType<typeof fakeEngine>;
const fakes: Fake[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) {
    expect(f.unscripted, 'every $ call the plugin made was scripted').toEqual([]);
    f.cleanup();
  }
});

/** An engine whose decision-log append fails with `writeError()` until `healed.on`, then succeeds; a level-log append succeeds unrun (each decision row is a level row too, and 2,000 real appends outrun the bound); every other run is real. */
function engine(writeError: () => string) {
  const healed = { on: false };
  const ok = { exitCode: 0, stdout: '', stderr: '' };
  const f = fakeEngine({
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', FORWARD_COMPACTION_LOG_FILE: '/logs/decisions.jsonl' },
    run: (argv) => (argv[3] === 'plugin-log' ? ok : argv[3] !== 'decision-log' ? undefined : healed.on ? ok : { exitCode: 1, stdout: '', stderr: `${writeError()}\n` }),
  });
  fakes.push(f);
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    healed,
    texts: f.texts,
    start: async () => { await f.dispatch('session.start', { reason: 'startup' }, async () => ({})); await settle(); },
    // A manual /compact: one decision row, passed to Claude Code.
    ask: async () => {
      await f.dispatch('session.compact', { trigger: 'manual', messages: [{ role: 'user', text: 'go', toolUses: [], handle: 'm0' }] }, async () => ({ messages: [] }));
      await settle();
    },
    end: (reason = 'other') => f.dispatch('session.end', { reason }, async () => ({})),
  };
}

const PATH = '/logs/decisions.session-1.jsonl';
const failures = (texts: string[]) => texts.filter((line) => line.includes('writing the decision log'));
const lost = (texts: string[]) => texts.filter((line) => line.includes('not written to'));

describe('a decision log that cannot be written, through the adapter', () => {
  it('tells the person once for the same failure across many rows', async () => {
    const cc = engine(() => 'EACCES: permission denied');
    await cc.start();
    for (let i = 0; i < 4; i++) await cc.ask();
    expect(failures(cc.texts())).toEqual([`writing the decision log for ${PATH} failed: EACCES: permission denied; its 1 row is kept and written with the next`]);
  });

  it('tells the person once when the same failure carries a varying number', async () => {
    let size = 4_194_304;
    const cc = engine(() => `EFBIG: ${size++} bytes, over the 4 MiB limit`);
    await cc.start();
    for (let i = 0; i < 4; i++) await cc.ask();
    expect(failures(cc.texts())).toEqual([`writing the decision log for ${PATH} failed: EFBIG: 4194304 bytes, over the 4 MiB limit; its 1 row is kept and written with the next`]);
  });

  it('tells the person again when the failure is a different one, and promises no next write at session end', async () => {
    let n = 0;
    let ending = false;
    const cc = engine(() => (ending ? 'EIO: i/o error' : n++ < 2 ? 'EACCES: permission denied' : 'ENOSPC: no space left'));
    await cc.start();
    for (let i = 0; i < 6; i++) await cc.ask();
    // The session-end flush fails anew: no write follows it.
    ending = true;
    await cc.end();
    expect(failures(cc.texts())).toEqual([
      `writing the decision log for ${PATH} failed: EACCES: permission denied; its 1 row is kept and written with the next`,
      `writing the decision log for ${PATH} failed: ENOSPC: no space left; its 3 rows are kept and written with the next`,
      `writing the decision log for ${PATH} failed: EIO: i/o error`,
    ]);
  });

  it('tells the first drop past the 2,000-row hold, and counts every row lost at session end', async () => {
    const cc = engine(() => 'EACCES: permission denied');
    await cc.start();
    for (let i = 0; i < 2_003; i++) await cc.ask();
    await cc.end();
    const shown = failures(cc.texts());
    expect(shown).toHaveLength(2);
    expect(shown[1]).toMatch(/^writing the decision log for \/logs\/decisions\.session-1\.jsonl failed: EACCES: permission denied; its \d+ rows are kept and written with the next, and the 1 oldest held row was dropped past the 2000-row hold$/);
    const gone = lost(cc.texts());
    expect(gone).toHaveLength(1);
    const [, total, dropped] = /^(\d+) decision rows were not written to \/logs\/decisions\.session-1\.jsonl \((\d+) of them dropped past the 2000-row hold\): EACCES: permission denied$/.exec(gone[0]!) ?? [];
    expect(Number(dropped)).toBeGreaterThanOrEqual(3);
    expect(Number(total)).toBe(2_000 + Number(dropped));
  }, 30_000);

  it('starts a cleared session with no loss carried over from the one before it', async () => {
    const cc = engine(() => 'EACCES: permission denied');
    await cc.start();
    for (let i = 0; i < 2_003; i++) await cc.ask();
    await cc.end('clear');
    cc.healed.on = true;
    await cc.ask();
    await cc.end();
    expect(lost(cc.texts())).toHaveLength(1);
  }, 30_000);
});

describe('a plugin log that cannot be written, through the adapter', () => {
  it('drops past the 2,000-row hold and writes the exact dropped count to errors.jsonl once a write succeeds', async () => {
    const failing = { on: false };
    const ok = { exitCode: 0, stdout: '', stderr: '' };
    const f = fakeEngine({
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', FORWARD_COMPACTION_LOG_FILE: '/logs/decisions.jsonl' },
      run: (argv) => (argv[3] === 'decision-log' ? ok : argv[3] === 'plugin-log' && failing.on ? { exitCode: 1, stdout: '', stderr: 'lock held by another writer\n' } : undefined),
    });
    fakes.push(f);
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const ask = async () => {
      await f.dispatch('session.compact', { trigger: 'manual', messages: [{ role: 'user', text: 'go', toolUses: [], handle: 'm0' }] }, async () => ({ messages: [] }));
      await settle();
    };
    await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
    await settle();
    // Each manual ask offers five level rows (four debug, one info): 401 failing asks offer 2,005 rows, and the healed
    // ask's first row joins the full queue before its write succeeds, so six rows fall past the 2,000-row hold.
    failing.on = true;
    for (let i = 0; i < 401; i++) await ask();
    failing.on = false;
    await ask();
    await f.dispatch('session.end', { reason: 'other' }, async () => ({}));
    const path = join(f.home, '.local/state/forward-compaction/logs/errors.jsonl');
    const errors = (existsSync(path) ? readFileSync(path, 'utf8') : '').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(errors.filter((row) => row.event === 'plugin-log-rows-dropped').map((row) => row.detail)).toEqual([{ rows: 6 }]);
  }, 60_000);
});

describe('only errors reach the screen', () => {
  const A1 = 'a1b2c3d4e5';
  const ok = { exitCode: 0, stdout: '', stderr: '' };
  async function engine() {
    const failing = { on: false };
    const f = fakeEngine({
      window: 1_000_000,
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', FORWARD_COMPACTION_LOG_FILE: '/logs/decisions.jsonl' },
      run: (argv) => (argv[3] === 'decision-log' ? ok : argv[3] === 'plugin-log' && failing.on ? { exitCode: 1, stdout: '', stderr: 'lock held by another writer\n' } : undefined),
    });
    fakes.push(f);
    await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const step = async (tokens: number, agentId?: string) => {
      await f.dispatch('turn.step', { turnId: 't1', index: 0, model: 'claude-sonnet-4-5', messageCount: 4, ...(agentId ? { agentId } : {}) }, async () => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(tokens) }));
      await settle();
    };
    // An info row: a Read of the session's own transcript is a look back by hand.
    const lookByHand = async () => { await f.dispatch('tool.call', { tool: 'Read', tool_use_id: 'tu-r', file_path: '/t/session-1.jsonl' }, async () => ({ result: 'x' })); await settle(); };
    return { f, failing, step, lookByHand, settle };
  }
  const streak = (texts: string[]) => texts.filter((line) => /^plugin log .* failed: lock held by another writer/.test(line));

  it('keeps info rows off the screen while the plugin log fails, and says the failing log once per streak', async () => {
    const { f, failing, lookByHand } = await engine();
    failing.on = true;
    await lookByHand(); await lookByHand();
    expect(streak(f.texts())).toHaveLength(1);
    failing.on = false;
    await lookByHand();
    failing.on = true;
    await lookByHand();
    expect(streak(f.texts())).toHaveLength(2);
    expect(f.texts().filter((line) => line.includes('look back by hand'))).toEqual([]);
  });

  it('keeps warnings and the mechanical landed line off the screen, and shows an error', async () => {
    const { f, step } = await engine();
    await f.dispatch('agent.spawn', { tool_use_id: 'tu-spawn', prompt: 'Brief', description: 'one', subagentType: 'general-purpose', provider: { kind: 'local' } }, async () => ({ model: 'sonnet', agentId: A1 }));
    await step(120_000, A1);
    await step(30_000, A1); // a fall no compaction of ours explains: an unseen-compaction warning
    await step(650_000); // main past its 600k ceiling, no frontier: a mechanical wake, whose landed line is info
    await f.dispatch('session.compact', { trigger: 'auto', messages: [{ role: 'user', text: 'go', toolUses: [], handle: 'm0' }] }, async () => ({ messages: [] }));
    await step(40_000);
    await f.dispatch('tool.call', { tool: 'mcp__forward-compaction__forward_compaction', tool_use_id: 'tu-h', objective: 'o', done: 'd', remaining: 'r', next: 'n' }, async () => ({ result: 'not ours' }));
    await f.dispatch('session.compact', { trigger: 'manual', messages: [{ role: 'user', text: 'go', toolUses: [], handle: 'm1' }] }, async () => ({ messages: [] }));
    const texts = f.texts();
    expect(texts.filter((line) => /no compaction this plugin handled|mechanical wake installed/.test(line))).toEqual([]);
    expect(texts.filter((line) => line.includes('stored frontier was dropped'))).toHaveLength(1);
  });
});
