import { HttpError } from "@threahq/backend-common"
import {
  StreamErrorCodes,
  StreamReadOnlyReasons,
  StreamTypes,
  type StreamReadOnlyReason,
  type StreamViewerState,
  type StreamType,
  type Visibility,
} from "@threahq/types"
import type { Querier } from "../../db"
import { StreamNotFoundError } from "../../lib/errors"
import { BotChannelAccessRepository, isStreamReadableAsOwner } from "../api-keys"
import { findUserIdsWithoutBrowse } from "../workspaces"
import {
  isOpenToBots,
  resolveEffectiveAccessStream,
  resolveEffectiveAccessStreams,
  usersReadingWithoutMembership,
} from "./access"
import { findGuestPolicyClosedDmIds } from "./guest-dm-policy"
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
  originWorkspaceId?: string | null
  disconnectedAt: Date | string | null
}

export async function assertUserMayManageChannels(db: Querier, workspaceId: string, userId: string): Promise<void> {
  if ((await findUserIdsWithoutBrowse(db, workspaceId, [userId])).size === 0) return
  throw new HttpError("Guests cannot create or change channels", {
    status: 403,
    code: StreamErrorCodes.CHANNEL_MANAGEMENT_FORBIDDEN,
  })
}

/** Bots and API keys pass: channel management is a restriction on user principals only. */
export async function assertPrincipalMayManageChannel(
  db: Querier,
  workspaceId: string,
  stream: Pick<AuthorityStream, "type">,
  principal: StreamWritePrincipal
): Promise<void> {
  if (stream.type !== StreamTypes.CHANNEL || principal.kind !== "user") return
  await assertUserMayManageChannels(db, workspaceId, principal.userId)
}

