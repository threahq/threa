import { useMemo } from "react"
import type { Mentionable } from "@/components/editor/triggers/types"
import {
  useWorkspaceUsers,
  useWorkspacePersonas,
  useWorkspaceBots,
  useWorkspaceStreams,
} from "@/stores/workspace-store"
import { useParams } from "react-router-dom"
import { useUser } from "@/auth"
import { rankMatches } from "@/lib/match-score"
import { useStreamBootstrap } from "./use-streams"
import { useWorkspaceEmoji } from "./use-workspace-emoji"
import { StreamTypes, type StreamType } from "@threa/types"

/**
 * Stream context for filtering which broadcast mentions are available.
 * `streamType` is the current stream's type; `rootStreamType` is the root
 * stream's type when the current stream is a thread.
 *
 * `memberIds` is the set of users/bots already in the stream (or its root
 * stream). When `inviteMode` is true, only users/bots NOT in this set are
 * shown, and broadcasts/personas are hidden.
 *
 * `botMemberIds` is the set of bots that are members of the current stream
 * (or its root stream for threads). In normal chat mode, only bots in this
 * set are mentionable.
 */
export interface MentionStreamContext {
  streamType: StreamType
  rootStreamType?: StreamType
  inviteMode?: boolean
  memberIds?: Set<string>
  botMemberIds?: Set<string>
  /** Whether the current user can invite bots (admin/owner only). */
  canInviteBots?: boolean
}

interface MentionStreamSource {
  id: string
  type: StreamType
  rootStreamId?: string | null
}

/**
 * Build the `MentionStreamContext` for the editor — broadcast filtering
 * (@channel, @here), invite-mode member exclusion, bot mentionability, and
 * the admin/owner gate on bot invites. Threads inherit access from their
 * root stream, so the bootstrap fetch follows the root when present.
 *
 * Both the live stream composer (`MessageInput`) and the scheduled message
 * edit dialog use this — pass the destination stream from whichever local
 * source you have (props, IDB lookup, draft store).
 *
 * Returns `undefined` while `stream` is unresolved so the editor falls back
 * to no-broadcast-mentions instead of wrong ones.
 */
export function useMentionStreamContext(
  workspaceId: string,
  stream: MentionStreamSource | null | undefined
): MentionStreamContext | undefined {
  const idbStreams = useWorkspaceStreams(workspaceId)
  const rootStreamId = stream?.rootStreamId ?? null
  const streamId = stream?.id ?? ""

  const { data: currentBootstrap } = useStreamBootstrap(workspaceId, streamId, {
    enabled: !!streamId && !rootStreamId,
  })
  const { data: rootBootstrap } = useStreamBootstrap(workspaceId, rootStreamId ?? "", {
    enabled: !!rootStreamId,
  })
  const accessBootstrap = rootStreamId ? rootBootstrap : currentBootstrap

  const currentUser = useUser()
  const workspaceUsers = useWorkspaceUsers(workspaceId)
  const currentUserRole = useMemo(
    () => workspaceUsers.find((u) => u.workosUserId === currentUser?.id)?.role,
    [workspaceUsers, currentUser?.id]
  )

  return useMemo<MentionStreamContext | undefined>(() => {
    if (!stream) return undefined
    const ctx: MentionStreamContext = { streamType: stream.type }
    if (stream.type === StreamTypes.THREAD && stream.rootStreamId) {
      const rootStream = idbStreams.find((s) => s.id === stream.rootStreamId)
      if (rootStream) ctx.rootStreamType = rootStream.type
    }
    // Invite-mode exclusion uses channel-level access — threads inherit access
    // from their root, so inviting a root member to a thread is a no-op.
    if (accessBootstrap?.members) {
      const ids = new Set(accessBootstrap.members.map((m) => m.memberId))
      for (const botId of accessBootstrap.botMemberIds ?? []) ids.add(botId)
      ctx.memberIds = ids
    }
    if (accessBootstrap?.botMemberIds) ctx.botMemberIds = new Set(accessBootstrap.botMemberIds)
    ctx.canInviteBots = currentUserRole === "admin" || currentUserRole === "owner"
    return ctx
  }, [stream, idbStreams, accessBootstrap, currentUserRole])
}

/**
 * Reserved broadcast mention slugs.
 */
const BROADCAST_CHANNEL: Mentionable = {
  id: "broadcast:channel",
  slug: "channel",
  name: "Channel",
  type: "broadcast",
  avatarEmoji: "📢",
}

const BROADCAST_HERE: Mentionable = {
  id: "broadcast:here",
  slug: "here",
  name: "Here",
  type: "broadcast",
  avatarEmoji: "👋",
}

const ALL_BROADCAST_MENTIONS: Mentionable[] = [BROADCAST_CHANNEL, BROADCAST_HERE]

/**
 * Return the broadcast mentions allowed for a given stream context.
 *
 * @channel — channels and threads under channels
 * @here    — channels, DMs, and threads under either
 */
