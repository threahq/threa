import { useEffect, useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { BoardPostMessage } from "@threa/types"
import { useConversationService } from "@/contexts/services-context"
import { conversationKeys } from "@/hooks/use-conversations"
import { seedConversationMessages } from "@/stores/conversation-messages-store"

/**
 * Whether the conversation lists a member the browser cannot render from IDB —
 * the only reason to mark the server backfill stale. Everything the rail or the
 * backfill store already holds needs no fetch.
 */
export function hasUnknownMembers(messageIds: string[], knownMessageIds: ReadonlySet<string>): boolean {
  return messageIds.some((id) => !knownMessageIds.has(id))
}

interface UseConversationBackfillOptions {
  /** Consumer-side gate: the card adds `expanded`, the panel is always open. */
  enabled: boolean
  railCoversMembership: boolean
  /** The conversation's server membership. */
  memberIds: string[]
  /** What the rail + backfill store can already render locally. */
  knownMessageIds: ReadonlySet<string>
}

/**
 * The conversation's full server window, fetched when the local rail doesn't
 * carry every member, seeded into IDB (never rendered from the response), and
 * revalidated when membership names a message nothing local can render.
 *
 * Shared by the expanded board card and the conversation panel so both fetch,
 * seed and invalidate identically.
 */
export function useConversationBackfill(
  workspaceId: string,
  conversationId: string,
  { enabled, railCoversMembership, memberIds, knownMessageIds }: UseConversationBackfillOptions
): { data: BoardPostMessage[] | undefined; isError: boolean; refetch: () => void } {
  const conversationService = useConversationService()
  const queryClient = useQueryClient()
  // The fetch gate is RAIL coverage only: the backfill store renders those bodies
  // but can't refresh them, so a warm store must not suppress the fetch that
  // brings this conversation's out-of-rail edits/deletes/reactions. `staleTime`
  // bounds the frequency; the predicate can't loop, since fetching seeds the
  // store, never the rail.
  const railIncomplete = !railCoversMembership
  const {
    data: allMessages,
    isError,
    refetch,
  } = useQuery({
    queryKey: conversationKeys.boardMessages(conversationId),
    queryFn: () => conversationService.getBoardMessages(workspaceId, conversationId),
    enabled: enabled && railIncomplete,
    staleTime: 60_000,
  })

  // Seed, don't render: the response lands in IDB and the merged view reads it
  // back, so an edit/reaction/delete on a backfilled row patches in place instead
  // of staying frozen until the next fetch.
  useEffect(() => {
    if (!allMessages) return
    void seedConversationMessages(workspaceId, conversationId, allMessages)
  }, [allMessages, workspaceId, conversationId])

  // The backfill is a 60s-stale snapshot of a growing conversation, so a member
  // it doesn't cover marks it stale. Only a member the browser can't render
  // locally does: following the raw member COUNT refetched the endpoint on every
  // arriving message, including the ones the rail had already delivered.
  const memberKey = memberIds.join(",")
  // What the browser can already answer with: the hook's local set, plus the
  // landed response itself — its rows reach `knownMessageIds` only after an async
  // IDB seed, and treating that window as "unknown" refetched the very response
  // being seeded.
  const backfillKey = allMessages?.map((m) => m.id).join(",") ?? ""
  const coveredMessageIds = useMemo<ReadonlySet<string>>(
    () => new Set([...knownMessageIds, ...(allMessages?.map((m) => m.id) ?? [])]),
    [knownMessageIds, backfillKey]
  )
  useEffect(() => {
    // Before the first response lands, the fetch the mount already started IS the
    // answer to every unknown member — invalidating here refetches it (the cold
    // open's double fetch).
    if (!allMessages) return
    if (!hasUnknownMembers(memberIds, coveredMessageIds)) return
    void queryClient.invalidateQueries({ queryKey: conversationKeys.boardMessages(conversationId) })
    // `memberKey` proxies `memberIds` (a fresh array per render) — keeping the
    // array itself here re-ran the effect on EVERY render.
  }, [queryClient, conversationId, memberKey, coveredMessageIds, allMessages])

  return { data: allMessages, isError, refetch }
}
