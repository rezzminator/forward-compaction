/** `$.clock.after`: the hooks' environment has no `setTimeout`, so the wait is passed in. */
export type After = (ms: number, fn: () => void) => { cancel: () => void };

export type Bounded<T> = { timedOut: true } | { timedOut: false; value: T };

/**
 * The promise's value if it settles within `ms`, else `{ timedOut: true }`.
 * A rejection passes on. The timer is cancelled whichever way it ends; the
 * promise itself is not cancelled and may settle later.
 */
export async function bounded<T>(promise: Promise<T>, ms: number, after: After): Promise<Bounded<T>> {
  let timer: { cancel: () => void } | undefined;
  const limit = new Promise<{ timedOut: true }>((resolve) => {
    timer = after(ms, () => resolve({ timedOut: true }));
  });
  try {
    return await Promise.race([promise.then((value) => ({ timedOut: false as const, value })), limit]);
  } finally {
    timer?.cancel();
  }
}
