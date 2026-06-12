import { db, type CachedStream, type CachedStreamMembership, type CachedUnreadState } from "@/db"
import { seedWorkspaceCache, upsertWorkspaceUserInCache } from "@/stores/workspace-store"
import type { SyncEventSource } from "./socket-event-gate"
import type { QueryClient } from "@tanstack/react-query"
import { SW_MSG_CLEAR_NOTIFICATIONS } from "@/lib/sw-messages"
import { streamKeys } from "@/hooks/use-streams"
import { workspaceKeys } from "@/hooks/use-workspaces"
import type {
  Stream,
  StreamBootstrap,
  StreamEvent,
  User,
  Bot,
  WorkspaceBootstrap,
  StreamMember,
  UserPreferences,
  SidebarConfig,
  WorkspaceSettings,
  FeatureFlags,
  LastMessagePreview,
  ActivityCreatedPayload,
  SavedUpsertedPayload,
  SavedDeletedPayload,
  SavedReminderFiredPayload,
  ScheduledMessageUpsertedPayload,
  ScheduledMessageSentPayload,
  ScheduledMessageCancelledPayload,
  LabelUpsertedPayload,
  LabelDeletedPayload,
  LabelMemberJoinedPayload,
  LabelMemberLeftPayload,
  LabelAssignedPayload,
  LabelUnassignedPayload,
} from "@threa/types"
import { persistSavedRows, removeSavedRow, savedKeys } from "@/hooks/use-saved"
import { persistScheduledRows, removeScheduledRow, scheduledKeys } from "@/hooks/use-scheduled"
import { assignmentToCached, assignmentId } from "@/hooks/use-labels"
import {
  NOTIFICATION_CONFIG,
  NotificationLevels,
  StreamTypes,
  Visibilities,
  normalizeSidebarConfig,
} from "@threa/types"
import { applyStreamBootstrapInCurrentTransaction } from "./stream-sync"

// ============================================================================
// Workspace socket handler payload types
// ============================================================================

/** Workspace user shape from backend user repository. */
interface WorkspaceUserPayload {
  id: string
  workspaceId: string
  workosUserId: string
  role: User["role"]
  slug: string
  name: string
  description: string | null
  avatarUrl: string | null
  timezone: string | null
  locale: string | null
  pronouns: string | null
  phone: string | null
  githubUsername: string | null
  statusEmoji: string | null
  statusText: string | null
  statusExpiresAt: string | null
  statusPausesNotifications: boolean
  notificationsPausedUntil: string | null
  notificationsPausedIndefinitely: boolean
  setupCompleted: boolean
  email: string
  joinedAt: string
}

interface StreamPayload {
  workspaceId: string
  streamId: string
  stream: Stream
  dmUserIds?: [string, string]
}

interface WorkspaceUserAddedPayload {
  workspaceId: string
  user: WorkspaceUserPayload
}

interface WorkspaceUserRemovedPayload {
  workspaceId: string
  removedUserId: string
}

interface WorkspaceUserUpdatedPayload {
  workspaceId: string
  user: WorkspaceUserPayload
}

interface StreamReadPayload {
  workspaceId: string
  authorId: string
  streamId: string
  lastReadEventId: string
}

interface StreamsReadAllPayload {
  workspaceId: string
  authorId: string
  streamIds: string[]
}

interface StreamActivityPayload {
  workspaceId: string
  streamId: string
  authorId: string
  lastMessagePreview: LastMessagePreview
}

interface StreamDisplayNameUpdatedPayload {
  workspaceId: string
  streamId: string
  displayName: string
}

interface UserPreferencesUpdatedPayload {
  workspaceId: string
  authorId: string
  preferences: UserPreferences
}

interface SidebarConfigUpdatedPayload {
  workspaceId: string
  authorId: string
  sidebarConfig: SidebarConfig
}

interface WorkspaceSettingsUpdatedPayload {
  workspaceId: string
  settings: WorkspaceSettings
}

interface FeatureFlagsUpdatedPayload {
  workspaceId: string
  targetUserId: string
  featureFlags: FeatureFlags
}

// ============================================================================
// Workspace socket handler helpers
// ============================================================================

/**
 * Update the workspace bootstrap cache, or invalidate if it's not cached yet.
 *
 * Socket events can arrive before the bootstrap queryFn completes (the member
 * room is joined before the fetch finishes). Without this guard, setQueryData
 * sees `old === undefined` and silently drops the update. Invalidating triggers
 * a re-fetch that will include the event's state from the DB.
 *
 * Returns true if the update was applied, false if invalidated instead.
 */
function updateBootstrapOrInvalidate(
  queryClient: QueryClient,
  workspaceId: string,
  updater: (old: WorkspaceBootstrap) => WorkspaceBootstrap
): boolean {
  const key = workspaceKeys.bootstrap(workspaceId)
  if (!queryClient.getQueryData(key)) {
    queryClient.invalidateQueries({ queryKey: key })
    return false
  }
  queryClient.setQueryData<WorkspaceBootstrap>(key, (old) => {
    if (!old) return old
    return updater(old)
  })
  return true
}

function getWorkspaceUsers(bootstrap: WorkspaceBootstrap): User[] {
  return bootstrap.users
}

function withWorkspaceUsers(bootstrap: WorkspaceBootstrap, users: User[]): WorkspaceBootstrap {
  return {
    ...bootstrap,
    users,
  }
}

function toWorkspaceUser(user: WorkspaceUserPayload): User {
  return { ...user }
}
function toWorkspaceBootstrapStream(stream: CachedStream): WorkspaceBootstrap["streams"][number] {
  return {
    id: stream.id,
    workspaceId: stream.workspaceId,
    type: stream.type,
    displayName: stream.displayName,
    slug: stream.slug,
    description: stream.description,
    visibility: stream.visibility,
    parentStreamId: stream.parentStreamId,
    parentMessageId: stream.parentMessageId,
    rootStreamId: stream.rootStreamId,
    companionMode: stream.companionMode,
    companionPersonaId: stream.companionPersonaId,
    createdBy: stream.createdBy,
    createdAt: stream.createdAt,
    updatedAt: stream.updatedAt,
    archivedAt: stream.archivedAt,
    lastMessagePreview: stream.lastMessagePreview ?? null,
  }
}

function toWorkspaceBootstrapMembership(membership: CachedStreamMembership): StreamMember {
  return {
    streamId: membership.streamId,
    memberId: membership.memberId,
    notificationLevel: membership.notificationLevel,
    lastReadEventId: membership.lastReadEventId,
    lastReadAt: membership.lastReadAt,
    joinedAt: membership.joinedAt,
  }
}

function mergeSidebarStream(
  current: WorkspaceBootstrap["streams"][number] | undefined,
  nextStream: Stream
): WorkspaceBootstrap["streams"][number] {
  const displayName =
    nextStream.type === StreamTypes.DM && nextStream.displayName == null
      ? (current?.displayName ?? null)
      : nextStream.displayName

  return {
    ...(current ?? { lastMessagePreview: null }),
    ...nextStream,
    displayName,
    lastMessagePreview: current?.lastMessagePreview ?? null,
  }
}

function sumActivityCounts(activityCounts: Record<string, number>): number {
  return Object.values(activityCounts).reduce((sum, count) => sum + count, 0)
}

function setMutedState(
  mutedStreamIds: Set<string>,
  streamId: string,
  streamType: Stream["type"],
  notificationLevel: StreamMember["notificationLevel"] | null | undefined
): void {
  const effectiveLevel = notificationLevel ?? NOTIFICATION_CONFIG[streamType].defaultLevel
  if (effectiveLevel === NotificationLevels.MUTED) {
    mutedStreamIds.add(streamId)
    return
  }
  mutedStreamIds.delete(streamId)
}

interface ReconnectWorkspaceMergeParams {
  workspaceBootstrap: WorkspaceBootstrap
  successfulStreamBootstraps: Map<string, StreamBootstrap>
  staleStreamIds: Set<string>
  terminalStreamIds: Set<string>
  localStreams: CachedStream[]
  localMemberships: CachedStreamMembership[]
  localUnreadState?: CachedUnreadState
  fetchStartedAt?: number
}

