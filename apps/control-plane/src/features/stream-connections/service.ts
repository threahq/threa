import { createHash, randomBytes } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import { HttpError, OutboxRepository, logger, streamConnectionId, withTransaction } from "@threahq/backend-common"
import {
  StreamConnectionErrorCodes,
  StreamConnectionStates,
  type StreamConnectionChannel,
  type StreamConnectionLookupResponse,
  type StreamConnectionSnapshot,
  type StreamConnectionState,
  type Visibility,
} from "@threahq/types"
import { StreamConnectionRepository } from "./repository"
import { WorkspaceRegistryRepository } from "../workspaces"
import { RegionUnavailableError, type RegionalClient } from "../../lib/regional-client"

export const OUTBOX_STREAM_CONNECTION_SYNC = "stream_connection_sync"

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Carries only the id; the handler re-reads current state, so replays are idempotent. */
export interface StreamConnectionSyncPayload extends Record<string, unknown> {
  connectionId: string
}

export interface CreateInviteParams {
  hostWorkspaceId: string
  hostStreamId: string
  invitedBy: string
}

export interface CreateInviteResult {
  snapshot: StreamConnectionSnapshot
  token: string
}

export interface AcceptParams {
  token: string
  partnerWorkspaceId: string
  visibility: Visibility
  acceptedBy: string
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

function alreadyConnected(): HttpError {
  return new HttpError("Workspace is already in this channel", {
    status: 409,
    code: StreamConnectionErrorCodes.ALREADY_CONNECTED,
  })
}

function notShareable(): HttpError {
  return new HttpError("Channel can no longer be shared", {
    status: 409,
    code: StreamConnectionErrorCodes.NOT_SHAREABLE,
  })
}

function alreadyAccepted(): HttpError {
  return new HttpError("Invite already accepted", { status: 409, code: StreamConnectionErrorCodes.ALREADY_ACCEPTED })
}

function hostRegionUnavailable(): HttpError {
  return new HttpError("The channel's region didn't answer", {
    status: 503,
    code: StreamConnectionErrorCodes.HOST_REGION_UNAVAILABLE,
  })
}

/**
 * Why the workspace can't accept this invite, or null when it can. An active
 * invite already accepted by the same workspace is a retry, not a refusal.
 * Checked before asking the host's region and again under the lock, so both
 * give the same answer.
 */
function refusalFor(
  invite: { state: StreamConnectionState; expiresAt: Date; hostWorkspaceId: string; partnerWorkspaceId: string | null },
  partnerWorkspaceId: string
): HttpError | null {
  if (invite.state === StreamConnectionStates.ACTIVE) {
    return invite.partnerWorkspaceId === partnerWorkspaceId ? null : alreadyAccepted()
  }
  if (invite.state === StreamConnectionStates.REVOKED) return revoked()
  if (invite.expiresAt <= new Date()) return expired()
  if (invite.hostWorkspaceId === partnerWorkspaceId) return alreadyConnected()
  return null
}

function lookupBase(snapshot: StreamConnectionSnapshot, channel: StreamConnectionChannel) {
  return {
    hostWorkspaceId: snapshot.hostWorkspaceId,
    hostWorkspaceName: snapshot.hostWorkspaceName,
    hostRegion: snapshot.hostRegion,
    streamDisplayName: channel.displayName,
    streamSlug: channel.slug,
  }
}

/** Source of truth for shared channels. Every state change bumps the revision and fans out a snapshot. */
export class StreamConnectionService {
  private pool: Pool
  private regionalClient: RegionalClient

  constructor({ pool, regionalClient }: Dependencies) {
    this.pool = pool
    this.regionalClient = regionalClient
  }

