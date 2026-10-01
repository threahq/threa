import { createHash, randomBytes } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import {
  HttpError,
  OutboxRepository,
  isUniqueViolation,
  logger,
  streamConnectionId,
  withTransaction,
} from "@threahq/backend-common"
import {
  STREAM_CONNECTION_INVITE_TTL_MS,
  StreamConnectionErrorCodes,
  StreamConnectionStates,
  type StreamConnectionLookupResponse,
  type StreamConnectionSnapshot,
  type Visibility,
} from "@threahq/types"
import { StreamConnectionRepository } from "./repository"
import { WorkspaceRegistryRepository } from "../workspaces"
import type { RegionalClient } from "../../lib/regional-client"

export const OUTBOX_STREAM_CONNECTION_SYNC = "stream_connection_sync"

/** Carries only the id; the handler re-reads current state, so replays are idempotent. */
export interface StreamConnectionSyncPayload extends Record<string, unknown> {
  connectionId: string
}

export interface CreateInviteParams {
  hostWorkspaceId: string
  hostStreamId: string
  hostStreamSlug: string | null
  hostStreamDisplayName: string | null
  invitedByUserId: string
}

export interface CreateInviteResult {
  snapshot: StreamConnectionSnapshot
  token: string
  superseded: StreamConnectionSnapshot | null
}

export interface AcceptParams {
  token: string
  partnerWorkspaceId: string
  acceptedByUserId: string
  visibility: Visibility
}

interface Dependencies {
  pool: Pool
  regionalClient: RegionalClient
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function notFound(): HttpError {
  return new HttpError("Connection not found", { status: 404, code: StreamConnectionErrorCodes.NOT_FOUND })
}

function revoked(): HttpError {
  return new HttpError("Invite revoked", { status: 409, code: StreamConnectionErrorCodes.REVOKED })
}

function expired(): HttpError {
  return new HttpError("Invite expired", { status: 409, code: StreamConnectionErrorCodes.EXPIRED })
}

function alreadyShared(): HttpError {
  return new HttpError("Channel already shared", { status: 409, code: StreamConnectionErrorCodes.ALREADY_SHARED })
}

function alreadyAccepted(): HttpError {
  return new HttpError("Invite already accepted", { status: 409, code: StreamConnectionErrorCodes.ALREADY_ACCEPTED })
}

/** Source of truth for shared channels. Every state change bumps the revision and fans out a snapshot. */
export class StreamConnectionService {
  private pool: Pool
  private regionalClient: RegionalClient

  constructor({ pool, regionalClient }: Dependencies) {
    this.pool = pool
    this.regionalClient = regionalClient
  }

  /**
   * Mints a new invite link for a channel. A pending invite for the same channel
   * is revoked in the same transaction, so only the newest link works. The
   * revoked one comes back as `superseded` so the caller's region can project
   * both at once instead of waiting for the outbox.
   */
  async createInvite(params: CreateInviteParams): Promise<CreateInviteResult> {
    const host = await WorkspaceRegistryRepository.findById(this.pool, params.hostWorkspaceId)
    if (!host) {
      throw new HttpError("Workspace not found", { status: 404, code: "NOT_FOUND" })
    }

    const id = streamConnectionId()
    const token = randomBytes(32).toString("base64url")
    const supersededId = await withTransaction(this.pool, async (client) => {
      const live = await StreamConnectionRepository.lockLiveForStream(
        client,
        params.hostWorkspaceId,
        params.hostStreamId
      )
      if (live?.state === StreamConnectionStates.ACTIVE) throw alreadyShared()
      if (live) {
        await StreamConnectionRepository.revokeInvite(client, live.id)
        await this.enqueueSync(client, live.id)
      }
      await StreamConnectionRepository.insert(client, {
        id,
        hostWorkspaceId: params.hostWorkspaceId,
        hostStreamId: params.hostStreamId,
        hostStreamSlug: params.hostStreamSlug,
        hostStreamDisplayName: params.hostStreamDisplayName,
        tokenHash: hashToken(token),
        invitedByUserId: params.invitedByUserId,
        expiresAt: new Date(Date.now() + STREAM_CONNECTION_INVITE_TTL_MS),
      })
      await this.enqueueSync(client, id)
      return live?.id ?? null
    }).catch((error: unknown) => {
      // A concurrent create for the same channel committed first.
      if (isUniqueViolation(error, "stream_connections_live_per_stream")) throw alreadyShared()
      throw error
    })

    return {
      snapshot: await this.requireSnapshot(id),
      token,
      superseded: supersededId ? await this.requireSnapshot(supersededId) : null,
    }
  }