export function mergeReconnectWorkspaceBootstrap({
  workspaceBootstrap,
  successfulStreamBootstraps,
  staleStreamIds,
  terminalStreamIds,
  localStreams,
  localMemberships,
  localUnreadState,
  fetchStartedAt,
}: ReconnectWorkspaceMergeParams): WorkspaceBootstrap {
  const successfulStreamIds = new Set(successfulStreamBootstraps.keys())
  const streamsById = new Map(workspaceBootstrap.streams.map((stream) => [stream.id, stream]))
  const membershipsByStreamId = new Map(
    workspaceBootstrap.streamMemberships.map((membership) => [membership.streamId, membership])
  )
  const unreadCounts = { ...workspaceBootstrap.unreadCounts }
  const mentionCounts = { ...workspaceBootstrap.mentionCounts }
  const activityCounts = { ...workspaceBootstrap.activityCounts }
  const mutedStreamIds = new Set(workspaceBootstrap.mutedStreamIds)
  const localStreamById = new Map(localStreams.map((stream) => [stream.id, stream]))
  const localMembershipByStreamId = new Map(localMemberships.map((membership) => [membership.streamId, membership]))

  if (fetchStartedAt !== undefined) {
    for (const stream of localStreams) {
      if (stream._cachedAt < fetchStartedAt) continue
      if (successfulStreamIds.has(stream.id)) continue
      streamsById.set(stream.id, toWorkspaceBootstrapStream(stream))
    }

    for (const membership of localMemberships) {
      if (membership._cachedAt < fetchStartedAt) continue
      if (successfulStreamIds.has(membership.streamId)) continue
      membershipsByStreamId.set(membership.streamId, toWorkspaceBootstrapMembership(membership))
    }

    if (localUnreadState && localUnreadState._cachedAt >= fetchStartedAt) {
      for (const [streamId, count] of Object.entries(localUnreadState.unreadCounts)) {
        if (successfulStreamIds.has(streamId)) continue
        unreadCounts[streamId] = count
      }
      for (const [streamId, count] of Object.entries(localUnreadState.mentionCounts)) {
        if (successfulStreamIds.has(streamId)) continue
        mentionCounts[streamId] = count
      }
      for (const [streamId, count] of Object.entries(localUnreadState.activityCounts)) {
        if (successfulStreamIds.has(streamId)) continue
        activityCounts[streamId] = count
      }
      for (const streamId of localUnreadState.mutedStreamIds) {
        if (successfulStreamIds.has(streamId)) continue
        mutedStreamIds.add(streamId)
      }
    }
  }

  for (const streamId of staleStreamIds) {
    const localStream = localStreamById.get(streamId)
    if (localStream) {
      streamsById.set(streamId, toWorkspaceBootstrapStream(localStream))
    }

    const localMembership = localMembershipByStreamId.get(streamId)
    if (localMembership) {
      membershipsByStreamId.set(streamId, toWorkspaceBootstrapMembership(localMembership))
    }

    if (localUnreadState) {
      unreadCounts[streamId] = localUnreadState.unreadCounts[streamId] ?? 0
      mentionCounts[streamId] = localUnreadState.mentionCounts[streamId] ?? 0
      activityCounts[streamId] = localUnreadState.activityCounts[streamId] ?? 0
      if (localUnreadState.mutedStreamIds.includes(streamId)) {
        mutedStreamIds.add(streamId)
      } else {
        mutedStreamIds.delete(streamId)
      }
    }
  }

  for (const [streamId, bootstrap] of successfulStreamBootstraps) {
    const currentStream = streamsById.get(streamId)
    const localStream = localStreamById.get(streamId)
    streamsById.set(
      streamId,
      mergeSidebarStream(
        currentStream ?? (localStream ? toWorkspaceBootstrapStream(localStream) : undefined),
        bootstrap.stream
      )
    )

    if (bootstrap.membership) {
      membershipsByStreamId.set(streamId, bootstrap.membership)
    } else {
      membershipsByStreamId.delete(streamId)
    }

    unreadCounts[streamId] = bootstrap.unreadCount
    mentionCounts[streamId] = bootstrap.mentionCount
    activityCounts[streamId] = bootstrap.activityCount
    setMutedState(mutedStreamIds, streamId, bootstrap.stream.type, bootstrap.membership?.notificationLevel)
  }

  for (const streamId of terminalStreamIds) {
    streamsById.delete(streamId)
    membershipsByStreamId.delete(streamId)
    delete unreadCounts[streamId]
    delete mentionCounts[streamId]
    delete activityCounts[streamId]
    mutedStreamIds.delete(streamId)
  }

  return {
    ...workspaceBootstrap,
    streams: Array.from(streamsById.values()),
    streamMemberships: Array.from(membershipsByStreamId.values()),
    unreadCounts,
    mentionCounts,
    activityCounts,
    unreadActivityCount: sumActivityCounts(activityCounts),
    mutedStreamIds: Array.from(mutedStreamIds),
  }
}

function resolveDmPeerUserId(dmUserIds: [string, string] | undefined, currentUserId: string | null): string | null {
  if (!currentUserId || !dmUserIds?.includes(currentUserId)) return null
  return dmUserIds.find((userId) => userId !== currentUserId) ?? null
}

// ============================================================================
// Register workspace-level socket handlers
// ============================================================================

/**
 * Registers all workspace-level socket event handlers and returns a cleanup
 * function that unregisters them.
 *
 * Lives outside React so the SyncEngine can own handler lifecycle
 * independently of component mount/unmount cycles.
 */
