import type { Pool } from "pg"
import { serializeBigInt } from "@threahq/backend-common"
import {
  BRIDGE_PROFILES_MAX_IDS,
  StreamConnectionStates,
  type BridgeProfile,
  type StreamConnection,
} from "@threahq/types"
import { withTransaction, type Querier } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { JobQueues, QueueRepository, type StreamConnectionProfilesJobData } from "../../lib/queue"
import { logger } from "../../lib/logger"
import type { FeatureFlagService } from "../feature-flags"
import { UserRepository, userAvatarToken, type AvatarService, type CopyProfileUpdate, type User } from "../workspaces"
import type { BridgeClient } from "./bridge-client"
import { StreamConnectionRepository, type ConnectionRef } from "./repository"

/** Pokes that land in one window share a refresh, the same way pulls coalesce. */
const REFRESH_COALESCE_MS = 1_000

interface Dependencies {
  pool: Pool
  bridgeClient: BridgeClient
  featureFlagService: FeatureFlagService
  avatarService: AvatarService
}

/**
 * Keeps a workspace's copies of the other end's users named and pictured as
 * they are at home, between the messages that would otherwise carry a rename.
 * A copy's avatar files are copied into this workspace's own avatar keys, the
 * only ones its avatar URLs serve. Bridge and file calls run outside any
 * transaction (INV-41). The write keeps a copy only while its name and avatar
 * are the ones this refresh read, so a refresh that lost a race leaves the copy to the next.
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
    const remoteWorkspaceId = linkedRemoteWorkspaceId(
      await StreamConnectionRepository.findById(this.pool, ref.workspaceId, ref.connectionId)
    )
    if (!remoteWorkspaceId) return

    const copies = await UserRepository.listCopiesFrom(this.pool, ref.workspaceId, remoteWorkspaceId)
    const address = {
      workspaceId: remoteWorkspaceId,
      connectionId: ref.connectionId,
      callerWorkspaceId: ref.workspaceId,
    }
    const profiles = new Map<string, BridgeProfile>()
    for (let i = 0; i < copies.length; i += BRIDGE_PROFILES_MAX_IDS) {
      const ids = copies.slice(i, i + BRIDGE_PROFILES_MAX_IDS).map((copy) => copy.id)
      const page = await this.bridgeClient.getProfiles(address, ids)
      for (const profile of page.users) profiles.set(profile.id, profile)
    }

    const updates: CopyProfileUpdate[] = []
    for (const copy of copies) {
      const profile = profiles.get(copy.id)
      if (!profile) continue
      const avatarUrl = await this.copyAvatar(ref.workspaceId, remoteWorkspaceId, copy, profile.avatar).catch(
        (err: unknown) => {
          logger.warn({ err, ...ref, userId: copy.id }, "Kept a copy's avatar: copying the remote avatar failed")
          return copy.avatarUrl
        }
      )
      if (profile.name === copy.name && avatarUrl === copy.avatarUrl) continue
      updates.push({
        id: copy.id,
        name: profile.name,
        avatarUrl,
        observedName: copy.name,
        observedAvatarUrl: copy.avatarUrl,
      })
    }
    if (updates.length === 0) return

    const changed = await withTransaction(this.pool, async (client) => {
      const locked = await StreamConnectionRepository.findByIdForUpdate(client, ref.workspaceId, ref.connectionId)
      if (linkedRemoteWorkspaceId(locked) !== remoteWorkspaceId) {
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
    if (copy.avatarUrl && userAvatarToken(copy.avatarUrl) === remoteAvatar) return copy.avatarUrl
    const copied = await this.avatarService.copyUserAvatar({
      workspaceId,
      userId: copy.id,
      token: remoteAvatar,
      fetchFile: (file) => this.bridgeClient.getAvatarFile({ workspaceId: remoteWorkspaceId, userId: copy.id, file }),
    })
    return copied ?? copy.avatarUrl
  }
}

/**
 * The workspace at the other end of an active host or partner connection, else
 * null. The same predicate as `StreamConnectionRepository.listActiveLinkedConnections`.
 */
export function linkedRemoteWorkspaceId(connection: StreamConnection | null): string | null {
  if (!connection || (connection.role !== "host" && connection.role !== "partner")) return null
  if (connection.state !== StreamConnectionStates.ACTIVE) return null
  return connection.remoteWorkspaceId
}

/**
 * Queues a profile refresh of each connection, `delayMs` from now, folded into
 * that window's refresh when one is already queued.
 */
export async function enqueueProfileRefreshes(db: Querier, connections: ConnectionRef[], delayMs = 0): Promise<void> {
  const now = Date.now()
  const window = Math.floor((now + delayMs) / REFRESH_COALESCE_MS)
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
