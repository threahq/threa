import { useWorkspaceMetadata } from "@/stores/workspace-store"
import { getWorkspaceEmojiIndexes } from "@/stores/actor-lookup"
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

const EMPTY_EMOJIS: EmojiEntry[] = []
const EMPTY_WEIGHTS: Record<string, number> = {}

/**
 * Hook to look up emojis from workspace data.
 * Reads from IndexedDB via the shared workspace-table registry — reactive and
 * offline-capable. The shortcode index and the reverse map are built once per
 * emoji set (`stores/actor-lookup`), not once per consumer.
 */
export function useWorkspaceEmoji(workspaceId: string): WorkspaceEmojiData {
  const metadata = useWorkspaceMetadata(workspaceId)
  const emojis = (metadata?.emojis ?? EMPTY_EMOJIS) as EmojiEntry[]
  const emojiWeights = metadata?.emojiWeights ?? EMPTY_WEIGHTS
  return getWorkspaceEmojiIndexes(emojis, emojiWeights)
}
