import { isDeepStrictEqual } from "node:util"
import type { Pool, PoolClient } from "pg"
import { generateUniqueSlug } from "@threahq/backend-common"
import {
  AuthorTypes,
  StreamConnectionStates,
  StreamTypes,
  TitleSources,
  type BridgeActor,
  type BridgeEvents,
  type BridgeMessage,
  type BridgeStream,
  type StreamConnection,
} from "@threahq/types"
import { withTransaction } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { eventId, streamContextItemId } from "../../lib/id"
import { logger } from "../../lib/logger"
import { PersonaRepository } from "../agents"
import type { FeatureFlagService } from "../feature-flags"
import { MessageRepository, applyCopyChanges } from "../messaging"
import { BotRepository } from "../public-api"
import { StreamContextRepository, contextSnippet } from "../stream-context"
import {
  StreamEventRepository,
  StreamMemberRepository,
  StreamRepository,
  normalizeStreamDescription,
  publishThreadUpdated,
  type InsertStreamParams,
  type NormalizedStreamDescription,
  type Stream,
} from "../streams"
import { ActorCopyRepository, UserRepository, syncActorCopies, syncUserCopies } from "../workspaces"
import type { BridgeClient, ConnectionAddress } from "./bridge-client"
import { StreamConnectionCursorRepository } from "./cursor-repository"
import { namedAuthors } from "./named-authors"
import { StreamConnectionRepository, type ConnectionRef } from "./repository"

const PAGE_LIMIT = 200

interface Dependencies {
  pool: Pool
  bridgeClient: BridgeClient
  featureFlagService: FeatureFlagService
}

/** A connection seen from its partner end, with the fields a pull needs filled. */
interface ActivePartnerConnection {
  workspaceId: string
  connectionId: string
  hostWorkspaceId: string
  hostWorkspaceName: string
  rootStreamId: string
  partnerVisibility: NonNullable<StreamConnection["partnerVisibility"]>
  acceptedBy: string
}

/**
 * Copies a shared channel into a partner workspace: the channel and its
 * threads under the host's ids, then each stream's changes page by page. A
 * page and the cursor past it commit together, so a pull that dies resumes
 * where it stopped and a page applied twice writes nothing new. Bridge calls
 * run outside any transaction (INV-41); each write locks the connection row,
 * so it sees the connection still active and runs alone against it.
 */
export class StreamConnectionPullService {
  private readonly pool: Pool
  private readonly bridgeClient: BridgeClient
  private readonly featureFlagService: FeatureFlagService

  constructor(deps: Dependencies) {
    this.pool = deps.pool
    this.bridgeClient = deps.bridgeClient
    this.featureFlagService = deps.featureFlagService
  }

  /**
   * Syncs the whole shared tree, or only `options.streamId` of it. Returns
   * whether every stream it set out to sync reached the manifest head: false
   * when it stopped early because the connection is no longer active or
   * another pull moved a cursor first, or when the stream is not in the tree.
   */
  async pull(ref: ConnectionRef, options: { streamId?: string } = {}): Promise<boolean> {
    const flag = await this.featureFlagService.getWorkspaceFlag(ref.workspaceId, "streamConnections")
    if (flag !== "on") {
      logger.info({ ...ref }, "Skipped a shared channel pull: connections are off for the workspace")
      return false
    }
    const connection = toActivePartner(
      ref,
      await StreamConnectionRepository.findById(this.pool, ref.workspaceId, ref.connectionId)
    )
    if (!connection) {
      logger.info({ ...ref }, "Skipped a shared channel pull: the connection is not an active partner")
      return false
    }

    const address = bridgeAddress(connection)
    const manifest = await this.bridgeClient.getManifest(address)
    const [root] = manifest.streams
    if (!root || root.id !== connection.rootStreamId || root.parentStreamId !== null) {
      throw new Error(`Manifest of connection ${connection.connectionId} does not start at its shared channel`)
    }

    // The manifest lists every parent before its threads, so a thread's parent
    // copy and the message it hangs off are in place by the time it is reached.
    const streams = options.streamId
      ? manifest.streams.filter((stream) => stream.id === options.streamId)
      : manifest.streams
    if (streams.length === 0) return false
    for (const hostStream of streams) {
      const after = await this.locked(connection, (client) => ensureCopyStream(client, connection, hostStream))
      if (after === null) return false
      let cursor = after
      const head = BigInt(hostStream.head)
      while (cursor < head) {
        const page = await this.bridgeClient.listEvents(address, {
          streamId: hostStream.id,
          after: cursor,
          limit: PAGE_LIMIT,
        })
        const next = BigInt(page.cursor)
        if (next < cursor || (page.hasMore && next === cursor)) {
          throw new Error(`Bridge page of ${hostStream.id} moved its cursor from ${cursor} to ${next}`)
        }
        const applied = await this.locked(connection, (client) =>
          applyPage(client, connection, hostStream.id, cursor, page)
        )
        if (!applied) return false
        cursor = next
        if (!page.hasMore) break
      }
    }
    return true
  }

