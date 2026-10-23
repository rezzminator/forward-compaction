import { afterEach, describe, expect, it } from 'vitest';
import { fakeEngine } from './fakes/engine.ts';

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

/** An engine whose decision-log append fails with `writeError()` until `healed.on`, then succeeds; every other run is real. */
function engine(writeError: () => string) {
  const healed = { on: false };
  const f = fakeEngine({
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', FORWARD_COMPACTION_LOG_FILE: '/logs/decisions.jsonl' },
    run: (argv) => (argv[3] !== 'decision-log' ? undefined : healed.on ? { exitCode: 0, stdout: '', stderr: '' } : { exitCode: 1, stdout: '', stderr: `${writeError()}\n` }),
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
