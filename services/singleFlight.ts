/**
 * Allows one asynchronous operation at a time.
 *
 * A second call made while the first is still pending is ignored (it
 * resolves immediately with `{ started: false }`) instead of queuing or
 * running in parallel. The lock is held synchronously, so two clicks in
 * the same tick cannot both start, which a React state flag alone cannot
 * guarantee before the next render. It is always released, including
 * when the operation throws.
 */
export interface SingleFlight {
  /** True while an operation is pending. */
  readonly busy: boolean;
  run<T>(operation: () => Promise<T>): Promise<{ started: false } | { started: true; value: T }>;
}

export function createSingleFlight(): SingleFlight {
  let busy = false;

  return {
    get busy() {
      return busy;
    },

    async run<T>(operation: () => Promise<T>) {
      if (busy) return { started: false as const };

      busy = true;
      try {
        const value = await operation();
        return { started: true as const, value };
      } finally {
        busy = false;
      }
    }
  };
}
