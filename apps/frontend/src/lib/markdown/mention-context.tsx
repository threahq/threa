import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { Mentionable } from "@/components/editor/triggers/types"

export type MentionType = "user" | "persona" | "bot" | "broadcast" | "me"

interface MentionContextValue {
  getMentionType: (slug: string) => MentionType
  /**
   * `id` is the resolved actor id from a pointer-link mention (INV-64) — when
   * present, navigate by it directly rather than re-resolving the slug (slugs
   * are mutable). The bare-slug render path omits it.
   */
  onMentionClick?: (slug: string, type: MentionType, id?: string) => void
}

const MentionContext = createContext<MentionContextValue | null>(null)

interface MentionProviderProps {
  mentionables: Mentionable[]
  onMentionClick?: (slug: string, type: MentionType, id?: string) => void
  children: ReactNode
}

export function MentionProvider({ mentionables, onMentionClick, children }: MentionProviderProps) {
  const value = useMemo<MentionContextValue>(() => {
    const slugToType = new Map<string, MentionType>()
    for (const m of mentionables) {
      slugToType.set(m.slug, m.isCurrentUser ? "me" : m.type)
    }
    slugToType.set("here", "broadcast")
    slugToType.set("channel", "broadcast")

    return {
      getMentionType: (slug: string) => slugToType.get(slug) ?? "user",
      onMentionClick,
    }
  }, [mentionables, onMentionClick])

  return <MentionContext.Provider value={value}>{children}</MentionContext.Provider>
}

/** Falls back to broadcast-only lookup when used outside a MentionProvider. */
export function useMentionType(): (slug: string) => MentionType {
  const context = useContext(MentionContext)
  if (!context) {
    return (slug: string) => {
      if (slug === "here" || slug === "channel") return "broadcast"
      return "user"
    }
  }
  return context.getMentionType
}

export function useMentionClick(): ((slug: string, type: MentionType, id?: string) => void) | undefined {
  const context = useContext(MentionContext)
  return context?.onMentionClick
}
