import {
  db,
  type CachedBot,
  type CachedDmPeer,
  type CachedLabel,
  type CachedLabelAssignment,
  type CachedPersona,
  type CachedStream,
  type CachedStreamMembership,
  type CachedStreamReadState,
  type CachedUnreadState,
  type CachedWorkspace,
  type CachedWorkspaceUser,
} from "@/db"
import { getPerfCapture } from "@/lib/perf/capture"
import { resolveFeatureFlags } from "@threa/types"
import {
  diffRows,
  diffSingleton,
  effectiveFreshness,
  recordSkippedRowConfirmations,
  semanticEqual,
  writeAllRows,
} from "./bootstrap-diff"
import { seedWorkspaceCache, upsertWorkspaceUserInCache } from "@/stores/workspace-store"
import {
  seedAgentActivity,
  upsertAgentSession,
  removeAgentSession,
  hasAgentSession,
} from "@/stores/agent-activity-store"
import { seedActiveCalls, upsertActiveCall, removeActiveCall } from "@/stores/active-calls-store"
import type { CallStartedEventPayload } from "@threa/types"
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
  FeatureFlagLayers,
  StreamMember,
  StreamReadFrontier,
  StreamReadFrontierSnapshot,
  UserPreferences,
  SidebarConfig,
  WorkspaceSettings,
  LastMessagePreview,
  Activity,
  AgentSessionStartedPayload,
  AgentSessionProgressPayload,
  AgentActivityStartedPayload,
  AgentActivityEndedPayload,
  ActivityCreatedPayload,
  ActivityReadPayload,
  SavedUpsertedPayload,
  SavedDeletedPayload,
  SavedReminderFiredPayload,
  BoardConversationHideChangedPayload,
  BoardStreamMuteChangedPayload,
  SavedSuggestionUpsertedPayload,
  ScheduledMessageUpsertedPayload,
  ScheduledMessageSentPayload,
  ScheduledMessageCancelledPayload,
  ConversationWithStaleness,
  BoardPost,
  LabelUpsertedPayload,
  LabelDeletedPayload,
  LabelAssignedPayload,
  LabelUnassignedPayload,
  DraftUpsertedPayload,
  DraftDeletedPayload,
  PersonaListItem,
} from "@threa/types"
import { cachedPersonaFromListItem } from "@/lib/personas"
import { persistSavedRows, removeSavedRow, savedKeys } from "@/hooks/use-saved"
import { conversationKeys } from "@/hooks/use-conversations"
import { addIncomingCall, settleIncomingCall } from "@/stores/incoming-call-store"
import type { CallMode } from "@/calls/config"
import { personaKeys } from "@/hooks/use-personas"
import {
  mergeBoardConversation,
  addBoardConversationStream,
  setBoardRootArchived,
  removeBoardConversationsForStream,
} from "@/stores/board-store"
import { putHidden, deleteHidden, putMuted, deleteMuted } from "@/stores/board-exclusions-store"
import { activityKeys } from "@/hooks/use-activity"
import { memoKeys } from "@/hooks/use-memos"
import { invitationKeys } from "@/api/invitations"
import { savedSuggestionKeys } from "@/hooks/use-saved-suggestions"
import { persistScheduledRows, removeScheduledRow, scheduledKeys } from "@/hooks/use-scheduled"
import { assignmentToCached, assignmentId } from "@/hooks/use-labels"
import {
  NOTIFICATION_CONFIG,
  NotificationLevels,
  SHAREABLE_SAFETY_STATUSES,
  StreamTypes,
  StreamPurposes,
  Visibilities,
  normalizeSidebarConfig,
} from "@threa/types"
import { applyStreamBootstrapInCurrentTransaction } from "./stream-sync"
import { deleteStreamSlots, deleteSlotsForStreams } from "@/stores/slot-store"
import { applyDraftDeleted, applyDraftUpserted } from "./draft-sync"
import {
  applyStreamActivityOrdinal,
  applyStreamReadOrdinal,
  applyStreamReadSet,
  applyStreamsReadAllOrdinals,
  bootstrapActivityCacheFields,
  dropActivitiesById,
  mergeBootstrapUnreadFields,
  pruneCounterTouches,
  upsertActivity,
} from "./unread-counters"
import { isAutoReadAttentiveNow } from "@/lib/auto-read-attention"
import { commitCounterMutation, commitStreamPreview, type CatchUpBatch, type CounterMutator } from "./catch-up-batch"
import {
  commitReadAll,
  commitReadStateSnapshot,
  mergeReadStateIntoBootstrapCache,
  putReadStateIdb,
  toStreamReadFrontier,
} from "./read-state"

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

// The unread counter payloads carry absolute fields (sync phase 2c): the
// backend always emits them, so clients set counters from
// latestOrdinal − lastReadOrdinal instead of incrementing and replayed or
// duplicated events converge.
interface StreamReadPayload {
  workspaceId: string
  authorId: string
  streamId: string
  lastReadEventId: string
  /** The read event's per-stream sequence (bigint as string). */
  lastReadSequence?: string
  /** Message ordinal of the read position. */
  lastReadOrdinal: number
  /** Post-write sparse overlay for this stream (usually shrunk by compaction).
   *  Absent = not carried (rollout) → leave the client set unchanged; `[]` =
   *  overlay now empty. See docs/sparse-read-overlay-design.md. */
  readMessageIds?: string[]
}

// The absolute post-write read-state snapshot for one stream from a
// conversation-surface read (docs/sparse-read-overlay-design.md). readMessageIds
// is the ENTIRE overlay after the write (post-compaction), applied as a SET.
interface StreamReadMessagesPayload {
  workspaceId: string
  authorId: string
  streamId: string
  readMessageIds: string[]
  lastReadEventId: string | null
  lastReadSequence: string
  lastReadOrdinal: number
  markedMessageIds?: string[]
}

interface StreamsReadAllPayload {
  workspaceId: string
  authorId: string
  streamIds: string[]
  /** Absolute read position per updated stream. */
  reads: Array<{ streamId: string; lastReadOrdinal: number }>
  /**
   * The canonical post-write frontier per updated stream (additive). Absent on
   * legacy events from before the field shipped — the handler leaves existing
   * frontiers untouched and relies on the next bootstrap to reconcile.
   */
  frontiers?: StreamReadFrontierSnapshot[]
}

// Read-pointer SET from an explicit "mark as unread". Unlike stream:read, the
// ordinal is applied as a plain set (not max-merged) so the pointer can move
// backward and unread can rise. lastReadEventId is null when the pointer lands
// before the first message.
interface StreamReadSetPayload {
  workspaceId: string
  authorId: string
  streamId: string
  lastReadEventId: string | null
  lastReadSequence?: string
  lastReadOrdinal: number
  /** Post-write sparse overlay for this stream (deleted ids above the pointer
   *  on a re-unread). Absent = not carried; `[]` = overlay now empty. */
  readMessageIds?: string[]
}

// Author-scoped: the user's own mute/notify choice for one stream, mirrored to
// their other sessions so the badge updates live instead of waiting for a
// reconnect merge.
interface StreamNotificationLevelUpdatedPayload {
  workspaceId: string
  authorId: string
  streamId: string
  notificationLevel: StreamMember["notificationLevel"]
}

interface StreamActivityPayload {
  workspaceId: string
  streamId: string
  authorId: string
  /** The message event's per-stream sequence (bigint as string). */
  sequence?: string
  /** Count of message_created events with sequence ≤ this one. */
  messageOrdinal: number
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
  /** The user layer's raw overrides; the client re-resolves against its own workspace layer. */
  overrides: Record<string, string>
}

interface FeatureFlagsWorkspaceUpdatedPayload {
  workspaceId: string
  /** The workspace layer's raw overrides; the client re-resolves against its own user layer. */
  overrides: Record<string, string>
}

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
    descriptionJson: stream.descriptionJson,
    visibility: stream.visibility,
    parentStreamId: stream.parentStreamId,
    parentAnchorId: stream.parentAnchorId ?? stream.parentMessageId,
    rootStreamId: stream.rootStreamId,
    replyCount: stream.replyCount,
    lastReplyAt: stream.lastReplyAt,
    companionMode: stream.companionMode,
    companionPersonaId: stream.companionPersonaId,
    memoryMode: stream.memoryMode,
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
    joinedAt: membership.joinedAt,
  }
}

/** The bootstrap's additive `streamReadState` map → IDB/seed rows (read cutover). */
function toCachedReadStates(
  workspaceId: string,
  streamReadState: WorkspaceBootstrap["streamReadState"],
  now: number
): CachedStreamReadState[] {
  if (!streamReadState) return []
  return Object.entries(streamReadState).map(([streamId, frontier]) => ({
    id: `${workspaceId}:${streamId}`,
    workspaceId,
    streamId,
    lastReadEventId: frontier.lastReadEventId,
    lastReadSequence: frontier.lastReadSequence,
    lastReadAt: frontier.lastReadAt,
    _cachedAt: now,
  }))
}

/**
 * The in-memory seed mirror of IDB after a bootstrap apply: every local row
 * (nonmember thread lazy state included — the member-only bootstrap map never
 * enumerates it) with the applied server rows winning per stream. Keeps the
 * first synchronous render from dropping frontiers IDB still holds.
 */