export function registerWorkspaceSocketHandlers(
  socket: SyncEventSource,
  workspaceId: string,
  queryClient: QueryClient,
  refs: {
    getCurrentStreamId: () => string | undefined
    getCurrentUser: () => { id: string } | null
    subscribeStream: (streamId: string) => void
  }
): () => void {
  const abortController = new AbortController()

  // Close the reconnect event gap (INV-53): if the Saved or Scheduled view
  // is mounted when the socket re-registers, invalidate so TanStack refetches
  // and rehydrates IDB with any rows whose upsert/delete events we missed
  // during the disconnect. `refetchOnReconnect: true` alone only covers
  // browser network online/offline, not socket.io reconnects.
  queryClient.invalidateQueries({ queryKey: savedKeys.all })
  queryClient.invalidateQueries({ queryKey: scheduledKeys.all })

  // Handle stream created
  const handleStreamCreated = (payload: StreamPayload) => {
    let shouldJoinStreamRoom = false
    let shouldCacheStream = payload.stream.visibility !== Visibilities.PRIVATE
    let shouldAddMembership = false
    let shouldAddDmPeer = false
    let currentUserId: string | null = null
    let dmPeerUserId: string | null = null
    let cachedStream: Stream & { lastMessagePreview?: LastMessagePreview | null } = payload.stream

    // Add to workspace bootstrap cache (sidebar)
    const applied = updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => {
      const streamExists = old.streams.some((s) => s.id === payload.stream.id)
      const currentUser = refs.getCurrentUser()
      const currentMember = currentUser && getWorkspaceUsers(old).find((u) => u.workosUserId === currentUser.id)
      currentUserId = currentMember?.id ?? null
      const isCreator = Boolean(currentMember && payload.stream.createdBy === currentMember.id)
      const isDmParticipant =
        payload.stream.type === StreamTypes.DM &&
        currentUserId !== null &&
        payload.dmUserIds?.includes(currentUserId) === true
      dmPeerUserId = resolveDmPeerUserId(payload.dmUserIds, currentUserId)
      const dmPeerDisplayName =
        dmPeerUserId != null ? (getWorkspaceUsers(old).find((user) => user.id === dmPeerUserId)?.name ?? null) : null
      cachedStream =
        payload.stream.type === StreamTypes.DM && dmPeerDisplayName
          ? { ...payload.stream, displayName: dmPeerDisplayName }
          : payload.stream
      const hasMembership = old.streamMemberships.some((m: StreamMember) => m.streamId === payload.stream.id)
      shouldAddMembership = Boolean(currentUserId && !hasMembership && (isCreator || isDmParticipant))
      shouldAddDmPeer = Boolean(
        dmPeerUserId && !old.dmPeers.some((peer) => peer.streamId === payload.stream.id && peer.userId === dmPeerUserId)
      )
      const isPrivate = payload.stream.visibility === Visibilities.PRIVATE
      const shouldAddStream =
        !streamExists &&
        (payload.stream.type === StreamTypes.DM
          ? isDmParticipant
          : // Private streams (scratchpads, private channels) — only add to sidebar for the creator.
            // Other members are added via stream:member_added.
            !isPrivate || isCreator)

      // Ensure members are subscribed immediately for follow-up stream activity.
      shouldJoinStreamRoom = hasMembership || shouldAddMembership
      shouldCacheStream = payload.stream.type === StreamTypes.DM ? isDmParticipant : !isPrivate || isCreator

      if (streamExists && !shouldAddMembership && !shouldAddDmPeer) return old

      return {
        ...old,
        streams: shouldAddStream
          ? [...old.streams, { ...cachedStream, lastMessagePreview: null }]
          : old.streams.map((stream) =>
              stream.id === payload.stream.id
                ? {
                    ...stream,
                    ...cachedStream,
                    displayName: cachedStream.displayName ?? stream.displayName,
                  }
                : stream
            ),
        streamMemberships: shouldAddMembership
          ? [
              ...old.streamMemberships,
              {
                streamId: payload.stream.id,
                memberId: currentUserId!,
                notificationLevel: null,
                lastReadEventId: null,
                lastReadAt: null,
                joinedAt: payload.stream.createdAt,
              },
            ]
          : old.streamMemberships,
        dmPeers:
          shouldAddDmPeer && dmPeerUserId != null
            ? [...old.dmPeers, { userId: dmPeerUserId, streamId: payload.stream.id }]
            : old.dmPeers,
      }
    })

    if (applied && shouldJoinStreamRoom) {
      refs.subscribeStream(payload.stream.id)
    }

    void db.transaction("rw", [db.streams, db.streamMemberships, db.dmPeers], async () => {
      const now = Date.now()

      // Cache to IndexedDB — skip other users' scratchpads to avoid stale
      // entries resurfacing on hydration if the event leaks during a deploy race.
      if (shouldCacheStream) {
        await db.streams.put({ ...cachedStream, _cachedAt: now })
      }

      // Persist membership to IDB so sidebar correctly filters public channels.
      if (shouldAddMembership && currentUserId) {
        await db.streamMemberships.put({
          id: `${workspaceId}:${payload.stream.id}`,
          workspaceId,
          streamId: payload.stream.id,
          memberId: currentUserId,
          notificationLevel: null,
          lastReadEventId: null,
          lastReadAt: null,
          joinedAt: payload.stream.createdAt,
          _cachedAt: now,
        })
      }

      if (shouldAddDmPeer && dmPeerUserId != null) {
        await db.dmPeers.put({
          id: `${workspaceId}:${payload.stream.id}`,
          workspaceId,
          userId: dmPeerUserId,
          streamId: payload.stream.id,
          _cachedAt: now,
        })
      }
    })
  }

  // Handle stream updated
  const handleStreamUpdated = (payload: StreamPayload) => {
    // For DMs the backend sends displayName: null (the name is derived from
    // the peer user on the frontend). Preserve whatever name is already cached.
    const isDmWithNullName = payload.stream.type === StreamTypes.DM && payload.stream.displayName == null

    // Update stream detail cache
    queryClient.setQueryData<Stream>(streamKeys.detail(workspaceId, payload.stream.id), (old) => {
      if (isDmWithNullName && old?.displayName) {
        return { ...payload.stream, displayName: old.displayName }
      }
      return payload.stream
    })

    // Update stream bootstrap cache (preserves events, members, etc.)
    queryClient.setQueryData<StreamBootstrap>(streamKeys.bootstrap(workspaceId, payload.stream.id), (old) => {
      if (!old) return old
      const stream =
        isDmWithNullName && old.stream.displayName
          ? { ...payload.stream, displayName: old.stream.displayName }
          : payload.stream
      return { ...old, stream }
    })

    // Update workspace bootstrap cache (sidebar) - handle visibility changes
    queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
      if (!old?.streams) return old
      const exists = old.streams.some((s) => s.id === payload.stream.id)
      if (exists) {
        const isMember = old.streamMemberships?.some((m) => m.streamId === payload.stream.id)
        // Stream went private and user isn't a member — remove from sidebar
        if (payload.stream.visibility === "private" && !isMember) {
          return { ...old, streams: old.streams.filter((s) => s.id !== payload.stream.id) }
        }
        return {
          ...old,
          streams: old.streams.map((s) =>
            s.id === payload.stream.id
              ? {
                  ...s,
                  ...payload.stream,
                  displayName:
                    payload.stream.type === StreamTypes.DM && payload.stream.displayName == null
                      ? s.displayName
                      : payload.stream.displayName,
                }
              : s
          ),
        }
      }
      // Stream not in list — add if now visible (e.g. became public)
      if (payload.stream.visibility === "public") {
        return { ...old, streams: [...old.streams, { ...payload.stream, lastMessagePreview: null }] }
      }
      return old
    })

    // Update IndexedDB — use update() (partial merge) instead of put() (full replace)
    // to preserve fields not on the Stream payload: lastMessagePreview,
    // notificationLevel, lastReadEventId (merged from membership during bootstrap).
    // For DMs, also preserve the resolved displayName since the backend sends null.
    const idbUpdate =
      payload.stream.type === StreamTypes.DM && payload.stream.displayName == null
        ? (() => {
            const { displayName: _, ...rest } = payload.stream
            return { ...rest, _cachedAt: Date.now() }
          })()
        : { ...payload.stream, _cachedAt: Date.now() }
    db.streams.update(payload.stream.id, idbUpdate)
  }

  // Handle stream archived
  const handleStreamArchived = (payload: StreamPayload) => {
    // Update stream bootstrap cache with archived stream
    queryClient.setQueryData(streamKeys.bootstrap(workspaceId, payload.stream.id), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      return { ...old, stream: payload.stream }
    })

    // Remove from workspace bootstrap cache (sidebar - archived streams don't show)
    queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      const bootstrap = old as { streams?: Stream[] }
      if (!bootstrap.streams) return old
      return {
        ...bootstrap,
        streams: bootstrap.streams.filter((s) => s.id !== payload.stream.id),
      }
    })

    // Update IndexedDB — partial merge to preserve lastMessagePreview etc.
    db.streams.update(payload.stream.id, { ...payload.stream, _cachedAt: Date.now() })
  }

  // Handle stream unarchived
  const handleStreamUnarchived = (payload: StreamPayload) => {
    // Update stream bootstrap cache with unarchived stream
    queryClient.setQueryData(streamKeys.bootstrap(workspaceId, payload.stream.id), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      return { ...old, stream: payload.stream }
    })

    // Add back to workspace bootstrap cache (sidebar)
    queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      const bootstrap = old as { streams?: Stream[] }
      if (!bootstrap.streams) return old
      // Only add if not already present
      if (bootstrap.streams.some((s) => s.id === payload.stream.id)) {
        // Update existing entry - merge to preserve lastMessagePreview
        return {
          ...bootstrap,
          streams: bootstrap.streams.map((s) => (s.id === payload.stream.id ? { ...s, ...payload.stream } : s)),
        }
      }
      return {
        ...bootstrap,
        streams: [...bootstrap.streams, payload.stream],
      }
    })

    // Update IndexedDB — partial merge to preserve lastMessagePreview etc.
    db.streams.update(payload.stream.id, { ...payload.stream, _cachedAt: Date.now() })
  }

  // Handle workspace user added
  const handleWorkspaceUserAdded = (payload: WorkspaceUserAddedPayload) => {
    const now = Date.now()
    const { user } = payload

    // Update workspace bootstrap cache with user if not already present.
    updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => {
      const users = getWorkspaceUsers(old)
      const incomingUser = toWorkspaceUser(user)
      const updatedUsers = users.some((u) => u.id === user.id) ? users : [...users, incomingUser]

      return withWorkspaceUsers(old, updatedUsers)
    })

    // Cache user to IndexedDB
    db.workspaceUsers.put({
      ...toWorkspaceUser(user),
      _cachedAt: now,
    })
  }

  // Handle workspace user removed
  const handleWorkspaceUserRemoved = (payload: WorkspaceUserRemovedPayload) => {
    // Update workspace bootstrap cache
    queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      const bootstrap = old as WorkspaceBootstrap
      const users = getWorkspaceUsers(bootstrap)
      return withWorkspaceUsers(
        bootstrap,
        users.filter((u) => u.id !== payload.removedUserId)
      )
    })

    // Remove from IndexedDB workspace users
    db.workspaceUsers.delete(payload.removedUserId)
  }

  // Handle workspace user updated
  const handleWorkspaceUserUpdated = (payload: WorkspaceUserUpdatedPayload) => {
    const now = Date.now()
    const { user } = payload

    // Update workspace bootstrap cache.
    queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      const bootstrap = old as WorkspaceBootstrap
      const users = getWorkspaceUsers(bootstrap)
      const incomingUser = toWorkspaceUser(user)
      const updatedUsers = users.map((u) => (u.id === user.id ? incomingUser : u))

      return withWorkspaceUsers(bootstrap, updatedUsers)
    })

    // Update IndexedDB and the in-memory cache so a freshly-mounted reader's
    // first synchronous render (before useLiveQuery resolves) sees this update.
    const cachedUser = { ...toWorkspaceUser(user), _cachedAt: now }
    db.workspaceUsers.put(cachedUser)
    upsertWorkspaceUserInCache(workspaceId, cachedUser)
  }

  // Handle stream read (from other sessions of the same user)
  // Backend marks ALL stream activity as read (mentions + message notifications)
  const handleStreamRead = (payload: StreamReadPayload) => {
    if (payload.workspaceId !== workspaceId) return

    const current = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId))
    const hadActivity = (current?.activityCounts[payload.streamId] ?? 0) > 0

    queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
      if (!old) return old
      const clearedActivity = old.activityCounts[payload.streamId] ?? 0
      return {
        ...old,
        unreadCounts: {
          ...old.unreadCounts,
          [payload.streamId]: 0,
        },
        mentionCounts: {
          ...old.mentionCounts,
          [payload.streamId]: 0,
        },
        activityCounts: {
          ...old.activityCounts,
          [payload.streamId]: 0,
        },
        unreadActivityCount: Math.max(0, (old.unreadActivityCount ?? 0) - clearedActivity),
        streamMemberships: old.streamMemberships.map((membership) =>
          membership.streamId === payload.streamId
            ? { ...membership, lastReadEventId: payload.lastReadEventId }
            : membership
        ),
      }
    })

    queryClient.setQueryData<import("@threa/types").StreamBootstrap | undefined>(
      streamKeys.bootstrap(workspaceId, payload.streamId),
      (old) => {
        if (!old?.membership) return old
        return {
          ...old,
          membership: { ...old.membership, lastReadEventId: payload.lastReadEventId },
        }
      }
    )

    // Keep both stream and membership mirrors in sync so unread-divider state
    // updates immediately without waiting for a re-bootstrap/remount.
    db.transaction("rw", [db.unreadState, db.streams, db.streamMemberships], async () => {
      const now = Date.now()
      const state = await db.unreadState.get(workspaceId)
      if (state) {
        const clearedActivity = state.activityCounts[payload.streamId] ?? 0
        await db.unreadState.put({
          ...state,
          unreadCounts: { ...state.unreadCounts, [payload.streamId]: 0 },
          mentionCounts: { ...state.mentionCounts, [payload.streamId]: 0 },
          activityCounts: { ...state.activityCounts, [payload.streamId]: 0 },
          unreadActivityCount: Math.max(0, state.unreadActivityCount - clearedActivity),
          _cachedAt: now,
        })
      }

      await db.streams.update(payload.streamId, { lastReadEventId: payload.lastReadEventId, _cachedAt: now })

      const membershipId = `${workspaceId}:${payload.streamId}`
      const membership = await db.streamMemberships.get(membershipId)
      if (membership) {
        await db.streamMemberships.put({
          ...membership,
          lastReadEventId: payload.lastReadEventId,
          id: membershipId,
          workspaceId,
          _cachedAt: now,
        })
      }
    })

    if (hadActivity) {
      queryClient.invalidateQueries({ queryKey: ["activity", workspaceId] })
    }

    // Dismiss push notification for this stream (fast path when the app is open)
    navigator.serviceWorker?.controller?.postMessage({
      type: SW_MSG_CLEAR_NOTIFICATIONS,
      streamId: payload.streamId,
    })
  }

  // Handle all streams read (from other sessions of the same user)
  const handleStreamReadAll = (payload: StreamsReadAllPayload) => {
    if (payload.workspaceId !== workspaceId) return

    queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
      if (!old) return old

      const newUnreadCounts = { ...old.unreadCounts }
      const newMentionCounts = { ...old.mentionCounts }
      const newActivityCounts = { ...old.activityCounts }
      let clearedActivity = 0
      for (const streamId of payload.streamIds) {
        newUnreadCounts[streamId] = 0
        newMentionCounts[streamId] = 0
        clearedActivity += newActivityCounts[streamId] ?? 0
        newActivityCounts[streamId] = 0
      }
      return {
        ...old,
        unreadCounts: newUnreadCounts,
        mentionCounts: newMentionCounts,
        activityCounts: newActivityCounts,
        unreadActivityCount: Math.max(0, (old.unreadActivityCount ?? 0) - clearedActivity),
      }
    })

    // Update IDB unread state
    db.transaction("rw", [db.unreadState], async () => {
      const state = await db.unreadState.get(workspaceId)
      if (!state) return
      const updated = { ...state, _cachedAt: Date.now() }
      const newUnread = { ...state.unreadCounts }
      const newMention = { ...state.mentionCounts }
      const newActivity = { ...state.activityCounts }
      let cleared = 0
      for (const sid of payload.streamIds) {
        newUnread[sid] = 0
        newMention[sid] = 0
        cleared += newActivity[sid] ?? 0
        newActivity[sid] = 0
      }
      updated.unreadCounts = newUnread
      updated.mentionCounts = newMention
      updated.activityCounts = newActivity
      updated.unreadActivityCount = Math.max(0, state.unreadActivityCount - cleared)
      await db.unreadState.put(updated)
    })

    queryClient.invalidateQueries({ queryKey: ["activity", workspaceId] })

    // Dismiss push notifications for all read streams (fast path when the app is open)
    for (const streamId of payload.streamIds) {
      navigator.serviceWorker?.controller?.postMessage({
        type: SW_MSG_CLEAR_NOTIFICATIONS,
        streamId,
      })
    }
  }

  // Handle stream activity (when a new message is created in any stream)
  // Always updates the preview, but only increments unread for others' messages
  const handleStreamActivity = (payload: StreamActivityPayload) => {
    // Only update if it's for this workspace
    if (payload.workspaceId !== workspaceId) return

    const isViewingStream = refs.getCurrentStreamId() === payload.streamId

    // If not viewing this stream and it has an active bootstrap observer,
    // invalidate so it refetches. Dormant queries are not touched — IDB
    // already has the latest data via socket writes, so navigation will
    // read from useLiveQuery without a redundant HTTP refetch.
    if (!isViewingStream) {
      queryClient.invalidateQueries({
        queryKey: streamKeys.bootstrap(workspaceId, payload.streamId),
        type: "active",
      })
    }

    queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
      if (!old) return old

      // Only update if user is a member of this stream
      const isMember = old.streamMemberships.some((m: StreamMember) => m.streamId === payload.streamId)
      if (!isMember) return old

      // Determine if we should increment unread count:
      // - Not for own messages (authorId is a userId — match via user.workosUserId)
      // - Not when currently viewing the stream
      const currentUser = refs.getCurrentUser()
      const currentMember = currentUser && getWorkspaceUsers(old).find((u) => u.workosUserId === currentUser.id)
      const isOwnMessage = currentMember && payload.authorId === currentMember.id
      const shouldIncrementUnread = !isOwnMessage && !isViewingStream

      return {
        ...old,
        // Only increment unread count for others' messages when not viewing
        unreadCounts: shouldIncrementUnread
          ? {
              ...old.unreadCounts,
              [payload.streamId]: (old.unreadCounts[payload.streamId] ?? 0) + 1,
            }
          : old.unreadCounts,
        // Always update stream's lastMessagePreview for sidebar display
        streams: old.streams.map((stream) =>
          stream.id === payload.streamId ? { ...stream, lastMessagePreview: payload.lastMessagePreview } : stream
        ),
      }
    })

    // Always persist lastMessagePreview to IDB so the cached sort order
    // matches what the user last saw (sidebar sorts scratchpads by activity).
    db.streams.update(payload.streamId, {
      lastMessagePreview: payload.lastMessagePreview,
      _cachedAt: Date.now(),
    })

    // Update IDB: increment unread count for others' messages when not viewing.
    // We check membership via IDB to avoid dependency on the TanStack closure.
    if (!isViewingStream) {
      void (async () => {
        const membership = await db.streamMemberships.get(`${workspaceId}:${payload.streamId}`)
        if (!membership) return
        const currentUser = refs.getCurrentUser()
        const currentMember = currentUser
          ? await db.workspaceUsers
              .where("workspaceId")
              .equals(workspaceId)
              .filter((u) => u.workosUserId === currentUser.id)
              .first()
          : null
        if (currentMember && payload.authorId === currentMember.id) return

        await db.transaction("rw", [db.unreadState], async () => {
          const state = await db.unreadState.get(workspaceId)
          if (!state) return
          await db.unreadState.put({
            ...state,
            unreadCounts: {
              ...state.unreadCounts,
              [payload.streamId]: (state.unreadCounts[payload.streamId] ?? 0) + 1,
            },
            _cachedAt: Date.now(),
          })
        })
      })()
    }
  }

  // Handle stream display name updated (from auto-naming service)
  const handleStreamDisplayNameUpdated = (payload: StreamDisplayNameUpdatedPayload) => {
    // Update stream detail cache
    queryClient.setQueryData(streamKeys.detail(workspaceId, payload.streamId), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      return { ...old, displayName: payload.displayName }
    })

    // Update stream bootstrap cache
    queryClient.setQueryData(streamKeys.bootstrap(workspaceId, payload.streamId), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      const bootstrap = old as { stream?: Stream }
      if (!bootstrap.stream) return old
      return { ...old, stream: { ...bootstrap.stream, displayName: payload.displayName } }
    })

    // Update workspace bootstrap cache (sidebar)
    queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      const bootstrap = old as { streams?: Stream[] }
      if (!bootstrap.streams) return old
      return {
        ...bootstrap,
        streams: bootstrap.streams.map((s) =>
          s.id === payload.streamId ? { ...s, displayName: payload.displayName } : s
        ),
      }
    })

    // Update IndexedDB
    db.streams.update(payload.streamId, { displayName: payload.displayName, _cachedAt: Date.now() })
  }

  // Handle stream member added
  const handleStreamMemberAdded = (payload: {
    workspaceId: string
    streamId: string
    memberId: string
    stream: Stream
    event: StreamEvent
  }) => {
    if (payload.workspaceId !== workspaceId) return
    let shouldSubscribeStream = false

    // Update stream bootstrap members list (humans) or botMemberIds (bots)
    queryClient.setQueryData(streamKeys.bootstrap(workspaceId, payload.streamId), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      const bootstrap = old as { members?: StreamMember[]; botMemberIds?: string[] }

      if (payload.event.actorType === "bot") {
        const botMemberIds = bootstrap.botMemberIds ?? []
        if (botMemberIds.includes(payload.memberId)) return old
        return { ...bootstrap, botMemberIds: [...botMemberIds, payload.memberId] }
      }

      if (!bootstrap.members) return old
      const exists = bootstrap.members.some((m: StreamMember) => m.memberId === payload.memberId)
      if (exists) return old
      return {
        ...bootstrap,
        members: [
          ...bootstrap.members,
          {
            streamId: payload.streamId,
            memberId: payload.memberId,
            notificationLevel: null,
            lastReadEventId: null,
            lastReadAt: null,
            joinedAt: new Date().toISOString(),
          },
        ],
      }
    })

    // If the added member is the current user, add to streamMemberships + sidebar
    updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => {
      const currentUser = refs.getCurrentUser()
      const currentMember = currentUser && getWorkspaceUsers(old).find((u) => u.workosUserId === currentUser.id)
      if (!currentMember || payload.memberId !== currentMember.id) return old
      shouldSubscribeStream = true

      const membershipExists = old.streamMemberships.some((m: StreamMember) => m.streamId === payload.streamId)
      const streamExists = old.streams?.some((s) => s.id === payload.streamId)

      // Write membership to IDB
      if (!membershipExists) {
        const now = Date.now()
        db.streamMemberships.put({
          id: `${workspaceId}:${payload.streamId}`,
          workspaceId,
          streamId: payload.streamId,
          memberId: payload.memberId,
          notificationLevel: null,
          lastReadEventId: null,
          lastReadAt: null,
          joinedAt: new Date().toISOString(),
          _cachedAt: now,
        })
      }
      if (!streamExists) {
        db.streams.put({ ...payload.stream, _cachedAt: Date.now() })
      }

      return {
        ...old,
        streamMemberships: membershipExists
          ? old.streamMemberships
          : [
              ...old.streamMemberships,
              {
                streamId: payload.streamId,
                memberId: payload.memberId,
                notificationLevel: null,
                lastReadEventId: null,
                lastReadAt: null,
                joinedAt: new Date().toISOString(),
              },
            ],
        streams: streamExists ? old.streams : [...(old.streams ?? []), { ...payload.stream, lastMessagePreview: null }],
      }
    })

    if (shouldSubscribeStream) {
      refs.subscribeStream(payload.streamId)
    }
  }

  // Handle stream member removed
  const handleStreamMemberRemoved = (payload: { workspaceId: string; streamId: string; memberId: string }) => {
    if (payload.workspaceId !== workspaceId) return

    // Update stream bootstrap members list (humans) and botMemberIds (bots)
    queryClient.setQueryData(streamKeys.bootstrap(workspaceId, payload.streamId), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      const bootstrap = old as { members?: StreamMember[]; botMemberIds?: string[] }

      const next: Record<string, unknown> = { ...bootstrap }
      let changed = false

      if (bootstrap.members) {
        const filtered = bootstrap.members.filter((m: StreamMember) => m.memberId !== payload.memberId)
        if (filtered.length !== bootstrap.members.length) {
          next.members = filtered
          changed = true
        }
      }

      if (bootstrap.botMemberIds) {
        const filtered = bootstrap.botMemberIds.filter((id) => id !== payload.memberId)
        if (filtered.length !== bootstrap.botMemberIds.length) {
          next.botMemberIds = filtered
          changed = true
        }
      }

      return changed ? next : old
    })

    // If the removed member is the current user, remove from streamMemberships
    // and remove private streams from sidebar (no longer visible)
    queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
      if (!old) return old
      const currentUser = refs.getCurrentUser()
      const currentMember = currentUser && getWorkspaceUsers(old).find((u) => u.workosUserId === currentUser.id)
      if (!currentMember || payload.memberId !== currentMember.id) return old

      // Remove membership from IDB
      db.streamMemberships.delete(`${workspaceId}:${payload.streamId}`)

      const removedStream = old.streams?.find((s) => s.id === payload.streamId)
      const shouldRemoveFromSidebar = removedStream?.visibility === "private"
      if (shouldRemoveFromSidebar) {
        db.streams.delete(payload.streamId)
      }

      return {
        ...old,
        streamMemberships: old.streamMemberships.filter((m: StreamMember) => m.streamId !== payload.streamId),
        streams: shouldRemoveFromSidebar ? old.streams?.filter((s) => s.id !== payload.streamId) : old.streams,
      }
    })
  }

  // Handle user preferences updated (from other sessions of the same user)
  const handleUserPreferencesUpdated = (payload: UserPreferencesUpdatedPayload) => {
    // Only update if it's for this workspace
    if (payload.workspaceId !== workspaceId) return

    queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
      if (!old) return old
      return {
        ...old,
        userPreferences: payload.preferences,
      }
    })

    // Write to IDB
    db.userPreferences.put({
      ...payload.preferences,
      id: workspaceId,
      workspaceId,
      _cachedAt: Date.now(),
    })
  }

  // Handle sidebar config updated (from other sessions of the same user)
  const handleSidebarConfigUpdated = (payload: SidebarConfigUpdatedPayload) => {
    if (payload.workspaceId !== workspaceId) return

    // Normalize at the write boundary so an event from a not-yet-upgraded
    // backend (missing quickLinks) can't seed an incomplete document into the
    // query cache / IDB for any reader that bypasses useSidebarConfig.
    const config = normalizeSidebarConfig(payload.sidebarConfig)

    queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
      if (!old) return old
      return { ...old, sidebarConfig: config }
    })

    // Write to IDB so the IDB-backed sidebar store hook reacts immediately.
    db.sidebarConfigs.put({
      id: workspaceId,
      workspaceId,
      config,
      _cachedAt: Date.now(),
    })
  }

  // Handle workspace settings updated (an admin changed the workspace default
  // schedule). Workspace-scoped, so every member receives it. Lives only in the
  // bootstrap query cache — no IDB table — matching how it's read.
  const handleWorkspaceSettingsUpdated = (payload: WorkspaceSettingsUpdatedPayload) => {
    if (payload.workspaceId !== workspaceId) return

    // Invalidate (forcing a refetch) when the bootstrap isn't cached yet so the
    // event isn't dropped if it lands before the bootstrap fetch settles (INV-53).
    updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => ({ ...old, workspaceSettings: payload.settings }))
  }

  // Handle feature flags updated (a platform admin toggled a flag for this
  // user from the backoffice). User-scoped event carrying the full resolved
  // map; lives only in the bootstrap query cache, like workspace settings.
  const handleFeatureFlagsUpdated = (payload: FeatureFlagsUpdatedPayload) => {
    if (payload.workspaceId !== workspaceId) return

    updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => ({ ...old, featureFlags: payload.featureFlags }))
  }

  // Handle bot created
  const handleBotCreated = (payload: { workspaceId: string; bot: Bot }) => {
    if (payload.workspaceId !== workspaceId) return

    updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => {
      const exists = old.bots?.some((b) => b.id === payload.bot.id)
      if (exists) return old
      return { ...old, bots: [...(old.bots ?? []), payload.bot] }
    })

    db.bots.put({ ...payload.bot, _cachedAt: Date.now() })
  }

  // Handle bot updated
  const handleBotUpdated = (payload: { workspaceId: string; bot: Bot }) => {
    if (payload.workspaceId !== workspaceId) return

    updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => {
      const exists = old.bots?.some((b) => b.id === payload.bot.id)
      if (exists) {
        return { ...old, bots: (old.bots ?? []).map((b) => (b.id === payload.bot.id ? payload.bot : b)) }
      }
      return { ...old, bots: [...(old.bots ?? []), payload.bot] }
    })

    db.bots.put({ ...payload.bot, _cachedAt: Date.now() })
  }

  // Handle activity created (mentions, notification-level activities, reactions, self rows)
  const handleActivityCreated = (payload: ActivityCreatedPayload) => {
    if (payload.workspaceId !== workspaceId) return

    const { streamId, activityType, isSelf } = payload.activity

    // Self rows (the user's own message or reaction) show in the feed but must
    // not inflate unread counts. The backend inserts them already read.
    if (!isSelf) {
      updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => ({
        ...old,
        mentionCounts:
          activityType === "mention"
            ? { ...old.mentionCounts, [streamId]: (old.mentionCounts[streamId] ?? 0) + 1 }
            : old.mentionCounts,
        activityCounts: {
          ...old.activityCounts,
          [streamId]: (old.activityCounts[streamId] ?? 0) + 1,
        },
        unreadActivityCount: (old.unreadActivityCount ?? 0) + 1,
      }))

      // Update IDB unread state
      db.transaction("rw", [db.unreadState], async () => {
        const state = await db.unreadState.get(workspaceId)
        if (!state) return
        await db.unreadState.put({
          ...state,
          mentionCounts:
            activityType === "mention"
              ? { ...state.mentionCounts, [streamId]: (state.mentionCounts[streamId] ?? 0) + 1 }
              : state.mentionCounts,
          activityCounts: {
            ...state.activityCounts,
            [streamId]: (state.activityCounts[streamId] ?? 0) + 1,
          },
          unreadActivityCount: state.unreadActivityCount + 1,
          _cachedAt: Date.now(),
        })
      })
    }

    // Invalidate activity feed so it refetches when the page is mounted
    queryClient.invalidateQueries({ queryKey: ["activity", workspaceId] })
  }

  // Handle attachment transcoded (video processing completed or failed)
  const handleAttachmentTranscoded = async (payload: {
    workspaceId: string
    attachmentId: string
    processingStatus: string
    streamId?: string
    messageId?: string
  }) => {
    if (payload.workspaceId !== workspaceId) return

    // Update the message event in IDB if we have stream + message context
    if (payload.streamId && payload.messageId) {
      const updatePayload = (p: Record<string, unknown>) => {
        if (!Array.isArray(p.attachments)) return p
        const attachments = p.attachments as Array<Record<string, unknown>>
        const updatedAttachments = attachments.map((a) =>
          a.id === payload.attachmentId ? { ...a, processingStatus: payload.processingStatus } : a
        )
        return { ...p, attachments: updatedAttachments }
      }

      const events = await db.events
        .where("[streamId+eventType]")
        .equals([payload.streamId, "message_created"])
        .filter((e) => (e.payload as { messageId?: string })?.messageId === payload.messageId)
        .toArray()

      if (events.length > 0) {
        const event = events[0]
        await db.events.update(event.id, {
          payload: updatePayload(event.payload as Record<string, unknown>),
          _cachedAt: Date.now(),
        })
      } else {
        queryClient.invalidateQueries({
          queryKey: streamKeys.bootstrap(workspaceId, payload.streamId),
          type: "active",
        })
      }

      queryClient.setQueryData<StreamBootstrap>(streamKeys.bootstrap(workspaceId, payload.streamId), (old) => {
        if (!old) return old
        return {
          ...old,
          events: old.events.map((event) => {
            const eventPayload = event.payload as { messageId?: string } & Record<string, unknown>
            if (event.eventType !== "message_created" || eventPayload.messageId !== payload.messageId) {
              return event
            }
            return { ...event, payload: updatePayload(eventPayload) }
          }),
        }
      })
    }
  }

  // Image thumbnail ready — patch the attachment's intrinsic dimensions into
  // cached message events so the inline image box reserves the right size even
  // when the message was sent before the thumbnail worker finished.
  const handleAttachmentThumbnailed = async (payload: {
    workspaceId: string
    attachmentId: string
    width: number
    height: number
    streamId?: string
    messageId?: string
  }) => {
    if (payload.workspaceId !== workspaceId) return
    if (!payload.streamId || !payload.messageId) return

    const updatePayload = (p: Record<string, unknown>) => {
      if (!Array.isArray(p.attachments)) return p
      const attachments = p.attachments as Array<Record<string, unknown>>
      const updatedAttachments = attachments.map((a) =>
        a.id === payload.attachmentId ? { ...a, width: payload.width, height: payload.height } : a
      )
      return { ...p, attachments: updatedAttachments }
    }

    const events = await db.events
      .where("[streamId+eventType]")
      .equals([payload.streamId, "message_created"])
      .filter((e) => (e.payload as { messageId?: string })?.messageId === payload.messageId)
      .toArray()

    if (events.length > 0) {
      const event = events[0]
      await db.events.update(event.id, {
        payload: updatePayload(event.payload as Record<string, unknown>),
        _cachedAt: Date.now(),
      })
    } else {
      queryClient.invalidateQueries({
        queryKey: streamKeys.bootstrap(workspaceId, payload.streamId),
        type: "active",
      })
    }

    queryClient.setQueryData<StreamBootstrap>(streamKeys.bootstrap(workspaceId, payload.streamId), (old) => {
      if (!old) return old
      return {
        ...old,
        events: old.events.map((event) => {
          const eventPayload = event.payload as { messageId?: string } & Record<string, unknown>
          if (event.eventType !== "message_created" || eventPayload.messageId !== payload.messageId) {
            return event
          }
          return { ...event, payload: updatePayload(eventPayload) }
        }),
      }
    })
  }

  // Saved messages — write-through to IDB and invalidate TanStack caches so
  // cross-device saves reflect on every open tab without a refresh.
  const handleSavedUpserted = (payload: SavedUpsertedPayload) => {
    if (payload.workspaceId !== workspaceId) return
    void persistSavedRows(workspaceId, [payload.saved])
    queryClient.invalidateQueries({ queryKey: savedKeys.list(workspaceId, "saved") })
    queryClient.invalidateQueries({ queryKey: savedKeys.list(workspaceId, "done") })
    queryClient.invalidateQueries({ queryKey: savedKeys.list(workspaceId, "archived") })
  }

  const handleSavedDeleted = (payload: SavedDeletedPayload) => {
    if (payload.workspaceId !== workspaceId) return
    void removeSavedRow(payload.savedId)
    queryClient.invalidateQueries({ queryKey: savedKeys.list(workspaceId, "saved") })
    queryClient.invalidateQueries({ queryKey: savedKeys.list(workspaceId, "done") })
    queryClient.invalidateQueries({ queryKey: savedKeys.list(workspaceId, "archived") })
  }

  const handleSavedReminderFired = (payload: SavedReminderFiredPayload) => {
    if (payload.workspaceId !== workspaceId) return
    // Update the cached row so the badge flips to "reminded" immediately. The
    // persistent surface is the Activity feed (backend emits `activity:created`
    // for the saved_reminder row) — we deliberately don't pop a toast here so
    // there's one canonical notification path.
    void persistSavedRows(workspaceId, [payload.saved])
    queryClient.invalidateQueries({ queryKey: savedKeys.list(workspaceId, "saved") })
  }

  // Scheduled messages — write-through to IDB and invalidate TanStack lists
  // so the To send / Sent tabs and the per-stream composer popover reflect
  // cross-tab and cross-device state without a refresh.
  const handleScheduledUpserted = (payload: ScheduledMessageUpsertedPayload) => {
    if (payload.workspaceId !== workspaceId) return
    void (async () => {
      // If the row carries a clientMessageId, sweep any optimistic placeholder
      // sharing that key — the operation queue's `replaceLocalScheduledRow`
      // already does this when the POST returns, but a socket event can race
      // ahead of the executor and we don't want both rows visible briefly.
      const cmid = payload.scheduled.clientMessageId
      if (cmid) {
        const stale = await db.scheduledMessages
          .where("workspaceId")
          .equals(workspaceId)
          .filter((row) => row._localOnly === true && row.id !== payload.scheduled.id && row.clientMessageId === cmid)
          .toArray()
        if (stale.length > 0) {
          await db.scheduledMessages.bulkDelete(stale.map((row) => row.id))
        }
      }
      await persistScheduledRows([payload.scheduled])
      queryClient.invalidateQueries({ queryKey: scheduledKeys.all })
    })()
  }

  const handleScheduledSent = (payload: ScheduledMessageSentPayload) => {
    if (payload.workspaceId !== workspaceId) return
    // Persist the (now status='sent') row so the Sent tab picks it up; the
    // live message itself has already been broadcast through the standard
    // message:created path so the in-stream timeline updates separately.
    void persistScheduledRows([payload.scheduled])
    queryClient.invalidateQueries({ queryKey: scheduledKeys.all })
  }

  const handleScheduledCancelled = (payload: ScheduledMessageCancelledPayload) => {
    if (payload.workspaceId !== workspaceId) return
    void removeScheduledRow(payload.scheduledId)
    queryClient.invalidateQueries({ queryKey: scheduledKeys.all })
  }

  // Labels — created/updated arrive in the creator's user room for private
  // labels, workspace-wide for public ones. The receiving client just writes
  // the row; visibility-based filtering happens at the UI layer.
  const handleLabelUpserted = (payload: LabelUpsertedPayload) => {
    if (payload.workspaceId !== workspaceId) return
    const { label } = payload
    const now = Date.now()

    updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => {
      const labels = old.labels ?? []
      const exists = labels.some((l) => l.id === label.id)
      return {
        ...old,
        labels: exists ? labels.map((l) => (l.id === label.id ? label : l)) : [...labels, label],
      }
    })

    void db.labels.put({ ...label, _cachedAt: now })
  }

  const handleLabelDeleted = (payload: LabelDeletedPayload) => {
    if (payload.workspaceId !== workspaceId) return
    const { labelId } = payload

    updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => ({
      ...old,
      labels: (old.labels ?? []).filter((l) => l.id !== labelId),
      labelMemberships: (old.labelMemberships ?? []).filter((m) => m.labelId !== labelId),
      // Backend archive drops assignments in the same transaction without
      // per-row unassign events (see label service) — mirror that here so a
      // deleted label's chips disappear immediately.
      labelAssignments: (old.labelAssignments ?? []).filter((a) => a.labelId !== labelId),
    }))

    void db.transaction("rw", [db.labels, db.labelMemberships, db.labelAssignments], async () => {
      await db.labels.delete(labelId)
      const membershipIds = await db.labelMemberships.where("labelId").equals(labelId).primaryKeys()
      if (membershipIds.length > 0) {
        await db.labelMemberships.bulkDelete(membershipIds as string[])
      }
      const assignmentIds = await db.labelAssignments.where("labelId").equals(labelId).primaryKeys()
      if (assignmentIds.length > 0) {
        await db.labelAssignments.bulkDelete(assignmentIds as string[])
      }
    })
  }

  const handleLabelMemberJoined = (payload: LabelMemberJoinedPayload) => {
    if (payload.workspaceId !== workspaceId) return
    const { member } = payload
    const now = Date.now()
    const id = `${workspaceId}:${member.labelId}:${member.userId}`

    updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => {
      const memberships = old.labelMemberships ?? []
      const exists = memberships.some((m) => m.labelId === member.labelId && m.userId === member.userId)
      return {
        ...old,
        labelMemberships: exists ? memberships : [...memberships, member],
      }
    })

    void db.labelMemberships.put({
      id,
      workspaceId,
      labelId: member.labelId,
      userId: member.userId,
      joinedAt: member.joinedAt,
      _cachedAt: now,
    })
  }

  const handleLabelMemberLeft = (payload: LabelMemberLeftPayload) => {
    if (payload.workspaceId !== workspaceId) return
    const { labelId, userId } = payload
    const id = `${workspaceId}:${labelId}:${userId}`

    updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => ({
      ...old,
      labelMemberships: (old.labelMemberships ?? []).filter((m) => !(m.labelId === labelId && m.userId === userId)),
    }))

    void db.labelMemberships.delete(id)
  }

  // Assignments — viewer-scoped, so these arrive only in the assigning user's
  // room. Generic over resourceType: the handler never special-cases what kind
  // of resource was labeled.
  const sameAssignment = (
    a: { labelId: string; resourceType: string; resourceId: string; userId: string },
    b: { labelId: string; resourceType: string; resourceId: string; userId: string }
  ) =>
    a.labelId === b.labelId &&
    a.resourceType === b.resourceType &&
    a.resourceId === b.resourceId &&
    a.userId === b.userId

  const handleLabelAssigned = (payload: LabelAssignedPayload) => {
    if (payload.workspaceId !== workspaceId) return
    const { assignment } = payload

    updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => {
      const assignments = old.labelAssignments ?? []
      const exists = assignments.some((a) => sameAssignment(a, assignment))
      return {
        ...old,
        labelAssignments: exists
          ? assignments.map((a) => (sameAssignment(a, assignment) ? assignment : a))
          : [...assignments, assignment],
      }
    })

    void db.labelAssignments.put(assignmentToCached(assignment))
  }

  const handleLabelUnassigned = (payload: LabelUnassignedPayload) => {
    if (payload.workspaceId !== workspaceId) return
    const { labelId, resourceType, resourceId, userId } = payload

    updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => ({
      ...old,
      labelAssignments: (old.labelAssignments ?? []).filter(
        (a) => !sameAssignment(a, { labelId, resourceType, resourceId, userId })
      ),
    }))

    void db.labelAssignments.delete(assignmentId(workspaceId, resourceType, resourceId, labelId, userId))
  }

  // Register all handlers
  socket.on("stream:created", handleStreamCreated)
  socket.on("stream:updated", handleStreamUpdated)
  socket.on("stream:archived", handleStreamArchived)
  socket.on("stream:unarchived", handleStreamUnarchived)
  socket.on("workspace_user:added", handleWorkspaceUserAdded)
  socket.on("workspace_user:removed", handleWorkspaceUserRemoved)
  socket.on("workspace_user:updated", handleWorkspaceUserUpdated)
  socket.on("stream:read", handleStreamRead)
  socket.on("stream:read_all", handleStreamReadAll)
  socket.on("stream:activity", handleStreamActivity)
  socket.on("stream:display_name_updated", handleStreamDisplayNameUpdated)
  socket.on("stream:member_added", handleStreamMemberAdded)
  socket.on("stream:member_removed", handleStreamMemberRemoved)
  socket.on("user_preferences:updated", handleUserPreferencesUpdated)
  socket.on("sidebar_config:updated", handleSidebarConfigUpdated)
  socket.on("workspace_settings:updated", handleWorkspaceSettingsUpdated)
  socket.on("feature_flags:updated", handleFeatureFlagsUpdated)
  socket.on("bot:created", handleBotCreated)
  socket.on("bot:updated", handleBotUpdated)
  socket.on("activity:created", handleActivityCreated)
  socket.on("saved:upserted", handleSavedUpserted)
  socket.on("saved:deleted", handleSavedDeleted)
  socket.on("saved_reminder:fired", handleSavedReminderFired)
  socket.on("scheduled_message:upserted", handleScheduledUpserted)
  socket.on("scheduled_message:sent", handleScheduledSent)
  socket.on("scheduled_message:cancelled", handleScheduledCancelled)
  socket.on("attachment:transcoded", handleAttachmentTranscoded)
  socket.on("attachment:thumbnailed", handleAttachmentThumbnailed)
  socket.on("label:created", handleLabelUpserted)
  socket.on("label:updated", handleLabelUpserted)
  socket.on("label:deleted", handleLabelDeleted)
  socket.on("label:member_joined", handleLabelMemberJoined)
  socket.on("label:member_left", handleLabelMemberLeft)
  socket.on("label:assigned", handleLabelAssigned)
  socket.on("label:unassigned", handleLabelUnassigned)

  return () => {
    abortController.abort()
    // Do NOT leave workspace room here. Multiple hooks perform ws joins and Socket.io
    // rooms are not reference-counted; one leave can drop member-scoped delivery.
    socket.off("stream:created", handleStreamCreated)
    socket.off("stream:updated", handleStreamUpdated)
    socket.off("stream:archived", handleStreamArchived)
    socket.off("stream:unarchived", handleStreamUnarchived)
    socket.off("workspace_user:added", handleWorkspaceUserAdded)
    socket.off("workspace_user:removed", handleWorkspaceUserRemoved)
    socket.off("workspace_user:updated", handleWorkspaceUserUpdated)
    socket.off("stream:read", handleStreamRead)
    socket.off("stream:read_all", handleStreamReadAll)
    socket.off("stream:activity", handleStreamActivity)
    socket.off("stream:display_name_updated", handleStreamDisplayNameUpdated)
    socket.off("stream:member_added", handleStreamMemberAdded)
    socket.off("stream:member_removed", handleStreamMemberRemoved)
    socket.off("user_preferences:updated", handleUserPreferencesUpdated)
    socket.off("sidebar_config:updated", handleSidebarConfigUpdated)
    socket.off("workspace_settings:updated", handleWorkspaceSettingsUpdated)
    socket.off("feature_flags:updated", handleFeatureFlagsUpdated)
    socket.off("bot:created", handleBotCreated)
    socket.off("bot:updated", handleBotUpdated)
    socket.off("activity:created", handleActivityCreated)
    socket.off("saved:upserted", handleSavedUpserted)
    socket.off("saved:deleted", handleSavedDeleted)
    socket.off("saved_reminder:fired", handleSavedReminderFired)
    socket.off("scheduled_message:upserted", handleScheduledUpserted)
    socket.off("scheduled_message:sent", handleScheduledSent)
    socket.off("scheduled_message:cancelled", handleScheduledCancelled)
    socket.off("attachment:transcoded", handleAttachmentTranscoded)
    socket.off("attachment:thumbnailed", handleAttachmentThumbnailed)
    socket.off("label:created", handleLabelUpserted)
    socket.off("label:updated", handleLabelUpserted)
    socket.off("label:deleted", handleLabelDeleted)
    socket.off("label:member_joined", handleLabelMemberJoined)
    socket.off("label:member_left", handleLabelMemberLeft)
    socket.off("label:assigned", handleLabelAssigned)
    socket.off("label:unassigned", handleLabelUnassigned)
  }
}

