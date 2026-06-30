import { useEffect, useRef } from "react"

/**
 * Heal a missed/raced conversation assignment so "Show in conversation" resolves
 * without a manual reload. The per-stream conversation list is a one-time fetch
 * plus live `conversation:*` events; a message sent from another surface (e.g. a
 * board reply, then opening the DM) can land before the list's fetch sees it and
 * after the live event was delivered to a room the sender wasn't yet in. When the
 * viewer's own newest message (`latestOwnMessageId`) isn't mapped yet, refetch
 * the list once for it.
 *
 * Scoped to the viewer's own send (the case users notice) so an ambient
 * unassigned message from others doesn't trigger refetches, and ref-guarded so a
 * genuinely unassigned message refetches at most once — the guard re-arms for a
 * newer message id.
 */
export function useConversationMembershipHeal({
  enabled,
  latestOwnMessageId,
  conversationIdByMessageId,
  refetch,
}: {
  enabled: boolean
  latestOwnMessageId: string | null
  conversationIdByMessageId: ReadonlyMap<string, string>
  refetch: () => void
}): void {
  const healedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled || !latestOwnMessageId) return
    if (conversationIdByMessageId.has(latestOwnMessageId)) {
      healedForRef.current = latestOwnMessageId
      return
    }
    if (healedForRef.current === latestOwnMessageId) return
    healedForRef.current = latestOwnMessageId
    refetch()
  }, [enabled, latestOwnMessageId, conversationIdByMessageId, refetch])
}