  /** Revokes a pending invite. Disconnecting an accepted share is a separate operation. */
  async revokeInvite(params: { connectionId: string; hostWorkspaceId: string }): Promise<StreamConnectionSnapshot> {
    await withTransaction(this.pool, async (client) => {
      const record = await StreamConnectionRepository.lockById(client, params.connectionId)
      if (!record || record.hostWorkspaceId !== params.hostWorkspaceId) throw notFound()
      if (record.state === StreamConnectionStates.ACTIVE) throw alreadyAccepted()
      if (record.state === StreamConnectionStates.INVITED) {
        await StreamConnectionRepository.revokeInvite(client, record.id)
        await this.enqueueSync(client, record.id)
      }
    })
    return this.requireSnapshot(params.connectionId)
  }

  /**
   * Activates the invite for the partner workspace. The partner's region has
   * already checked the caller is an admin there. A retry from the same partner
   * returns the current state, so a lost response is safe to repeat.
   */
  async accept(params: AcceptParams): Promise<StreamConnectionSnapshot> {
    const partner = await WorkspaceRegistryRepository.findById(this.pool, params.partnerWorkspaceId)
    if (!partner) {
      throw new HttpError("Workspace not found", { status: 404, code: "NOT_FOUND" })
    }

    const connectionId = await withTransaction(this.pool, async (client) => {
      const record = await StreamConnectionRepository.lockByTokenHash(client, hashToken(params.token))
      if (!record) throw notFound()
      if (record.state === StreamConnectionStates.ACTIVE) {
        if (record.partnerWorkspaceId === params.partnerWorkspaceId) return record.id
        throw alreadyAccepted()
      }
      if (record.state === StreamConnectionStates.REVOKED) throw revoked()
      if (record.expiresAt <= new Date()) throw expired()
      if (record.hostWorkspaceId === params.partnerWorkspaceId) {
        throw new HttpError("A channel can't be shared with its own workspace", {
          status: 400,
          code: StreamConnectionErrorCodes.SAME_WORKSPACE,
        })
      }

      await StreamConnectionRepository.activate(client, {
        id: record.id,
        partnerWorkspaceId: params.partnerWorkspaceId,
        partnerVisibility: params.visibility,
        acceptedByUserId: params.acceptedByUserId,
      })
      await this.enqueueSync(client, record.id)
      return record.id
    })
    return this.requireSnapshot(connectionId)
  }

  /** What the invite page shows. Never exposes who created the link. */
  async lookup(token: string): Promise<StreamConnectionLookupResponse> {
    const snapshot = await StreamConnectionRepository.findSnapshotByTokenHash(this.pool, hashToken(token))
    if (!snapshot) throw notFound()
    if (snapshot.state === StreamConnectionStates.REVOKED) throw revoked()
    if (snapshot.state === StreamConnectionStates.INVITED && new Date(snapshot.expiresAt) <= new Date()) {
      throw expired()
    }
    return {
      connectionId: snapshot.id,
      state: snapshot.state,
      hostWorkspaceId: snapshot.hostWorkspaceId,
      hostWorkspaceName: snapshot.hostWorkspaceName,
      hostRegion: snapshot.hostRegion,
      streamDisplayName: snapshot.hostStreamDisplayName,
      streamSlug: snapshot.hostStreamSlug,
      partnerWorkspaceId: snapshot.partnerWorkspaceId,
      partnerWorkspaceName: snapshot.partnerWorkspaceName,
      expiresAt: snapshot.expiresAt,
    }
  }

  /**
   * Outbox handler: push the current snapshot, not event-time state, to each
   * side's region. One region holding both sides gets it once and projects both.
   */
  async syncToRegions(payload: StreamConnectionSyncPayload): Promise<void> {
    const snapshot = await StreamConnectionRepository.findSnapshot(this.pool, payload.connectionId)
    if (!snapshot) {
      logger.warn({ connectionId: payload.connectionId }, "Stream connection sync skipped: connection or host gone")
      return
    }
    const regions = new Set([snapshot.hostRegion])
    if (snapshot.partnerRegion) regions.add(snapshot.partnerRegion)
    for (const region of regions) {
      await this.regionalClient.syncStreamConnection(region, snapshot)
    }
  }

  private async enqueueSync(client: PoolClient, connectionId: string): Promise<void> {
    await OutboxRepository.insert(client, OUTBOX_STREAM_CONNECTION_SYNC, {
      connectionId,
    } satisfies StreamConnectionSyncPayload)
  }

  private async requireSnapshot(id: string): Promise<StreamConnectionSnapshot> {
    const snapshot = await StreamConnectionRepository.findSnapshot(this.pool, id)
    if (!snapshot) throw notFound()
    return snapshot
  }
}
