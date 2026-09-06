import type { Pool } from "pg"
import { logger, type WorkosMembershipStatus } from "@threahq/backend-common"
import { WorkspaceRegistryRepository } from "../workspaces"
import type { RegionalClient } from "../../lib/regional-client"

export const OUTBOX_AUTHZ_MEMBERSHIP_CHANGED = "authz_membership_changed"
export const OUTBOX_AUTHZ_MEMBERSHIP_REMOVED = "authz_membership_removed"

// `Record<string, unknown>` index signatures let these payloads flow through
// `OutboxRepository.insert`'s generic constraint without a cast at every call site.
export interface AuthzMembershipChangedPayload extends Record<string, unknown> {
  workosOrganizationId: string
  workosUserId: string
  roleSlugs: string[]
  status: WorkosMembershipStatus
  /** ISO timestamp; deserialized to Date by the dispatcher. */
  lastEventAt: string
}

export interface AuthzMembershipRemovedPayload extends Record<string, unknown> {
  workosOrganizationId: string
  workosUserId: string
  /** ISO timestamp; deserialized to Date by the dispatcher. */
  eventCreatedAt: string
}

interface Dependencies {
  pool: Pool
  regionalClient: RegionalClient
  /** Memoize `workspace_registry` lookups for this many ms during burst drains. */
  workspaceLookupTtlMs?: number
}

type WorkspaceRow = { id: string; region: string }

interface CachedLookup {
  expiresAt: number
  rows: WorkspaceRow[]
}

function parseIsoTimestamp(value: string, fieldName: string): Date {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${fieldName}: ${value}`)
  }
  return parsed
}

export class RegionalAuthzFanOut {
  private pool: Pool
  private regionalClient: RegionalClient
  private readonly workspaceLookupTtlMs: number
  // Burst drains after backfill produce N outbox events for the same org in
  // quick succession; each one would otherwise hit `workspace_registry` for an
  // identical indexed read. A short TTL collapses those without changing
  // semantics — eventual consistency is fine since `workspace_user_permissions`
  // upserts are idempotent and last-event-wins.
  private readonly workspaceLookupCache = new Map<string, CachedLookup>()

  constructor({ pool, regionalClient, workspaceLookupTtlMs = 1_000 }: Dependencies) {
    this.pool = pool
    this.regionalClient = regionalClient
    this.workspaceLookupTtlMs = workspaceLookupTtlMs
  }

  async handleMembershipChanged(payload: AuthzMembershipChangedPayload): Promise<void> {
    const lastEventAt = parseIsoTimestamp(payload.lastEventAt, "lastEventAt")
    await this.dispatchToWorkspaces(payload.workosOrganizationId, "fan-out", async (ws) =>
      this.regionalClient.syncWorkspaceMembership(ws.region, {
        workspaceId: ws.id,
        workosUserId: payload.workosUserId,
        roleSlugs: payload.roleSlugs,
        status: payload.status,
        lastEventAt,
      })
    )
  }

  async handleMembershipRemoved(payload: AuthzMembershipRemovedPayload): Promise<void> {
    const eventCreatedAt = parseIsoTimestamp(payload.eventCreatedAt, "eventCreatedAt")
    await this.dispatchToWorkspaces(payload.workosOrganizationId, "removal fan-out", async (ws) =>
      this.regionalClient.removeWorkspaceMembership(ws.region, {
        workspaceId: ws.id,
        workosUserId: payload.workosUserId,
        eventCreatedAt,
      })
    )
  }

  private async dispatchToWorkspaces(
    workosOrganizationId: string,
    op: string,
    send: (ws: WorkspaceRow) => Promise<void>
  ): Promise<void> {
    const workspaces = await this.lookupWorkspaces(workosOrganizationId)
    if (workspaces.length === 0) return

    const results = await Promise.allSettled(workspaces.map((ws) => send(ws)))

    const errors: unknown[] = []
    results.forEach((result, idx) => {
      if (result.status === "rejected") {
        const ws = workspaces[idx]
        logger.error(
          { err: result.reason, region: ws.region, workspaceId: ws.id, workosOrganizationId },
          `Regional authz ${op} failed for workspace`
        )
        errors.push(result.reason)
      }
    })

    if (errors.length > 0) {
      throw new AggregateError(errors, `Regional authz ${op} failed for one or more workspaces`)
    }
  }

  private async lookupWorkspaces(workosOrganizationId: string): Promise<WorkspaceRow[]> {
    const now = Date.now()
    const cached = this.workspaceLookupCache.get(workosOrganizationId)
    if (cached && cached.expiresAt > now) {
      return cached.rows
    }
    // Sweep stale entries on every miss so a backfill burst (one distinct org id
    // per event) doesn't leave permanent residue in the Map for the lifetime
    // of the process. Bounded by the live org count, not the historical one.
    for (const [orgId, entry] of this.workspaceLookupCache) {
      if (entry.expiresAt <= now) this.workspaceLookupCache.delete(orgId)
    }
    const rows = await WorkspaceRegistryRepository.listByWorkosOrganizationId(this.pool, workosOrganizationId)
    this.workspaceLookupCache.set(workosOrganizationId, {
      rows,
      expiresAt: now + this.workspaceLookupTtlMs,
    })
    return rows
  }
}
