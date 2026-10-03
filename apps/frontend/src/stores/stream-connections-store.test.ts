import { beforeEach, describe, expect, it } from "vitest"
import type { StreamConnection } from "@threahq/types"
import { db, type CachedStreamConnection } from "@/db"
import { seedStreamConnections } from "./stream-connections-store"

function connection(id: string, overrides: Partial<StreamConnection> = {}): StreamConnection {
  return {
    id,
    role: "host",
    state: "invited",
    revision: 1,
    streamId: "stream_1",
    remoteWorkspaceId: null,
    remoteWorkspaceName: null,
    partnerVisibility: null,
    invitedBy: "user_1",
    acceptedBy: null,
    expiresAt: "2026-10-08T00:00:00.000Z",
    ...overrides,
  }
}

function cached(id: string, cachedAt: number, overrides: Partial<CachedStreamConnection> = {}): CachedStreamConnection {
  return { ...connection(id), workspaceId: "ws_1", _cachedAt: cachedAt, ...overrides }
}

describe("seedStreamConnections", () => {
  beforeEach(async () => {
    await db.streamConnections.clear()
  })

  it("should drop rows the fetch left out unless written after it started, and never roll a row back", async () => {
    const startedAt = Date.now()
    await db.streamConnections.bulkPut([
      cached("strconn_revoked_elsewhere", startedAt - 1),
      cached("strconn_created_mid_fetch", startedAt + 1),
      cached("strconn_accepted_mid_fetch", startedAt + 1, { state: "active", revision: 2 }),
      cached("strconn_other_stream", startedAt - 1, { streamId: "stream_2" }),
      cached("strconn_other_workspace", startedAt - 1, { workspaceId: "ws_2" }),
    ])

    await seedStreamConnections(
      "ws_1",
      "stream_1",
      [connection("strconn_accepted_mid_fetch"), connection("strconn_unseen", { state: "active", revision: 2 })],
      startedAt
    )

    const rows = await db.streamConnections.toArray()
    expect(
      rows
        .map((row) => ({ workspaceId: row.workspaceId, id: row.id, state: row.state, revision: row.revision }))
        .sort((a, b) => a.id.localeCompare(b.id))
    ).toEqual([
      { workspaceId: "ws_1", id: "strconn_accepted_mid_fetch", state: "active", revision: 2 },
      { workspaceId: "ws_1", id: "strconn_created_mid_fetch", state: "invited", revision: 1 },
      { workspaceId: "ws_1", id: "strconn_other_stream", state: "invited", revision: 1 },
      { workspaceId: "ws_2", id: "strconn_other_workspace", state: "invited", revision: 1 },
      { workspaceId: "ws_1", id: "strconn_unseen", state: "active", revision: 2 },
    ])
  })
})
