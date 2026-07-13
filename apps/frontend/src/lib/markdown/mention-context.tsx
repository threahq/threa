import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { Mentionable } from "@/components/editor/triggers/types"

export type MentionType = "user" | "persona" | "bot" | "broadcast" | "me"

interface MentionContextValue {
  getMentionType: (slug: string) => MentionType
  /**
   * True for a personal bot the viewer doesn't own: the mention renders but
   * the backend won't dispatch an invocation for it (owner-only). Checked by
   * id when the pointer path has one, else by slug.
   */
  isMentionOnlyBot: (slugOrId: string) => boolean
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
    const mentionOnly = new Set<string>()
    for (const m of mentionables) {
      slugToType.set(m.slug, m.isCurrentUser ? "me" : m.type)
      if (m.mentionOnly) {
        mentionOnly.add(m.slug)
        mentionOnly.add(m.id)
      }
    }
    slugToType.set("here", "broadcast")
    slugToType.set("channel", "broadcast")

    return {
      getMentionType: (slug: string) => slugToType.get(slug) ?? "user",
      isMentionOnlyBot: (slugOrId: string) => mentionOnly.has(slugOrId),
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

/** Falls back to "never" outside a MentionProvider (no roster to check against). */
export function useIsMentionOnlyBot(): (slugOrId: string) => boolean {
  const context = useContext(MentionContext)
  return context?.isMentionOnlyBot ?? (() => false)
}