  /** Mints an invite link for a channel. Each link admits one workspace, and a channel can have several pending. */
  async createInvite(params: CreateInviteParams): Promise<CreateInviteResult> {
    const host = await WorkspaceRegistryRepository.findById(this.pool, params.hostWorkspaceId)
    if (!host) {
      throw new HttpError("Workspace not found", { status: 404, code: "NOT_FOUND" })
    }

    const id = streamConnectionId()
    const token = randomBytes(32).toString("base64url")
    await withTransaction(this.pool, async (client) => {
      await StreamConnectionRepository.insert(client, {
        id,
        hostWorkspaceId: params.hostWorkspaceId,
        hostStreamId: params.hostStreamId,
        invitedBy: params.invitedBy,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      await this.enqueueSync(client, [id])
    })
    return { snapshot: await this.requireSnapshot(id), token }
  }

  /** Revokes a pending invite. Disconnecting an accepted share is a separate operation. */
  async revokeInvite(params: { connectionId: string; hostWorkspaceId: string }): Promise<StreamConnectionSnapshot> {
    await withTransaction(this.pool, async (client) => {
      const record = await StreamConnectionRepository.lockById(client, params.connectionId)
      if (!record || record.hostWorkspaceId !== params.hostWorkspaceId) throw notFound()
      if (record.state === StreamConnectionStates.ACTIVE) throw alreadyAccepted()
      if (record.state === StreamConnectionStates.INVITED) {
        await StreamConnectionRepository.revokeInvite(client, record.id)
        await this.enqueueSync(client, [record.id])
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

    const tokenHash = hashToken(params.token)
    const found = await StreamConnectionRepository.findSnapshotByTokenHash(this.pool, tokenHash)
    if (!found) throw notFound()
    const early = refusalFor({ ...found, expiresAt: new Date(found.expiresAt) }, params.partnerWorkspaceId)
    if (early) throw early
    // The host may have archived the channel or switched sharing off since the
    // link was minted. Asked before the transaction so no lock waits on the region.
    if (found.state === StreamConnectionStates.INVITED && !(await this.describeChannel(found)).shareable) {
      throw notShareable()
    }

    const connectionId = await withTransaction(this.pool, async (client) => {
      // Accepts into one channel take turns, so each sees every partner that
      // joined before it. Two running side by side would each miss the other,
      // and neither partner would learn the other is in the channel. The host
      // and stream never change on a row, so the unlocked read above names them.
      await StreamConnectionRepository.lockChannel(client, found.hostWorkspaceId, found.hostStreamId)
      const record = await StreamConnectionRepository.lockByTokenHash(client, tokenHash)
      if (!record) throw notFound()
      const refusal = refusalFor(record, params.partnerWorkspaceId)
      if (refusal) throw refusal
      if (record.state === StreamConnectionStates.ACTIVE) return record.id
      const partners = await StreamConnectionRepository.listPartners(
        client,
        record.hostWorkspaceId,
        record.hostStreamId
      )
      if (partners.some((p) => p.workspaceId === params.partnerWorkspaceId)) throw alreadyConnected()

      await StreamConnectionRepository.activate(client, {
        id: record.id,
        partnerWorkspaceId: params.partnerWorkspaceId,
        partnerVisibility: params.visibility,
        acceptedBy: params.acceptedBy,
      })
      // Every partner already in the channel gains a peer, so their connections fan out again too.
      const partnerConnectionIds = partners.map((p) => p.connectionId)
      await StreamConnectionRepository.bumpRevisions(client, partnerConnectionIds)
      await this.enqueueSync(client, [record.id, ...partnerConnectionIds])
      return record.id
    })
    return this.requireSnapshot(connectionId)
  }

  /**
   * A region re-reading the channel's connections it holds, to heal syncs the
   * outbox never delivered. `includeIds` names the rows it is about to show.
   */
  async listForWorkspace(params: {
    workspaceId: string
    streamId: string
    includeIds: string[]
  }): Promise<StreamConnectionSnapshot[]> {
    return StreamConnectionRepository.listSnapshotsForWorkspace(this.pool, params)
  }

  /** What the invite page shows. Never exposes who created the link. */
  async lookup(token: string, workosUserId: string): Promise<StreamConnectionLookupResponse> {
    const snapshot = await StreamConnectionRepository.findSnapshotByTokenHash(this.pool, hashToken(token))
    if (!snapshot) throw notFound()
    if (snapshot.state === StreamConnectionStates.REVOKED) throw revoked()

    if (snapshot.state === StreamConnectionStates.INVITED) {
      if (new Date(snapshot.expiresAt) <= new Date()) throw expired()
      const channel = await this.describeChannel(snapshot)
      if (!channel.shareable) throw notShareable()
      const partners = await StreamConnectionRepository.listPartners(
        this.pool,
        snapshot.hostWorkspaceId,
        snapshot.hostStreamId
      )
      return {
        ...lookupBase(snapshot, channel),
        state: snapshot.state,
        partnerWorkspaceId: null,
        partnerWorkspaceName: null,
        partners: partners.map(({ workspaceId, workspaceName }) => ({ workspaceId, workspaceName })),
      }
    }

    // A used link tells only the accepting workspace's members where the channel went.
    const { partnerWorkspaceId, partnerWorkspaceName } = snapshot
    if (
      partnerWorkspaceId === null ||
      partnerWorkspaceName === null ||
      !(await WorkspaceRegistryRepository.isMember(this.pool, partnerWorkspaceId, workosUserId))
    ) {
      throw alreadyAccepted()
    }
    return {
      ...lookupBase(snapshot, await this.describeChannel(snapshot)),
      state: snapshot.state,
      partnerWorkspaceId,
      partnerWorkspaceName,
    }
  }

  /**
   * Outbox handler: push the current snapshot, not event-time state, to the
   * region of every workspace that holds a row for it: host, partner and peers.
   * A region holding several of them gets it once and projects them all. Every
   * region is attempted before a failure is raised, so one region being down
   * doesn't hold back the others.
   */
  async syncToRegions(payload: StreamConnectionSyncPayload): Promise<void> {
    const snapshot = await StreamConnectionRepository.findSnapshot(this.pool, payload.connectionId)
    if (!snapshot) {
      logger.warn({ connectionId: payload.connectionId }, "Stream connection sync skipped: connection or host gone")
      return
    }
    const peers = await WorkspaceRegistryRepository.findByIds(this.pool, snapshot.peerWorkspaceIds)
    const regions = [
      ...new Set([snapshot.hostRegion, snapshot.partnerRegion, ...peers.map((peer) => peer.region)]),
    ].filter((region) => region !== null)
    const results = await Promise.allSettled(
      regions.map((region) => this.regionalClient.syncStreamConnection(region, snapshot))
    )
    const failures = results.flatMap((result, i) =>
      result.status === "rejected" ? [{ region: regions[i], reason: result.reason as unknown }] : []
    )
    if (failures.length > 0) {
      // The outbox keeps only the message on a dead letter, so it names each failed region.
      const detail = failures
        .map(({ region, reason }) => `${region}: ${reason instanceof Error ? reason.message : String(reason)}`)
        .join("; ")
      throw new AggregateError(
        failures.map((f) => f.reason),
        `Stream connection sync failed (${detail})`
      )
    }
  }

  private async describeChannel(snapshot: StreamConnectionSnapshot): Promise<StreamConnectionChannel> {
    try {
      return await this.regionalClient.describeStreamConnectionChannel(snapshot.hostRegion, {
        workspaceId: snapshot.hostWorkspaceId,
        streamId: snapshot.hostStreamId,
      })
    } catch (err) {
      if (!(err instanceof RegionUnavailableError)) throw err
      logger.warn(
        { err, connectionId: snapshot.id, region: snapshot.hostRegion },
        "Stream connection channel lookup failed"
      )
      throw hostRegionUnavailable()
    }
  }

  private async enqueueSync(client: PoolClient, connectionIds: string[]): Promise<void> {
    await OutboxRepository.insertMany(
      client,
      connectionIds.map((connectionId) => ({
        eventType: OUTBOX_STREAM_CONNECTION_SYNC,
        payload: { connectionId } satisfies StreamConnectionSyncPayload,
      }))
    )
  }

  private async requireSnapshot(id: string): Promise<StreamConnectionSnapshot> {
    const snapshot = await StreamConnectionRepository.findSnapshot(this.pool, id)
    if (!snapshot) throw notFound()
    return snapshot
  }
}
