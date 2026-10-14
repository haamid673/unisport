/**
 * Notices for user-initiated actions (reserve, join, leave, accept).
 *
 * The booking flow and the waitlist flow each keep one state of the
 * shape { phase: 'idle' | 'submitting' | 'success' | 'error' }. They
 * are independent states, so a result from one never replaced the
 * other's: an old "slot was just taken" error stayed on screen beside a
 * later "you're on the waitlist" success.
 *
 * Rule: a finished notice (success or error) is obsolete the moment the
 * user starts another action, so starting one clears the other flow's
 * finished notice. A request that is still in flight is never touched,
 * because its buttons and aria-busy state depend on it and it will
 * report its own result.
 *
 * Pure so the rule is testable without a DOM.
 */
export function clearFinishedFlow<T extends { phase: string }>(
  flow: T,
  idle: T
): T {
  return flow.phase === 'submitting' ? flow : idle;
}

/**
 * "Latest action wins" for notices that are published when an action
 * FINISHES (the owner portal).
 *
 * Every action takes a token when it starts, and clears the notice of
 * earlier, finished actions at that moment. When its request settles it
 * may publish its result only while its token is still the newest:
 * a slow, older request can then never overwrite the notice of a newer
 * action. An action that is still running has no notice yet, so there is
 * nothing in flight to clear.
 *
 * Pure (no React), so the rule is testable without a DOM.
 */
export function createActionSequence() {
  let latest = 0;

  return {
    /** Start an action; returns its token. */
    begin(): number {
      latest += 1;
      return latest;
    },
    /** True while no newer action has started since `token`. */
    isCurrent(token: number): boolean {
      return token === latest;
    }
  };
}