// ============================================================================
// Bootstrap application — writes workspace bootstrap data to IndexedDB
// ============================================================================

/**
 * Shred a WorkspaceBootstrap response into individual IDB tables.
 *
 * For workspace-scoped entities (streams, users, memberships, etc.), this
 * is a REPLACE: entities not in the bootstrap snapshot are deleted if they
 * were written before this bootstrap (`_cachedAt < now`). Entities written
 * concurrently by socket handlers (`_cachedAt >= now`) are preserved.
 *
 * This prevents stale data from accumulating across environments or DB resets.
 */
export async function applyWorkspaceBootstrap(
  workspaceId: string,
  bootstrap: WorkspaceBootstrap,
  fetchStartedAt?: number
): Promise<void> {
  const now = Date.now()

  // Build membership lookup for O(1) access when merging onto streams
  const membershipByStream = new Map(bootstrap.streamMemberships.map((sm) => [sm.streamId, sm]))

  // Workspace bootstrap doesn't carry stream-level fields that the per-stream
  // bootstrap writes (e.g. `contextBag`), but `bulkPut` is a full overwrite.
  // Read existing local records once so we can preserve those fields across
  // a refresh — without this merge, opening any bag-attached scratchpad
  // after a fresh load shows the message badge briefly, then loses it when
  // workspace bootstrap clobbers the field.
  const existingStreams = await db.streams.where("workspaceId").equals(workspaceId).toArray()
  const existingByStreamId = new Map(existingStreams.map((s) => [s.id, s]))

  // Effective sidebar config for the in-memory seed below. If a newer
  // `sidebar_config:updated` landed during the fetch window we keep the local
  // row (the IDB write is skipped) and must seed that value, not the older
  // snapshot, so the in-memory cache doesn't briefly regress to the old preset.
  let effectiveSidebarConfig = bootstrap.sidebarConfig

  await Promise.all([
    db.workspaces.put({ ...bootstrap.workspace, _cachedAt: now }),
    db.workspaceUsers.bulkPut(bootstrap.users.map((u) => ({ ...u, _cachedAt: now }))),
    db.streams.bulkPut(
      bootstrap.streams.map((s) => {
        const membership = membershipByStream.get(s.id)
        const existing = existingByStreamId.get(s.id)
        return {
          ...s,
          notificationLevel: membership?.notificationLevel,
          lastReadEventId: membership?.lastReadEventId,
          // Preserve fields workspace-bootstrap doesn't carry but stream-
          // bootstrap does (bag mirroring lives in `applyStreamBootstrap`).
          contextBag: existing?.contextBag,
          _cachedAt: now,
        }
      })
    ),
    db.streamMemberships.bulkPut(
      bootstrap.streamMemberships.map((sm) => ({
        ...sm,
        id: `${workspaceId}:${sm.streamId}`,
        workspaceId,
        _cachedAt: now,
      }))
    ),
    db.dmPeers.bulkPut(
      bootstrap.dmPeers.map((dp) => ({
        ...dp,
        id: `${workspaceId}:${dp.streamId}`,
        workspaceId,
        _cachedAt: now,
      }))
    ),
    db.personas.bulkPut(bootstrap.personas.map((p) => ({ ...p, workspaceId: workspaceId, _cachedAt: now }))),
    db.bots.bulkPut(bootstrap.bots.map((b) => ({ ...b, workspaceId: workspaceId, _cachedAt: now }))),
    db.labels.bulkPut(bootstrap.labels.map((l) => ({ ...l, _cachedAt: now }))),
    db.labelMemberships.bulkPut(
      bootstrap.labelMemberships.map((m) => ({
        id: `${workspaceId}:${m.labelId}:${m.userId}`,
        workspaceId,
        labelId: m.labelId,
        userId: m.userId,
        joinedAt: m.joinedAt,
        _cachedAt: now,
      }))
    ),
    db.labelAssignments.bulkPut(bootstrap.labelAssignments.map(assignmentToCached)),
    // Only write unreadState if no concurrent socket handler has updated it
    // since the fetch started. Socket handlers (stream:activity, activity:created)
    // may have incremented counts during the fetch window.
    // Wrapped in a transaction so the read→check→write is atomic (INV-20).
    db.transaction("rw", [db.unreadState], async () => {
      const existing = await db.unreadState.get(workspaceId)
      if (!existing || !fetchStartedAt || existing._cachedAt < fetchStartedAt) {
        await db.unreadState.put({
          id: workspaceId,
          workspaceId,
          unreadCounts: bootstrap.unreadCounts,
          mentionCounts: bootstrap.mentionCounts,
          activityCounts: bootstrap.activityCounts,
          unreadActivityCount: bootstrap.unreadActivityCount,
          mutedStreamIds: bootstrap.mutedStreamIds,
          _cachedAt: now,
        })
      }
    }),
    db.transaction("rw", [db.userPreferences], async () => {
      const existing = await db.userPreferences.get(workspaceId)
      if (!existing || !fetchStartedAt || existing._cachedAt < fetchStartedAt) {
        await db.userPreferences.put({
          ...bootstrap.userPreferences,
          id: workspaceId,
          workspaceId,
          _cachedAt: now,
        })
      }
    }),
    db.transaction("rw", [db.sidebarConfigs], async () => {
      const existing = await db.sidebarConfigs.get(workspaceId)
      if (!existing || !fetchStartedAt || existing._cachedAt < fetchStartedAt) {
        await db.sidebarConfigs.put({
          id: workspaceId,
          workspaceId,
          config: bootstrap.sidebarConfig,
          _cachedAt: now,
        })
      } else {
        effectiveSidebarConfig = existing.config
      }
    }),
    db.workspaceMetadata.put({
      id: workspaceId,
      workspaceId,
      emojis: bootstrap.emojis,
      emojiWeights: bootstrap.emojiWeights,
      commands: bootstrap.commands,
      _cachedAt: now,
    }),
  ])

  // Clean up stale entities: anything in IDB for this workspace that
  // wasn't in the bootstrap AND was written before this bootstrap.
  // Entities with _cachedAt >= now were written concurrently by socket
  // handlers and must be preserved.
  // Use the pre-fetch timestamp for stale cleanup. Entities written by
  // socket handlers DURING the fetch have _cachedAt > fetchStartedAt and
  // survive. Only truly stale entities (from before we started fetching)
  // are removed. If no fetchStartedAt provided, skip cleanup entirely.
  if (fetchStartedAt !== undefined) {
    await cleanupStaleEntities(workspaceId, bootstrap, fetchStartedAt)
  }

  // Populate in-memory cache so useLiveQuery hooks return real data on first
  // synchronous render (the default value). Without this, every component sees
  // empty arrays for one render cycle until the async IDB read resolves.
  seedWorkspaceCache(workspaceId, {
    workspace: { ...bootstrap.workspace, _cachedAt: now },
    users: bootstrap.users.map((u) => ({ ...u, _cachedAt: now })),
    streams: bootstrap.streams.map((s) => ({
      ...s,
      notificationLevel: membershipByStream.get(s.id)?.notificationLevel,
      lastReadEventId: membershipByStream.get(s.id)?.lastReadEventId,
      _cachedAt: now,
    })),
    memberships: bootstrap.streamMemberships.map((sm) => ({
      ...sm,
      id: `${workspaceId}:${sm.streamId}`,
      workspaceId,
      _cachedAt: now,
    })),
    dmPeers: bootstrap.dmPeers.map((dp) => ({
      ...dp,
      id: `${workspaceId}:${dp.streamId}`,
      workspaceId,
      _cachedAt: now,
    })),
    personas: bootstrap.personas.map((p) => ({ ...p, workspaceId, _cachedAt: now })),
    bots: bootstrap.bots.map((b) => ({ ...b, workspaceId, _cachedAt: now })),
    labels: bootstrap.labels.map((l) => ({ ...l, _cachedAt: now })),
    labelMemberships: bootstrap.labelMemberships.map((m) => ({
      id: `${workspaceId}:${m.labelId}:${m.userId}`,
      workspaceId,
      labelId: m.labelId,
      userId: m.userId,
      joinedAt: m.joinedAt,
      _cachedAt: now,
    })),
    labelAssignments: bootstrap.labelAssignments.map(assignmentToCached),
    unreadState: {
      id: workspaceId,
      workspaceId,
      unreadCounts: bootstrap.unreadCounts,
      mentionCounts: bootstrap.mentionCounts,
      activityCounts: bootstrap.activityCounts,
      unreadActivityCount: bootstrap.unreadActivityCount,
      mutedStreamIds: bootstrap.mutedStreamIds,
      _cachedAt: now,
    },
    userPreferences: {
      ...bootstrap.userPreferences,
      id: workspaceId,
      workspaceId,
      sendMode: bootstrap.userPreferences.messageSendMode,
      _cachedAt: now,
    },
    sidebarConfig: {
      id: workspaceId,
      workspaceId,
      config: effectiveSidebarConfig,
      _cachedAt: now,
    },
    metadata: {
      id: workspaceId,
      workspaceId,
      emojis: bootstrap.emojis,
      emojiWeights: bootstrap.emojiWeights,
      commands: bootstrap.commands,
      _cachedAt: now,
    },
  })
}