function mergeLocalAndServerReadStates(
  localReadStates: CachedStreamReadState[],
  serverRows: CachedStreamReadState[]
): CachedStreamReadState[] {
  const byStreamId = new Map(localReadStates.map((row) => [row.streamId, row]))
  for (const row of serverRows) byStreamId.set(row.streamId, row)
  return Array.from(byStreamId.values())
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
  localReadStates: CachedStreamReadState[]
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
  localReadStates,
  localUnreadState,
  fetchStartedAt,
}: ReconnectWorkspaceMergeParams): WorkspaceBootstrap {
  const successfulStreamIds = new Set(successfulStreamBootstraps.keys())
  const streamsById = new Map(workspaceBootstrap.streams.map((stream) => [stream.id, stream]))
  const membershipsByStreamId = new Map(
    workspaceBootstrap.streamMemberships.map((membership) => [membership.streamId, membership])
  )
  // Standalone read frontier (read cutover): merged with the same freshness
  // rules as the membership mirror it shadows — server snapshot as the base,
  // local rows winning where they were touched during the fetch window or the
  // stream went stale, deleted for terminal streams. An OMITTED map (old
  // server / payload cached before the field shipped) is not authoritative:
  // the omission is propagated so the downstream stale-sweep never reads a
  // fabricated empty map as "the server says no frontiers" and deletes every
  // standalone IDB row. A present map — explicit `{}` included — IS
  // authoritative and merges normally.
  const readStateOmitted = workspaceBootstrap.streamReadState === undefined
  const readStateByStreamId = new Map<string, StreamReadFrontier>(
    Object.entries(workspaceBootstrap.streamReadState ?? {})
  )
  const localReadStateByStreamId = new Map(localReadStates.map((row) => [row.streamId, row]))
  const unreadCounts = { ...workspaceBootstrap.unreadCounts }
  // The latest message ordinals (sync phase 2c). A stream's ordinal must
  // stay paired with whichever unreadCounts source wins for it — the implied
  // read position is latestOrdinal − unreadCount, so mixing a local unread
  // with the server ordinal (or vice versa) would shift it. Streams whose
  // local unread state wins but that have no local ordinal lose their
  // baseline (handlers re-seed from the next absolute event).
  const messageCounts = { ...workspaceBootstrap.messageCounts }
  // The sparse read overlay (docs/sparse-read-overlay-design.md) is the third
  // leg of the per-stream triple: effective unread = latest − read − |overlay|,
  // so a stream's overlay must stay paired with whichever unread/ordinal source
  // wins for it, exactly as messageCounts does.
  const readMessageIds = { ...workspaceBootstrap.readMessageIds }
  const mutedStreamIds = new Set(workspaceBootstrap.mutedStreamIds)
  const localStreamById = new Map(localStreams.map((stream) => [stream.id, stream]))
  const localMembershipByStreamId = new Map(localMemberships.map((membership) => [membership.streamId, membership]))

  // One override per stream, shared by the touched loop and the stale loop so
  // the two field lists can't drift apart. Counters and mute membership merge
  // on SEPARATE freshness (counterTouchedAt vs mutedTouchedAt): a mute-only
  // write must not freeze that stream's counter triple against a fresher
  // server snapshot — the stream-scoped recurrence of the row-level bug.
  const applyLocalCounterOverride = (streamId: string): void => {
    if (!localUnreadState) return
    unreadCounts[streamId] = localUnreadState.unreadCounts[streamId] ?? 0
    const localOrdinal = localUnreadState.latestOrdinals?.[streamId]
    if (localOrdinal !== undefined) {
      messageCounts[streamId] = localOrdinal
    } else {
      delete messageCounts[streamId]
    }
    const localOverlay = localUnreadState.readMessageIds?.[streamId]
    if (localOverlay !== undefined) {
      readMessageIds[streamId] = localOverlay
    } else {
      delete readMessageIds[streamId]
    }
  }
  const applyLocalMuteOverride = (streamId: string): void => {
    if (!localUnreadState) return
    if (localUnreadState.mutedStreamIds.includes(streamId)) {
      mutedStreamIds.add(streamId)
    } else {
      mutedStreamIds.delete(streamId)
    }
  }

  if (fetchStartedAt !== undefined) {
    const mergeWorkspaceId = workspaceBootstrap.workspace.id
    for (const stream of localStreams) {
      if (effectiveFreshness(mergeWorkspaceId, "streams", stream.id, stream._cachedAt) < fetchStartedAt) continue
      if (successfulStreamIds.has(stream.id)) continue
      // Archived rows persist in db.streams (they ride bootstrap.archivedStreams),
      // so a fresh _cachedAt no longer implies active — promoting one here would
      // leak it into the active-only streams cache the sidebar seeds from.
      if (stream.archivedAt) continue
      streamsById.set(stream.id, toWorkspaceBootstrapStream(stream))
    }

    for (const membership of localMemberships) {
      if (
        effectiveFreshness(mergeWorkspaceId, "streamMemberships", membership.id, membership._cachedAt) < fetchStartedAt
      )
        continue
      if (successfulStreamIds.has(membership.streamId)) continue
      membershipsByStreamId.set(membership.streamId, toWorkspaceBootstrapMembership(membership))
    }

    for (const row of localReadStates) {
      if (effectiveFreshness(mergeWorkspaceId, "streamReadState", row.id, row._cachedAt) < fetchStartedAt) continue
      if (successfulStreamIds.has(row.streamId)) continue
      readStateByStreamId.set(row.streamId, toStreamReadFrontier(row))
    }

    // Per-stream: local counter state wins only for streams actually touched
    // during the fetch window (see `counterTouchedAt`). The previous row-level
    // `_cachedAt` check let any one stream's write keep EVERY stream's local
    // count, so a drifted count survived reconnects indefinitely.
    if (localUnreadState) {
      for (const [streamId, touchedAt] of Object.entries(localUnreadState.counterTouchedAt ?? {})) {
        if (touchedAt < fetchStartedAt) continue
        if (successfulStreamIds.has(streamId)) continue
        applyLocalCounterOverride(streamId)
      }
      for (const [streamId, touchedAt] of Object.entries(localUnreadState.mutedTouchedAt ?? {})) {
        if (touchedAt < fetchStartedAt) continue
        if (successfulStreamIds.has(streamId)) continue
        applyLocalMuteOverride(streamId)
      }
    }
  }

  for (const streamId of staleStreamIds) {
    const localStream = localStreamById.get(streamId)
    // Same archived guard as the locally-fresher loop above: archived rows
    // persist in db.streams now, and this list must stay active-only.
    if (localStream && !localStream.archivedAt) {
      streamsById.set(streamId, toWorkspaceBootstrapStream(localStream))
    }

    const localMembership = localMembershipByStreamId.get(streamId)
    if (localMembership) {
      membershipsByStreamId.set(streamId, toWorkspaceBootstrapMembership(localMembership))
    }

    const localReadState = localReadStateByStreamId.get(streamId)
    if (localReadState) {
      readStateByStreamId.set(streamId, toStreamReadFrontier(localReadState))
    }

    if (localUnreadState) {
      applyLocalCounterOverride(streamId)
      applyLocalMuteOverride(streamId)
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

    // The per-stream bootstrap carries the viewer's frontier (the field the
    // membership watermark used to ride). A present row overrides; a confirmed
    // absent row (null) is the never-read frontier. Absent field (payloads
    // cached before it shipped) leaves whatever the workspace map holds.
    if (bootstrap.readState !== undefined) {
      readStateByStreamId.set(
        streamId,
        bootstrap.readState ?? { lastReadEventId: null, lastReadSequence: null, lastReadAt: null }
      )
    }

    unreadCounts[streamId] = bootstrap.unreadCount
    setMutedState(mutedStreamIds, streamId, bootstrap.stream.type, bootstrap.membership?.notificationLevel)
  }

  for (const streamId of terminalStreamIds) {
    streamsById.delete(streamId)
    membershipsByStreamId.delete(streamId)
    readStateByStreamId.delete(streamId)
    delete unreadCounts[streamId]
    delete messageCounts[streamId]
    delete readMessageIds[streamId]
    mutedStreamIds.delete(streamId)
  }

  return {
    ...workspaceBootstrap,
    streams: Array.from(streamsById.values()),
    streamMemberships: Array.from(membershipsByStreamId.values()),
    streamReadState: readStateOmitted ? undefined : Object.fromEntries(readStateByStreamId),
    unreadCounts,
    // Activities are user-scoped: the reconnect bootstrap carries the viewer's
    // full unread set, so it is authoritative (no per-stream merge). The count
    // fields derive from it.
    ...bootstrapActivityCacheFields(workspaceBootstrap),
    messageCounts,
    readMessageIds,
    mutedStreamIds: Array.from(mutedStreamIds),
  }
}

function resolveDmPeerUserId(dmUserIds: [string, string] | undefined, currentUserId: string | null): string | null {
  if (!currentUserId || !dmUserIds?.includes(currentUserId)) return null
  return dmUserIds.find((userId) => userId !== currentUserId) ?? null
}

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
    /** Active only during a sync catch-up replay. When present, counter and
     *  preview updates fold into the batch instead of writing per-entry; the
     *  engine flushes the final state once when the window closes, so the badges
     *  and sidebar order never flicker through intermediate replay values.
     *  Absent → live, write-immediately. */
    getCatchUpBatch?: () => CatchUpBatch | null
  }
): () => void {
  const abortController = new AbortController()

  // The seams every flickering write routes through: fold into the catch-up
  // batch when one is active, else commit immediately (live). Read-pointer
  // mirrors and feed invalidations are not coalesced — they stay on their own
  // immediate paths in the handlers below.
  const commitCounter = (mutate: CounterMutator): void => {
    const batch = refs.getCatchUpBatch?.() ?? null
    if (batch) {
      batch.applyCounter(mutate)
      return
    }
    commitCounterMutation(queryClient, workspaceId, mutate)
  }

  const commitPreview = (streamId: string, preview: LastMessagePreview | null): void => {
    const batch = refs.getCatchUpBatch?.() ?? null
    if (batch) {
      batch.setStreamPreview(streamId, preview)
      return
    }
    commitStreamPreview(queryClient, workspaceId, streamId, preview)
  }

  // Activity-feed invalidation seam. During catch-up it marks the feed stale on
  // the batch (one invalidation at flush) instead of refetching per replayed
  // entry; the batch path ignores `live` because the per-entry `hadActivity`
  // gate reads the not-yet-committed cache and is unreliable mid-replay — the
  // single flush settles it. Live path keeps the gate to avoid needless fetches.
  const invalidateActivityFeed = (live: boolean): void => {
    const batch = refs.getCatchUpBatch?.() ?? null
    if (batch) {
      batch.markActivityFeedStale()
      return
    }
    if (live) {
      queryClient.invalidateQueries({ queryKey: activityKeys.list(workspaceId) })
    }
  }

  // The reconnect event gap for saved/scheduled rows (INV-53) is closed by the
  // workspace catch-up cursor, which replays the missed user-scoped sync-log
  // entries through these same handlers — so no blanket `savedKeys`/
  // `scheduledKeys` invalidation is needed here.

  const handleStreamCreated = (payload: StreamPayload) => {
    // A system-purpose stream (e.g. a persona-editor test scratchpad) is a real,
    // fully-functional stream, but not a sidebar entry: the editor mounts it
    // directly (StreamContent runs its own subscribe+bootstrap), so the workspace
    // layer must neither list it in the sidebar cache nor persist it to IDB. The
    // bootstrap query applies the same exclusion; both must agree (D6 revision).
    if (payload.stream.purpose === StreamPurposes.PERSONA_TEST) return

    let shouldJoinStreamRoom = false
    let shouldCacheStream = payload.stream.visibility !== Visibilities.PRIVATE
    let shouldAddMembership = false
    let shouldAddDmPeer = false
    let currentUserId: string | null = null
    let dmPeerUserId: string | null = null
    let cachedStream: Stream & { lastMessagePreview?: LastMessagePreview | null } = payload.stream

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

  const handleStreamUpdated = (payload: StreamPayload) => {
    // For DMs the backend sends displayName: null (the name is derived from
    // the peer user on the frontend). Preserve whatever name is already cached.
    const isDmWithNullName = payload.stream.type === StreamTypes.DM && payload.stream.displayName == null

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
    // to preserve cached fields not carried by the Stream payload, notably the
    // last-message preview and notification level. For DMs, also preserve the
    // resolved displayName since the backend sends null.
    const idbUpdate =
      payload.stream.type === StreamTypes.DM && payload.stream.displayName == null
        ? (() => {
            const { displayName: _, ...rest } = payload.stream
            return { ...rest, _cachedAt: Date.now() }
          })()
        : { ...payload.stream, _cachedAt: Date.now() }
    db.streams.update(payload.stream.id, idbUpdate)
  }

  const handleStreamArchived = (payload: StreamPayload) => {
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

    // Upsert IndexedDB — partial merge preserves lastMessagePreview etc.; a
    // missing row (swept while archived) is restored rather than silently lost.
    void upsertStreamRow(payload.stream)
    // The board gates on each card's own `rootArchived`, so the cards this
    // stream covers must carry the new verdict or they keep showing until a
    // refetch.
    void setBoardRootArchived(workspaceId, payload.stream.id, true)
  }

  const handleStreamUnarchived = (payload: StreamPayload) => {
    queryClient.setQueryData(streamKeys.bootstrap(workspaceId, payload.stream.id), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      return { ...old, stream: payload.stream }
    })

    queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      const bootstrap = old as { streams?: Stream[] }
      if (!bootstrap.streams) return old
      if (bootstrap.streams.some((s) => s.id === payload.stream.id)) {
        // Merge to preserve lastMessagePreview.
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

    // Upsert IndexedDB — partial merge preserves lastMessagePreview etc.; a
    // missing row (swept while archived) is restored rather than silently lost.
    void upsertStreamRow(payload.stream)
    void setBoardRootArchived(workspaceId, payload.stream.id, false)
  }

  const handleWorkspaceUserAdded = (payload: WorkspaceUserAddedPayload) => {
    const now = Date.now()
    const { user } = payload

    updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => {
      const users = getWorkspaceUsers(old)
      const incomingUser = toWorkspaceUser(user)
      const updatedUsers = users.some((u) => u.id === user.id) ? users : [...users, incomingUser]

      return withWorkspaceUsers(old, updatedUsers)
    })

    db.workspaceUsers.put({
      ...toWorkspaceUser(user),
      _cachedAt: now,
    })
  }

  const handleWorkspaceUserRemoved = (payload: WorkspaceUserRemovedPayload) => {
    queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      const bootstrap = old as WorkspaceBootstrap
      const users = getWorkspaceUsers(bootstrap)
      return withWorkspaceUsers(
        bootstrap,
        users.filter((u) => u.id !== payload.removedUserId)
      )
    })

    db.workspaceUsers.delete(payload.removedUserId)
  }

  const handleWorkspaceUserUpdated = (payload: WorkspaceUserUpdatedPayload) => {
    const now = Date.now()
    const { user } = payload

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

    commitCounter((state) =>
      applyStreamReadOrdinal(state, payload.streamId, payload.lastReadOrdinal, payload.readMessageIds)
    )

    // Read frontier (sole source): the payload carries the server's post-write
    // frontier, applied immediately so the unread divider tracks even mid
    // catch-up. Advance semantics — a replayed/stale event never moves it
    // backward. Legacy payloads may omit lastReadSequence: event ids are NOT
    // order-comparable, so a sequence-less event can never be safely merged over
    // an EXISTING frontier — skip the mutation and rely on the next bootstrap to
    // reconcile. Seeding a row where no frontier exists is allowed.
    const existingFrontier = current?.streamReadState?.[payload.streamId]
    const sequenceLess = payload.lastReadSequence === undefined
    const advanceFrontier = {
      lastReadEventId: payload.lastReadEventId,
      lastReadSequence: payload.lastReadSequence ?? null,
      lastReadAt: new Date().toISOString(),
    }
    if (!sequenceLess || existingFrontier === undefined) {
      const advanceSeq = advanceFrontier.lastReadSequence != null ? BigInt(advanceFrontier.lastReadSequence) : null
      const existingSeq = existingFrontier?.lastReadSequence != null ? BigInt(existingFrontier.lastReadSequence) : null
      if (existingSeq == null || advanceSeq == null || advanceSeq >= existingSeq) {
        mergeReadStateIntoBootstrapCache(queryClient, workspaceId, payload.streamId, advanceFrontier)
        queryClient.setQueryData<import("@threa/types").StreamBootstrap | undefined>(
          streamKeys.bootstrap(workspaceId, payload.streamId),
          (old) => (old ? { ...old, readState: advanceFrontier } : old)
        )
      }
    }

    db.transaction("rw", [db.streamReadState], async () => {
      const now = Date.now()
      const existingRow = await db.streamReadState.get(`${workspaceId}:${payload.streamId}`)
      // Same legacy guard as the cache merge above: a sequence-less event never
      // overwrites an EXISTING row — it may only seed one.
      if (!sequenceLess || existingRow === undefined) {
        const rowSeq = advanceFrontier.lastReadSequence != null ? BigInt(advanceFrontier.lastReadSequence) : null
        const storedSeq = existingRow?.lastReadSequence != null ? BigInt(existingRow.lastReadSequence) : null
        if (storedSeq == null || rowSeq == null || rowSeq >= storedSeq) {
          await putReadStateIdb(workspaceId, payload.streamId, advanceFrontier, now)
        }
      }
    })

    invalidateActivityFeed(hadActivity)

    // Dismiss push notification for this stream (fast path when the app is open)
    navigator.serviceWorker?.controller?.postMessage({
      type: SW_MSG_CLEAR_NOTIFICATIONS,
      streamId: payload.streamId,
    })
  }

  // Handle a read-pointer SET ("mark as unread") — from this or another session
  // of the same user. Mirrors the pointer backward and SETs the unread count;
  // never dismisses notifications (this re-unreads, it doesn't clear).
  const handleStreamReadSet = (payload: StreamReadSetPayload) => {
    if (payload.workspaceId !== workspaceId) return

    commitCounter((state) =>
      applyStreamReadSet(state, payload.streamId, payload.lastReadOrdinal, payload.readMessageIds)
    )

    // Read frontier (sole source): explicit unread is one of the few authorized
    // downward moves — SET, not max-merge (a null watermark parks before the
    // first message and must beat any stale stored value).
    const current = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId))
    const existingFrontier = current?.streamReadState?.[payload.streamId]
    const frontier = {
      lastReadEventId: payload.lastReadEventId,
      lastReadSequence: payload.lastReadSequence ?? existingFrontier?.lastReadSequence ?? null,
      lastReadAt: new Date().toISOString(),
    }
    mergeReadStateIntoBootstrapCache(queryClient, workspaceId, payload.streamId, frontier)
    queryClient.setQueryData<import("@threa/types").StreamBootstrap | undefined>(
      streamKeys.bootstrap(workspaceId, payload.streamId),
      (old) => (old ? { ...old, readState: frontier } : old)
    )

    db.transaction("rw", [db.streamReadState], async () => {
      const now = Date.now()
      const existingRow = await db.streamReadState.get(`${workspaceId}:${payload.streamId}`)
      await putReadStateIdb(
        workspaceId,
        payload.streamId,
        {
          lastReadEventId: payload.lastReadEventId,
          lastReadSequence: payload.lastReadSequence ?? existingRow?.lastReadSequence ?? null,
          lastReadAt: new Date().toISOString(),
        },
        now
      )
    })
  }

  // Handle a sparse-read snapshot (`stream:read_messages`) from a conversation
  // surface — this or another session of the same user. Mirrors the read
  // watermark, SETs the overlay to the absolute post-write snapshot, and
  // dismisses this stream's push notification (the user read here).
  const handleStreamReadMessages = (payload: StreamReadMessagesPayload) => {
    if (payload.workspaceId !== workspaceId) return

    commitReadStateSnapshot(
      queryClient,
      workspaceId,
      {
        streamId: payload.streamId,
        readMessageIds: payload.readMessageIds,
        lastReadEventId: payload.lastReadEventId,
        lastReadSequence: payload.lastReadSequence,
        lastReadOrdinal: payload.lastReadOrdinal,
        markedMessageIds: payload.markedMessageIds,
      },
      commitCounter
    )

    navigator.serviceWorker?.controller?.postMessage({
      type: SW_MSG_CLEAR_NOTIFICATIONS,
      streamId: payload.streamId,
    })
  }

  // Handle all streams read (from other sessions of the same user)
  const handleStreamReadAll = (payload: StreamsReadAllPayload) => {
    if (payload.workspaceId !== workspaceId) return

    // Counter fold (absolute read positions + overlay clearing) and the
    // canonical frontier rows persist in ONE transaction: folded into the
    // catch-up batch when one is active (its flush covers every table the
    // replay touched), else committed live through commitReadAll. The additive
    // `frontiers` snapshot carries each updated stream's post-write watermark;
    // legacy payloads omit it — counter behavior only, frontier rows untouched.
    const batch = refs.getCatchUpBatch?.() ?? null
    if (batch) {
      batch.applyCounter((state) => applyStreamsReadAllOrdinals(state, payload.reads))
      batch.applyReadAllFrontiers(payload.frontiers)
    } else {
      void commitReadAll(queryClient, workspaceId, payload.reads, payload.frontiers)
    }

    // Standalone frontier (read cutover): read_all carries ordinals, no event
    // ids, so the frontier VALUES can't move here — but stamp the rows so an
    // in-flight bootstrap's per-stream merge keeps this stream's local row
    // instead of restoring a pre-read_all snapshot (same touched-at rule the
    // counter triple gets via commitCounter). Without the stamp the snapshot
    // regresses the frontier until the next bootstrap re-fetches it.
    void db.transaction("rw", [db.streamReadState], async () => {
      const now = Date.now()
      const rowIds = payload.streamIds.map((streamId) => `${workspaceId}:${streamId}`)
      const rows = (await db.streamReadState.bulkGet(rowIds)).filter((row) => row !== undefined)
      if (rows.length > 0) await db.streamReadState.bulkPut(rows.map((row) => ({ ...row, _cachedAt: now })))
    })

    invalidateActivityFeed(true)

    // Dismiss push notifications for all read streams (fast path when the app is open)
    for (const streamId of payload.streamIds) {
      navigator.serviceWorker?.controller?.postMessage({
        type: SW_MSG_CLEAR_NOTIFICATIONS,
        streamId,
      })
    }
  }

  // Handle a notification-level change made in another session of this user.
  // Keeps the mute/notify badge live across tabs/devices (the reconnect merge
  // in setMutedState otherwise leaves it stale until the next reconnect).
  const handleStreamNotificationLevelUpdated = (payload: StreamNotificationLevelUpdatedPayload) => {
    if (payload.workspaceId !== workspaceId) return

    // The sidebar / quick-switcher / share mute badges render from
    // `unreadState.mutedStreamIds`, a derived set — NOT from the membership
    // row's notificationLevel — so the muted set has to move alongside the
    // membership caches. `setMutedState` centralizes the level→muted rule.
    queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
      if (!old) return old
      const streamType = old.streams.find((s) => s.id === payload.streamId)?.type
      const mutedStreamIds = new Set(old.mutedStreamIds)
      if (streamType) {
        setMutedState(mutedStreamIds, payload.streamId, streamType, payload.notificationLevel)
      }
      return {
        ...old,
        streamMemberships: old.streamMemberships.map((membership) =>
          membership.streamId === payload.streamId
            ? { ...membership, notificationLevel: payload.notificationLevel }
            : membership
        ),
        mutedStreamIds: streamType ? Array.from(mutedStreamIds) : old.mutedStreamIds,
      }
    })

    // Stream bootstrap membership mirror — drives the settings dialog's level.
    queryClient.setQueryData<import("@threa/types").StreamBootstrap | undefined>(
      streamKeys.bootstrap(workspaceId, payload.streamId),
      (old) => {
        if (!old?.membership) return old
        return {
          ...old,
          membership: { ...old.membership, notificationLevel: payload.notificationLevel },
        }
      }
    )

    // Persist to IDB so both the membership and the muted set survive a remount
    // without a re-bootstrap. `db.unreadState` is the live source the badge
    // hooks observe; `db.streamMemberships` backs the settings dialog.
    void db.transaction("rw", [db.streamMemberships, db.streams, db.unreadState], async () => {
      const now = Date.now()
      const membershipId = `${workspaceId}:${payload.streamId}`
      const membership = await db.streamMemberships.get(membershipId)
      if (membership) {
        await db.streamMemberships.put({
          ...membership,
          notificationLevel: payload.notificationLevel,
          _cachedAt: now,
        })
      }

      const stream = await db.streams.get(payload.streamId)
      const unread = await db.unreadState.get(workspaceId)
      if (stream && unread) {
        const mutedStreamIds = new Set(unread.mutedStreamIds)
        setMutedState(mutedStreamIds, payload.streamId, stream.type, payload.notificationLevel)
        await db.unreadState.put({
          ...unread,
          mutedStreamIds: Array.from(mutedStreamIds),
          // Mute-specific stamp so an in-flight bootstrap's merge keeps this
          // stream's local mute membership WITHOUT freezing its counter triple
          // (counterTouchedAt would make the merge prefer possibly-stale local
          // counts for an unrelated mute toggle).
          mutedTouchedAt: { ...unread.mutedTouchedAt, [payload.streamId]: now },
          _cachedAt: now,
        })
      }
    })
  }

  // Handle stream activity (when a new message is created in any stream)
  // Always updates the preview; sets unread from the absolute message ordinal
  // (own messages and viewing advance the read position instead of raising it).
  const handleStreamActivity = (payload: StreamActivityPayload) => {
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

    // Preview (cache + IDB) drives the activity-ordered sidebar. Coalesced
    // during catch-up so the list re-sorts once on the final order instead of
    // jumping as every replayed message advances a stream's preview time.
    commitPreview(payload.streamId, payload.lastMessagePreview)

    // Counter: membership and author identity resolve from the workspace
    // bootstrap (the synchronous read model both reactive surfaces share), then
    // the absolute ordinal apply folds through commitCounter. Own messages never
    // raise unread (authorId is a userId — match via user.workosUserId): the
    // server auto-advances the author's read pointer in the send transaction
    // without emitting stream:read. Viewing pins the read position to latest —
    // gated on the SAME attention signal `useAutoMarkAsRead` uses: the pin is
    // optimistic against the auto-read confirm, so pinning while unattentive
    // (stream open in a blurred window, reconnect catch-up replays) zeroes the
    // local count with no server confirm ever coming, and the stream vanishes
    // from the sidebar's Unread section while genuinely unread.
    const old = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId))
    if (!old) return
    const isMember = old.streamMemberships.some((m: StreamMember) => m.streamId === payload.streamId)
    if (!isMember) return
    const currentUser = refs.getCurrentUser()
    const currentMember = currentUser && getWorkspaceUsers(old).find((u) => u.workosUserId === currentUser.id)
    const isOwnMessage = Boolean(currentMember && payload.authorId === currentMember.id)

    commitCounter((state) =>
      applyStreamActivityOrdinal(state, payload.streamId, payload.messageOrdinal, {
        isOwnMessage,
        isViewing: isViewingStream && isAutoReadAttentiveNow(),
      })
    )
  }

  // Sidebar agent-activity: keep the running-session store live for stream rows
  // the viewer isn't currently looking at. Indicators key on the exact stream;
  // the resolved root is retained for access metadata. An uncached stream is
  // skipped until the next bootstrap/reconnect re-seed.
  const resolveRootStreamId = async (streamId: string): Promise<string | null> => {
    const stream = await db.streams.get(streamId)
    if (!stream) return null
    return stream.rootStreamId ?? stream.id
  }

  let agentActivityQueue = Promise.resolve()
  const enqueueAgentActivity = (task: () => void | Promise<void>): Promise<void> => {
    const run = agentActivityQueue.then(task)
    agentActivityQueue = run.catch((error) => {
      console.error("Failed to update sidebar agent activity", error)
    })
    return run
  }

  const handleAgentSessionStartedActivity = (payload: { workspaceId: string; streamId: string; event: StreamEvent }) =>
    enqueueAgentActivity(async () => {
      if (payload.workspaceId !== workspaceId) return
      const inner = payload.event.payload as AgentSessionStartedPayload
      const rootStreamId = await resolveRootStreamId(payload.streamId)
      if (!rootStreamId) return
      upsertAgentSession(workspaceId, {
        sessionId: inner.sessionId,
        streamId: payload.streamId,
        rootStreamId,
        personaName: inner.personaName,
        startedAt: inner.startedAt,
      })
    })

  const handleAgentSessionProgressActivity = (payload: AgentSessionProgressPayload) =>
    enqueueAgentActivity(async () => {
      if (payload.workspaceId !== workspaceId) return
      // Progress arrives per step, but only for the stream/parent rooms this viewer
      // has joined (trace-emitter emits to streamRoom + parentRoom, never workspace-
      // wide). Once the session is tracked, nothing the sidebar renders changes —
      // skip the IDB lookup and the no-op upsert entirely.
      if (hasAgentSession(workspaceId, payload.sessionId)) return
      const rootStreamId = await resolveRootStreamId(payload.streamId)
      if (!rootStreamId) return
      upsertAgentSession(workspaceId, {
        sessionId: payload.sessionId,
        streamId: payload.streamId,
        rootStreamId,
        personaName: payload.personaName,
        // Progress carries no start time; anchor sort order to arrival.
        startedAt: new Date().toISOString(),
      })
    })

  const handleAgentActivityStarted = (payload: AgentActivityStartedPayload) =>
    enqueueAgentActivity(async () => {
      const rootStreamId = await resolveRootStreamId(payload.threadStreamId)
      if (!rootStreamId) return
      upsertAgentSession(workspaceId, {
        sessionId: payload.sessionId,
        streamId: payload.threadStreamId,
        rootStreamId,
        personaName: payload.personaName,
        startedAt: new Date().toISOString(),
      })
    })

  const handleAgentActivityEnded = (payload: AgentActivityEndedPayload) =>
    enqueueAgentActivity(() => removeAgentSession(workspaceId, payload.sessionId))

  // agent_session:completed/failed reach this socket in two shapes: the
  // stream-scoped outbox form `{ workspaceId, streamId, event }`, and a flat
  // session-room form `{ sessionId }` (trace-emitter/orphan-cleanup/enclave/
  // public-api) delivered whenever the trace dialog holds the session room open
  // on this same shared socket. Read the id from either and remove by it —
  // removal is stream-agnostic and a no-op for an id this workspace never tracked.
  const handleAgentSessionEndedActivity = (payload: {
    workspaceId?: string
    streamId?: string
    event?: StreamEvent
    sessionId?: string
  }) =>
    enqueueAgentActivity(() => {
      if (payload.workspaceId !== undefined && payload.workspaceId !== workspaceId) return
      const sessionId = (payload.event?.payload as { sessionId?: string } | undefined)?.sessionId ?? payload.sessionId
      if (sessionId) removeAgentSession(workspaceId, sessionId)
    })

  // Handle stream display name updated (from auto-naming service)
  const handleStreamDisplayNameUpdated = (payload: StreamDisplayNameUpdatedPayload) => {
    queryClient.setQueryData(streamKeys.detail(workspaceId, payload.streamId), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      return { ...old, displayName: payload.displayName }
    })

    queryClient.setQueryData(streamKeys.bootstrap(workspaceId, payload.streamId), (old: unknown) => {
      if (!old || typeof old !== "object") return old
      const bootstrap = old as { stream?: Stream }
      if (!bootstrap.stream) return old
      return { ...old, stream: { ...bootstrap.stream, displayName: payload.displayName } }
    })

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

    db.streams.update(payload.streamId, { displayName: payload.displayName, _cachedAt: Date.now() })
  }

  const handleStreamMemberAdded = (payload: {
    workspaceId: string
    streamId: string
    memberId: string
    stream: Stream
    event: StreamEvent
    bot?: Bot
  }) => {
    if (payload.workspaceId !== workspaceId) return
    // Same exclusion as handleStreamCreated: the creator's own member_added for a
    // system-purpose stream must not add it to the sidebar/IDB either — this was
    // the second add path and the one that leaked the test scratchpad.
    if (payload.stream.purpose === StreamPurposes.PERSONA_TEST) return
    let shouldSubscribeStream = false

    // A bot joining may be a personal bot the viewer's roster doesn't hold
    // (visibility-scoped) — upsert the carried metadata so the new participant
    // renders with its name/avatar instead of the generic bot fallback.
    if (payload.bot) {
      const bot = payload.bot
      updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => {
        const exists = old.bots?.some((b) => b.id === bot.id)
        if (exists) return old
        return { ...old, bots: [...(old.bots ?? []), bot] }
      })
      db.bots.put({ ...bot, _cachedAt: Date.now() })
    }

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

      if (!membershipExists) {
        const now = Date.now()
        db.streamMemberships.put({
          id: `${workspaceId}:${payload.streamId}`,
          workspaceId,
          streamId: payload.streamId,
          memberId: payload.memberId,
          notificationLevel: null,
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

      db.streamMemberships.delete(`${workspaceId}:${payload.streamId}`)
      db.streamReadState.delete(`${workspaceId}:${payload.streamId}`)

      const removedStream = old.streams?.find((s) => s.id === payload.streamId)
      const shouldRemoveFromSidebar = removedStream?.visibility === "private"
      if (shouldRemoveFromSidebar) {
        db.streams.delete(payload.streamId)
        void deleteStreamSlots(db, payload.streamId)
        // The cards this stream contributed are unreadable now — drop them
        // rather than leave them rendering off the cache.
        void removeBoardConversationsForStream(workspaceId, payload.streamId)
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
    if (payload.workspaceId !== workspaceId) return

    queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
      if (!old) return old
      return {
        ...old,
        userPreferences: payload.preferences,
      }
    })

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

  // Handle feature flags updated (a platform admin toggled a flag from the
  // backoffice). Two scope-routed events, each patching only its own raw layer
  // and leaving the other intact; the hook re-resolves (INV-53 via the guard).
  // The patched layers are also written back to the persisted metadata row so a
  // warm restart before the next bootstrap repaints the live value, not a stale
  // one — the whole point of persisting layers is first-render correctness.
  const patchFeatureFlagLayers = (nextLayers: (old: WorkspaceBootstrap) => FeatureFlagLayers) => {
    const patched = updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => ({
      ...old,
      featureFlags: nextLayers(old),
    }))
    if (!patched) return
    const layers = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId))?.featureFlags
    if (layers) void db.workspaceMetadata.update(workspaceId, { featureFlags: layers })
  }

  const handleFeatureFlagsUpdated = (payload: FeatureFlagsUpdatedPayload) => {
    if (payload.workspaceId !== workspaceId) return
    patchFeatureFlagLayers((old) => ({ workspace: old.featureFlags?.workspace ?? {}, user: payload.overrides }))
  }

  const handleFeatureFlagsWorkspaceUpdated = (payload: FeatureFlagsWorkspaceUpdatedPayload) => {
    if (payload.workspaceId !== workspaceId) return
    patchFeatureFlagLayers((old) => ({ workspace: payload.overrides, user: old.featureFlags?.user ?? {} }))
  }

  const handleBotCreated = (payload: { workspaceId: string; bot: Bot }) => {
    if (payload.workspaceId !== workspaceId) return

    updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => {
      const exists = old.bots?.some((b) => b.id === payload.bot.id)
      if (exists) return old
      return { ...old, bots: [...(old.bots ?? []), payload.bot] }
    })

    db.bots.put({ ...payload.bot, _cachedAt: Date.now() })
  }

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

  // An admin committed a persona (built-in agent) config override. Workspace-
  // scoped — every member inherits the built-in — carrying the resolved light
  // persona so display-name/avatar caches update without a refetch. The light
  // payload lacks systemPrompt/tools/etc., so merge its fields onto the existing
  // rows rather than replacing them: the timeline reads name/avatar from
  // `db.personas` via `useWorkspacePersonas`, and the bootstrap cache keeps the
  // list in sync for the next seed. The editor's own config query is refetched
  // so a concurrent admin's change is reflected.
  const handleAgentConfigUpdated = (payload: { workspaceId: string; agentId: string; persona: PersonaListItem }) => {
    if (payload.workspaceId !== workspaceId) return

    const { id, slug, name, description, avatarEmoji, avatarUrl, model, status } = payload.persona
    // status rides along so an archive/unarchive flips the cached row — the
    // store-backed companion roster filters on it without a refetch.
    const patch = { slug, name, description, avatarEmoji, avatarUrl, model, status }
    // A fork broadcasts a NEW custom/personal row that no existing row covers —
    // upsert it so the roster and actor rendering reflect it live (the list
    // payload lacks the full row, so synthesize the non-display fields; a
    // bootstrap resync fills them in). A personal (`kind: "personal"`) row is
    // workspace-scoped and owned; only its owner ever receives the broadcast.
    const synthesized = cachedPersonaFromListItem(payload.persona, workspaceId)
    updateBootstrapOrInvalidate(queryClient, workspaceId, (old) => {
      const personas = old.personas ?? []
      if (personas.some((persona) => persona.id === id)) {
        return { ...old, personas: personas.map((persona) => (persona.id === id ? { ...persona, ...patch } : persona)) }
      }
      return { ...old, personas: [...personas, synthesized] }
    })
    // Upsert into IDB: update the display fields if present, else insert the synthesized row.
    void db.personas.get(id).then((existing) => {
      if (existing) {
        void db.personas.update(id, { ...patch, _cachedAt: Date.now() })
        return
      }
      void db.personas.put(synthesized)
    })

    queryClient.invalidateQueries({ queryKey: personaKeys.config(workspaceId, payload.agentId) })
    queryClient.invalidateQueries({ queryKey: personaKeys.list(workspaceId) })
  }

  // Handle activity created (mentions, notification-level activities, reactions, self rows)
  const handleActivityCreated = (payload: ActivityCreatedPayload) => {
    if (payload.workspaceId !== workspaceId) return

    const a = payload.activity
    // The held set is the source of truth (D3/D4): upsert the row by its stable
    // id so a replayed event (sync-log catch-up, INV-53) updates in place rather
    // than duplicating; the derived counts follow. Self rows are skipped inside
    // upsertActivity. The payload's absolute `counts` are intentionally ignored —
    // the badge derives from the held rows, never a separately maintained number.
    const held: Activity = {
      id: a.id,
      workspaceId: payload.workspaceId,
      userId: payload.targetUserId,
      activityType: a.activityType,
      streamId: a.streamId,
      messageId: a.messageId,
      actorId: a.actorId,
      actorType: a.actorType,
      context: a.context,
      readAt: null,
      createdAt: a.createdAt,
      isSelf: a.isSelf,
      emoji: a.emoji ?? null,
    }
    commitCounter((state) => upsertActivity(state, held))

    // Invalidate activity feed so it refetches when the page is mounted
    // (coalesced to one invalidation at flush during catch-up).
    invalidateActivityFeed(true)
  }

  // Cross-device activity-read propagation: rows flipped to read in another
  // session (per-row click, stream open, mark-all). Drop by id — idempotent
  // with this device's own optimistic mutations — and always invalidate the
  // feed: a mounted feed page can show rows the 200-cap held set doesn't.
  // Push banners dismiss per distinct stream only when the server populated
  // streamIds (stream/all scope); per-row reads carry none so a grouped
  // banner representing sibling unread rows stays.
  const handleActivityRead = (payload: ActivityReadPayload) => {
    if (payload.workspaceId !== workspaceId) return
    if (payload.activityIds.length === 0) return

    commitCounter((state) => dropActivitiesById(state, payload.activityIds))
    invalidateActivityFeed(true)

    for (const streamId of new Set(payload.streamIds)) {
      navigator.serviceWorker?.controller?.postMessage({ type: SW_MSG_CLEAR_NOTIFICATIONS, streamId })
    }
  }

  // GAM memo extraction: surface new memos in the memory explorer without a
  // manual refresh. memo:created is routed to the memo's source root (or its
  // owner, for a user-scoped memo) — never workspace-wide — but registration
  // is per event type on the one workspace socket/gate, so a room-delivered
  // event and its catch-up replay both land here. Registering per stream would
  // only duplicate the invalidation. The in-situ timeline row rides the
  // separate stream:memos_captured event (stream-sync).
  const handleMemoCreated = (payload: { workspaceId: string; memoId: string }) => {
    if (payload.workspaceId !== workspaceId) return
    queryClient.invalidateQueries({ queryKey: memoKeys.searches(workspaceId) })
  }

  // Invitation lifecycle (sent / accepted / revoked / link-created /
  // link-claimed): heal the settings → users invitation list for every admin,
  // not just the one who performed the mutation. The five events are
  // permission-scoped to members:write holders (delivery-groups.ts) — logged and
  // emitted to that group only — so registering here both updates an open list
  // live and replays through the sync catch-up cursor on reconnect, the same
  // query a viewer's own send/revoke/resend mutation already invalidates. Every
  // payload carries workspaceId; the differing per-event fields are unused since
  // we only invalidate.
  const handleInvitationChanged = (payload: { workspaceId: string }) => {
    if (payload.workspaceId !== workspaceId) return
    queryClient.invalidateQueries({ queryKey: invitationKeys.list(workspaceId) })
  }

  // Shared write path for attachment-state socket events (transcoded,
  // thumbnailed, upload status): apply `transform` to the matching attachment
  // summary in the message's cached `attachments` array, in both IDB and the
  // live bootstrap query. Falls back to an active-bootstrap invalidation when
  // the event row isn't cached yet.
  const patchCachedMessageAttachment = async (
    streamId: string,
    messageId: string,
    attachmentId: string,
    transform: (a: Record<string, unknown>) => Record<string, unknown>
  ) => {
    const updatePayload = (p: Record<string, unknown>) => {
      if (!Array.isArray(p.attachments)) return p
      const attachments = p.attachments as Array<Record<string, unknown>>
      const updatedAttachments = attachments.map((a) => (a.id === attachmentId ? transform(a) : a))
      return { ...p, attachments: updatedAttachments }
    }

    const events = await db.events
      .where("[streamId+eventType]")
      .equals([streamId, "message_created"])
      .filter((e) => (e.payload as { messageId?: string })?.messageId === messageId)
      .toArray()

    if (events.length > 0) {
      const event = events[0]
      await db.events.update(event.id, {
        payload: updatePayload(event.payload as Record<string, unknown>),
        _cachedAt: Date.now(),
      })
    } else {
      queryClient.invalidateQueries({
        queryKey: streamKeys.bootstrap(workspaceId, streamId),
        type: "active",
      })
    }

    queryClient.setQueryData<StreamBootstrap>(streamKeys.bootstrap(workspaceId, streamId), (old) => {
      if (!old) return old
      return {
        ...old,
        events: old.events.map((event) => {
          const eventPayload = event.payload as { messageId?: string } & Record<string, unknown>
          if (event.eventType !== "message_created" || eventPayload.messageId !== messageId) {
            return event
          }
          return { ...event, payload: updatePayload(eventPayload) }
        }),
      }
    })
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
    if (!payload.streamId || !payload.messageId) return
    await patchCachedMessageAttachment(payload.streamId, payload.messageId, payload.attachmentId, (a) => ({
      ...a,
      processingStatus: payload.processingStatus,
    }))
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
    await patchCachedMessageAttachment(payload.streamId, payload.messageId, payload.attachmentId, (a) => ({
      ...a,
      width: payload.width,
      height: payload.height,
    }))
  }

  // Reserved upload state changed (settled clean/blocked, failed, abandoned) —
  // a message binds an attachment while its bytes are still uploading and the
  // stored content is never revisited, so this event is what flips an
  // already-rendered timeline chip. Settled-safe state is encoded by REMOVING
  // the pending markers, matching the summary wire shape (absence = safe).
  const handleAttachmentUploadStatusChanged = async (payload: {
    workspaceId: string
    attachmentId: string
    uploadStatus: string
    safetyStatus: string
    streamId: string
    messageId: string
  }) => {
    if (payload.workspaceId !== workspaceId) return
    if (!payload.streamId || !payload.messageId) return
    const settledSafe = (SHAREABLE_SAFETY_STATUSES as readonly string[]).includes(payload.safetyStatus)
    await patchCachedMessageAttachment(payload.streamId, payload.messageId, payload.attachmentId, (a) => {
      const { safetyStatus: _safety, uploadStatus: _upload, ...rest } = a
      return settledSafe ? rest : { ...rest, safetyStatus: payload.safetyStatus, uploadStatus: payload.uploadStatus }
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

  // Board hide/mute changed on another device — patch the exclusion store so the
  // reactive board re-filters with no refetch (board-view-design.md § "Hide & mute").
  const handleBoardHideChanged = (payload: BoardConversationHideChangedPayload) => {
    if (payload.workspaceId !== workspaceId) return
    if (payload.active)
      void putHidden(workspaceId, payload.conversationId, payload.hiddenAt ? Date.parse(payload.hiddenAt) : Date.now())
    else void deleteHidden(payload.conversationId)
  }

  const handleBoardMuteChanged = (payload: BoardStreamMuteChangedPayload) => {
    if (payload.workspaceId !== workspaceId) return
    if (payload.active) void putMuted(workspaceId, payload.streamId)
    else void deleteMuted(payload.streamId)
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

  // Saved suggestions — pull-only pile. Any upsert (new suggestion, accept, or
  // dismiss elsewhere) just invalidates the suggested list; the query refetches
  // the authoritative page. No IDB: suggestions are low-volume and never the
  // offline-critical surface.
  const handleSavedSuggestionUpserted = (payload: SavedSuggestionUpsertedPayload) => {
    if (payload.workspaceId !== workspaceId) return
    queryClient.invalidateQueries({ queryKey: savedSuggestionKeys.list(workspaceId, "suggested") })
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

  // Labels — every label is owner-scoped, so these arrive only in the owning
  // actor's user room. The receiving client just writes the row.
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
      // Backend archive drops assignments in the same transaction without
      // per-row unassign events (see label service) — mirror that here so a
      // deleted label's chips disappear immediately.
      labelAssignments: (old.labelAssignments ?? []).filter((a) => a.labelId !== labelId),
    }))

    void db.transaction("rw", [db.labels, db.labelAssignments], async () => {
      await db.labels.delete(labelId)
      const assignmentIds = await db.labelAssignments.where("labelId").equals(labelId).primaryKeys()
      if (assignmentIds.length > 0) {
        await db.labelAssignments.bulkDelete(assignmentIds as string[])
      }
    })
  }

  // Assignments are owner-scoped — they reach only the applying actor's user
  // room. Generic over resourceType: the
  // handler never special-cases what kind of resource was labeled.
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

  // Drafts (Stage 3) — user-scoped, so these arrive only in the author's own
  // room. Apply is drift-aware (splits locally on a collision with unpushed
  // edits); see draft-sync.ts. The store layer (IDB + draft-store cache), not
  // the TanStack workspace bootstrap, is the draft read model.
  const handleDraftUpserted = (payload: DraftUpsertedPayload) => {
    void applyDraftUpserted(payload, workspaceId)
  }

  const handleDraftDeleted = (payload: DraftDeletedPayload) => {
    void applyDraftDeleted(payload, workspaceId)
  }

  // Conversation events feed the board's IDB store, the board's read authority
  // (it reads reactively from it, like the timeline reads `events`). The
  // created/updated events carry the conversation aggregate for every touched
  // conversation, so merging them re-sorts the board in place on
  // `lastActivityAt` without a refetch — the live half of the board's rails.
  // A card we don't have cached can't be rendered from the aggregate alone (the
  // message bodies aren't in the event), so refresh the board head to hydrate it.
  // Mark every matching board-list query stale (so a closed board refetches on
  // reopen) but only refetch the ones with active observers now. The viewer's own
  // sends are already reflected optimistically, and reconcile when their echo
  // merges here.
  const handleConversationUpserted = (payload: {
    workspaceId: string
    conversation: ConversationWithStaleness
    settlingMessageIds?: string[]
  }) => {
    if (payload.workspaceId !== workspaceId) return
    void mergeBoardConversation(payload.conversation.id, payload.conversation, payload.settlingMessageIds).then(
      (merged) => {
        if (merged) return
        queryClient.invalidateQueries({
          queryKey: [...conversationKeys.all, "workspaceList", workspaceId],
          refetchType: "active",
        })
        // A post fetched by id (deep link, search, in-stream list, past the board
        // cursor) has no IDB row, so the merge above reached nothing and the
        // panel would sit on its 60s-stale copy — the settling mark would never
        // appear or fade. Patch the by-id cache in place when it holds the row
        // (no refetch, panel stays live); otherwise mark it stale.
        const boardPostKey = conversationKeys.boardPost(payload.conversation.id)
        const cached = queryClient.getQueryData<BoardPost>(boardPostKey)
        // A patched post must stay internally consistent, like
        // mergeBoardConversation: prune rendered rows to the new membership, and
        // if the OPENER left the membership the post's shape can't be patched —
        // refetch instead of rendering a non-member opening.
        const memberIds =
          cached && new Set([...payload.conversation.messageIds, ...payload.conversation.secondaryMessageIds])
        if (cached && memberIds && (!cached.openingMessage || memberIds.has(cached.openingMessage.id))) {
          queryClient.setQueryData<BoardPost>(boardPostKey, (prev) =>
            prev
              ? {
                  ...prev,
                  conversation: payload.conversation,
                  recentMessages: prev.recentMessages.filter((m) => memberIds.has(m.id)),
                  settlingMessageIds: payload.settlingMessageIds ?? prev.settlingMessageIds,
                }
              : prev
          )
        } else {
          queryClient.invalidateQueries({ queryKey: boardPostKey })
        }
      }
    )
  }

  // A conversation can span its root + the root's threads (one root —
  // board-view-design.md). When a reply lands in a stream the card's snapshot
  // didn't list (a convert-to-thread, or a cross-stream continuation), record
  // that stream on the board row so the card subscribes to its rail and draws the
  // member live — no board refetch. The aggregate `conversation:updated` re-sorts
  // the card; this only widens its stream set.
  // Incoming DM call ring (user-scoped: lands in the account's user room, so it
  // reaches every device this user has open). One attempt id = one ring across
  // devices; the store drops a ring already past its deadline (stale replay).
  const handleCallInvitationCreated = (payload: {
    workspaceId: string
    attemptId: string
    callId: string
    streamId: string
    inviter: { id: string; name: string | null }
    mode: string
    expiresAt: string
  }) => {
    if (payload.workspaceId !== workspaceId) return
    addIncomingCall({
      attemptId: payload.attemptId,
      callId: payload.callId,
      workspaceId: payload.workspaceId,
      streamId: payload.streamId,
      inviterId: payload.inviter.id,
      inviterName: payload.inviter.name,
      mode: payload.mode as CallMode,
      expiresAtMs: Date.parse(payload.expiresAt),
    })
  }

  // Ring settled anywhere (accept on another device, decline, cancel, expire) →
  // drop the overlay on this device too.
  const handleCallInvitationSettled = (payload: { workspaceId: string; attemptId: string }) => {
    if (payload.workspaceId !== workspaceId) return
    settleIncomingCall(payload.attemptId)
  }

  // Live-call presence for the sidebar dot (roadmap 1.4). These reach the
  // workspace room (public channels) or the viewer's user room (private/DM),
  // which the sidebar renders from even when the stream room isn't joined. Calls
  // live only on non-thread roots today, so rootStreamId equals streamId.
  const handleCallStarted = (payload: {
    workspaceId: string
    streamId: string
    callId: string
    event: StreamEvent
  }) => {
    if (payload.workspaceId !== workspaceId) return
    const inner = payload.event.payload as CallStartedEventPayload
    upsertActiveCall(workspaceId, {
      callId: payload.callId,
      streamId: payload.streamId,
      rootStreamId: payload.streamId,
      mode: inner.mode,
      participantCount: 1,
    })
  }

  const handleCallEnded = (payload: { workspaceId: string; callId: string }) => {
    if (payload.workspaceId !== workspaceId) return
    removeActiveCall(workspaceId, payload.callId)
  }

  const handleConversationMessageAssigned = (payload: {
    workspaceId: string
    streamId: string
    conversationId: string
  }) => {
    if (payload.workspaceId !== workspaceId) return
    void addBoardConversationStream(payload.conversationId, payload.streamId)
  }

  socket.on("stream:created", handleStreamCreated)
  socket.on("stream:updated", handleStreamUpdated)
  socket.on("stream:archived", handleStreamArchived)
  socket.on("stream:unarchived", handleStreamUnarchived)
  socket.on("workspace_user:added", handleWorkspaceUserAdded)
  socket.on("workspace_user:removed", handleWorkspaceUserRemoved)
  socket.on("workspace_user:updated", handleWorkspaceUserUpdated)
  socket.on("stream:read", handleStreamRead)
  socket.on("stream:read_set", handleStreamReadSet)
  socket.on("stream:read_messages", handleStreamReadMessages)
  socket.on("stream:read_all", handleStreamReadAll)
  socket.on("stream:notification_level_updated", handleStreamNotificationLevelUpdated)
  socket.on("stream:activity", handleStreamActivity)
  socket.on("agent_session:started", handleAgentSessionStartedActivity)
  socket.on("agent_session:progress", handleAgentSessionProgressActivity)
  socket.on("agent_session:activity_started", handleAgentActivityStarted)
  socket.on("agent_session:activity_ended", handleAgentActivityEnded)
  socket.on("agent_session:completed", handleAgentSessionEndedActivity)
  socket.on("agent_session:failed", handleAgentSessionEndedActivity)
  socket.on("agent_session:deleted", handleAgentSessionEndedActivity)
  socket.on("stream:display_name_updated", handleStreamDisplayNameUpdated)
  socket.on("stream:member_added", handleStreamMemberAdded)
  socket.on("stream:member_removed", handleStreamMemberRemoved)
  socket.on("user_preferences:updated", handleUserPreferencesUpdated)
  socket.on("sidebar_config:updated", handleSidebarConfigUpdated)
  socket.on("workspace_settings:updated", handleWorkspaceSettingsUpdated)
  socket.on("feature_flags:updated", handleFeatureFlagsUpdated)
  socket.on("feature_flags:workspace_updated", handleFeatureFlagsWorkspaceUpdated)
  socket.on("bot:created", handleBotCreated)
  socket.on("bot:updated", handleBotUpdated)
  socket.on("agent_config:updated", handleAgentConfigUpdated)
  socket.on("activity:created", handleActivityCreated)
  socket.on("activity:read", handleActivityRead)
  socket.on("memo:created", handleMemoCreated)
  socket.on("invitation:sent", handleInvitationChanged)
  socket.on("invitation:accepted", handleInvitationChanged)
  socket.on("invitation:revoked", handleInvitationChanged)
  socket.on("invitation:link-created", handleInvitationChanged)
  socket.on("invitation:link-claimed", handleInvitationChanged)
  socket.on("saved:upserted", handleSavedUpserted)
  socket.on("saved:deleted", handleSavedDeleted)
  socket.on("saved_reminder:fired", handleSavedReminderFired)
  socket.on("board:conversation_hide_changed", handleBoardHideChanged)
  socket.on("board:stream_mute_changed", handleBoardMuteChanged)
  socket.on("saved_suggestion:upserted", handleSavedSuggestionUpserted)
  socket.on("scheduled_message:upserted", handleScheduledUpserted)
  socket.on("scheduled_message:sent", handleScheduledSent)
  socket.on("scheduled_message:cancelled", handleScheduledCancelled)
  socket.on("attachment:transcoded", handleAttachmentTranscoded)
  socket.on("attachment:upload_status_changed", handleAttachmentUploadStatusChanged)
  socket.on("attachment:thumbnailed", handleAttachmentThumbnailed)
  socket.on("label:created", handleLabelUpserted)
  socket.on("label:updated", handleLabelUpserted)
  socket.on("label:deleted", handleLabelDeleted)
  socket.on("label:assigned", handleLabelAssigned)
  socket.on("label:unassigned", handleLabelUnassigned)
  socket.on("draft:upserted", handleDraftUpserted)
  socket.on("draft:deleted", handleDraftDeleted)
  socket.on("conversation:created", handleConversationUpserted)
  socket.on("conversation:updated", handleConversationUpserted)
  socket.on("conversation:message_assigned", handleConversationMessageAssigned)
  socket.on("call:invitation_created", handleCallInvitationCreated)
  socket.on("call:invitation_settled", handleCallInvitationSettled)
  socket.on("stream:call_started", handleCallStarted)
  socket.on("stream:call_ended", handleCallEnded)

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
    socket.off("stream:read_set", handleStreamReadSet)
    socket.off("stream:read_messages", handleStreamReadMessages)
    socket.off("stream:read_all", handleStreamReadAll)
    socket.off("stream:notification_level_updated", handleStreamNotificationLevelUpdated)
    socket.off("stream:activity", handleStreamActivity)
    socket.off("agent_session:started", handleAgentSessionStartedActivity)
    socket.off("agent_session:progress", handleAgentSessionProgressActivity)
    socket.off("agent_session:activity_started", handleAgentActivityStarted)
    socket.off("agent_session:activity_ended", handleAgentActivityEnded)
    socket.off("agent_session:completed", handleAgentSessionEndedActivity)
    socket.off("agent_session:failed", handleAgentSessionEndedActivity)
    socket.off("agent_session:deleted", handleAgentSessionEndedActivity)
    socket.off("stream:display_name_updated", handleStreamDisplayNameUpdated)
    socket.off("stream:member_added", handleStreamMemberAdded)
    socket.off("stream:member_removed", handleStreamMemberRemoved)
    socket.off("user_preferences:updated", handleUserPreferencesUpdated)
    socket.off("sidebar_config:updated", handleSidebarConfigUpdated)
    socket.off("workspace_settings:updated", handleWorkspaceSettingsUpdated)
    socket.off("feature_flags:updated", handleFeatureFlagsUpdated)
    socket.off("feature_flags:workspace_updated", handleFeatureFlagsWorkspaceUpdated)
    socket.off("bot:created", handleBotCreated)
    socket.off("bot:updated", handleBotUpdated)
    socket.off("agent_config:updated", handleAgentConfigUpdated)
    socket.off("activity:created", handleActivityCreated)
    socket.off("activity:read", handleActivityRead)
    socket.off("memo:created", handleMemoCreated)
    socket.off("invitation:sent", handleInvitationChanged)
    socket.off("invitation:accepted", handleInvitationChanged)
    socket.off("invitation:revoked", handleInvitationChanged)
    socket.off("invitation:link-created", handleInvitationChanged)
    socket.off("invitation:link-claimed", handleInvitationChanged)
    socket.off("saved:upserted", handleSavedUpserted)
    socket.off("saved:deleted", handleSavedDeleted)
    socket.off("saved_reminder:fired", handleSavedReminderFired)
    socket.off("board:conversation_hide_changed", handleBoardHideChanged)
    socket.off("board:stream_mute_changed", handleBoardMuteChanged)
    socket.off("saved_suggestion:upserted", handleSavedSuggestionUpserted)
    socket.off("scheduled_message:upserted", handleScheduledUpserted)
    socket.off("scheduled_message:sent", handleScheduledSent)
    socket.off("scheduled_message:cancelled", handleScheduledCancelled)
    socket.off("attachment:transcoded", handleAttachmentTranscoded)
    socket.off("attachment:upload_status_changed", handleAttachmentUploadStatusChanged)
    socket.off("attachment:thumbnailed", handleAttachmentThumbnailed)
    socket.off("label:created", handleLabelUpserted)
    socket.off("label:updated", handleLabelUpserted)
    socket.off("label:deleted", handleLabelDeleted)
    socket.off("label:assigned", handleLabelAssigned)
    socket.off("label:unassigned", handleLabelUnassigned)
    socket.off("draft:upserted", handleDraftUpserted)
    socket.off("draft:deleted", handleDraftDeleted)
    socket.off("conversation:created", handleConversationUpserted)
    socket.off("conversation:updated", handleConversationUpserted)
    socket.off("conversation:message_assigned", handleConversationMessageAssigned)
    socket.off("call:invitation_created", handleCallInvitationCreated)
    socket.off("call:invitation_settled", handleCallInvitationSettled)
    socket.off("stream:call_started", handleCallStarted)
    socket.off("stream:call_ended", handleCallEnded)
  }
}

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
/**
 * Upsert a stream row into IDB. Partial-merges onto an existing row so the
 * socket payload doesn't clobber fields it never carries (lastMessagePreview,
 * membership). When no row exists — an archived root swept before it was
 * unarchived live — a fully-mapped row is put instead, so a live
 * archive/unarchive can't silently drop the local row (INV-11: no silent loss).
 */
