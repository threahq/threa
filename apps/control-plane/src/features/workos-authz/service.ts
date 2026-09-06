import type { Pool } from "pg"
import { logger, OutboxRepository, withTransaction, type WorkosMembershipEvent } from "@threahq/backend-common"
import { WorkosAuthzRepository } from "./repository"
import {
  OUTBOX_AUTHZ_MEMBERSHIP_CHANGED,
  OUTBOX_AUTHZ_MEMBERSHIP_REMOVED,
  type AuthzMembershipChangedPayload,
  type AuthzMembershipRemovedPayload,
} from "./fan-out"

interface Dependencies {
  pool: Pool
}

/**
 * Apply WorkOS membership events to the local mirror and emit outbox events
 * for regional fan-out (INV-6, INV-7). The mirror upsert and the outbox insert
 * commit together — if the upsert is rejected by the timestamp guard, no
 * fan-out event is emitted.
 */
export class WorkosAuthzService {
  private pool: Pool

  constructor({ pool }: Dependencies) {
    this.pool = pool
  }

  async processEvent(event: WorkosMembershipEvent): Promise<void> {
    const { membership } = event
    switch (event.type) {
      case "organization_membership.created":
      case "organization_membership.updated": {
        const updated = await withTransaction(this.pool, async (client) => {
          const row = await WorkosAuthzRepository.upsertMembershipFromEvent(client, {
            organizationMembershipId: membership.id,
            workosOrganizationId: membership.organizationId,
            workosUserId: membership.userId,
            status: membership.status,
            roleSlugs: membership.roleSlugs,
            eventId: event.id,
            eventCreatedAt: event.createdAt,
          })
          if (!row) return null

          const payload: AuthzMembershipChangedPayload = {
            workosOrganizationId: membership.organizationId,
            workosUserId: membership.userId,
            roleSlugs: membership.roleSlugs,
            status: membership.status,
            lastEventAt: event.createdAt.toISOString(),
          }
          await OutboxRepository.insert(client, OUTBOX_AUTHZ_MEMBERSHIP_CHANGED, payload)
          return row
        })

        if (!updated) {
          logger.debug(
            {
              eventId: event.id,
              eventType: event.type,
              organizationId: membership.organizationId,
              userId: membership.userId,
            },
            "WorkOS authz event ignored as stale"
          )
        }
        return
      }
      case "organization_membership.deleted": {
        await withTransaction(this.pool, async (client) => {
          const removed = await WorkosAuthzRepository.deleteMembership(client, {
            workosOrganizationId: membership.organizationId,
            workosUserId: membership.userId,
            eventCreatedAt: event.createdAt,
          })
          if (!removed) return

          const payload: AuthzMembershipRemovedPayload = {
            workosOrganizationId: membership.organizationId,
            workosUserId: membership.userId,
            eventCreatedAt: event.createdAt.toISOString(),
          }
          await OutboxRepository.insert(client, OUTBOX_AUTHZ_MEMBERSHIP_REMOVED, payload)
        })
        return
      }
    }
  }
}
