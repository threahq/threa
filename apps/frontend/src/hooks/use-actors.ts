import { useCallback, useMemo } from "react"
import { getAvatarUrl, getBotAvatarUrl } from "@threa/types"
import { useWorkspaceEmoji } from "./use-workspace-emoji"
import { useWorkspaceUsers, useWorkspacePersonas, useWorkspaceBots } from "@/stores/workspace-store"
import type { Persona, Bot, User, AuthorType } from "@threa/types"

interface ActorAvatarInfo {
  fallback: string
  slug?: string
  avatarUrl?: string
}

/**
 * Infer an actor's type from its prefixed ULID. Used where only the id is
 * known — notably reactions, which store `Record<emoji, actorId[]>` with no
 * per-reactor type. Prefixes are stable by convention (`persona_…` for AI
 * agents, `bot_…` for bots, `usr_…` for workspace users).
 */
export function actorTypeFromId(id: string): AuthorType {
  if (id.startsWith("persona_")) return "persona"
  if (id.startsWith("bot_")) return "bot"
  return "user"
}

export interface ActorLookup {
  getActorName: (actorId: string | null, actorType: AuthorType | null) => string
  getActorInitials: (actorId: string | null, actorType: AuthorType | null) => string
  /** Returns avatar info including fallback text and persona slug (for SVG icon support) */
  getActorAvatar: (actorId: string | null, actorType: AuthorType | null) => ActorAvatarInfo
  getUser: (userId: string) => User | undefined
  getPersona: (personaId: string) => Persona | undefined
  getBot: (botId: string) => Bot | undefined
}

/**
 * Hook to look up actor names from cached workspace data.
 * Reads from IndexedDB via useLiveQuery — reactive and offline-capable.
 */
export function useActors(workspaceId: string): ActorLookup {
  const { toEmoji } = useWorkspaceEmoji(workspaceId)

  // Reactive data from IDB — updates automatically when IDB changes
  const users = useWorkspaceUsers(workspaceId)
  const personas = useWorkspacePersonas(workspaceId)
  const bots = useWorkspaceBots(workspaceId)

  // Build lookup maps for O(1) access in callbacks
  const userMap = useMemo(() => new Map(users.map((u) => [u.id, u])), [users])
  const personaMap = useMemo(() => new Map(personas.map((p) => [p.id, p])), [personas])
  const botMap = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots])

  const getUser = useCallback((userId: string): User | undefined => userMap.get(userId) as User | undefined, [userMap])

  const getPersona = useCallback(
    (personaId: string): Persona | undefined => personaMap.get(personaId) as Persona | undefined,
    [personaMap]
  )

  const getBot = useCallback((botId: string): Bot | undefined => botMap.get(botId) as Bot | undefined, [botMap])

  const getActorName = useCallback(
    (actorId: string | null, actorType: AuthorType | null): string => {
      if (!actorId) return "Unknown"
      if (actorType === "system") return "Threa"

      if (actorType === "persona") {
        return personaMap.get(actorId)?.name ?? "AI Companion"
      }

      if (actorType === "bot") {
        return botMap.get(actorId)?.name ?? "Bot"
      }

      // actorType === "user" — resolve workspace-scoped name
      return userMap.get(actorId)?.name || actorId.substring(0, 8)
    },
    [userMap, personaMap, botMap]
  )

  const getActorInitials = useCallback(
    (actorId: string | null, actorType: AuthorType | null): string => {
      if (!actorId) return "?"
      if (actorType === "system") return "T"

      if (actorType === "persona") {
        const persona = personaMap.get(actorId)
        if (persona?.avatarEmoji) {
          const emoji = toEmoji(persona.avatarEmoji)
          if (emoji) return emoji
        }
        return initialsFrom(persona?.name) ?? "AI"
      }

      if (actorType === "bot") {
        const bot = botMap.get(actorId)
        if (bot?.avatarEmoji) {
          const emoji = toEmoji(bot.avatarEmoji)
          if (emoji) return emoji
        }
        return initialsFrom(bot?.name) ?? "B"
      }

      return initialsFrom(userMap.get(actorId)?.name) ?? actorId.substring(0, 2).toUpperCase()
    },
    [userMap, personaMap, botMap, toEmoji]
  )

  const getActorAvatar = useCallback(
    (actorId: string | null, actorType: AuthorType | null): ActorAvatarInfo => {
      const fallback = getActorInitials(actorId, actorType)

      if (actorType === "system") return { fallback }

      if (actorType === "persona" && actorId) {
        const persona = personaMap.get(actorId)
        return { fallback, slug: persona?.slug }
      }

      if (actorType === "bot" && actorId) {
        const bot = getBot(actorId)
        const avatarUrl = getBotAvatarUrl(workspaceId, bot?.avatarUrl, 64)
        if (avatarUrl) return { fallback, avatarUrl }
        return { fallback }
      }

      if (actorId) {
        const workspaceUser = userMap.get(actorId)
        const avatarUrl = getAvatarUrl(workspaceId, workspaceUser?.avatarUrl, 64)
        if (avatarUrl) return { fallback, avatarUrl }
      }

      return { fallback }
    },
    [getActorInitials, getBot, userMap, workspaceId]
  )

  return useMemo(
    () => ({
      getActorName,
      getActorInitials,
      getActorAvatar,
      getUser,
      getPersona,
      getBot,
    }),
    [getActorName, getActorInitials, getActorAvatar, getUser, getPersona, getBot]
  )
}

function initialsFrom(name: string | null | undefined): string | undefined {
  if (!name) return undefined
  const words = name.split(" ")
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
}