  /**
   * Runs one write with the connection locked, or returns null when the
   * connection stopped being active since the pull started.
   */
  private locked<T>(connection: ActivePartnerConnection, write: (client: PoolClient) => Promise<T>): Promise<T | null> {
    return withTransaction(this.pool, async (client) => {
      const current = await StreamConnectionRepository.findByIdForUpdate(
        client,
        connection.workspaceId,
        connection.connectionId
      )
      if (!toActivePartner(connection, current)) {
        logger.info({ ...connection }, "Stopped a shared channel pull: the connection is no longer active")
        return null
      }
      return write(client)
    })
  }
}

export function toActivePartner(
  ref: ConnectionRef,
  connection: StreamConnection | null
): ActivePartnerConnection | null {
  if (connection?.role !== "partner" || connection.state !== StreamConnectionStates.ACTIVE) return null
  const { remoteWorkspaceId, remoteWorkspaceName, partnerVisibility, acceptedBy } = connection
  if (!remoteWorkspaceId || !remoteWorkspaceName || !partnerVisibility || !acceptedBy) {
    throw new Error(`Active partner connection ${connection.id} is missing its host or acceptance`)
  }
  return {
    workspaceId: ref.workspaceId,
    connectionId: connection.id,
    hostWorkspaceId: remoteWorkspaceId,
    hostWorkspaceName: remoteWorkspaceName,
    rootStreamId: connection.streamId,
    partnerVisibility,
    acceptedBy,
  }
}

export function bridgeAddress(connection: ActivePartnerConnection): ConnectionAddress {
  return {
    workspaceId: connection.hostWorkspaceId,
    connectionId: connection.connectionId,
    callerWorkspaceId: connection.workspaceId,
  }
}

/**
 * Creates the copy of a host stream, or brings an existing copy's name,
 * description and archive state to the host's. Returns the cursor its changes
 * resume from. A stream id taken by anything other than this tree's copy is
 * refused.
 */
async function ensureCopyStream(
  client: PoolClient,
  connection: ActivePartnerConnection,
  host: BridgeStream
): Promise<bigint> {
  const { workspaceId } = connection
  const existing = await StreamRepository.findById(client, workspaceId, host.id)
  const copy = existing
    ? assertCopyOf(connection, existing, host.parentStreamId)
    : await insertCopyStream(client, connection, host)
  await syncCopyMetadata(client, copy, host)
  return StreamConnectionCursorRepository.findForStream(client, workspaceId, connection.connectionId, host.id)
}

