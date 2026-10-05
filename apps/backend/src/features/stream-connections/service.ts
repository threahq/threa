import type { Pool, PoolClient } from "pg"
import {
  StreamConnectionErrorCodes,
  StreamConnectionStates,
  StreamTypes,
  Visibilities,
  WORKSPACE_PERMISSION_SCOPES,
  permissionsForRole,
  type ConnectedWorkspace,
  type CreateStreamConnectionInviteResponse,
  type StreamConnection,
  type StreamConnectionChannel,
  type StreamConnectionSnapshot,
  type Visibility,
  type WorkspaceRoleSlug,
} from "@threahq/types"
import { withTransaction } from "../../db"
import { HttpError, StreamNotFoundError } from "../../lib/errors"
import { logger } from "../../lib/logger"
import { OutboxRepository } from "../../lib/outbox"
import type { ControlPlaneClient } from "../../lib/control-plane-client"
import type { FeatureFlagService } from "../feature-flags"
import { StreamMemberRepository, StreamRepository, checkStreamAccess, type Stream } from "../streams"
import { WorkspaceUserPermissionsRepository } from "../workspace-authz"
import { UserRepository, WorkspaceRepository } from "../workspaces"
import { connectionNotFound } from "./errors"
import { enqueuePulls } from "./import"
import { StreamConnectionRepository, type AppliedStreamConnection } from "./repository"

interface Dependencies {
  pool: Pool
  controlPlaneClient: ControlPlaneClient | null
  featureFlagService: FeatureFlagService
}

