export { createStreamHandlers } from "./handlers"

export { createStreamBriefHandlers } from "./brief-handlers"
export { StreamBriefService, resolveBriefStreamId, STREAM_BRIEF_MAX_CHARS } from "./brief-service"
export type { UpdateBriefParams, UpdateBriefResult } from "./brief-service"
export { StreamBriefRepository } from "./brief-repository"
export type { StreamBrief, BriefAuthorKind } from "./brief-repository"

export { StreamService } from "./service"
export type { CreateScratchpadParams, CreateChannelParams, CreateThreadParams } from "./service"

// Canonical "can this user read this stream?" check (INV-8)
export {
  checkStreamAccess,
  listAccessibleStreamIds,
  listRoomReadableStreamIds,
  resolveEffectiveAccessStream,
  rootReadableConditionSql,
  streamAccessPredicateSql,
} from "./access"

export {
  deriveStreamViewerState,
  createStreamReadOnlyError,
  assertViewerStreamWritable,
  assertStreamWritable,
  assertStreamsWritable,
  resolveLockedStreamAuthorities,
  projectStreamForPrincipal,
  projectStreamsForPrincipal,
  projectStreamForUser,
  projectStreamsForUser,
  projectStreamForBot,
  projectStreamsForBot,
} from "./write-authority"
export type { StreamWritePrincipal, LockedStreamAuthority } from "./write-authority"

export { prependThreadNamingAnchor, renderNamingEventAnchor } from "./naming-context"

export { NOTIFICATION_CONFIG, isAllowedLevel, getDefaultLevel, getEffectiveLevel } from "./notification-config"

export { resolveNotificationLevelsForStream } from "./notification-resolver"
export type { ResolvedNotification } from "./notification-resolver"

export { StreamRepository } from "./repository"
export type {
  Stream,
  InsertStreamParams,
  UpdateStreamParams,
  StreamWithPreview,
  LastMessagePreview,
  DmPeer,
} from "./repository"
export { searchDmStreamsByParticipant } from "./dm-search"
export type { DmStreamSearchMatch } from "./dm-search"

export { StreamEventRepository } from "./event-repository"
export type {
  StreamEvent,
  InsertEventParams,
  MoveEventSequenceUpdate,
  MoveEventIdSequenceUpdate,
} from "./event-repository"

export { StreamMemberRepository } from "./member-repository"
export type { StreamMember, UpdateStreamMemberParams } from "./member-repository"

export { ReadStateRepository } from "./read-state-repository"
export type { StreamReadState } from "./read-state-repository"

export { getEffectiveReadState, usersReadThroughEffective } from "./effective-read-state"
export type { EffectiveReadState } from "./effective-read-state"

export { StreamStateRepository } from "./state-repository"
export type { MemoStreamState, StreamReadyToProcess } from "./state-repository"

export { StreamPoliciesRepository } from "./policy-repository"

export { SparseReadRepository } from "./sparse-read-repository"
export type { CompactionTarget } from "./sparse-read-repository"

export { applySparseRead, applySparseUnread } from "./sparse-read"
export type { ReadStateSnapshot, ApplySparseReadParams } from "./sparse-read"

export { getEffectiveDisplayName, formatParticipantNames } from "./display-name"
export type { DisplayNameSource, DisplayNameContext, EffectiveDisplayName } from "./display-name"
