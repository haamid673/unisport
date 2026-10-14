import { describe, it, expect } from 'vitest';
import { createSingleFlight } from '../singleFlight';

const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('createSingleFlight', () => {
  it('ignores a second call while the first is pending', async () => {
    const guard = createSingleFlight();
    const gate = deferred<string>();
    let calls = 0;

    const first = guard.run(async () => {
      calls++;
      return gate.promise;
    });

    expect(guard.busy).toBe(true);

    // the double click: synchronous, same tick
    const second = await guard.run(async () => {
      calls++;
      return 'second';
    });

    expect(second).toEqual({ started: false });
    expect(calls).toBe(1);

    gate.resolve('done');
    await expect(first).resolves.toEqual({ started: true, value: 'done' });
    expect(guard.busy).toBe(false);
  });

  it('allows another run once the first has settled', async () => {
    const guard = createSingleFlight();
    await guard.run(async () => 1);
    const again = await guard.run(async () => 2);
    expect(again).toEqual({ started: true, value: 2 });
  });

  it('releases the lock when the operation throws', async () => {
    const guard = createSingleFlight();

    await expect(
      guard.run(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(guard.busy).toBe(false);
    await expect(guard.run(async () => 'ok')).resolves.toEqual({
      started: true,
      value: 'ok'
    });
  });
});
