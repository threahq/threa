import { ACCOUNT_ASSERTION_HEADER } from "@threahq/types"

/**
 * The account this client believes its session cookie belongs to, stated on
 * every request it forms. A browser signed in to several accounts shares one
 * cookie, so a request formed under account A and sent after a switch would
 * otherwise execute as account B with nothing on the wire to tell them apart.
 *
 * `AuthProvider` is the single writer, and it publishes the value synchronously
 * with the identity, never from an effect: a request issued by the first render
 * under the new account would otherwise still assert the outgoing one. Same
 * shape as the active-db pointer (`db/database.ts`): a deliberate single-owner
 * scope bridge, not hidden state (INV-9).
 */
let assertedAccountId: string | null = null
let accountGeneration = 0

type MismatchListener = () => void
const mismatchListeners = new Set<MismatchListener>()

/** AuthProvider-only: state which account this client's requests belong to. */
export function setAssertedAccount(workosUserId: string | null): void {
  if (assertedAccountId !== workosUserId) accountGeneration += 1
  assertedAccountId = workosUserId
}

export function getAccountAssertionGeneration(): number {
  return accountGeneration
}

/** The asserted account, for callers that build their own transport. */
export function getAssertedAccount(): string | null {
  return assertedAccountId
}

/** Assertion headers for a request formed right now; empty pre-auth. */
export function accountAssertionHeaders(): Record<string, string> {
  return assertedAccountId ? { [ACCOUNT_ASSERTION_HEADER]: assertedAccountId } : {}
}

/**
 * The server refused a request because its cookie names a different account —
 * this client is behind (another tab switched, or a session rotated). The
 * refusal is not a verdict on the request: work stays queued for the account
 * that formed it, and the identity owner revalidates so this tab catches up.
 */
export function reportAccountMismatch(): void {
  for (const listener of mismatchListeners) listener()
}

export function subscribeAccountMismatch(listener: MismatchListener): () => void {
  mismatchListeners.add(listener)
  return () => mismatchListeners.delete(listener)
}
