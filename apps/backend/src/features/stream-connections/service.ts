import type { Pool } from "pg"
import {
  StreamConnectionErrorCodes,
  StreamTypes,
  type CreateStreamConnectionInviteResponse,
  type StreamConnection,
  type StreamConnectionSnapshot,
  type Visibility,
} from "@threahq/types"
import { HttpError, StreamNotFoundError } from "../../lib/errors"
import type { ControlPlaneClient } from "../../lib/control-plane-client"
import type { FeatureFlagService } from "../feature-flags"
import { checkStreamAccess, type Stream } from "../streams"
import { StreamConnectionRepository } from "./repository"

interface Dependencies {
  pool: Pool
  controlPlaneClient: ControlPlaneClient | null
  featureFlagService: FeatureFlagService
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
    if (stream.type !== StreamTypes.CHANNEL || stream.archivedAt || stream.e2eEnabled) {
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
      invitedByUserId: params.userId,
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

  async accept(params: {
    workspaceId: string
    userId: string
    token: string
    visibility: Visibility
  }): Promise<StreamConnection> {
    await this.assertEnabled(params.workspaceId)
    const snapshot = await this.requireControlPlane().acceptStreamConnection({
      token: params.token,
      partnerWorkspaceId: params.workspaceId,
      acceptedByUserId: params.userId,
      visibility: params.visibility,
    })
    await this.applySnapshot(snapshot)
    return this.readBack(params.workspaceId, snapshot.id)
  }

  async listForStream(params: { workspaceId: string; streamId: string; userId: string }): Promise<StreamConnection[]> {
    await this.assertEnabled(params.workspaceId)
    await this.requireStream(params)
    return StreamConnectionRepository.listLiveForStream(this.pool, params.workspaceId, params.streamId)
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

  private async assertEnabled(workspaceId: string): Promise<void> {
    if ((await this.featureFlagService.getWorkspaceFlag(workspaceId, "streamConnections")) !== "on") {
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