export function filterBroadcastMentions(ctx?: MentionStreamContext): Mentionable[] {
  if (!ctx) return ALL_BROADCAST_MENTIONS

  // For threads, use the root stream type to determine eligibility
  const effectiveType = ctx.rootStreamType ?? ctx.streamType

  const allowed: Mentionable[] = []

  // @channel: only in channel-tree streams
  if (effectiveType === StreamTypes.CHANNEL) {
    allowed.push(BROADCAST_CHANNEL)
  }

  // @here: channel-tree and DM-tree streams
  if (effectiveType === StreamTypes.CHANNEL || effectiveType === StreamTypes.DM) {
    allowed.push(BROADCAST_HERE)
  }

  return allowed
}

/**
 * Mentionable entities for the current workspace (users, personas, bots,
 * broadcasts, "me" shortcut). With `streamContext`, broadcasts are filtered by
 * stream type; without it, all broadcasts are included.
 */
export function useMentionables(streamContext?: MentionStreamContext) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const workspaceUsers = useWorkspaceUsers(workspaceId ?? "")
  const workspacePersonas = useWorkspacePersonas(workspaceId ?? "")
  const workspaceBots = useWorkspaceBots(workspaceId ?? "")
  const currentUser = useUser()
  const { toEmoji } = useWorkspaceEmoji(workspaceId ?? "")

  const mentionables = useMemo<Mentionable[]>(() => {
    const broadcasts = filterBroadcastMentions(streamContext)

    const currentUserId = currentUser?.id
    const users: Mentionable[] = workspaceUsers.map((u) => ({
      id: u.id,
      slug: u.slug,
      name: u.name,
      type: "user",
      isCurrentUser: u.workosUserId === currentUserId,
    }))

    // Sort users so current user is first
    users.sort((a, b) => {
      if (a.isCurrentUser) return -1
      if (b.isCurrentUser) return 1
      return 0
    })

    const personas: Mentionable[] = workspacePersonas.map((persona) => {
      // Convert shortcode to emoji (e.g., ":thread:" -> "🧵")
      const emoji = persona.avatarEmoji ? toEmoji(persona.avatarEmoji) : undefined
      return {
        id: persona.id,
        slug: persona.slug,
        name: persona.name,
        type: "persona",
        avatarEmoji: emoji ?? undefined,
      }
    })

    const bots: Mentionable[] = workspaceBots
      .filter((b) => b.slug !== null && b.archivedAt === null)
      .map((bot) => ({
        id: bot.id,
        slug: bot.slug!,
        name: bot.name,
        type: "bot",
        avatarEmoji: bot.avatarEmoji ?? undefined,
        avatarUrl: bot.avatarUrl ?? undefined,
      }))

    // In invite mode, only users and bots that are NOT already members are shown.
    // Broadcasts and personas are hidden since they cannot be invited.
    // Bots are only shown if the current user has permission to invite them.
    if (streamContext?.inviteMode && streamContext.memberIds) {
      const memberIds = streamContext.memberIds
      const inviteables = [...users]
      if (streamContext.canInviteBots) {
        inviteables.push(...bots)
      }
      return inviteables.filter((m) => !memberIds.has(m.id))
    }

    // Normal mode: only bots that are members of the stream are mentionable.
    const memberBots = streamContext?.botMemberIds ? bots.filter((b) => streamContext.botMemberIds!.has(b.id)) : bots

    return [...users, ...personas, ...memberBots, ...broadcasts]
  }, [workspaceUsers, workspacePersonas, workspaceBots, currentUser?.id, toEmoji, streamContext])

  return {
    mentionables,
    isLoading: false,
  }
}

/**
 * Filter and rank mentionables by query string.
 * Matches against slug and name (both visible in the row), case-insensitive;
 * exact/prefix matches rank above mid-word substring hits, ties keep input
 * order (current user stays first among equals).
 * Special case: "me" matches the current user.
 */
export function filterMentionables(items: Mentionable[], query: string): Mentionable[] {
  if (!query) return items

  if (query.toLowerCase() === "me") {
    const currentUser = items.find((item) => item.isCurrentUser)
    if (currentUser) return [currentUser]
  }

  return rankMatches(items, query, (item) => ({ labels: [item.slug, item.name] }))
}

/**
 * Filter mentionables for search context.
 * Excludes broadcast mentions (@channel, @here) since they don't make sense to search for.
 */
export function filterSearchMentionables(items: Mentionable[], query: string): Mentionable[] {
  const searchableItems = items.filter((item) => item.type !== "broadcast")
  return filterMentionables(searchableItems, query)
}

/**
 * Filter to only users (no personas, no broadcasts).
 * Used for `in:` filter since you can only DM with users, not personas.
 */
export function filterUsersOnly(items: Mentionable[], query: string): Mentionable[] {
  const usersOnly = items.filter((item) => item.type === "user")
  return filterMentionables(usersOnly, query)
}
