import type { Pool } from "pg"
import { StreamConnectionStates } from "@threahq/types"
import { JobQueues, QueueRepository, type StreamConnectionPullJobData } from "../../lib/queue"
import type { FeatureFlagService } from "../feature-flags"
import { connectionNotFound } from "./errors"
import { StreamConnectionRepository, type ConnectionRef } from "./repository"

/**
 * Pokes that land in one window share a pull, which runs once the window has
 * closed and so reads every change a poke in it announced.
 */
const PULL_COALESCE_MS = 1_000

interface Dependencies {
  pool: Pool
  featureFlagService: FeatureFlagService
}

/** Brings a shared channel's changes from the host's region into a partner workspace of this region. */
export class StreamConnectionImportService {
  private readonly pool: Pool
  private readonly featureFlagService: FeatureFlagService

  constructor(deps: Dependencies) {
    this.pool = deps.pool
    this.featureFlagService = deps.featureFlagService
  }

  /** A host's poke: queues a pull of the connection, if the caller is the host it names. */
  async requestPull(params: { workspaceId: string; connectionId: string; callerWorkspaceId: string }): Promise<void> {
    const flag = await this.featureFlagService.getWorkspaceFlag(params.workspaceId, "streamConnections")
    if (flag !== "on") throw connectionNotFound()
    const connection = await StreamConnectionRepository.findById(this.pool, params.workspaceId, params.connectionId)
    const pullable =
      connection?.role === "partner" &&
      connection.state === StreamConnectionStates.ACTIVE &&
      connection.remoteWorkspaceId === params.callerWorkspaceId
    if (!pullable) throw connectionNotFound()
    await enqueuePulls(this.pool, [{ workspaceId: params.workspaceId, connectionId: params.connectionId }])
  }

  /** The sweep: queues a pull of every active connection, so a lost poke delays a change rather than dropping it. */
  async enqueueAllPulls(): Promise<void> {
    await enqueuePulls(this.pool, await StreamConnectionRepository.listActivePartnerConnections(this.pool))
  }
}

async function enqueuePulls(pool: Pool, connections: ConnectionRef[]): Promise<void> {
  const now = Date.now()
  const window = Math.floor(now / PULL_COALESCE_MS)
  const processAfter = new Date((window + 1) * PULL_COALESCE_MS)
  await QueueRepository.batchInsert(
    pool,
    connections.map(({ workspaceId, connectionId }) => {
      const payload: StreamConnectionPullJobData = { workspaceId, connectionId }
      return {
        id: `scpull_${workspaceId}_${connectionId}_${window}`,
        queueName: JobQueues.STREAM_CONNECTION_PULL,
        workspaceId,
        payload,
        processAfter,
        insertedAt: new Date(now),
      }
    })
  )
}