function assertCopyOf(connection: ActivePartnerConnection, stream: Stream, parentStreamId: string | null): Stream {
  const isCopy =
    stream.originWorkspaceId === connection.hostWorkspaceId &&
    stream.parentStreamId === parentStreamId &&
    (stream.rootStreamId ?? stream.id) === connection.rootStreamId
  if (!isCopy) {
    throw new Error(
      `Stream ${stream.id} in ${connection.workspaceId} is not a copy in connection ${connection.connectionId}`
    )
  }
  return stream
}

async function insertCopyStream(
  client: PoolClient,
  connection: ActivePartnerConnection,
  host: BridgeStream
): Promise<Stream> {
  const { workspaceId } = connection
  let stream: Stream
  if (host.parentStreamId === null) {
    if (!host.slug) throw new Error(`Shared channel ${host.id} has no slug`)
    stream = await StreamRepository.insert(client, {
      id: host.id,
      workspaceId,
      type: StreamTypes.CHANNEL,
      slug: await copySlug(client, workspaceId, host.slug, null),
      ...hostDisplayName(host),
      ...hostDescription(host),
      visibility: connection.partnerVisibility,
      originWorkspaceId: connection.hostWorkspaceId,
      createdBy: connection.acceptedBy,
    })
    await StreamMemberRepository.insert(client, workspaceId, stream.id, connection.acceptedBy)
  } else {
    const parent = await StreamRepository.findById(client, workspaceId, host.parentStreamId)
    if (!parent || !host.parentAnchorId) {
      throw new Error(`Thread ${host.id} hangs off ${host.parentStreamId}, which has no copy`)
    }
    assertCopyOf(connection, parent, parent.parentStreamId)
    stream = await StreamRepository.insert(client, {
      id: host.id,
      workspaceId,
      type: StreamTypes.THREAD,
      parentStreamId: parent.id,
      parentAnchorId: host.parentAnchorId,
      rootStreamId: connection.rootStreamId,
      ...hostDisplayName(host),
      visibility: connection.partnerVisibility,
      originWorkspaceId: connection.hostWorkspaceId,
      createdBy: connection.acceptedBy,
    })
    await insertThreadLandmark(client, parent, stream)
  }
  await OutboxRepository.insert(client, "stream:created", { workspaceId, streamId: stream.id, stream })
  return stream
}

/**
 * The "in this stream" row a thread puts on its parent, as a local thread
 * does. A deleted anchor gets none: deleting a message drops the rows it
 * sources, on the host and on the copy alike.
 */
async function insertThreadLandmark(client: PoolClient, parent: Stream, thread: Stream): Promise<void> {
  const anchor = await MessageRepository.findById(client, parent.workspaceId, thread.parentAnchorId!)
  if (!anchor || anchor.streamId !== parent.id || anchor.deletedAt) return
  await StreamContextRepository.insertMany(client, [
    {
      id: streamContextItemId(),
      workspaceId: parent.workspaceId,
      streamId: parent.id,
      rootStreamId: parent.rootStreamId ?? parent.id,
      category: "thread",
      refKind: "thread",
      refId: thread.id,
      groupKey: thread.id,
      sourceMessageId: anchor.id,
      authorId: anchor.authorId,
      occurredAt: anchor.createdAt,
      sequence: anchor.sequence,
      snippet: contextSnippet(anchor.contentMarkdown),
      detail: {},
    },
  ])
}

/**
 * A copy takes the first free form of the host's slug, suffixed while a local
 * stream holds the plain one. Its own slug never counts as taken, so it keeps
 * its slug until the host renames or a freed form ranks ahead of it.
 */
function copySlug(client: PoolClient, workspaceId: string, hostSlug: string, copyId: string | null): Promise<string> {
  return generateUniqueSlug(hostSlug, (candidate) =>
    StreamRepository.slugExistsInWorkspace(client, workspaceId, candidate, copyId)
  )
}