export async function applyReconnectBootstrapBatch(
  workspaceId: string,
  workspaceBootstrap: WorkspaceBootstrap,
  streamBootstraps: Map<string, StreamBootstrap>,
  staleStreamIds: Set<string>,
  terminalStreamIds: Set<string>,
  fetchStartedAt?: number
): Promise<{
  workspaceBootstrap: WorkspaceBootstrap
  streamBootstraps: Map<string, StreamBootstrap>
}> {
  const now = Date.now()

  const [localStreams, localMemberships, localUnreadState] = await Promise.all([
    db.streams.where("workspaceId").equals(workspaceId).toArray(),
    db.streamMemberships.where("workspaceId").equals(workspaceId).toArray(),
    db.unreadState.get(workspaceId),
  ])

  const finalBootstrap = mergeReconnectWorkspaceBootstrap({
    workspaceBootstrap,
    successfulStreamBootstraps: streamBootstraps,
    staleStreamIds,
    terminalStreamIds,
    localStreams,
    localMemberships,
    localUnreadState: localUnreadState ?? undefined,
    fetchStartedAt,
  })

  const membershipByStream = new Map(finalBootstrap.streamMemberships.map((sm) => [sm.streamId, sm]))

  // See applyWorkspaceBootstrap: preserve a sidebar config written by a
  // `sidebar_config:updated` event during the fetch window rather than seeding
  // (and returning) the older snapshot.
  let effectiveSidebarConfig = finalBootstrap.sidebarConfig

  await db.transaction(
    "rw",
    [
      db.workspaces,
      db.workspaceUsers,
      db.streams,
      db.streamMemberships,
      db.dmPeers,
      db.personas,
      db.bots,
      db.labels,
      db.labelMemberships,
      db.labelAssignments,
      db.unreadState,
      db.userPreferences,
      db.sidebarConfigs,
      db.workspaceMetadata,
      db.events,
      db.pendingMessages,
    ],
    async () => {
      await Promise.all([
        db.workspaces.put({ ...finalBootstrap.workspace, _cachedAt: now }),
        db.workspaceUsers.bulkPut(finalBootstrap.users.map((user) => ({ ...user, _cachedAt: now }))),
        db.streams.bulkPut(
          finalBootstrap.streams.map((stream) => {
            const membership = membershipByStream.get(stream.id)
            const local = localStreams.find((s) => s.id === stream.id)
            return {
              ...stream,
              notificationLevel: membership?.notificationLevel,
              lastReadEventId: membership?.lastReadEventId,
              // Preserve fields workspace-bootstrap doesn't carry but
              // stream-bootstrap mirrors locally (`contextBag` is the
              // canonical example — see `applyStreamBootstrap`).
              contextBag: local?.contextBag,
              _cachedAt: now,
            }
          })
        ),
        db.streamMemberships.bulkPut(
          finalBootstrap.streamMemberships.map((membership) => ({
            ...membership,
            id: `${workspaceId}:${membership.streamId}`,
            workspaceId,
            _cachedAt: now,
          }))
        ),
        db.dmPeers.bulkPut(
          finalBootstrap.dmPeers.map((dmPeer) => ({
            ...dmPeer,
            id: `${workspaceId}:${dmPeer.streamId}`,
            workspaceId,
            _cachedAt: now,
          }))
        ),
        db.personas.bulkPut(finalBootstrap.personas.map((persona) => ({ ...persona, workspaceId, _cachedAt: now }))),
        db.bots.bulkPut(finalBootstrap.bots.map((bot) => ({ ...bot, workspaceId, _cachedAt: now }))),
        db.labels.bulkPut(finalBootstrap.labels.map((label) => ({ ...label, _cachedAt: now }))),
        db.labelMemberships.bulkPut(
          finalBootstrap.labelMemberships.map((membership) => ({
            id: `${workspaceId}:${membership.labelId}:${membership.userId}`,
            workspaceId,
            labelId: membership.labelId,
            userId: membership.userId,
            joinedAt: membership.joinedAt,
            _cachedAt: now,
          }))
        ),
        db.labelAssignments.bulkPut(finalBootstrap.labelAssignments.map(assignmentToCached)),
        db.unreadState.put({
          id: workspaceId,
          workspaceId,
          unreadCounts: finalBootstrap.unreadCounts,
          mentionCounts: finalBootstrap.mentionCounts,
          activityCounts: finalBootstrap.activityCounts,
          unreadActivityCount: finalBootstrap.unreadActivityCount,
          mutedStreamIds: finalBootstrap.mutedStreamIds,
          _cachedAt: now,
        }),
        db.workspaceMetadata.put({
          id: workspaceId,
          workspaceId,
          emojis: finalBootstrap.emojis,
          emojiWeights: finalBootstrap.emojiWeights,
          commands: finalBootstrap.commands,
          _cachedAt: now,
        }),
      ])

      const existingUserPreferences = await db.userPreferences.get(workspaceId)
      if (!existingUserPreferences || !fetchStartedAt || existingUserPreferences._cachedAt < fetchStartedAt) {
        await db.userPreferences.put({
          ...finalBootstrap.userPreferences,
          id: workspaceId,
          workspaceId,
          _cachedAt: now,
        })
      }

      const existingSidebarConfig = await db.sidebarConfigs.get(workspaceId)
      if (!existingSidebarConfig || !fetchStartedAt || existingSidebarConfig._cachedAt < fetchStartedAt) {
        await db.sidebarConfigs.put({
          id: workspaceId,
          workspaceId,
          config: finalBootstrap.sidebarConfig,
          _cachedAt: now,
        })
      } else {
        effectiveSidebarConfig = existingSidebarConfig.config
      }

      for (const [streamId, bootstrap] of streamBootstraps) {
        await applyStreamBootstrapInCurrentTransaction(workspaceId, streamId, bootstrap, now)
      }

      if (terminalStreamIds.size > 0) {
        await Promise.all([
          db.streams.bulkDelete(Array.from(terminalStreamIds)),
          db.streamMemberships.bulkDelete(Array.from(terminalStreamIds, (streamId) => `${workspaceId}:${streamId}`)),
        ])
      }
    }
  )

  if (fetchStartedAt !== undefined) {
    await cleanupStaleEntities(workspaceId, finalBootstrap, fetchStartedAt)
  }

  seedWorkspaceCache(workspaceId, {
    workspace: { ...finalBootstrap.workspace, _cachedAt: now },
    users: finalBootstrap.users.map((user) => ({ ...user, _cachedAt: now })),
    streams: finalBootstrap.streams.map((stream) => ({
      ...stream,
      notificationLevel: membershipByStream.get(stream.id)?.notificationLevel,
      lastReadEventId: membershipByStream.get(stream.id)?.lastReadEventId,
      _cachedAt: now,
    })),
    memberships: finalBootstrap.streamMemberships.map((membership) => ({
      ...membership,
      id: `${workspaceId}:${membership.streamId}`,
      workspaceId,
      _cachedAt: now,
    })),
    dmPeers: finalBootstrap.dmPeers.map((dmPeer) => ({
      ...dmPeer,
      id: `${workspaceId}:${dmPeer.streamId}`,
      workspaceId,
      _cachedAt: now,
    })),
    personas: finalBootstrap.personas.map((persona) => ({ ...persona, workspaceId, _cachedAt: now })),
    bots: finalBootstrap.bots.map((bot) => ({ ...bot, workspaceId, _cachedAt: now })),
    labels: finalBootstrap.labels.map((label) => ({ ...label, _cachedAt: now })),
    labelMemberships: finalBootstrap.labelMemberships.map((membership) => ({
      id: `${workspaceId}:${membership.labelId}:${membership.userId}`,
      workspaceId,
      labelId: membership.labelId,
      userId: membership.userId,
      joinedAt: membership.joinedAt,
      _cachedAt: now,
    })),
    labelAssignments: finalBootstrap.labelAssignments.map(assignmentToCached),
    unreadState: {
      id: workspaceId,
      workspaceId,
      unreadCounts: finalBootstrap.unreadCounts,
      mentionCounts: finalBootstrap.mentionCounts,
      activityCounts: finalBootstrap.activityCounts,
      unreadActivityCount: finalBootstrap.unreadActivityCount,
      mutedStreamIds: finalBootstrap.mutedStreamIds,
      _cachedAt: now,
    },
    userPreferences: {
      ...finalBootstrap.userPreferences,
      id: workspaceId,
      workspaceId,
      sendMode: finalBootstrap.userPreferences.messageSendMode,
      _cachedAt: now,
    },
    sidebarConfig: {
      id: workspaceId,
      workspaceId,
      config: effectiveSidebarConfig,
      _cachedAt: now,
    },
    metadata: {
      id: workspaceId,
      workspaceId,
      emojis: finalBootstrap.emojis,
      emojiWeights: finalBootstrap.emojiWeights,
      commands: finalBootstrap.commands,
      _cachedAt: now,
    },
  })

  // The returned bootstrap is written to the bootstrap query cache by the
  // caller; reflect the preserved local config so it doesn't carry the stale
  // snapshot value.
  finalBootstrap.sidebarConfig = effectiveSidebarConfig

  return { workspaceBootstrap: finalBootstrap, streamBootstraps }
}