function isAdmin(role: WorkspaceRoleSlug): boolean {
  return permissionsForRole(role).includes(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
}

function isShareable(stream: Stream): boolean {
  return stream.type === StreamTypes.CHANNEL && !stream.archivedAt && !stream.e2eEnabled
}

/**
 * Regional side of Threa Connect. The control plane owns every connection;
 * this service asks it to change state and projects the snapshots it returns.
 */
export class StreamConnectionService {
  private pool: Pool
  private controlPlaneClient: ControlPlaneClient | null
  private featureFlagService: FeatureFlagService

  constructor({ pool, controlPlaneClient, featureFlagService }: Dependencies) {
    this.pool = pool
    this.controlPlaneClient = controlPlaneClient
    this.featureFlagService = featureFlagService
  }

  async createInvite(params: {
    workspaceId: string
    streamId: string
    userId: string
  }): Promise<CreateStreamConnectionInviteResponse> {
    await this.assertEnabled(params.workspaceId)
    await this.requireAdmin(params)
    const cp = this.requireControlPlane()
    const stream = await this.requireStream(params)
    if (!isShareable(stream)) {
      throw new HttpError("Only active, unencrypted channels can be shared", {
        status: 400,
        code: StreamConnectionErrorCodes.NOT_SHAREABLE,
      })
    }

    const result = await cp.createStreamConnectionInvite({
      hostWorkspaceId: params.workspaceId,
      hostStreamId: stream.id,
      invitedBy: params.userId,
    })
    await this.applySnapshot(result.snapshot)
    return { connection: await this.readBack(params.workspaceId, result.snapshot.id), token: result.token }
  }

  async revokeInvite(params: { workspaceId: string; connectionId: string; userId: string }): Promise<StreamConnection> {
    await this.assertEnabled(params.workspaceId)
    await this.requireAdmin(params)
    const cp = this.requireControlPlane()
    const connection = await StreamConnectionRepository.findById(this.pool, params.workspaceId, params.connectionId)
    if (!connection || connection.role !== "host") throw connectionNotFound()
    await this.requireStream({ ...params, streamId: connection.streamId })

    const snapshot = await cp.revokeStreamConnectionInvite({
      connectionId: params.connectionId,
      hostWorkspaceId: params.workspaceId,
    })
    await this.applySnapshot(snapshot)
    return this.readBack(params.workspaceId, snapshot.id)
  }

  async assertCanAccept(params: { workspaceId: string; userId: string }): Promise<void> {
    await this.assertEnabled(params.workspaceId)
    await this.requireAdmin(params)
    this.requireControlPlane()
  }

  async accept(params: {
    workspaceId: string
    userId: string
    token: string
    visibility: Visibility
  }): Promise<StreamConnection> {
    await this.assertCanAccept(params)
    const snapshot = await this.requireControlPlane().acceptStreamConnection({
      token: params.token,
      partnerWorkspaceId: params.workspaceId,
      visibility: params.visibility,
      acceptedBy: params.userId,
    })
    await this.applySnapshot(snapshot)
    return this.readBack(params.workspaceId, snapshot.id)
  }

  async listForStream(params: { workspaceId: string; streamId: string; userId: string }): Promise<StreamConnection[]> {
    await this.assertEnabled(params.workspaceId)
    await this.requireAdmin(params)
    await this.requireStream(params)
    const connections = await StreamConnectionRepository.listLiveForStream(
      this.pool,
      params.workspaceId,
      params.streamId
    )
    // Changes made in another region reach this one only through the control
    // plane's outbox, which gives up after a few retries. Re-reading heals it,
    // including rows this region shows that the control plane has since moved
    // on. While the control plane is down the local rows are still the best answer.
    const controlPlane = this.requireControlPlane()
    let snapshots: StreamConnectionSnapshot[]
    try {
      snapshots = await controlPlane.listStreamConnections({
        workspaceId: params.workspaceId,
        streamId: params.streamId,
        includeIds: connections.map((c) => c.id),
      })
    } catch (err) {
      if (!(err instanceof HttpError && err.code === "CONTROL_PLANE_UNAVAILABLE")) throw err
      logger.warn(
        { err, workspaceId: params.workspaceId, streamId: params.streamId },
        "Stream connection read-repair skipped: control plane unavailable"
      )
      return connections
    }
    await this.project(snapshots)
    return StreamConnectionRepository.listLiveForStream(this.pool, params.workspaceId, params.streamId)
  }

  async listConnectedWorkspaces(params: { workspaceId: string; stream: Stream }): Promise<ConnectedWorkspace[]> {
    return StreamConnectionRepository.listConnectedWorkspaces(
      this.pool,
      params.workspaceId,
      params.stream.rootStreamId ?? params.stream.id
    )
  }

  /**
   * The control plane keeps no copy of the channel, so it asks here before an
   * accept and to name the channel on the invite page.
   */
  async describeChannel(params: {
    workspaceId: string
    streamId: string
    invitedBy: string
  }): Promise<StreamConnectionChannel> {
    if (!(await WorkspaceRepository.findById(this.pool, params.workspaceId))) {
      throw new HttpError("This workspace does not live in this region", { status: 404, code: "WORKSPACE_NOT_FOUND" })
    }
    const stream = await StreamRepository.findById(this.pool, params.workspaceId, params.streamId)
    if (!stream) return { shareable: false, slug: null, displayName: null }
    return {
      shareable:
        isShareable(stream) && (await this.isEnabled(params.workspaceId)) && (await this.inviterMayShare(params)),
      slug: stream.slug,
      displayName: stream.displayName,
    }
  }

  /** A link carries its creator's authority, so it lapses once they stop being an admin who can read the channel. */
  private async inviterMayShare(params: {
    workspaceId: string
    streamId: string
    invitedBy: string
  }): Promise<boolean> {
    if (!(await this.isCurrentAdmin(params.workspaceId, params.invitedBy))) return false
    return (await checkStreamAccess(this.pool, params.streamId, params.workspaceId, params.invitedBy)) !== null
  }

  /**
   * The route gate trusts the session's permission claim, which lags a
   * demotion. A connection hands the channel to another tenant, so every action
   * also checks the member's current role here.
   */
  private async requireAdmin(params: { workspaceId: string; userId: string }): Promise<void> {
    if (!(await this.isCurrentAdmin(params.workspaceId, params.userId))) {
      throw new HttpError("Insufficient permissions", { status: 403, code: "FORBIDDEN" })
    }
  }

  private async isCurrentAdmin(workspaceId: string, userId: string): Promise<boolean> {
    const user = await UserRepository.findById(this.pool, workspaceId, userId)
    if (!user?.workosUserId || !isAdmin(user.role)) return false
    const membership = await WorkspaceUserPermissionsRepository.getByWorkspaceAndUser(
      this.pool,
      workspaceId,
      user.workosUserId
    )
    if (membership) return membership.status === "active"
    // No row: either WorkOS doesn't mirror this workspace (dev, pre-mirror) and
    // users.role is the only role there is, or the membership isn't mirrored yet
    // (invite accepted, poll pending). The second is refused until the poll
    // lands, since an accepted link replicates the channel to another org.
    return !(await WorkspaceUserPermissionsRepository.existsForWorkspace(this.pool, workspaceId))
  }

  /** Projects a control-plane snapshot. Safe to repeat and to receive out of order. */
  async applySnapshot(snapshot: StreamConnectionSnapshot): Promise<void> {
    if ((await this.project([snapshot])) === 0) {
      throw new HttpError("No workspace of this connection lives in this region", {
        status: 404,
        code: "WORKSPACE_NOT_FOUND",
      })
    }
  }

  /**
   * Writes the snapshots, an event for each row they changed, and a pull of
   * each active partner row they changed, in one transaction: a partner that
   * just accepted reads the channel's history without waiting for the host to
   * post. Returns the local row count.
   */
  private async project(snapshots: StreamConnectionSnapshot[]): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const { localRows, changed } = await StreamConnectionRepository.applySnapshots(client, snapshots)
      await this.publishChanges(client, changed)
      await enqueuePulls(
        client,
        changed
          .filter(
            ({ connection }) => connection.role === "partner" && connection.state === StreamConnectionStates.ACTIVE
          )
          .map(({ workspaceId, connection }) => ({ workspaceId, connectionId: connection.id }))
      )
      return localRows
    })
  }

  /**
   * Only the host's rows have a Connect tab to update: partner and peer rows
   * carry the host's stream id, which names no stream in their workspace.
   */
  private async publishChanges(client: PoolClient, changed: AppliedStreamConnection[]): Promise<void> {
    const hostRows = changed.filter(({ connection }) => connection.role === "host")
    const streamIdsByWorkspace = new Map<string, Set<string>>()
    for (const { workspaceId, connection } of hostRows) {
      const ids = streamIdsByWorkspace.get(workspaceId) ?? new Set<string>()
      streamIdsByWorkspace.set(workspaceId, ids.add(connection.streamId))
    }

    const audiences = new Map<string, { visibility: Visibility; adminMemberUserIds: string[] }>()
    for (const [workspaceId, ids] of streamIdsByWorkspace) {
      const streams = await StreamRepository.findByIds(client, workspaceId, [...ids])
      const privateIds = streams.filter((s) => s.visibility === Visibilities.PRIVATE).map((s) => s.id)
      const members =
        privateIds.length > 0 ? await StreamMemberRepository.list(client, workspaceId, { streamIds: privateIds }) : []
      const users = await UserRepository.findByIds(client, workspaceId, [...new Set(members.map((m) => m.memberId))])
      const adminIds = new Set(users.filter((user) => isAdmin(user.role)).map((user) => user.id))
      for (const stream of streams) {
        audiences.set(`${workspaceId}/${stream.id}`, {
          visibility: stream.visibility,
          adminMemberUserIds: members
            .filter((m) => m.streamId === stream.id && adminIds.has(m.memberId))
            .map((m) => m.memberId),
        })
      }
    }

    const entries = hostRows.flatMap(({ workspaceId, connection }) => {
      const audience = audiences.get(`${workspaceId}/${connection.streamId}`)
      if (!audience) return []
      // A private channel with no admin among its members has no Connect tab open to update.
      if (audience.visibility === Visibilities.PRIVATE && audience.adminMemberUserIds.length === 0) return []
      return [
        {
          eventType: "stream_connection:updated" as const,
          payload: {
            workspaceId,
            streamId: connection.streamId,
            streamVisibility: audience.visibility,
            adminMemberUserIds: audience.adminMemberUserIds,
            connection,
          },
        },
      ]
    })
    if (entries.length > 0) await OutboxRepository.insertMany(client, entries)
  }

  /** The caller's projected row, which may be newer than the snapshot just applied. */
  private async readBack(workspaceId: string, connectionId: string): Promise<StreamConnection> {
    const connection = await StreamConnectionRepository.findById(this.pool, workspaceId, connectionId)
    if (!connection) throw new Error(`Stream connection ${connectionId} has no projection for ${workspaceId}`)
    return connection
  }

  private async isEnabled(workspaceId: string): Promise<boolean> {
    return (await this.featureFlagService.getWorkspaceFlag(workspaceId, "streamConnections")) === "on"
  }

  private async assertEnabled(workspaceId: string): Promise<void> {
    if (!(await this.isEnabled(workspaceId))) {
      throw new HttpError("Shared channels are not enabled for this workspace", {
        status: 404,
        code: StreamConnectionErrorCodes.DISABLED,
      })
    }
  }

  private async requireStream(params: { workspaceId: string; streamId: string; userId: string }): Promise<Stream> {
    const stream = await checkStreamAccess(this.pool, params.streamId, params.workspaceId, params.userId)
    if (!stream) throw new StreamNotFoundError()
    return stream
  }

  private requireControlPlane(): ControlPlaneClient {
    if (!this.controlPlaneClient) {
      throw new HttpError("Control plane is not configured for this regional backend", {
        status: 503,
        code: "CONTROL_PLANE_UNAVAILABLE",
      })
    }
    return this.controlPlaneClient
  }
}
