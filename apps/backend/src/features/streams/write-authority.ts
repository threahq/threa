import { HttpError } from "@threahq/backend-common"
import {
  StreamErrorCodes,
  StreamReadOnlyReasons,
  StreamTypes,
  Visibilities,
  type StreamReadOnlyReason,
  type StreamViewerState,
  type StreamType,
  type Visibility,
} from "@threahq/types"
import type { Querier } from "../../db"
import { StreamNotFoundError } from "../../lib/errors"
import { BotChannelAccessRepository, isStreamReadableAsOwner } from "../api-keys"
import { resolveEffectiveAccessStream, resolveEffectiveAccessStreams } from "./access"
import { StreamMemberRepository } from "./member-repository"
import { StreamRepository, type Stream } from "./repository"

export type StreamWritePrincipal = { kind: "user"; userId: string } | { kind: "bot"; botId: string }

interface AuthorityStream {
  id: string
  workspaceId: string
  rootStreamId: string | null
  type: StreamType
  visibility: Visibility
  archivedAt: Date | string | null
}

export function deriveStreamViewerState(params: {
  target: Pick<AuthorityStream, "type" | "archivedAt">
  root: Pick<AuthorityStream, "archivedAt">
  participates: boolean
  /**
   * Whether the host (parent) of the effective aside root is archived. An aside
   * is a root of its own, so root-archival never covers the host — the aside,
   * and every thread rooted in it, reads read-only while the host it annotates
   * is archived.
   */
  parentEffectivelyArchived?: boolean
}): StreamViewerState {
  if (params.target.archivedAt || params.root.archivedAt || params.parentEffectivelyArchived) {
    return { readOnly: true, readOnlyReason: StreamReadOnlyReasons.ARCHIVED }
  }
  if (params.target.type === StreamTypes.SYSTEM) {
    return { readOnly: true, readOnlyReason: StreamReadOnlyReasons.SYSTEM_STREAM }
  }
  if (!params.participates) {
    return { readOnly: true, readOnlyReason: StreamReadOnlyReasons.NOT_A_MEMBER }
  }
  return { readOnly: false, readOnlyReason: null }
}

export function createStreamReadOnlyError(reason: StreamReadOnlyReason): HttpError {
  return new HttpError("This stream is read-only", {
    status: 403,
    code: StreamErrorCodes.READ_ONLY,
    details: { reason },
  })
}

export function assertViewerStreamWritable(state: StreamViewerState): void {
  if (state.readOnlyReason) throw createStreamReadOnlyError(state.readOnlyReason)
}

async function principalParticipates(
  db: Querier,
  workspaceId: string,
  rootStreamId: string,
  principal: StreamWritePrincipal
): Promise<boolean> {
  if (principal.kind === "user") {
    return StreamMemberRepository.isMember(db, rootStreamId, principal.userId)
  }
  return BotChannelAccessRepository.hasGrant(db, workspaceId, principal.botId, rootStreamId)
}

export async function projectStreamForPrincipal<T extends AuthorityStream>(
  db: Querier,
  params: { workspaceId: string; stream: T; principal: StreamWritePrincipal }
): Promise<(T & StreamViewerState) | null> {
  const { stream, workspaceId, principal } = params
  if (stream.workspaceId !== workspaceId) return null

  const effective = await resolveEffectiveAccessStream(db, stream)
  if (stream.rootStreamId && effective.id !== stream.rootStreamId) return null
  if (effective.workspaceId !== workspaceId) return null

  const participates = await principalParticipates(db, workspaceId, effective.id, principal)
  if (effective.visibility !== Visibilities.PUBLIC && !participates) return null

  return { ...stream, ...deriveStreamViewerState({ target: stream, root: effective, participates }) }
}

