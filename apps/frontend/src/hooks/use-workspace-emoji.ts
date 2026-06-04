import { useCallback, useMemo } from "react"
import { useWorkspaceMetadata } from "@/stores/workspace-store"
import type { EmojiEntry } from "@threa/types"

interface WorkspaceEmojiData {
  /** All available emojis in the workspace */
  emojis: EmojiEntry[]
  /** Emoji weights for personalized sorting (shortcode -> weight) */
  emojiWeights: Record<string, number>
  /** Look up emoji character by shortcode */
  toEmoji: (shortcode: string) => string | null
  /** Get full emoji entry by shortcode */
  getEmoji: (shortcode: string) => EmojiEntry | undefined
  /** Reverse lookup: emoji character → shortcode (no colons). Null when unknown. */
  toShortcode: (emoji: string) => string | null
}

/**
 * Hook to look up emojis from workspace data.
 * Reads from IndexedDB via useLiveQuery — reactive and offline-capable.
 */
export function useWorkspaceEmoji(workspaceId: string): WorkspaceEmojiData {
  const metadata = useWorkspaceMetadata(workspaceId)

  const emojis = useMemo(() => (metadata?.emojis ?? []) as EmojiEntry[], [metadata])
  const emojiWeights = useMemo(() => metadata?.emojiWeights ?? {}, [metadata])

  const emojiMap = useMemo(() => {
    const map = new Map<string, EmojiEntry>()
    for (const entry of emojis) {
      map.set(entry.shortcode, entry)
    }
    return map
  }, [emojis])

  const getEmoji = useCallback(
    (shortcode: string): EmojiEntry | undefined => {
      const normalized = shortcode.startsWith(":") && shortcode.endsWith(":") ? shortcode.slice(1, -1) : shortcode
      return emojiMap.get(normalized)
    },
    [emojiMap]
  )

  const toEmoji = useCallback(
    (shortcode: string): string | null => {
      const entry = getEmoji(shortcode)
      return entry?.emoji ?? null
    },
    [getEmoji]
  )

  const shortcodeMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const entry of emojis) {
      map.set(entry.emoji, entry.shortcode)
    }
    return map
  }, [emojis])

  const toShortcode = useCallback((emoji: string): string | null => shortcodeMap.get(emoji) ?? null, [shortcodeMap])

  return useMemo(
    () => ({
      emojis,
      emojiWeights,
      toEmoji,
      getEmoji,
      toShortcode,
    }),
    [emojis, emojiWeights, toEmoji, getEmoji, toShortcode]
  )
}
