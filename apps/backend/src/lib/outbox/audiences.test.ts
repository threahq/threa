import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Querier } from "../../db"
import * as workspacesModule from "../../features/workspaces"
import { resolveAudiences } from "./audiences"
import type { OutboxEvent } from "./repository"

function makeEvent(id: bigint, eventType: string, payload: Record<string, unknown>): OutboxEvent {
  return { id, eventType, payload, createdAt: new Date() } as unknown as OutboxEvent
}

describe("resolveAudiences", () => {
  afterEach(() => {
    mock.restore()
  })

  it("should read each workspace's guests once for its distinct people and keep input order", async () => {
    const guestsSpy = spyOn(workspacesModule, "listGuestViewers").mockImplementation(async (_db, workspaceId) =>
      workspaceId === "ws_1" ? new Map([["usr_a", ["usr_g1"]]]) : new Map([["usr_b", ["usr_g2"]]])
    )
    const events = [
      makeEvent(1n, "workspace_user:updated", { workspaceId: "ws_1", user: { id: "usr_a" } }),
      makeEvent(2n, "bot_invocation:available", { workspaceId: "ws_1", botId: "bot_1", invocationId: "inv_1" }),
      makeEvent(3n, "workspace_user:removed", { workspaceId: "ws_2", removedUserId: "usr_b" }),
      makeEvent(4n, "workspace_user:added", { workspaceId: "ws_1", user: { id: "usr_a" } }),
    ]

    const audiences = await resolveAudiences({} as Querier, events)

    expect({
      queries: guestsSpy.mock.calls.map((call) => call.slice(1)),
      audiences: audiences.map((audience) => [audience.event.id, audience.groups]),
    }).toEqual({
      queries: [
        ["ws_1", ["usr_a"]],
        ["ws_2", ["usr_b"]],
      ],
      audiences: [
        [1n, ["permission:workspace:browse", "user:usr_a", "user:usr_g1"]],
        [2n, null],
        [3n, ["permission:workspace:browse", "user:usr_b", "user:usr_g2"]],
        [4n, ["permission:workspace:browse", "user:usr_a", "user:usr_g1"]],
      ],
    })
  })
})
