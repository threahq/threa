import type { Pool } from "pg"
import {
  StreamConnectionErrorCodes,
  StreamConnectionStates,
  StreamTypes,
  type CreateStreamConnectionInviteResponse,
  type StreamConnection,
  type StreamConnectionSnapshot,
  type Visibility,
} from "@threahq/types"
import { HttpError, StreamNotFoundError } from "../../lib/errors"
import type { ControlPlaneClient } from "../../lib/control-plane-client"
import type { FeatureFlagService } from "../feature-flags"
import { StreamRepository, checkStreamAccess, type Stream } from "../streams"
import { WorkspaceRepository } from "../workspaces"
import { StreamConnectionRepository } from "./repository"

interface Dependencies {
  pool: Pool
  controlPlaneClient: ControlPlaneClient | null
  featureFlagService: FeatureFlagService
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
      hostStreamSlug: stream.slug,
      hostStreamDisplayName: stream.displayName,
    })
    if (result.superseded) await this.applySnapshot(result.superseded)
    await this.applySnapshot(result.snapshot)
    return { connection: await this.readBack(params.workspaceId, result.snapshot.id), token: result.token }
  }

  async revokeInvite(params: { workspaceId: string; connectionId: string }): Promise<StreamConnection> {
    await this.assertEnabled(params.workspaceId)
    const snapshot = await this.requireControlPlane().revokeStreamConnectionInvite({
      connectionId: params.connectionId,
      hostWorkspaceId: params.workspaceId,
    })
    await this.applySnapshot(snapshot)
    return this.readBack(params.workspaceId, snapshot.id)
  }

  async assertCanAccept(workspaceId: string): Promise<void> {
    await this.assertEnabled(workspaceId)
    this.requireControlPlane()
  }

  async accept(params: { workspaceId: string; token: string; visibility: Visibility }): Promise<StreamConnection> {
    await this.assertCanAccept(params.workspaceId)
    const snapshot = await this.requireControlPlane().acceptStreamConnection({
      token: params.token,
      partnerWorkspaceId: params.workspaceId,
      visibility: params.visibility,
    })
    await this.applySnapshot(snapshot)
    return this.readBack(params.workspaceId, snapshot.id)
  }

  async listForStream(params: { workspaceId: string; streamId: string; userId: string }): Promise<StreamConnection[]> {
    await this.assertEnabled(params.workspaceId)
    await this.requireStream(params)
    const connections = await StreamConnectionRepository.listLiveForStream(
      this.pool,
      params.workspaceId,
      params.streamId
    )
    const pending = connections.find((c) => c.state === StreamConnectionStates.INVITED)
    if (!pending) return connections
    // An accept from another region reaches this one only through the control
    // plane's outbox, which gives up after a few retries. Re-reading heals it.
    const snapshot = await this.requireControlPlane().getStreamConnection({
      connectionId: pending.id,
      workspaceId: params.workspaceId,
    })
    await this.applySnapshot(snapshot)
    return StreamConnectionRepository.listLiveForStream(this.pool, params.workspaceId, params.streamId)
  }

  /** The control plane asks before an accept, since the channel may have changed since the link was minted. */
  async isStreamShareable(params: { workspaceId: string; streamId: string }): Promise<boolean> {
    if (!(await WorkspaceRepository.findById(this.pool, params.workspaceId))) {
      throw new HttpError("This workspace does not live in this region", { status: 404, code: "WORKSPACE_NOT_FOUND" })
    }
    if (!(await this.isEnabled(params.workspaceId))) return false
    const stream = await StreamRepository.findByIdForWorkspace(this.pool, params.streamId, params.workspaceId)
    return stream !== null && isShareable(stream)
  }

  /** Projects a control-plane snapshot. Safe to repeat and to receive out of order. */
  async applySnapshot(snapshot: StreamConnectionSnapshot): Promise<void> {
    const localSides = await StreamConnectionRepository.applySnapshot(this.pool, snapshot)
    if (localSides === 0) {
      throw new HttpError("Neither workspace of this connection lives in this region", {
        status: 404,
        code: "WORKSPACE_NOT_FOUND",
      })
    }
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
