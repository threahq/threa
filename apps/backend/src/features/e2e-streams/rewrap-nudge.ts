import type { Querier } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { RewrapNotificationsRepository } from "./rewrap-notifications-repository"

/** How long a socket nudge for one root stream suppresses the next one. */
export const REWRAP_SOCKET_REEMIT_MS = 5 * 60 * 1000

/**
 * Tell the owner's online tab that an actor on `rootStreamId` holds a live key
 * with no wrap of the stream key, so only that unlocked device can re-wrap
 * (neither the enclave nor a bot can seal the SSK to itself, INV-E7).
 *
 * Both callers — the enclave's unservable-turn sweep and a bot runtime
 * registering a key it has never held — go through here so the dedup claim and
 * the outbox insert always share the caller's transaction (INV-7): the clock
 * can never advance without the event that justifies it. Returns whether this
 * call won the emit.
 */
export async function emitRewrapSocketNudge(
  tx: Querier,
  params: { workspaceId: string; rootStreamId: string; ownerUserId: string }
): Promise<boolean> {
  const claimed = await RewrapNotificationsRepository.claimSocketNudge(tx, {
    workspaceId: params.workspaceId,
    rootStreamId: params.rootStreamId,
    reemitMs: REWRAP_SOCKET_REEMIT_MS,
  })
  if (!claimed) return false
  await OutboxRepository.insert(tx, "e2e:rewrap_needed", {
    workspaceId: params.workspaceId,
    targetUserId: params.ownerUserId,
    rootStreamId: params.rootStreamId,
  })
  return true
}