async function upsertStreamRow(stream: Stream): Promise<void> {
  const now = Date.now()
  const updated = await db.streams.update(stream.id, { ...stream, _cachedAt: now })
  if (updated === 0) {
    await db.streams.put({ ...stream, lastMessagePreview: null, _cachedAt: now })
  }
}

const EMPTY_FLAG_LAYERS: FeatureFlagLayers = { workspace: {}, user: {} }

function byId<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]))
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  return Array.from(byId(rows).values())
}

/**
 * Map slim archived-root `Stream` rows (bootstrap.archivedStreams — no preview
 * or membership joins) to `CachedStream` rows, merging onto any existing row so
 * a live-archived row's `lastMessagePreview`/membership/`contextBag` survive a
 * reload's bootstrap apply. When no local row exists, the result is just the
 * plain stream fields stamped with `_cachedAt`.
 */
function mapArchivedStreamRows(
  archivedStreams: Stream[],
  existingByStreamId: Map<string, CachedStream>,
  now: number
): CachedStream[] {
  return archivedStreams.map((s) => ({ ...existingByStreamId.get(s.id), ...s, _cachedAt: now }))
}

export async function applyWorkspaceBootstrap(
  workspaceId: string,
  bootstrap: WorkspaceBootstrap,
  fetchStartedAt?: number
): Promise<WorkspaceBootstrap> {
  const now = Date.now()
  const capture = getPerfCapture()
  const diffEnabled = resolveFeatureFlags(bootstrap.featureFlags ?? EMPTY_FLAG_LAYERS).bootstrapDiff === "on"

  // Build membership lookup for O(1) access when merging onto streams
  const membershipByStream = new Map(bootstrap.streamMemberships.map((sm) => [sm.streamId, sm]))

  // Effective sidebar config for the in-memory seed below. If a newer
  // `sidebar_config:updated` landed during the fetch window we keep the local
  // row (the IDB write is skipped) and must seed that value, not the older
  // snapshot, so the in-memory cache doesn't briefly regress to the old preset.
  let effectiveSidebarConfig = bootstrap.sidebarConfig

  // The merged (server ⊕ fresh-local) counter fields, assigned inside the
  // transaction; seeded into the in-memory cache and returned so the query
  // cache carries the same values as IDB.
  let effectiveUnread = mergeBootstrapUnreadFields(bootstrap, undefined, fetchStartedAt)

  // The standalone read-frontier map the caller writes to the query cache and
  // the in-memory seed rows — assigned inside the transaction so a frontier
  // touched during the fetch window is preserved in ALL three surfaces (IDB,
  // cache, seed) instead of regressing to the snapshot. `undefined` until the
  // bootstrap carries a map; an omitted map leaves every surface untouched.
  let effectiveReadStateMap = bootstrap.streamReadState
  let seedReadStates: CachedStreamReadState[] | undefined

  let rowsWritten = 0
  let rowsSkipped = 0

  const workspaceRow = { ...bootstrap.workspace, _cachedAt: now }
  const userRows = bootstrap.users.map((u) => ({ ...u, _cachedAt: now }))
  const membershipRows = bootstrap.streamMemberships.map((sm) => ({
    ...sm,
    id: `${workspaceId}:${sm.streamId}`,
    workspaceId,
    _cachedAt: now,
  }))
  const dmPeerRows = bootstrap.dmPeers.map((dp) => ({
    ...dp,
    id: `${workspaceId}:${dp.streamId}`,
    workspaceId,
    _cachedAt: now,
  }))
  const personaRows = bootstrap.personas.map((p) => ({ ...p, workspaceId, _cachedAt: now }))
  const botRows = bootstrap.bots.map((b) => ({ ...b, workspaceId, _cachedAt: now }))
  const labelRows = bootstrap.labels.map((l) => ({ ...l, _cachedAt: now }))
  const labelAssignmentRows = bootstrap.labelAssignments.map(assignmentToCached)
  const metadataRow = {
    id: workspaceId,
    workspaceId,
    emojis: bootstrap.emojis,
    emojiWeights: bootstrap.emojiWeights,
    commands: bootstrap.commands,
    configuredToolCategories: bootstrap.configuredToolCategories,
    featureFlags: bootstrap.featureFlags,
    _cachedAt: now,
  }

  let mergedWorkspace: CachedWorkspace = workspaceRow
  let mergedUsers: CachedWorkspaceUser[] = userRows
  let mergedStreams: CachedStream[] = []
  let mergedMemberships: CachedStreamMembership[] = membershipRows
  let mergedDmPeers: CachedDmPeer[] = dmPeerRows
  let mergedPersonas: CachedPersona[] = personaRows
  let mergedBots: CachedBot[] = botRows
  let mergedLabels: CachedLabel[] = labelRows
  let mergedLabelAssignments: CachedLabelAssignment[] = labelAssignmentRows

  // One transaction over every table so they commit together and each table's
  // `useLiveQuery` fires once — one settle, not a per-table trickle. Parallel
  // independent writes (the previous shape) commit a micro-transaction each, so
  // the sidebar / badges / memberships re-render table-by-table; that is visible
  // on a reconnect-collapse that lands here with no apply window held (and on a
  // cold first connect). Mirrors applyReconnectBootstrapBatch. The conditional
  // unread/prefs/sidebar writes are inlined (read→check→write stays atomic,
  // INV-20) rather than nested transactions.
  const stopTx = capture.time("bootstrap.tx")
  await db.transaction(
    "rw",
    [
      db.workspaces,
      db.workspaceUsers,
      db.streams,
      db.streamMemberships,
      db.streamReadState,
      db.dmPeers,
      db.personas,
      db.bots,
      db.labels,
      db.labelAssignments,
      db.unreadState,
      db.userPreferences,
      db.sidebarConfigs,
      db.workspaceMetadata,
    ],
    async () => {
      const stopPreRead = capture.time("bootstrap.preRead")
      const existingStreams = await db.streams.where("workspaceId").equals(workspaceId).toArray()
      const existingByStreamId = new Map(existingStreams.map((s) => [s.id, s]))
      const [
        existingWorkspace,
        existingUsers,
        existingMemberships,
        existingDmPeers,
        existingPersonas,
        existingBots,
        existingLabels,
        existingLabelAssignments,
        existingMetadata,
      ] = diffEnabled
        ? await Promise.all([
            db.workspaces.get(workspaceId),
            db.workspaceUsers.where("workspaceId").equals(workspaceId).toArray(),
            db.streamMemberships.where("workspaceId").equals(workspaceId).toArray(),
            db.dmPeers.where("workspaceId").equals(workspaceId).toArray(),
            db.personas.where("workspaceId").equals(workspaceId).toArray(),
            db.bots.where("workspaceId").equals(workspaceId).toArray(),
            db.labels.where("workspaceId").equals(workspaceId).toArray(),
            db.labelAssignments.where("workspaceId").equals(workspaceId).toArray(),
            db.workspaceMetadata.get(workspaceId),
          ])
        : [undefined, [], [], [], [], [], [], [], undefined]
      stopPreRead()

      const stopDiff = capture.time("bootstrap.diff")
      const streamCandidates = dedupeById([
        ...bootstrap.streams.map((s) => {
          const membership = membershipByStream.get(s.id)
          const existing = existingByStreamId.get(s.id)
          return {
            ...s,
            notificationLevel: membership?.notificationLevel,
            // Preserve fields workspace-bootstrap doesn't carry but stream-
            // bootstrap does (bag mirroring lives in `applyStreamBootstrap`).
            contextBag: existing?.contextBag,
            _cachedAt: now,
          }
        }),
        // Archived roots ship slim (no preview/membership) but must persist so
        // every `useWorkspaceStreams` consumer (drafts, name resolution) keeps
        // seeing them across a reload. Not added to the TanStack bootstrap
        // `streams` cache — that list stays active-only.
        ...mapArchivedStreamRows(bootstrap.archivedStreams ?? [], existingByStreamId, now),
      ])

      const workspaceDiff = diffEnabled
        ? diffSingleton(existingWorkspace, workspaceRow)
        : { write: true, merged: workspaceRow }
      const usersDiff = diffEnabled ? diffRows(byId(existingUsers), userRows) : writeAllRows(userRows)
      const streamsDiff = diffEnabled ? diffRows(existingByStreamId, streamCandidates) : writeAllRows(streamCandidates)
      const membershipsDiff = diffEnabled
        ? diffRows(byId(existingMemberships), membershipRows)
        : writeAllRows(membershipRows)
      const dmPeersDiff = diffEnabled ? diffRows(byId(existingDmPeers), dmPeerRows) : writeAllRows(dmPeerRows)
      const personasDiff = diffEnabled ? diffRows(byId(existingPersonas), personaRows) : writeAllRows(personaRows)
      const botsDiff = diffEnabled ? diffRows(byId(existingBots), botRows) : writeAllRows(botRows)
      const labelsDiff = diffEnabled ? diffRows(byId(existingLabels), labelRows) : writeAllRows(labelRows)
      const labelAssignmentsDiff = diffEnabled
        ? diffRows(byId(existingLabelAssignments), labelAssignmentRows)
        : writeAllRows(labelAssignmentRows)
      const metadataDiff = diffEnabled
        ? diffSingleton(existingMetadata, metadataRow)
        : { write: true, merged: metadataRow }
      stopDiff()

      mergedWorkspace = workspaceDiff.merged
      mergedUsers = usersDiff.merged
      mergedStreams = streamsDiff.merged
      mergedMemberships = membershipsDiff.merged
      mergedDmPeers = dmPeersDiff.merged
      mergedPersonas = personasDiff.merged
      mergedBots = botsDiff.merged
      mergedLabels = labelsDiff.merged
      mergedLabelAssignments = labelAssignmentsDiff.merged
      recordSkippedRowConfirmations(workspaceId, "streams", streamsDiff, now)
      recordSkippedRowConfirmations(workspaceId, "streamMemberships", membershipsDiff, now)
      rowsSkipped +=
        usersDiff.skipped +
        streamsDiff.skipped +
        membershipsDiff.skipped +
        dmPeersDiff.skipped +
        personasDiff.skipped +
        botsDiff.skipped +
        labelsDiff.skipped +
        labelAssignmentsDiff.skipped +
        (workspaceDiff.write ? 0 : 1) +
        (metadataDiff.write ? 0 : 1)
      rowsWritten +=
        usersDiff.toWrite.length +
        streamsDiff.toWrite.length +
        membershipsDiff.toWrite.length +
        dmPeersDiff.toWrite.length +
        personasDiff.toWrite.length +
        botsDiff.toWrite.length +
        labelsDiff.toWrite.length +
        labelAssignmentsDiff.toWrite.length +
        (workspaceDiff.write ? 1 : 0) +
        (metadataDiff.write ? 1 : 0)

      await Promise.all([
        workspaceDiff.write ? db.workspaces.put(workspaceRow) : Promise.resolve(),
        usersDiff.toWrite.length > 0 ? db.workspaceUsers.bulkPut(usersDiff.toWrite) : Promise.resolve(),
        streamsDiff.toWrite.length > 0 ? db.streams.bulkPut(streamsDiff.toWrite) : Promise.resolve(),
        membershipsDiff.toWrite.length > 0 ? db.streamMemberships.bulkPut(membershipsDiff.toWrite) : Promise.resolve(),
        dmPeersDiff.toWrite.length > 0 ? db.dmPeers.bulkPut(dmPeersDiff.toWrite) : Promise.resolve(),
        personasDiff.toWrite.length > 0 ? db.personas.bulkPut(personasDiff.toWrite) : Promise.resolve(),
        botsDiff.toWrite.length > 0 ? db.bots.bulkPut(botsDiff.toWrite) : Promise.resolve(),
        labelsDiff.toWrite.length > 0 ? db.labels.bulkPut(labelsDiff.toWrite) : Promise.resolve(),
        labelAssignmentsDiff.toWrite.length > 0
          ? db.labelAssignments.bulkPut(labelAssignmentsDiff.toWrite)
          : Promise.resolve(),
        metadataDiff.write ? db.workspaceMetadata.put(metadataRow) : Promise.resolve(),
      ])

      // Per-stream merge with concurrent socket writes (INV-20): the server
      // snapshot wins except for streams whose local counter state was touched
      // during the fetch window. The previous row-level `_cachedAt` skip let
      // one busy stream veto the whole server snapshot, so a drifted local
      // count never healed.
      const existingUnread = await db.unreadState.get(workspaceId)
      effectiveUnread = mergeBootstrapUnreadFields(bootstrap, existingUnread, fetchStartedAt)
      const unreadRow = { id: workspaceId, workspaceId, ...effectiveUnread, _cachedAt: now }
      const unreadDiff = diffEnabled ? diffSingleton(existingUnread, unreadRow) : { write: true, merged: unreadRow }
      if (unreadDiff.write) {
        rowsWritten += 1
        await db.unreadState.put(unreadRow)
      } else {
        rowsSkipped += 1
      }

      // Standalone read frontier (read cutover), same per-stream freshness rule
      // as the counter triple above: the server snapshot wins except for
      // streams whose local row was touched during the fetch window (a live
      // read/read_set/read_messages/read_all or an optimistic mutation stamped
      // its `_cachedAt`). Restoring the snapshot there could regress a frontier
      // the snapshot predates — INCLUDING an explicit unread, a sanctioned
      // downward move no max(sequence) rule can represent, so freshness (not
      // sequence) decides. The map enumerates member streams only; rows it
      // omits (nonmember thread lazy state) are never touched here — upsert,
      // no sweep. Absent map (pre-cutover payload) → no write at all; frontier
      // readers fall back to the membership mirror.
      if (bootstrap.streamReadState !== undefined) {
        const existingRows = await db.streamReadState.where("workspaceId").equals(workspaceId).toArray()
        const existingByStreamId = new Map(existingRows.map((row) => [row.streamId, row]))
        const serverRows: CachedStreamReadState[] = []
        effectiveReadStateMap = { ...bootstrap.streamReadState }
        for (const [streamId, frontier] of Object.entries(bootstrap.streamReadState)) {
          const local = existingByStreamId.get(streamId)
          if (
            fetchStartedAt !== undefined &&
            local &&
            effectiveFreshness(workspaceId, "streamReadState", local.id, local._cachedAt) >= fetchStartedAt
          ) {
            // Touched during the fetch window: preserve the local cache+IDB row
            // exactly, and carry its frontier into the returned map so the
            // query cache the caller writes doesn't regress either.
            effectiveReadStateMap[streamId] = toStreamReadFrontier(local)
            continue
          }
          serverRows.push({
            id: `${workspaceId}:${streamId}`,
            workspaceId,
            streamId,
            lastReadEventId: frontier.lastReadEventId,
            lastReadSequence: frontier.lastReadSequence,
            lastReadAt: frontier.lastReadAt,
            _cachedAt: now,
          })
        }
        const readStateDiff = diffEnabled
          ? diffRows(new Map(existingRows.map((row) => [row.id, row])), serverRows)
          : writeAllRows(serverRows)
        if (readStateDiff.toWrite.length > 0) {
          await db.streamReadState.bulkPut(readStateDiff.toWrite)
        }
        rowsWritten += readStateDiff.toWrite.length
        rowsSkipped += readStateDiff.skipped
        recordSkippedRowConfirmations(workspaceId, "streamReadState", readStateDiff, now)
        seedReadStates = mergeLocalAndServerReadStates(existingRows, readStateDiff.merged)
      }

      const existingPrefs = await db.userPreferences.get(workspaceId)
      if (!existingPrefs || !fetchStartedAt || existingPrefs._cachedAt < fetchStartedAt) {
        const prefsRow = {
          ...bootstrap.userPreferences,
          id: workspaceId,
          workspaceId,
          _cachedAt: now,
        }
        if (diffEnabled && existingPrefs && semanticEqual(existingPrefs, prefsRow)) {
          rowsSkipped += 1
        } else {
          rowsWritten += 1
          await db.userPreferences.put(prefsRow)
        }
      }

      const existingSidebar = await db.sidebarConfigs.get(workspaceId)
      if (!existingSidebar || !fetchStartedAt || existingSidebar._cachedAt < fetchStartedAt) {
        const sidebarRow = {
          id: workspaceId,
          workspaceId,
          config: bootstrap.sidebarConfig,
          _cachedAt: now,
        }
        if (diffEnabled && existingSidebar && semanticEqual(existingSidebar, sidebarRow)) {
          rowsSkipped += 1
        } else {
          rowsWritten += 1
          await db.sidebarConfigs.put(sidebarRow)
        }
      } else {
        effectiveSidebarConfig = existingSidebar.config
      }
    }
  )

  stopTx()
  capture.mark("bootstrap.rowsWritten", rowsWritten)
  capture.mark("bootstrap.rowsSkipped", rowsSkipped)

  // Clean up stale entities: anything in IDB for this workspace that
  // wasn't in the bootstrap AND was written before this bootstrap.
  // Entities with _cachedAt >= now were written concurrently by socket
  // handlers and must be preserved.
  // Use the pre-fetch timestamp for stale cleanup. Entities written by
  // socket handlers DURING the fetch have _cachedAt > fetchStartedAt and
  // survive. Only truly stale entities (from before we started fetching)
  // are removed. If no fetchStartedAt provided, skip cleanup entirely.
  if (fetchStartedAt !== undefined) {
    const stopCleanup = capture.time("bootstrap.cleanup")
    await cleanupStaleEntities(workspaceId, bootstrap, fetchStartedAt)
    stopCleanup()
  }

  // Populate in-memory cache so useLiveQuery hooks return real data on first
  // synchronous render (the default value). Without this, every component sees
  // empty arrays for one render cycle until the async IDB read resolves.
  const stopSeed = capture.time("bootstrap.seed")
  seedWorkspaceCache(workspaceId, {
    workspace: mergedWorkspace,
    users: mergedUsers,
    // Archived roots must be in the synchronous seed too, or the first paint
    // can't tell a stream is archived until the IDB read resolves — a
    // one-frame flash of archived-root drafts (INV-21-adjacent).
    streams: mergedStreams,
    memberships: mergedMemberships,
    // An omitted map leaves the in-memory rows in place (nothing was written);
    // a present map seeds IDB's effective contents — server rows plus every
    // local row the member-only map omits (nonmember thread lazy state) and
    // every frontier preserved as touched during the fetch window.
    readStates: seedReadStates,
    dmPeers: mergedDmPeers,
    personas: mergedPersonas,
    bots: mergedBots,
    labels: mergedLabels,
    labelAssignments: mergedLabelAssignments,
    unreadState: {
      id: workspaceId,
      workspaceId,
      ...effectiveUnread,
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
      configuredToolCategories: bootstrap.configuredToolCategories,
      _cachedAt: now,
    },
  })
  stopSeed()

  // Seed the sidebar agent-activity store so a session already running on cold
  // load paints its stream row without waiting for a live event.
  seedAgentActivity(workspaceId, bootstrap.activeAgentSessions ?? [])
  // Same for the sidebar live-call dot (roadmap 1.4).
  seedActiveCalls(workspaceId, bootstrap.activeCalls ?? [])

  // The caller writes the returned bootstrap to the query cache — reflect the
  // merged counter fields and the preserved frontiers so cache and IDB never
  // disagree on unread state.
  return {
    ...bootstrap,
    streamReadState: effectiveReadStateMap,
    unreadCounts: effectiveUnread.unreadCounts,
    unreadActivities: effectiveUnread.unreadActivities,
    activityCounts: effectiveUnread.activityCounts,
    mentionCounts: effectiveUnread.mentionCounts,
    unreadActivityCount: effectiveUnread.unreadActivityCount,
    messageCounts: effectiveUnread.latestOrdinals,
    readMessageIds: effectiveUnread.readMessageIds,
    mutedStreamIds: effectiveUnread.mutedStreamIds,
  }
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
  const capture = getPerfCapture()
  let rowsWritten = 0
  let rowsSkipped = 0

  const [localStreams, localMemberships, localReadStates, localUnreadState] = await Promise.all([
    db.streams.where("workspaceId").equals(workspaceId).toArray(),
    db.streamMemberships.where("workspaceId").equals(workspaceId).toArray(),
    db.streamReadState.where("workspaceId").equals(workspaceId).toArray(),
    db.unreadState.get(workspaceId),
  ])

  const finalBootstrap = mergeReconnectWorkspaceBootstrap({
    workspaceBootstrap,
    successfulStreamBootstraps: streamBootstraps,
    staleStreamIds,
    terminalStreamIds,
    localStreams,
    localMemberships,
    localReadStates,
    localUnreadState: localUnreadState ?? undefined,
    fetchStartedAt,
  })

  const diffEnabled = resolveFeatureFlags(finalBootstrap.featureFlags ?? EMPTY_FLAG_LAYERS).bootstrapDiff === "on"

  const membershipByStream = new Map(finalBootstrap.streamMemberships.map((sm) => [sm.streamId, sm]))

  // See applyWorkspaceBootstrap: preserve a sidebar config written by a
  // `sidebar_config:updated` event during the fetch window rather than seeding
  // (and returning) the older snapshot.
  let effectiveSidebarConfig = finalBootstrap.sidebarConfig

  const workspaceRow = { ...finalBootstrap.workspace, _cachedAt: now }
  const userRows = finalBootstrap.users.map((user) => ({ ...user, _cachedAt: now }))
  const streamRows = dedupeById<CachedStream>([
    ...finalBootstrap.streams.map((stream) => {
      const membership = membershipByStream.get(stream.id)
      const local = localStreams.find((s) => s.id === stream.id)
      return {
        ...stream,
        notificationLevel: membership?.notificationLevel,
        // Preserve fields workspace-bootstrap doesn't carry but
        // stream-bootstrap mirrors locally (`contextBag` is the
        // canonical example — see `applyStreamBootstrap`).
        contextBag: local?.contextBag,
        _cachedAt: now,
      }
    }),
    // Persist archived roots on reconnect too (mirrors applyWorkspaceBootstrap).
    ...mapArchivedStreamRows(finalBootstrap.archivedStreams ?? [], byId(localStreams), now),
  ])
  const membershipRows = finalBootstrap.streamMemberships.map((membership) => ({
    ...membership,
    id: `${workspaceId}:${membership.streamId}`,
    workspaceId,
    _cachedAt: now,
  }))
  const readStateRows = toCachedReadStates(workspaceId, finalBootstrap.streamReadState, now)
  const dmPeerRows = finalBootstrap.dmPeers.map((dmPeer) => ({
    ...dmPeer,
    id: `${workspaceId}:${dmPeer.streamId}`,
    workspaceId,
    _cachedAt: now,
  }))
  const personaRows = finalBootstrap.personas.map((persona) => ({ ...persona, workspaceId, _cachedAt: now }))
  const botRows = finalBootstrap.bots.map((bot) => ({ ...bot, workspaceId, _cachedAt: now }))
  const labelRows = finalBootstrap.labels.map((label) => ({ ...label, _cachedAt: now }))
  const labelAssignmentRows = finalBootstrap.labelAssignments.map(assignmentToCached)
  const unreadRow = {
    id: workspaceId,
    workspaceId,
    unreadCounts: finalBootstrap.unreadCounts,
    ...bootstrapActivityCacheFields(finalBootstrap),
    latestOrdinals: finalBootstrap.messageCounts,
    readMessageIds: finalBootstrap.readMessageIds,
    mutedStreamIds: finalBootstrap.mutedStreamIds,
    counterTouchedAt: pruneCounterTouches(localUnreadState?.counterTouchedAt, fetchStartedAt),
    mutedTouchedAt: pruneCounterTouches(localUnreadState?.mutedTouchedAt, fetchStartedAt),
    _cachedAt: now,
  }
  const metadataRow = {
    id: workspaceId,
    workspaceId,
    emojis: finalBootstrap.emojis,
    emojiWeights: finalBootstrap.emojiWeights,
    commands: finalBootstrap.commands,
    configuredToolCategories: finalBootstrap.configuredToolCategories,
    featureFlags: finalBootstrap.featureFlags,
    _cachedAt: now,
  }

  let mergedWorkspace: CachedWorkspace = workspaceRow
  let mergedUsers: CachedWorkspaceUser[] = userRows
  let mergedStreams: CachedStream[] = streamRows
  let mergedMemberships: CachedStreamMembership[] = membershipRows
  let mergedDmPeers: CachedDmPeer[] = dmPeerRows
  let mergedPersonas: CachedPersona[] = personaRows
  let mergedBots: CachedBot[] = botRows
  let mergedLabels: CachedLabel[] = labelRows
  let mergedLabelAssignments: CachedLabelAssignment[] = labelAssignmentRows

  await db.transaction(
    "rw",
    [
      db.workspaces,
      db.workspaceUsers,
      db.streams,
      db.streamMemberships,
      db.streamReadState,
      db.dmPeers,
      db.personas,
      db.bots,
      db.labels,
      db.labelAssignments,
      db.unreadState,
      db.userPreferences,
      db.sidebarConfigs,
      db.workspaceMetadata,
      db.events,
      db.pendingMessages,
      db.pendingOperations,
      db.slots,
    ],
    async () => {
      const [
        existingWorkspace,
        existingUsers,
        existingStreams,
        existingMemberships,
        existingReadStates,
        existingDmPeers,
        existingPersonas,
        existingBots,
        existingLabels,
        existingLabelAssignments,
        existingUnread,
        existingMetadata,
      ] = diffEnabled
        ? await Promise.all([
            db.workspaces.get(workspaceId),
            db.workspaceUsers.where("workspaceId").equals(workspaceId).toArray(),
            db.streams.where("workspaceId").equals(workspaceId).toArray(),
            db.streamMemberships.where("workspaceId").equals(workspaceId).toArray(),
            db.streamReadState.where("workspaceId").equals(workspaceId).toArray(),
            db.dmPeers.where("workspaceId").equals(workspaceId).toArray(),
            db.personas.where("workspaceId").equals(workspaceId).toArray(),
            db.bots.where("workspaceId").equals(workspaceId).toArray(),
            db.labels.where("workspaceId").equals(workspaceId).toArray(),
            db.labelAssignments.where("workspaceId").equals(workspaceId).toArray(),
            db.unreadState.get(workspaceId),
            db.workspaceMetadata.get(workspaceId),
          ])
        : [undefined, [], [], [], [], [], [], [], [], [], undefined, undefined]

      const stopDiff = capture.time("bootstrap.diff")
      const workspaceDiff = diffEnabled
        ? diffSingleton(existingWorkspace, workspaceRow)
        : { write: true, merged: workspaceRow }
      const usersDiff = diffEnabled ? diffRows(byId(existingUsers), userRows) : writeAllRows(userRows)
      const streamsDiff = diffEnabled ? diffRows(byId(existingStreams), streamRows) : writeAllRows(streamRows)
      const membershipsDiff = diffEnabled
        ? diffRows(byId(existingMemberships), membershipRows)
        : writeAllRows(membershipRows)
      const readStatesDiff = diffEnabled
        ? diffRows(byId(existingReadStates), readStateRows)
        : writeAllRows(readStateRows)
      const dmPeersDiff = diffEnabled ? diffRows(byId(existingDmPeers), dmPeerRows) : writeAllRows(dmPeerRows)
      const personasDiff = diffEnabled ? diffRows(byId(existingPersonas), personaRows) : writeAllRows(personaRows)
      const botsDiff = diffEnabled ? diffRows(byId(existingBots), botRows) : writeAllRows(botRows)
      const labelsDiff = diffEnabled ? diffRows(byId(existingLabels), labelRows) : writeAllRows(labelRows)
      const labelAssignmentsDiff = diffEnabled
        ? diffRows(byId(existingLabelAssignments), labelAssignmentRows)
        : writeAllRows(labelAssignmentRows)
      const unreadDiff = diffEnabled ? diffSingleton(existingUnread, unreadRow) : { write: true, merged: unreadRow }
      const metadataDiff = diffEnabled
        ? diffSingleton(existingMetadata, metadataRow)
        : { write: true, merged: metadataRow }
      stopDiff()

      mergedWorkspace = workspaceDiff.merged
      mergedUsers = usersDiff.merged
      mergedStreams = streamsDiff.merged
      mergedMemberships = membershipsDiff.merged
      mergedDmPeers = dmPeersDiff.merged
      mergedPersonas = personasDiff.merged
      mergedBots = botsDiff.merged
      mergedLabels = labelsDiff.merged
      mergedLabelAssignments = labelAssignmentsDiff.merged
      recordSkippedRowConfirmations(workspaceId, "streams", streamsDiff, now)
      recordSkippedRowConfirmations(workspaceId, "streamMemberships", membershipsDiff, now)
      recordSkippedRowConfirmations(workspaceId, "streamReadState", readStatesDiff, now)
      rowsSkipped +=
        usersDiff.skipped +
        streamsDiff.skipped +
        membershipsDiff.skipped +
        readStatesDiff.skipped +
        dmPeersDiff.skipped +
        personasDiff.skipped +
        botsDiff.skipped +
        labelsDiff.skipped +
        labelAssignmentsDiff.skipped +
        (workspaceDiff.write ? 0 : 1) +
        (unreadDiff.write ? 0 : 1) +
        (metadataDiff.write ? 0 : 1)
      rowsWritten +=
        usersDiff.toWrite.length +
        streamsDiff.toWrite.length +
        membershipsDiff.toWrite.length +
        readStatesDiff.toWrite.length +
        dmPeersDiff.toWrite.length +
        personasDiff.toWrite.length +
        botsDiff.toWrite.length +
        labelsDiff.toWrite.length +
        labelAssignmentsDiff.toWrite.length +
        (workspaceDiff.write ? 1 : 0) +
        (unreadDiff.write ? 1 : 0) +
        (metadataDiff.write ? 1 : 0)

      await Promise.all([
        workspaceDiff.write ? db.workspaces.put(workspaceRow) : Promise.resolve(),
        usersDiff.toWrite.length > 0 ? db.workspaceUsers.bulkPut(usersDiff.toWrite) : Promise.resolve(),
        streamsDiff.toWrite.length > 0 ? db.streams.bulkPut(streamsDiff.toWrite) : Promise.resolve(),
        membershipsDiff.toWrite.length > 0 ? db.streamMemberships.bulkPut(membershipsDiff.toWrite) : Promise.resolve(),
        readStatesDiff.toWrite.length > 0 ? db.streamReadState.bulkPut(readStatesDiff.toWrite) : Promise.resolve(),
        dmPeersDiff.toWrite.length > 0 ? db.dmPeers.bulkPut(dmPeersDiff.toWrite) : Promise.resolve(),
        personasDiff.toWrite.length > 0 ? db.personas.bulkPut(personasDiff.toWrite) : Promise.resolve(),
        botsDiff.toWrite.length > 0 ? db.bots.bulkPut(botsDiff.toWrite) : Promise.resolve(),
        labelsDiff.toWrite.length > 0 ? db.labels.bulkPut(labelsDiff.toWrite) : Promise.resolve(),
        labelAssignmentsDiff.toWrite.length > 0
          ? db.labelAssignments.bulkPut(labelAssignmentsDiff.toWrite)
          : Promise.resolve(),
        unreadDiff.write ? db.unreadState.put(unreadRow) : Promise.resolve(),
        metadataDiff.write ? db.workspaceMetadata.put(metadataRow) : Promise.resolve(),
      ])

      const existingUserPreferences = await db.userPreferences.get(workspaceId)
      if (!existingUserPreferences || !fetchStartedAt || existingUserPreferences._cachedAt < fetchStartedAt) {
        const prefsRow = {
          ...finalBootstrap.userPreferences,
          id: workspaceId,
          workspaceId,
          _cachedAt: now,
        }
        if (!diffEnabled || !existingUserPreferences || !semanticEqual(existingUserPreferences, prefsRow)) {
          rowsWritten += 1
          await db.userPreferences.put(prefsRow)
        } else {
          rowsSkipped += 1
        }
      }

      const existingSidebarConfig = await db.sidebarConfigs.get(workspaceId)
      if (!existingSidebarConfig || !fetchStartedAt || existingSidebarConfig._cachedAt < fetchStartedAt) {
        const sidebarRow = {
          id: workspaceId,
          workspaceId,
          config: finalBootstrap.sidebarConfig,
          _cachedAt: now,
        }
        if (!diffEnabled || !existingSidebarConfig || !semanticEqual(existingSidebarConfig, sidebarRow)) {
          rowsWritten += 1
          await db.sidebarConfigs.put(sidebarRow)
        } else {
          rowsSkipped += 1
        }
      } else {
        effectiveSidebarConfig = existingSidebarConfig.config
      }

      for (const [streamId, bootstrap] of streamBootstraps) {
        // Carry the fetch window so a per-stream envelope's stale `readState`
        // never clobbers a frontier touched during the reconnect (same rule
        // the workspace map merge above applies).
        await applyStreamBootstrapInCurrentTransaction(workspaceId, streamId, bootstrap, now, fetchStartedAt)
      }

      if (terminalStreamIds.size > 0) {
        const terminalIds = Array.from(terminalStreamIds)
        const terminalRowIds = terminalIds.map((streamId) => `${workspaceId}:${streamId}`)
        await Promise.all([
          db.streams.bulkDelete(terminalIds),
          db.streamMemberships.bulkDelete(terminalRowIds),
          db.streamReadState.bulkDelete(terminalRowIds),
          deleteSlotsForStreams(db, terminalIds),
        ])
      }
    }
  )

  capture.mark("bootstrap.rowsWritten", rowsWritten)
  capture.mark("bootstrap.rowsSkipped", rowsSkipped)

  if (fetchStartedAt !== undefined) {
    await cleanupStaleEntities(workspaceId, finalBootstrap, fetchStartedAt)
  }

  seedWorkspaceCache(workspaceId, {
    workspace: mergedWorkspace,
    users: mergedUsers,
    // Archived roots ride the seed (mirrors applyWorkspaceBootstrap) so the
    // first paint after reconnect knows they're archived (no draft flash) —
    // they are already deduped into the merged streams list.
    streams: mergedStreams,
    memberships: mergedMemberships,
    // A present map seeds IDB's effective contents: the merged map's rows win
    // per stream, but local rows the member-only map omits (nonmember thread
    // lazy state) stay seeded — the apply upserts, it never sweeps. Terminal
    // streams' rows are bulkDeleted in this same transaction, so they must not
    // be re-seeded from the pre-transaction snapshot.
    readStates: finalBootstrap.streamReadState
      ? mergeLocalAndServerReadStates(
          localReadStates.filter((row) => !terminalStreamIds.has(row.streamId)),
          toCachedReadStates(workspaceId, finalBootstrap.streamReadState, now)
        )
      : undefined,
    dmPeers: mergedDmPeers,
    personas: mergedPersonas,
    bots: mergedBots,
    labels: mergedLabels,
    labelAssignments: mergedLabelAssignments,
    unreadState: {
      id: workspaceId,
      workspaceId,
      unreadCounts: finalBootstrap.unreadCounts,
      ...bootstrapActivityCacheFields(finalBootstrap),
      latestOrdinals: finalBootstrap.messageCounts,
      readMessageIds: finalBootstrap.readMessageIds,
      mutedStreamIds: finalBootstrap.mutedStreamIds,
      counterTouchedAt: pruneCounterTouches(localUnreadState?.counterTouchedAt, fetchStartedAt),
      mutedTouchedAt: pruneCounterTouches(localUnreadState?.mutedTouchedAt, fetchStartedAt),
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
      configuredToolCategories: finalBootstrap.configuredToolCategories,
      _cachedAt: now,
    },
  })

  // The returned bootstrap is written to the bootstrap query cache by the
  // caller; reflect the preserved local config so it doesn't carry the stale
  // snapshot value.
  finalBootstrap.sidebarConfig = effectiveSidebarConfig

  // Re-seed the sidebar agent-activity store with the reconnect's running set —
  // the authority that drops any entry whose end signal was missed (INV-53).
  seedAgentActivity(workspaceId, finalBootstrap.activeAgentSessions ?? [])
  // Same authoritative re-seed for the sidebar live-call dot (INV-53).
  seedActiveCalls(workspaceId, finalBootstrap.activeCalls ?? [])

  return { workspaceBootstrap: finalBootstrap, streamBootstraps }
}

