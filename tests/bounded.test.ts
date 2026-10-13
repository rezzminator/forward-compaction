import { describe, expect, it } from 'vitest';
import { bounded } from '../plugins/sub-agent-compact/src/bounded.ts';

// The hooks' environment has no setTimeout: the wait is `$.clock.after`, passed in.
function clock() {
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const after = (ms: number, fn: () => void) => {
    const timer = { ms, fn, cancelled: false };
    timers.push(timer);
    return { cancel: () => void (timer.cancelled = true) };
  };
  return { timers, after };
}

describe('bounded', () => {
  it('gives the value of a promise that settles in time, and cancels its timer', async () => {
    const { timers, after } = clock();
    await expect(bounded(Promise.resolve('registered'), 5_000, after)).resolves.toEqual({ timedOut: false, value: 'registered' });
    expect(timers.map((t) => [t.ms, t.cancelled])).toEqual([[5_000, true]]);
  });

  it('reports a timeout, never a value, for a promise that does not settle before its timer fires', async () => {
    const { timers, after } = clock();
    let outcome: unknown;
    void bounded(new Promise<string>(() => {}), 5_000, after).then((o) => (outcome = o));
    await Promise.resolve();
    expect(outcome).toBeUndefined();
    timers[0]!.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome).toEqual({ timedOut: true });
  });

  it('passes on the rejection of a promise that fails in time, and cancels its timer', async () => {
    const { timers, after } = clock();
    await expect(bounded(Promise.reject(new Error('session not bound')), 5_000, after)).rejects.toThrow('session not bound');
    expect(timers.every((t) => t.cancelled)).toBe(true);
  });
});
