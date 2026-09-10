/**
 * Namespace for the `localStorage` that belongs to one signed-in account: two
 * accounts share one origin, so a key that does not name its writer is read by
 * whoever signs in next.
 *
 * The active account is a pointer whose only writer is `AccountScopeProvider`,
 * set during its render before the keyed subtree mounts, so a switch redirects
 * reads and writes atomically — the same single-owner scope bridge as the `db`
 * proxy in `db/database.ts`, and the same deliberate INV-9 exception.
 *
 * With no account resolved there is no key at all: reads answer empty, writes
 * are dropped, and pre-namespace records stay unreachable. A fallback key would
 * be a guess at an owner, which is the leak itself.
 */

const PREFIX = "threa:acct:"

let owner: string | null = null

/** AccountScope-only: name the account whose stored state is in scope. */
export function setStorageAccount(workosUserId: string | null): void {
  owner = workosUserId
}

/** The active account's key for `suffix`, or null when no account owns the tab. */
export function accountStorageKey(suffix: string): string | null {
  return owner ? `${PREFIX}${owner}:${suffix}` : null
}
