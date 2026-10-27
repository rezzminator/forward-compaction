import { describe, expect, it } from 'vitest';
import { bounded, unlessAborted } from '../plugins/forward-compaction/src/bounded.ts';

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

describe('bounded with a signal', () => {
  it('ends the wait at once when the signal aborts, though the promise never settles and the timer never fires', async () => {
    const { timers, after } = clock();
    const controller = new AbortController();
    const hung = Symbol('hung');
    const waiting = bounded(new Promise<string>(() => {}), 5_000, after, controller.signal);
    controller.abort();
    const out = await Promise.race([waiting, new Promise((resolve) => setTimeout(() => resolve(hung), 50))]);
    expect(out).toEqual({ timedOut: true, aborted: true });
    expect(timers.every((t) => t.cancelled)).toBe(true);
  });

  it('sets no timer for a signal that has already aborted', async () => {
    const { timers, after } = clock();
    await expect(bounded(new Promise<string>(() => {}), 5_000, after, AbortSignal.abort())).resolves.toEqual({ timedOut: true, aborted: true });
    expect(timers).toEqual([]);
  });
});

describe('unlessAborted', () => {
  it('gives the value of a promise that settles first, and passes a rejection on', async () => {
    const controller = new AbortController();
    await expect(unlessAborted(Promise.resolve('read'), controller.signal)).resolves.toEqual({ value: 'read' });
    await expect(unlessAborted(Promise.reject(new Error('no')), controller.signal)).rejects.toThrow('no');
  });

  it('gives undefined once the signal aborts, though the promise never settles', async () => {
    const controller = new AbortController();
    const hung = Symbol('hung');
    const waiting = unlessAborted(new Promise<string>(() => {}), controller.signal);
    controller.abort();
    expect(await Promise.race([waiting, new Promise((resolve) => setTimeout(() => resolve(hung), 50))])).toBeUndefined();
  });
});
