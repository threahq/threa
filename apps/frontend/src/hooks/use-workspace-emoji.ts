import { useWorkspaceMetadata } from "@/stores/workspace-store"
import { getWorkspaceEmojiIndexes } from "@/stores/actor-lookup"
import { usePreferencesOptional } from "@/contexts/preferences-context"
import { useStableCallback } from "@/hooks/use-stable-callback"
import { DEFAULT_USER_PREFERENCES, type EmojiEntry } from "@threahq/types"

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
  /** Emoji a text emoticon (`:)`) stands for. Null when it is not one. */
  fromEmoticon: (emoticon: string) => string | null
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
  return getWorkspaceEmojiIndexes(workspaceId, emojis, emojiWeights)
}

/**
 * The emoticon lookup an editor converts with: `fromEmoticon`, or null for
 * everything once the user has turned conversion off. Stable, so it never
 * rebuilds the editor.
 */
export function useEmoticonConversion(
  fromEmoticon: WorkspaceEmojiData["fromEmoticon"]
): (emoticon: string) => string | null {
  const enabled = usePreferencesOptional()?.preferences?.convertEmoticons ?? DEFAULT_USER_PREFERENCES.convertEmoticons
  return useStableCallback((emoticon: string) => (enabled ? fromEmoticon(emoticon) : null))
}
