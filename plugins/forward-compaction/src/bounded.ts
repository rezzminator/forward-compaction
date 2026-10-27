/** `$.clock.after`: the hooks' environment has no `setTimeout`, so the wait is passed in. */
export type After = (ms: number, fn: () => void) => { cancel: () => void };

/** `aborted`: the wait ended because the hook's signal aborted, not because the time ran out. */
export type Bounded<T> = { timedOut: true; aborted?: true } | { timedOut: false; value: T };

/**
 * The promise's value if it settles within `ms`, else `{ timedOut: true }`.
 * A rejection passes on. The timer is cancelled whichever way it ends; the
 * promise itself is not cancelled and may settle later.
 *
 * With a `signal`, its abort ends the wait at once as `{ timedOut: true, aborted: true }`:
 * the timer belongs to the dispatch that was aborted and may never fire, and a
 * hook that waits on past its abort is a runaway to the hooks worker.
 */
export async function bounded<T>(promise: Promise<T>, ms: number, after: After, signal?: AbortSignal): Promise<Bounded<T>> {
  let timer: { cancel: () => void } | undefined;
  let onAbort: (() => void) | undefined;
  const limit = new Promise<{ timedOut: true; aborted?: true }>((resolve) => {
    if (signal !== undefined) {
      onAbort = () => resolve({ timedOut: true, aborted: true });
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (signal?.aborted !== true) timer = after(ms, () => resolve({ timedOut: true }));
  });
  try {
    return await Promise.race([promise.then((value) => ({ timedOut: false as const, value })), limit]);
  } finally {
    timer?.cancel();
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * The promise's value, or `undefined` once `signal` aborts first (at once when it already has). A rejection passes on;
 * the promise itself is not cancelled and may settle later. No timer: this is for a hook's hot path, where a wait
 * past the dispatch's abort is a runaway to the hooks worker.
 */
export async function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<{ value: T } | undefined> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise.then((value) => ({ value })), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}