async function syncCopyMetadata(client: PoolClient, copy: Stream, host: BridgeStream): Promise<void> {
  const { workspaceId } = copy
  const slug = host.slug && copy.slug ? await copySlug(client, workspaceId, host.slug, copy.id) : undefined
  const slugChanged = slug !== undefined && slug !== copy.slug
  const description = hostDescription(host)
  const descriptionChanged =
    copy.description !== description.description ||
    !isDeepStrictEqual(copy.descriptionJson ?? null, description.descriptionJson)
  const nameChanged = copy.displayName !== host.displayName

  if (slugChanged || descriptionChanged) {
    await StreamRepository.update(client, workspaceId, copy.id, {
      ...(slugChanged ? { slug } : {}),
      ...(descriptionChanged ? description : {}),
    })
  }
  if (nameChanged) {
    await StreamRepository.updateDisplayName(client, {
      workspaceId,
      streamId: copy.id,
      displayName: host.displayName,
      source: COPY_NAME_SOURCE,
    })
  }
  if (slugChanged || descriptionChanged || nameChanged) {
    const stream = await StreamRepository.findById(client, workspaceId, copy.id)
    await OutboxRepository.insert(client, "stream:updated", { workspaceId, streamId: copy.id, stream: stream! })
  }

  const archivedAt = host.archivedAt ? new Date(host.archivedAt) : null
  if ((copy.archivedAt !== null) !== (archivedAt !== null)) await setCopyArchived(client, copy, archivedAt)
}

/** A copy's name is the host's, never one this workspace generates. */
const COPY_NAME_SOURCE = TitleSources.EXPLICIT

function hostDisplayName(host: BridgeStream): Pick<InsertStreamParams, "displayName" | "displayNameSource"> {
  return host.displayName === null ? {} : { displayName: host.displayName, displayNameSource: COPY_NAME_SOURCE }
}

/** The description as this workspace stores it: the markdown is derived here from the JSON, never taken from the host (INV-58). */
function hostDescription(host: BridgeStream): NormalizedStreamDescription {
  if (!host.descriptionJson) return { description: null, descriptionJson: null }
  return normalizeStreamDescription({ descriptionJson: host.descriptionJson })!
}

/** Mirrors the host's archive flip, as the system: the partner does not know who archived it. */
async function setCopyArchived(client: PoolClient, copy: Stream, archivedAt: Date | null): Promise<void> {
  const stream = await StreamRepository.update(client, copy.workspaceId, copy.id, { archivedAt })
  if (!stream) throw new Error(`Copy ${copy.id} vanished while archiving`)
  const event = await StreamEventRepository.insert(client, {
    id: eventId(),
    workspaceId: stream.workspaceId,
    streamId: stream.id,
    eventType: archivedAt ? "stream_archived" : "stream_unarchived",
    payload: archivedAt ? { archivedAt: stream.archivedAt } : {},
    actorType: AuthorTypes.SYSTEM,
  })
  await OutboxRepository.insert(client, archivedAt ? "stream:archived" : "stream:unarchived", {
    workspaceId: stream.workspaceId,
    streamId: stream.id,
    stream,
    event,
    threadStreamIds: await StreamRepository.listArchivalCascadeIds(client, stream.workspaceId, stream.id),
  })
  if (stream.type === StreamTypes.THREAD) await publishThreadUpdated(client, stream, { includeReplyCount: false })
}

/**
 * Applies one page of a stream's changes and moves the cursor past it.
 * Returns false, writing nothing, when another pull already moved the cursor
 * since this page was asked for (INV-20).
 */