export async function projectStreamsForPrincipal<T extends AuthorityStream>(
  db: Querier,
  params: { workspaceId: string; streams: readonly T[]; principal: StreamWritePrincipal }
): Promise<Array<T & StreamViewerState>> {
  const { workspaceId, streams, principal } = params
  if (streams.length === 0) return []

  const facts = await resolveEffectiveAccessStreams(db, workspaceId, streams)
  const validRootIds = [...new Set(facts.map(({ root }) => root.id))]
  const participatingRootIds =
    principal.kind === "user"
      ? new Set(
          (await StreamMemberRepository.findByStreamsAndMember(db, validRootIds, principal.userId)).map(
            (member) => member.streamId
          )
        )
      : await BotChannelAccessRepository.filterGrantedStreamIds(db, workspaceId, principal.botId, validRootIds)

  const projected: Array<T & StreamViewerState> = []
  for (const { target, root } of facts) {
    const participates = participatingRootIds.has(root.id)
    if (root.visibility !== Visibilities.PUBLIC && !participates) continue
    projected.push({ ...target, ...deriveStreamViewerState({ target, root, participates }) })
  }
  return projected
}

export interface LockedStreamAuthority {
  target: Stream
  root: Stream
  state: StreamViewerState
}

export async function lockEffectiveStreams(
  db: Querier,
  workspaceId: string,
  streamIds: readonly string[],
  suppliedSnapshots?: readonly Stream[]
): Promise<Array<{ target: Stream; root: Stream; parentEffectivelyArchived: boolean }>> {
  const targetIds = [...new Set(streamIds)].sort()
  if (targetIds.length === 0) return []
  const snapshots = suppliedSnapshots ?? (await StreamRepository.findByIdsInWorkspace(db, workspaceId, targetIds))
  const snapshotById = new Map(snapshots.map((stream) => [stream.id, stream]))
  const lockIds = new Set<string>()
  for (const targetId of targetIds) {
    const target = snapshotById.get(targetId)
    if (!target || target.workspaceId !== workspaceId) throw inaccessibleStream()
    lockIds.add(target.id)
    lockIds.add(target.rootStreamId ?? target.id)
  }
  const locked = await StreamRepository.findByIdsForUpdateBlocking(db, workspaceId, [...lockIds])
  const lockedById = new Map(locked.map((stream) => [stream.id, stream]))
  // An aside's effective archive state includes its host (parent) chain — for
  // the aside itself and for every thread rooted in it. The root row is only
  // known once locked, so the host and the host's root join in a second round;
  // only the aside's creator and its companion ever write here, and both lock
  // in this same order, so the two rounds cannot form a cycle.
  const hostIds = new Set<string>()
  for (const stream of lockedById.values()) {
    if (stream.type === StreamTypes.ASIDE && stream.parentStreamId && !lockedById.has(stream.parentStreamId)) {
      hostIds.add(stream.parentStreamId)
    }
  }
  if (hostIds.size > 0) {
    const hosts = await StreamRepository.findByIdsInWorkspace(db, workspaceId, [...hostIds])
    if (hosts.length !== hostIds.size) throw inaccessibleStream()
    const hostLockIds = new Set<string>()
    for (const host of hosts) {
      hostLockIds.add(host.id)
      hostLockIds.add(host.rootStreamId ?? host.id)
    }
    for (const stream of await StreamRepository.findByIdsForUpdateBlocking(db, workspaceId, [...hostLockIds])) {
      lockedById.set(stream.id, stream)
    }
  }
  return targetIds.map((targetId) => {
    const target = lockedById.get(targetId)
    const root = target && lockedById.get(target.rootStreamId ?? target.id)
    if (!target || !root || target.workspaceId !== workspaceId || root.workspaceId !== workspaceId) {
      throw inaccessibleStream()
    }
    let parentEffectivelyArchived = false
    if (root.type === StreamTypes.ASIDE && root.parentStreamId) {
      const host = lockedById.get(root.parentStreamId)
      const hostRoot = host && lockedById.get(host.rootStreamId ?? host.id)
      if (!host || !hostRoot) throw inaccessibleStream()
      parentEffectivelyArchived = Boolean(host.archivedAt || hostRoot.archivedAt)
    }
    return { target, root, parentEffectivelyArchived }
  })
}

function inaccessibleStream(): StreamNotFoundError {
  return new StreamNotFoundError()
}

