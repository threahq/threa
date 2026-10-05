import type { Pool } from "pg"
import { serializeBigInt } from "@threahq/backend-common"
import { StreamConnectionStates, type BridgeProfile, type StreamConnection } from "@threahq/types"
import { withTransaction, type Querier } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { JobQueues, QueueRepository, type StreamConnectionProfilesJobData } from "../../lib/queue"
import { logger } from "../../lib/logger"
import type { FeatureFlagService } from "../feature-flags"
import { AVATAR_SIZES, UserRepository, type AvatarService, type User } from "../workspaces"
import type { BridgeClient } from "./bridge-client"
import { StreamConnectionRepository, type ConnectionRef } from "./repository"

/** Pokes that land in one window share a refresh, the same way pulls coalesce. */
const REFRESH_COALESCE_MS = 1_000

/** Matches the most ids a profiles request takes. */
const PROFILES_PAGE_SIZE = 500

const AVATAR_KEY_PATTERN = /^avatars\/[^/]+\/[^/]+\/(\d+)$/

interface Dependencies {
  pool: Pool
  bridgeClient: BridgeClient
  featureFlagService: FeatureFlagService
  avatarService: AvatarService
}

/** An active host or partner connection, with the workspace at its other end. */
type LinkedConnection = StreamConnection & { remoteWorkspaceId: string }

/**
 * Keeps a workspace's copies of the other end's users named and pictured as
 * they are at home, between the messages that would otherwise carry a rename.
 * A copy's avatar files are copied into this workspace's own avatar keys, the
 * only ones its avatar URLs serve. Bridge and file calls run outside any
 * transaction (INV-41). The write keeps a copy only while its avatar is the one
 * this refresh read, so a refresh that lost a race leaves the copy to the next.
 */
export class StreamConnectionProfileService {
  private readonly pool: Pool
  private readonly bridgeClient: BridgeClient
  private readonly featureFlagService: FeatureFlagService
  private readonly avatarService: AvatarService

  constructor(deps: Dependencies) {
    this.pool = deps.pool
    this.bridgeClient = deps.bridgeClient
    this.featureFlagService = deps.featureFlagService
    this.avatarService = deps.avatarService
  }

  async refresh(ref: ConnectionRef): Promise<void> {
    const flag = await this.featureFlagService.getWorkspaceFlag(ref.workspaceId, "streamConnections")
    if (flag !== "on") return
    const connection = toLinked(await StreamConnectionRepository.findById(this.pool, ref.workspaceId, ref.connectionId))
    if (!connection) return
    const remoteWorkspaceId = connection.remoteWorkspaceId

    const copies = await UserRepository.listCopiesFrom(this.pool, ref.workspaceId, remoteWorkspaceId)
    const address = {
      workspaceId: remoteWorkspaceId,
      connectionId: ref.connectionId,
      callerWorkspaceId: ref.workspaceId,
    }
    const profiles = new Map<string, BridgeProfile>()
    for (let i = 0; i < copies.length; i += PROFILES_PAGE_SIZE) {
      const ids = copies.slice(i, i + PROFILES_PAGE_SIZE).map((copy) => copy.id)
      const page = await this.bridgeClient.getProfiles(address, ids)
      for (const profile of page.users) profiles.set(profile.id, profile)
    }

    const updates: { id: string; name: string; avatarUrl: string | null; observedAvatarUrl: string | null }[] = []
    for (const copy of copies) {
      const profile = profiles.get(copy.id)
      if (!profile) continue
      const avatarUrl = await this.copyAvatar(ref.workspaceId, remoteWorkspaceId, copy, profile.avatar)
      if (profile.name === copy.name && avatarUrl === copy.avatarUrl) continue
      updates.push({ id: copy.id, name: profile.name, avatarUrl, observedAvatarUrl: copy.avatarUrl })
    }
    if (updates.length === 0) return

    const changed = await withTransaction(this.pool, async (client) => {
      const locked = toLinked(
        await StreamConnectionRepository.findByIdForUpdate(client, ref.workspaceId, ref.connectionId)
      )
      if (locked?.remoteWorkspaceId !== remoteWorkspaceId) {
        logger.info({ ...ref }, "Stopped a profile refresh: the connection is no longer active")
        return []
      }
      const users = await UserRepository.updateCopyProfiles(client, ref.workspaceId, remoteWorkspaceId, updates)
      await OutboxRepository.insertMany(
        client,
        users.map((user) => ({
          eventType: "workspace_user:updated" as const,
          payload: { workspaceId: ref.workspaceId, user: serializeBigInt(user) },
        }))
      )
      return users
    })

    const applied = new Set(changed.map((user) => user.id))
    for (const update of updates) {
      if (applied.has(update.id) && update.observedAvatarUrl && update.observedAvatarUrl !== update.avatarUrl) {
        await this.avatarService.deleteAvatarFiles(update.observedAvatarUrl)
      }
    }
  }

  /**
   * The avatar key the copy should hold for the remote's current avatar,
   * copying the files here first. Files the remote no longer has (replaced
   * again since it answered) keep the copy's current avatar for the next refresh.
   */
  private async copyAvatar(
    workspaceId: string,
    remoteWorkspaceId: string,
    copy: User,
    remoteAvatar: string | null
  ): Promise<string | null> {
    if (remoteAvatar === null) return null
    if (copy.avatarUrl && avatarToken(copy.avatarUrl) === remoteAvatar) return copy.avatarUrl
    const files = await Promise.all(
      AVATAR_SIZES.map((size) =>
        this.bridgeClient.getAvatarFile({
          workspaceId: remoteWorkspaceId,
          userId: copy.id,
          file: `${remoteAvatar}.${size}.webp`,
        })
      )
    )
    const images = new Map<number, Buffer>()
    for (const [i, size] of AVATAR_SIZES.entries()) {
      const file = files[i]
      if (!file) return copy.avatarUrl
      images.set(size, file)
    }
    const basePath = `avatars/${workspaceId}/${copy.id}/${remoteAvatar}`
    await this.avatarService.uploadImages(basePath, images)
    return basePath
  }
}

/** The upload timestamp an avatar key ends in, which names its files. */
export function avatarToken(avatarUrl: string): string {
  const match = AVATAR_KEY_PATTERN.exec(avatarUrl)
  if (!match) throw new Error(`Avatar key ${avatarUrl} is not a user avatar key`)
  return match[1]
}

/** The connection when it is an active host or partner end. */
export function toLinked(connection: StreamConnection | null): LinkedConnection | null {
  if (!connection || (connection.role !== "host" && connection.role !== "partner")) return null
  if (connection.state !== StreamConnectionStates.ACTIVE || !connection.remoteWorkspaceId) return null
  return { ...connection, remoteWorkspaceId: connection.remoteWorkspaceId }
}

/** Queues a profile refresh of each connection, folded into the current window's refresh when one is already queued. */
export async function enqueueProfileRefreshes(db: Querier, connections: ConnectionRef[]): Promise<void> {
  const now = Date.now()
  const window = Math.floor(now / REFRESH_COALESCE_MS)
  const processAfter = new Date((window + 1) * REFRESH_COALESCE_MS)
  await QueueRepository.batchInsert(
    db,
    connections.map(({ workspaceId, connectionId }) => {
      const payload: StreamConnectionProfilesJobData = { workspaceId, connectionId }
      return {
        id: `scprof_${workspaceId}_${connectionId}_${window}`,
        queueName: JobQueues.STREAM_CONNECTION_PROFILES,
        workspaceId,
        payload,
        processAfter,
        insertedAt: new Date(now),
      }
    })
  )
}