async function applyPage(
  client: PoolClient,
  connection: ActivePartnerConnection,
  streamId: string,
  after: bigint,
  page: BridgeEvents
): Promise<boolean> {
  const { workspaceId, connectionId } = connection
  const cursor = await StreamConnectionCursorRepository.findForStream(client, workspaceId, connectionId, streamId)
  if (cursor !== after) return false
  const stream = await StreamRepository.findById(client, workspaceId, streamId)
  if (!stream) throw new Error(`Copy ${streamId} is missing from ${workspaceId}`)

  await syncUserCopies(client, {
    workspaceId,
    originWorkspaceId: connection.hostWorkspaceId,
    originWorkspaceName: connection.hostWorkspaceName,
    users: page.users,
  })
  await syncActorCopies(client, {
    workspaceId,
    originWorkspaceId: connection.hostWorkspaceId,
    actors: page.actors,
  })
  const messages = page.changes.flatMap((change) => (change.kind === "message" ? [change.message] : []))
  const named = namedAuthors(messages)
  await assertUsersAreCopies(client, connection, messages, named.userIds)
  await assertActorsAreCopies(client, connection, named, page.actors)
  await applyCopyChanges(client, workspaceId, stream, page.changes, connectionId)
  await StreamConnectionCursorRepository.upsert(client, {
    workspaceId,
    connectionId,
    streamId,
    hostSequence: BigInt(page.cursor),
  })
  return true
}

/**
 * A user a page names as author or reactor must be a copy from the host or one
 * of this workspace's own users, never a copy from another workspace. An own
 * user wrote through the bridge, so the host holds a copy of them under the
 * same id and the page names them with no profile to copy. One with no row here
 * is a user the host no longer has, so the page names it with no profile to
 * copy, as the host shows it. A user id only ever authors as a user, so one
 * typed as a persona or bot is refused rather than passed on as that actor.
 */
async function assertUsersAreCopies(
  client: PoolClient,
  connection: ActivePartnerConnection,
  messages: BridgeMessage[],
  ids: Set<string>
): Promise<void> {
  const origins = await UserRepository.findOrigins(client, connection.workspaceId, [...ids])
  for (const id of ids) {
    const origin = origins.get(id)
    if (origin && origin !== connection.hostWorkspaceId) {
      throw new Error(`User ${id} in a page of connection ${connection.connectionId} is not a copy from its host`)
    }
  }
  for (const { authorId, authorType } of messages) {
    if (authorId.startsWith("usr_") && authorType !== AuthorTypes.USER) {
      throw new Error(`User ${authorId} in a page of connection ${connection.connectionId} is typed as a ${authorType}`)
    }
  }
}

/**
 * A persona or bot a page names as author, reactor or listed actor must be
 * unknown here or a copy from this host, never one of this workspace's own or
 * another host's copy. A built-in persona has a global id both sides resolve,
 * so it may author or react but is never listed as an actor to copy. Runs
 * after the copy upsert, so a listed actor another host's pull copied at the
 * same time is seen here rather than skipped by the upsert.
 */
async function assertActorsAreCopies(
  client: PoolClient,
  connection: ActivePartnerConnection,
  named: { personaIds: Set<string>; botIds: Set<string> },
  listed: BridgeActor[]
): Promise<void> {
  const personaIds = new Set(named.personaIds)
  const botIds = new Set(named.botIds)
  const listedIds = new Set(listed.map((actor) => actor.id))
  for (const id of listedIds) (id.startsWith("persona_") ? personaIds : botIds).add(id)

  const where = `in a page of connection ${connection.connectionId}`
  const personas = await PersonaRepository.findByIds(client, connection.workspaceId, [...personaIds])
  for (const persona of personas) {
    if (persona.workspaceId !== null) throw new Error(`Persona ${persona.id} ${where} is not a copy from its host`)
    if (listedIds.has(persona.id)) throw new Error(`Persona ${persona.id} ${where} is built in and cannot be copied`)
  }
  const [bot] = await BotRepository.findByIds(client, connection.workspaceId, [...botIds])
  if (bot) throw new Error(`Bot ${bot.id} ${where} is not a copy from its host`)
  const origins = await ActorCopyRepository.findOrigins(client, connection.workspaceId, [...personaIds, ...botIds])
  for (const [id, origin] of origins) {
    if (origin !== connection.hostWorkspaceId) throw new Error(`Actor ${id} ${where} is not a copy from its host`)
  }
}