export function deriveStreamViewerState(params: {
  target: Pick<AuthorityStream, "type" | "archivedAt" | "originWorkspaceId" | "disconnectedAt">
  /** Whether any stream up the target's `parent_stream_id` chain is archived. */
  ancestorArchived: boolean
  participates: boolean
  /** Whether the guest DM policy closes the target's DM root to writers. */
  guestDmClosed: boolean
}): StreamViewerState {
  if (params.target.archivedAt || params.ancestorArchived) {
    return { readOnly: true, readOnlyReason: StreamReadOnlyReasons.ARCHIVED }
  }
  if (params.target.type === StreamTypes.SYSTEM) {
    return { readOnly: true, readOnlyReason: StreamReadOnlyReasons.SYSTEM_STREAM }
  }
  if (!params.participates) {
    return { readOnly: true, readOnlyReason: StreamReadOnlyReasons.NOT_A_MEMBER }
  }
  if (params.target.disconnectedAt) {
    return { readOnly: true, readOnlyReason: StreamReadOnlyReasons.DISCONNECTED }
  }
  if (params.target.originWorkspaceId) {
    return { readOnly: true, readOnlyReason: StreamReadOnlyReasons.SHARED_COPY }
  }
  if (params.guestDmClosed) {
    return { readOnly: true, readOnlyReason: StreamReadOnlyReasons.GUEST_DM_POLICY }
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

/**
 * An aside inherits its host's archive state through the parent chain, so a
 * read-only host can't take one. A shared channel's copy can, connected or not:
 * the aside lives in this workspace and nothing in it reaches the host.
 */
export function canHostAside(state: StreamViewerState): boolean {
  return (
    !state.readOnlyReason ||
    state.readOnlyReason === StreamReadOnlyReasons.SHARED_COPY ||
    state.readOnlyReason === StreamReadOnlyReasons.DISCONNECTED
  )
}

async function principalParticipates(
  db: Querier,
  workspaceId: string,
  rootStreamId: string,
  principal: StreamWritePrincipal
): Promise<boolean> {
  if (principal.kind === "user") {
    return StreamMemberRepository.isMember(db, workspaceId, rootStreamId, principal.userId)
  }
  return BotChannelAccessRepository.hasGrant(db, workspaceId, principal.botId, rootStreamId)
}

async function visibilitiesReadWithoutParticipating(
  db: Querier,
  workspaceId: string,
  principal: StreamWritePrincipal,
  visibilities: Iterable<Visibility>
): Promise<Set<Visibility>> {
  const open = new Set<Visibility>()
  for (const visibility of new Set(visibilities)) {
    const reads =
      principal.kind === "bot"
        ? isOpenToBots(visibility)
        : (await usersReadingWithoutMembership(db, workspaceId, visibility, [principal.userId])).has(principal.userId)
    if (reads) open.add(visibility)
  }
  return open
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
  const readable =
    participates ||
    (await visibilitiesReadWithoutParticipating(db, workspaceId, principal, [effective.visibility])).has(
      effective.visibility
    )
  if (!readable) return null

  const ancestorArchived = stream.archivedAt
    ? false
    : await StreamRepository.isEffectivelyArchived(db, workspaceId, stream.id)
  const guestDmClosed = (await findGuestPolicyClosedDmIds(db, workspaceId, [effective])).has(effective.id)
  return { ...stream, ...deriveStreamViewerState({ target: stream, ancestorArchived, participates, guestDmClosed }) }
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
          (await StreamMemberRepository.findByStreamsAndMember(db, workspaceId, validRootIds, principal.userId)).map(
            (member) => member.streamId
          )
        )
      : await BotChannelAccessRepository.filterGrantedStreamIds(db, workspaceId, principal.botId, validRootIds)

  const sealedIds = new Set(
    await StreamRepository.filterEffectivelyArchivedIds(
      db,
      workspaceId,
      streams.filter((stream) => !stream.archivedAt).map((stream) => stream.id)
    )
  )
  const readableWithoutParticipating = await visibilitiesReadWithoutParticipating(
    db,
    workspaceId,
    principal,
    facts.filter(({ root }) => !participatingRootIds.has(root.id)).map(({ root }) => root.visibility)
  )
  const readable = facts.filter(
    ({ root }) => participatingRootIds.has(root.id) || readableWithoutParticipating.has(root.visibility)
  )
  const closedDmRootIds = await findGuestPolicyClosedDmIds(
    db,
    workspaceId,
    readable.map(({ root }) => root)
  )
  return readable.map(({ target, root }) => ({
    ...target,
    ...deriveStreamViewerState({
      target,
      ancestorArchived: sealedIds.has(target.id),
      participates: participatingRootIds.has(root.id),
      guestDmClosed: closedDmRootIds.has(root.id),
    }),
  }))
}

export interface LockedStreamAuthority {
  target: Stream
  root: Stream
  state: StreamViewerState
}

export interface LockedStreamFacts {
  target: Stream
  root: Stream
  /** Whether any locked ancestor up `parent_stream_id` is archived. */
  ancestorArchived: boolean
}

/**
 * Locks each target, every ancestor up its `parent_stream_id` chain, and its
 * access root, in one id-ordered statement. The archived state a write must
 * respect lives anywhere on that chain (a thread under an archived thread, an
 * aside under an archived host), so the whole chain is locked, not just the
 * root. The chain is read unlocked first: parent and root ids never change
 * after insert, so the id set cannot go stale before the lock lands.
 */
export async function lockEffectiveStreams(
  db: Querier,
  workspaceId: string,
  streamIds: readonly string[]
): Promise<LockedStreamFacts[]> {
  const targetIds = [...new Set(streamIds)].sort()
  if (targetIds.length === 0) return []
  const chainIds = await StreamRepository.listAncestorChainIds(db, workspaceId, targetIds)
  const locked = await StreamRepository.findByIdsForUpdateBlocking(db, workspaceId, chainIds)
  const lockedById = new Map(locked.map((stream) => [stream.id, stream]))
  return targetIds.map((targetId) => {
    const target = lockedById.get(targetId)
    const root = target && lockedById.get(target.rootStreamId ?? target.id)
    if (!target || !root || target.workspaceId !== workspaceId || root.workspaceId !== workspaceId) {
      throw inaccessibleStream()
    }
    let ancestorArchived = false
    for (let parentId = target.parentStreamId; parentId; ) {
      const parent = lockedById.get(parentId)
      if (!parent || parent.workspaceId !== workspaceId) throw inaccessibleStream()
      if (parent.archivedAt) {
        ancestorArchived = true
        break
      }
      parentId = parent.parentStreamId
    }
    return { target, root, ancestorArchived }
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
      ? await StreamMemberRepository.lockMemberships(db, params.workspaceId, rootIds, principal.userId)
      : await BotChannelAccessRepository.lockGrants(db, params.workspaceId, principal.botId, rootIds)

  const readableWithoutParticipating = await visibilitiesReadWithoutParticipating(
    db,
    params.workspaceId,
    principal,
    facts.filter(({ root }) => !participatingRootIds.has(root.id)).map(({ root }) => root.visibility)
  )
  const closedDmRootIds = await findGuestPolicyClosedDmIds(
    db,
    params.workspaceId,
    facts.filter(({ root }) => participatingRootIds.has(root.id)).map(({ root }) => root)
  )
  const authorities: LockedStreamAuthority[] = []
  for (const { target, root, ancestorArchived } of facts) {
    const participates = participatingRootIds.has(root.id)
    if (!participates && !readableWithoutParticipating.has(root.visibility)) {
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
      state: deriveStreamViewerState({
        target,
        ancestorArchived,
        participates,
        guestDmClosed: closedDmRootIds.has(root.id),
      }),
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