async function cleanupStaleEntities(workspaceId: string, bootstrap: WorkspaceBootstrap, now: number): Promise<void> {
  const bootstrapStreamIds = new Set(bootstrap.streams.map((s) => s.id))
  const bootstrapUserIds = new Set(bootstrap.users.map((u) => u.id))
  const bootstrapMembershipIds = new Set(bootstrap.streamMemberships.map((sm) => `${workspaceId}:${sm.streamId}`))
  const bootstrapDmPeerIds = new Set(bootstrap.dmPeers.map((dp) => `${workspaceId}:${dp.streamId}`))
  const bootstrapPersonaIds = new Set(bootstrap.personas.map((p) => p.id))
  const bootstrapBotIds = new Set(bootstrap.bots.map((b) => b.id))
  const bootstrapLabelIds = new Set(bootstrap.labels.map((l) => l.id))
  const bootstrapLabelMembershipIds = new Set(
    bootstrap.labelMemberships.map((m) => `${workspaceId}:${m.labelId}:${m.userId}`)
  )
  const bootstrapLabelAssignmentIds = new Set(
    bootstrap.labelAssignments.map((a) =>
      assignmentId(a.workspaceId, a.resourceType, a.resourceId, a.labelId, a.userId)
    )
  )

  await Promise.all([
    deleteStale(db.streams, "workspaceId", workspaceId, bootstrapStreamIds, now),
    deleteStale(db.workspaceUsers, "workspaceId", workspaceId, bootstrapUserIds, now),
    deleteStale(db.streamMemberships, "workspaceId", workspaceId, bootstrapMembershipIds, now),
    deleteStale(db.dmPeers, "workspaceId", workspaceId, bootstrapDmPeerIds, now),
    deleteStale(db.personas, "workspaceId", workspaceId, bootstrapPersonaIds, now),
    deleteStale(db.bots, "workspaceId", workspaceId, bootstrapBotIds, now),
    deleteStale(db.labels, "workspaceId", workspaceId, bootstrapLabelIds, now),
    deleteStale(db.labelMemberships, "workspaceId", workspaceId, bootstrapLabelMembershipIds, now),
    deleteStale(db.labelAssignments, "workspaceId", workspaceId, bootstrapLabelAssignmentIds, now),
  ])
}

async function deleteStale(
  table: {
    where: (field: string) => {
      equals: (value: string) => { toArray: () => Promise<Array<{ id: string; _cachedAt: number }>> }
    }
    bulkDelete: (ids: string[]) => Promise<void>
  },
  scopeField: string,
  scopeValue: string,
  keepIds: Set<string>,
  now: number
): Promise<void> {
  const all = await table.where(scopeField).equals(scopeValue).toArray()
  const toDelete = all.filter((entity) => !keepIds.has(entity.id) && entity._cachedAt < now).map((e) => e.id)
  if (toDelete.length > 0) {
    await table.bulkDelete(toDelete)
  }
}
