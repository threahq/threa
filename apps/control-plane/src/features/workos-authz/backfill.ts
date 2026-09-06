import type { Pool } from "pg"
import { logger, OutboxRepository, withTransaction, type WorkosOrgService } from "@threahq/backend-common"
import { WorkspaceRegistryRepository } from "../workspaces"
import { WorkosAuthzRepository } from "./repository"
import {
  OUTBOX_AUTHZ_MEMBERSHIP_CHANGED,
  OUTBOX_AUTHZ_MEMBERSHIP_REMOVED,
  type AuthzMembershipChangedPayload,
  type AuthzMembershipRemovedPayload,
} from "./fan-out"
import type { WorkosEventPollerLock } from "../../lib/workos-event-poller-lock"

interface Dependencies {
  pool: Pool
  workosOrgService: WorkosOrgService
  /** Optional — when provided, backfill stamps `last_backfill_at` after a successful run. */
  lock?: WorkosEventPollerLock
}

export interface WorkosAuthzBackfillResult {
  orgsScanned: number
  membershipsUpserted: number
  membershipsRemoved: number
}

export interface WorkosAuthzOrganizationBackfillResult {
  membershipsUpserted: number
  membershipsRemoved: number
  /**
   * Outbox event ids emitted by this run (BigInt serialised as decimal string
   * so the value crosses the wire safely). Empty when both `membershipsUpserted`
   * and `membershipsRemoved` are zero. The backoffice "Re-sync members" flow
   * polls these via the outbox-events status endpoint to surface fan-out
   * progress to the operator.
   */
  outboxEventIds: string[]
}

/**
 * Read every workspace with a non-null `workos_organization_id`, ask WorkOS
 * for its full membership list, and upsert each row via the backfill path.
 *
 * Backfill is idempotent and re-runnable. It does NOT touch the poller's
 * `last_event_id` cursor: the regular event poller has its own timestamp
 * guard so a stale event replay can't clobber freshly backfilled state.
 */
export class WorkosAuthzBackfill {
  private pool: Pool
  private workosOrgService: WorkosOrgService
  private lock?: WorkosEventPollerLock

  constructor({ pool, workosOrgService, lock }: Dependencies) {
    this.pool = pool
    this.workosOrgService = workosOrgService
    this.lock = lock
  }

  async run(): Promise<WorkosAuthzBackfillResult> {
    const orgIds = await WorkspaceRegistryRepository.listWorkosOrganizationIds(this.pool)

    let membershipsUpserted = 0
    let membershipsRemoved = 0
    let hadErrors = false
    for (const orgId of orgIds) {
      try {
        const result = await this.runForOrganizationInternal(orgId)
        membershipsUpserted += result.membershipsUpserted
        membershipsRemoved += result.membershipsRemoved
      } catch (err) {
        hadErrors = true
        logger.error({ err, organizationId: orgId }, "Failed to backfill WorkOS memberships for organization")
      }
    }
    // `run()` doesn't propagate per-org outbox ids — operator-facing progress
    // is only useful for `runForOrganization()`. Full backfill drains via the
    // poller logs, not a UI banner.

    // Only stamp last_backfill_at on a fully successful run — otherwise the
    // first-boot guard in server.ts would suppress retry of failed orgs.
    if (!hadErrors && this.lock) {
      await this.lock.stampBackfill()
    }

    logger.info(
      { orgsScanned: orgIds.length, membershipsUpserted, membershipsRemoved, hadErrors },
      "WorkOS authz backfill complete"
    )
    return { orgsScanned: orgIds.length, membershipsUpserted, membershipsRemoved }
  }

  /**
   * Re-run the backfill for a single WorkOS organization. Exposed for operator
   * triggers (backoffice "Re-sync members" button) where waiting for the next
   * event-poller tick isn't acceptable — e.g. when the regional mirror has
   * drifted and a PAT is failing with `OWNER_INACTIVE`.
   *
   * Does NOT stamp `last_backfill_at`: a per-org refresh isn't equivalent to a
   * full backfill and should not unblock the first-boot guard for other orgs.
   */
  async runForOrganization(workosOrganizationId: string): Promise<WorkosAuthzOrganizationBackfillResult> {
    const result = await this.runForOrganizationInternal(workosOrganizationId)
    logger.info(
      {
        organizationId: workosOrganizationId,
        membershipsUpserted: result.membershipsUpserted,
        membershipsRemoved: result.membershipsRemoved,
        outboxEventCount: result.outboxEventIds.length,
      },
      "WorkOS authz per-organization backfill complete"
    )
    return result
  }

  private async runForOrganizationInternal(orgId: string): Promise<WorkosAuthzOrganizationBackfillResult> {
    // Stamp once per org before reading, so any membership event WorkOS
    // observes after this snapshot wins the timestamp guard on upsert and
    // survives the reconcile delete below.
    const observedAt = new Date()
    const memberships = await this.workosOrgService.listOrganizationMemberships(orgId)
    const { reconciled, outboxEventIds } = await withTransaction(this.pool, async (client) => {
      for (const m of memberships) {
        await WorkosAuthzRepository.upsertMembershipFromBackfill(client, {
          organizationMembershipId: m.id,
          workosOrganizationId: m.organizationId,
          workosUserId: m.userId,
          status: m.status,
          roleSlugs: m.roleSlugs,
          observedAt,
        })
      }
      // Reconcile inside the same tx so the regional fan-out for missing
      // members is committed atomically with the upsert events above.
      const removedRows = await WorkosAuthzRepository.reconcileOrganizationSnapshotReturning(client, {
        workosOrganizationId: orgId,
        snapshotMembershipIds: memberships.map((m) => m.id),
        observedAt,
      })

      const observedAtIso = observedAt.toISOString()
      type AuthzOutboxEntry =
        | { eventType: typeof OUTBOX_AUTHZ_MEMBERSHIP_CHANGED; payload: AuthzMembershipChangedPayload }
        | { eventType: typeof OUTBOX_AUTHZ_MEMBERSHIP_REMOVED; payload: AuthzMembershipRemovedPayload }
      const outboxEntries: AuthzOutboxEntry[] = [
        ...memberships.map(
          (m): AuthzOutboxEntry => ({
            eventType: OUTBOX_AUTHZ_MEMBERSHIP_CHANGED,
            payload: {
              workosOrganizationId: m.organizationId,
              workosUserId: m.userId,
              roleSlugs: m.roleSlugs,
              status: m.status,
              lastEventAt: observedAtIso,
            },
          })
        ),
        ...removedRows.map(
          (removed): AuthzOutboxEntry => ({
            eventType: OUTBOX_AUTHZ_MEMBERSHIP_REMOVED,
            payload: {
              workosOrganizationId: removed.workos_organization_id,
              workosUserId: removed.workos_user_id,
              eventCreatedAt: observedAtIso,
            },
          })
        ),
      ]
      const inserted = await OutboxRepository.insertMany(client, outboxEntries)
      return {
        reconciled: removedRows.length,
        outboxEventIds: inserted.map((e) => e.id.toString()),
      }
    })
    return {
      membershipsUpserted: memberships.length,
      membershipsRemoved: reconciled,
      outboxEventIds,
    }
  }
}
