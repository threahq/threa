import type { Querier } from "../../db"
import { listGuestViewers } from "../../features/workspaces"
import { resolveDeliveryGroups, userGroup } from "./delivery-groups"
import { isOneOfOutboxEventType, isOutboxEventType, type OutboxEvent } from "./repository"

export interface EventAudience {
  event: OutboxEvent
  /** `null` for bot-scoped events, which ride the bot namespace instead of client groups. */
  groups: string[] | null
}

function personOf(event: OutboxEvent): { workspaceId: string; userId: string } | null {
  if (isOneOfOutboxEventType(event, ["workspace_user:added", "workspace_user:updated"])) {
    return { workspaceId: event.payload.workspaceId, userId: event.payload.user.id }
  }
  if (isOutboxEventType(event, "workspace_user:removed")) {
    return { workspaceId: event.payload.workspaceId, userId: event.payload.removedUserId }
  }
  return null
}

/**
 * Each event's delivery groups, in input order. The people directory goes to browsers, but a guest
 * still sees the members and authors of the streams they read; which guests is read here, one query
 * per workspace, not carried in the payload, which every recipient receives and the sync log stores.
 */
export async function resolveAudiences(db: Querier, events: readonly OutboxEvent[]): Promise<EventAudience[]> {
  const audiences: EventAudience[] = []
  const peopleByWorkspace = new Map<string, Array<{ audience: EventAudience; groups: string[]; userId: string }>>()
  for (const event of events) {
    const groups = resolveDeliveryGroups(event)
    const audience = { event, groups }
    audiences.push(audience)
    const person = groups === null ? null : personOf(event)
    if (groups === null || person === null) continue
    const people = peopleByWorkspace.get(person.workspaceId) ?? []
    people.push({ audience, groups, userId: person.userId })
    peopleByWorkspace.set(person.workspaceId, people)
  }

  for (const [workspaceId, people] of peopleByWorkspace) {
    const guests = await listGuestViewers(db, workspaceId, [...new Set(people.map((person) => person.userId))])
    for (const { audience, groups, userId } of people) {
      audience.groups = [...groups, ...(guests.get(userId) ?? []).map(userGroup)]
    }
  }
  return audiences
}