/**
 * Transaction-only authority gate. All callers lock streams in id order first,
 * then participation rows in root-id order; lifecycle transitions use the same order.
 */
export async function resolveLockedStreamAuthorities(
  db: Querier,
  params: { workspaceId: string; streamIds: readonly string[]; principal: StreamWritePrincipal }
): Promise<LockedStreamAuthority[]> {
  const facts = await lockEffectiveStreams(db, params.workspaceId, params.streamIds)
  if (facts.length === 0) return []

  const principal = params.principal
  const rootIds = [...new Set(facts.map(({ root }) => root.id))].sort()
  const participatingRootIds =
    principal.kind === "user"
      ? await StreamMemberRepository.lockMemberships(db, rootIds, principal.userId)
      : await BotChannelAccessRepository.lockGrants(db, params.workspaceId, principal.botId, rootIds)

  const authorities: LockedStreamAuthority[] = []
  for (const { target, root, parentEffectivelyArchived } of facts) {
    const participates = participatingRootIds.has(root.id)
    if (root.visibility !== Visibilities.PUBLIC && !participates) {
      // A bot that already reads this stream through its owner
      // (`bots.reads_as_owner`) must not be told "not found" on write — it just
      // read the stream, so the existence-hiding 404 reads as a transient error
      // and invites a retry loop. Falling through yields the truthful terminal
      // READ_ONLY/not_a_member 403. Existence hiding is kept everywhere the bot
      // genuinely cannot read, so the predicate here is the read gate's own.
      const readableAsOwner =
        principal.kind === "bot" && (await isStreamReadableAsOwner(db, params.workspaceId, principal.botId, target.id))
      if (!readableAsOwner) throw inaccessibleStream()
    }
    authorities.push({
      target,
      root,
      state: deriveStreamViewerState({ target, root, participates, parentEffectivelyArchived }),
    })
  }
  return authorities
}

export async function assertStreamsWritable(
  db: Querier,
  params: { workspaceId: string; streamIds: readonly string[]; principal: StreamWritePrincipal }
): Promise<LockedStreamAuthority[]> {
  const authorities = await resolveLockedStreamAuthorities(db, params)
  for (const authority of authorities) assertViewerStreamWritable(authority.state)
  return authorities
}

export async function assertStreamWritable(
  db: Querier,
  params: { workspaceId: string; streamId: string; principal: StreamWritePrincipal }
): Promise<LockedStreamAuthority> {
  const [authority] = await assertStreamsWritable(db, {
    workspaceId: params.workspaceId,
    streamIds: [params.streamId],
    principal: params.principal,
  })
  return authority
}

export function projectStreamForUser<T extends AuthorityStream>(
  db: Querier,
  params: { workspaceId: string; stream: T; userId: string }
): Promise<(T & StreamViewerState) | null> {
  return projectStreamForPrincipal(db, {
    workspaceId: params.workspaceId,
    stream: params.stream,
    principal: { kind: "user", userId: params.userId },
  })
}

export function projectStreamsForUser<T extends AuthorityStream>(
  db: Querier,
  params: { workspaceId: string; streams: readonly T[]; userId: string }
): Promise<Array<T & StreamViewerState>> {
  return projectStreamsForPrincipal(db, {
    workspaceId: params.workspaceId,
    streams: params.streams,
    principal: { kind: "user", userId: params.userId },
  })
}

export function projectStreamForBot<T extends AuthorityStream>(
  db: Querier,
  params: { workspaceId: string; stream: T; botId: string }
): Promise<(T & StreamViewerState) | null> {
  return projectStreamForPrincipal(db, {
    workspaceId: params.workspaceId,
    stream: params.stream,
    principal: { kind: "bot", botId: params.botId },
  })
}

export function projectStreamsForBot<T extends AuthorityStream>(
  db: Querier,
  params: { workspaceId: string; streams: readonly T[]; botId: string }
): Promise<Array<T & StreamViewerState>> {
  return projectStreamsForPrincipal(db, {
    workspaceId: params.workspaceId,
    streams: params.streams,
    principal: { kind: "bot", botId: params.botId },
  })
}
