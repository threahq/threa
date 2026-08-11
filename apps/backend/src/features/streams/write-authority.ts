import { HttpError } from "@threa/backend-common"
import {
  StreamErrorCodes,
  StreamReadOnlyReasons,
  StreamTypes,
  Visibilities,
  type StreamReadOnlyReason,
  type StreamViewerState,
  type StreamType,
  type Visibility,
} from "@threa/types"
import type { Querier } from "../../db"
import { BotChannelAccessRepository } from "../api-keys"
import { resolveEffectiveAccessStream, resolveEffectiveAccessStreams } from "./access"
import { StreamMemberRepository } from "./member-repository"

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
}): StreamViewerState {
  if (params.target.archivedAt || params.root.archivedAt) {
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
