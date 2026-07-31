import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { EmojiEntry } from "@threa/types"
import { buildShortcodeIndex, stripShortcodeColons } from "@/lib/emoji-picker"

type ToEmoji = (shortcode: string) => string | null

interface EmojiContextValue {
  toEmoji: ToEmoji
}

const EmojiContext = createContext<EmojiContextValue | null>(null)

interface EmojiProviderProps {
  emojis: EmojiEntry[]
  children: ReactNode
}

/**
 * Provider that supplies emoji lookup for rendering.
 * Wraps markdown content to enable :shortcode: → emoji conversion.
 */
export function EmojiProvider({ emojis, children }: EmojiProviderProps) {
  const value = useMemo<EmojiContextValue>(() => {
    const index = buildShortcodeIndex(emojis)
    return {
      toEmoji: (shortcode: string) => index.get(stripShortcodeColons(shortcode))?.emoji ?? null,
    }
  }, [emojis])

  return <EmojiContext.Provider value={value}>{children}</EmojiContext.Provider>
}

/**
 * Hook to get emoji lookup function.
 * Returns null converter if not within EmojiProvider (shortcodes stay as-is).
 */
export function useEmojiLookup(): ToEmoji {
  const context = useContext(EmojiContext)
  if (!context) {
    return () => null
  }
  return context.toEmoji
}
