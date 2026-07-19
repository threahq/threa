import type { Querier } from "../../db"
import { checkStreamAccess } from "../streams"
import { CallRepository, type Call } from "./repository"

/**
 * Access decision for a call sub-resource: the call itself (never the host
 * stream row — callers gate on call state, not stream state).
 */
export interface CallAccessResult {
  call: Call
}

/**
 * Canonical "can this user act on this call?" check. v1 rule (guests deferred):
 * host-stream access is the only leg, resolved through the canonical
 * `checkStreamAccess` predicate (INV-35/62) — never a parallel membership check.
 * The invite-as-grant leg lands with the guest design.
 *
 * Returns the call when access is granted; `null` on a missing/cross-workspace
 * call (INV-8) or when the user cannot see the host stream. Takes a `Querier` so
 * it composes inside the join/leave transactions without a second connection.
 */
export async function checkCallAccess(
  db: Querier,
  params: { workspaceId: string; userId: string; callId: string }
): Promise<CallAccessResult | null> {
  const call = await CallRepository.findById(db, params.workspaceId, params.callId)
  if (!call) return null

  const stream = await checkStreamAccess(db, call.streamId, params.workspaceId, params.userId)
  if (!stream) return null

  return { call }
}
