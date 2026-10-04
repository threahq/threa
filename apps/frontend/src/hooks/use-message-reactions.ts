import { useCallback, useMemo } from "react"
import { toast } from "sonner"
import { isPermanentApiError } from "@/api"
import { messagesApi } from "@/api/messages"
import { useWorkspaceEmoji } from "./use-workspace-emoji"
import { enqueueOperation } from "@/sync/operation-queue"
import { useSyncEngine } from "@/sync/sync-engine"
import { db } from "@/db"

/** Strip surrounding colons from a shortcode (":laughing:" → "laughing") */
export function stripColons(shortcode: string): string {
  return shortcode.startsWith(":") && shortcode.endsWith(":") ? shortcode.slice(1, -1) : shortcode
}

/** Derive the set of all reacted shortcodes (stripped) from a reactions dict. */
export function reactionShortcodes(reactions: Record<string, string[]> | null | undefined): Set<string> {
  if (!reactions) return new Set()
  return new Set(Object.keys(reactions).map(stripColons))
}

interface UseMessageReactionsResult {
  /** Add a reaction (emoji character, e.g. "👍") */
  addReaction: (emoji: string) => Promise<void>
  /** Remove a reaction (emoji character) */
  removeReaction: (emoji: string) => Promise<void>
  /** Toggle by shortcode: remove if user already reacted, add otherwise */
  toggleReaction: (
    shortcode: string,
    reactions: Record<string, string[]>,
    currentUserId: string | null
  ) => Promise<void>
  /** Toggle by emoji character: looks up the shortcode in the reactions dict,
   *  removes if user already reacted, adds otherwise */
  toggleByEmoji: (emoji: string, reactions: Record<string, string[]>, currentUserId: string | null) => Promise<void>
}

export function useMessageReactions(workspaceId: string, messageId: string): UseMessageReactionsResult {
  const { emojis, toEmoji } = useWorkspaceEmoji(workspaceId)
  const syncEngine = useSyncEngine()

  // Reverse lookup: emoji character → shortcode
  const emojiToShortcode = useMemo(() => {
    const map = new Map<string, string>()
    for (const entry of emojis) {
      map.set(entry.emoji, entry.shortcode)
    }
    return map
  }, [emojis])

  const addReaction = useCallback(
    async (emoji: string) => {
      try {
        await messagesApi.addReaction(workspaceId, messageId, emoji)
      } catch (err) {
        if (isPermanentApiError(err)) {
          toast.error("Couldn't add that reaction.")
          return
        }
        // Enqueue for retry when back online
        await enqueueOperation(workspaceId, "add_reaction", { messageId, emoji })
        syncEngine.kickOperationQueue()
      }

      // Bump the local emoji weight once the reaction is made or queued, so the
      // quick-bar re-ranks without needing a page reload. Fire-and-forget — non-critical.
      const shortcode = emojiToShortcode.get(emoji)
      if (shortcode) {
        db.workspaceMetadata.get(workspaceId).then((meta) => {
          if (!meta) return
          return db.workspaceMetadata.update(workspaceId, {
            emojiWeights: { ...meta.emojiWeights, [shortcode]: (meta.emojiWeights[shortcode] ?? 0) + 1 },
          })
        })
      }
    },
    [workspaceId, messageId, syncEngine, emojiToShortcode]
  )

  const removeReaction = useCallback(
    async (emoji: string) => {
      try {
        await messagesApi.removeReaction(workspaceId, messageId, emoji)
      } catch (err) {
        if (isPermanentApiError(err)) {
          toast.error("Couldn't remove that reaction.")
          return
        }
        await enqueueOperation(workspaceId, "remove_reaction", { messageId, emoji })
        syncEngine.kickOperationQueue()
      }
    },
    [workspaceId, messageId, syncEngine]
  )

  const toggleReaction = useCallback(
    async (shortcode: string, reactions: Record<string, string[]>, currentUserId: string | null) => {
      if (!currentUserId) return
      const emoji = toEmoji(shortcode)
      if (!emoji) {
        toast.error("Could not resolve emoji")
        return
      }
      // Reactions dict keys are colon-wrapped (":laughing:"), check both formats
      const colonWrapped = `:${shortcode}:`
      const userIds = reactions[colonWrapped] ?? reactions[shortcode] ?? []
      const hasReacted = userIds.includes(currentUserId)
      if (hasReacted) {
        await removeReaction(emoji)
      } else {
        await addReaction(emoji)
      }
    },
    [toEmoji, addReaction, removeReaction]
  )

  const toggleByEmoji = useCallback(
    async (emoji: string, reactions: Record<string, string[]>, currentUserId: string | null) => {
      if (!currentUserId) return
      const shortcode = emojiToShortcode.get(emoji)
      if (shortcode) {
        // Reactions dict keys are colon-wrapped (":laughing:"), check both formats
        const colonWrapped = `:${shortcode}:`
        const userIds = reactions[colonWrapped] ?? reactions[shortcode] ?? []
        if (userIds.includes(currentUserId)) {
          await removeReaction(emoji)
          return
        }
      }
      await addReaction(emoji)
    },
    [emojiToShortcode, addReaction, removeReaction]
  )

  return { addReaction, removeReaction, toggleReaction, toggleByEmoji }
}