// Every keep-set below derives from the BOOTSTRAP PAYLOAD, never from the set of
// rows the apply actually wrote. Under `bootstrapDiff` a row present in the
// payload can be skipped and keep an old `_cachedAt` — narrowing these sets to
// "the ids we wrote" would sweep exactly those rows. Presence in the payload is
// the protection; `_cachedAt >= now` only shields rows the payload never
// enumerated (concurrent socket writes during the fetch window).
async function cleanupStaleEntities(workspaceId: string, bootstrap: WorkspaceBootstrap, now: number): Promise<void> {
  // Archived roots ride in bootstrap.archivedStreams (absent from .streams);
  // keep them so the absence-sweep doesn't delete rows every consumer still
  // needs (drafts hiding, name resolution) across a reload.
  const bootstrapStreamIds = new Set([
    ...bootstrap.streams.map((s) => s.id),
    ...(bootstrap.archivedStreams ?? []).map((s) => s.id),
  ])
  const bootstrapUserIds = new Set(bootstrap.users.map((u) => u.id))
  const bootstrapMembershipIds = new Set(bootstrap.streamMemberships.map((sm) => `${workspaceId}:${sm.streamId}`))
  const bootstrapDmPeerIds = new Set(bootstrap.dmPeers.map((dp) => `${workspaceId}:${dp.streamId}`))
  const bootstrapPersonaIds = new Set(bootstrap.personas.map((p) => p.id))
  const bootstrapBotIds = new Set(bootstrap.bots.map((b) => b.id))
  const bootstrapLabelIds = new Set(bootstrap.labels.map((l) => l.id))
  const bootstrapLabelAssignmentIds = new Set(
    bootstrap.labelAssignments.map((a) =>
      assignmentId(a.workspaceId, a.resourceType, a.resourceId, a.labelId, a.userId)
    )
  )

  // Derive the stream ids the absence-sweep will remove BEFORE deleting, then
  // drop their slot rows too. Slots key off streamId, and the workspace
  // bootstrap enumerates streams — not each stream's valid slot keys — so they
  // can't ride the generic deleteStale (Amendment A4).
  const staleStreamIds = await staleEntityIds(db.streams, "workspaceId", workspaceId, bootstrapStreamIds, now)

  await Promise.all([
    staleStreamIds.length > 0 ? db.streams.bulkDelete(staleStreamIds) : Promise.resolve(),
    deleteSlotsForStreams(db, staleStreamIds),
    deleteStale(db.workspaceUsers, "workspaceId", workspaceId, bootstrapUserIds, now),
    deleteStale(db.streamMemberships, "workspaceId", workspaceId, bootstrapMembershipIds, now),
    // NO streamReadState sweep: the bootstrap map enumerates MEMBER streams
    // only, so a row omitted from it is usually a nonmember thread's lazy
    // frontier — not stale data. Neither an omitted map (old server / cached
    // pre-cutover payload) nor a present one (explicit `{}` included) is a
    // deletion authority over rows it never enumerated. Standalone rows are
    // deleted only by explicit lifecycle cleanup: terminal-stream deletes in
    // applyReconnectBootstrapBatch, stream removal, and account DB teardown.
    deleteStale(db.dmPeers, "workspaceId", workspaceId, bootstrapDmPeerIds, now),
    deleteStale(db.personas, "workspaceId", workspaceId, bootstrapPersonaIds, now),
    deleteStale(db.bots, "workspaceId", workspaceId, bootstrapBotIds, now),
    deleteStale(db.labels, "workspaceId", workspaceId, bootstrapLabelIds, now),
    deleteStale(db.labelAssignments, "workspaceId", workspaceId, bootstrapLabelAssignmentIds, now),
  ])
}

async function staleEntityIds(
  table: {
    where: (field: string) => {
      equals: (value: string) => { toArray: () => Promise<Array<{ id: string; _cachedAt: number }>> }
    }
  },
  scopeField: string,
  scopeValue: string,
  keepIds: Set<string>,
  now: number
): Promise<string[]> {
  const all = await table.where(scopeField).equals(scopeValue).toArray()
  return all.filter((entity) => !keepIds.has(entity.id) && entity._cachedAt < now).map((e) => e.id)
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
  const toDelete = await staleEntityIds(table, scopeField, scopeValue, keepIds, now)
  if (toDelete.length > 0) {
    await table.bulkDelete(toDelete)
  }
}
