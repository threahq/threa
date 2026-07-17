import { describe, it, expect, mock } from "bun:test"
import type { Pool } from "pg"
import { GithubRouteSyncHandler } from "./route-sync-outbox-handler"
import type { ControlPlaneClient } from "../../lib/control-plane-client"
import type { OutboxEvent, OutboxEventType } from "../../lib/outbox"

const fakeDb = {} as unknown as Pool

function event<T extends OutboxEventType>(eventType: T, payload: Record<string, unknown>): OutboxEvent<T> {
  return { id: 1n, eventType, payload, createdAt: new Date() } as unknown as OutboxEvent<T>
}

function fakeControlPlaneClient() {
  return {
    registerIntegrationRoute: mock(async () => {}),
    unregisterIntegrationRoute: mock(async () => {}),
  } as unknown as ControlPlaneClient & {
    registerIntegrationRoute: ReturnType<typeof mock>
    unregisterIntegrationRoute: ReturnType<typeof mock>
  }
}

/** processEvent is protected; the handler dispatches on it per outbox event. */
function processEvent(handler: GithubRouteSyncHandler, evt: OutboxEvent): Promise<void> {
  return (handler as unknown as { processEvent(e: OutboxEvent): Promise<void> }).processEvent(evt)
}

describe("GithubRouteSyncHandler", () => {
  it("registers the route from a github_route:register event", async () => {
    const client = fakeControlPlaneClient()
    const handler = new GithubRouteSyncHandler(fakeDb, client)

    await processEvent(
      handler,
      event("github_route:register", { workspaceId: "ws_1", installationId: "42", region: "eu-north-1" })
    )

    expect(client.registerIntegrationRoute).toHaveBeenCalledWith({
      provider: "github",
      externalId: "42",
      region: "eu-north-1",
      workspaceId: "ws_1",
    })
    expect(client.unregisterIntegrationRoute).not.toHaveBeenCalled()
  })

  it("unregisters the route from a github_route:unregister event", async () => {
    const client = fakeControlPlaneClient()
    const handler = new GithubRouteSyncHandler(fakeDb, client)

    await processEvent(
      handler,
      event("github_route:unregister", { workspaceId: "ws_1", installationId: "42", region: "eu-north-1" })
    )

    expect(client.unregisterIntegrationRoute).toHaveBeenCalledWith({
      provider: "github",
      externalId: "42",
      workspaceId: "ws_1",
    })
    expect(client.registerIntegrationRoute).not.toHaveBeenCalled()
  })

  it("ignores unrelated event types", async () => {
    const client = fakeControlPlaneClient()
    const handler = new GithubRouteSyncHandler(fakeDb, client)

    await processEvent(handler, event("link_preview:ready", { workspaceId: "ws_1" }))

    expect(client.registerIntegrationRoute).not.toHaveBeenCalled()
    expect(client.unregisterIntegrationRoute).not.toHaveBeenCalled()
  })

  it("no-ops when no control-plane client is configured", async () => {
    const handler = new GithubRouteSyncHandler(fakeDb, null)

    // Must not throw — local dev has no control plane (and no events are emitted).
    await processEvent(
      handler,
      event("github_route:register", { workspaceId: "ws_1", installationId: "42", region: "eu-north-1" })
    )
  })
})
