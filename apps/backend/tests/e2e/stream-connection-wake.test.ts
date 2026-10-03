import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { INTERNAL_API_KEY_HEADER, streamConnectionId } from "@threahq/backend-common"
import { BRIDGE_WORKSPACE_HEADER, type StreamConnectionSnapshot } from "@threahq/types"
import { JobQueues } from "../../src/lib/queue"
import { workspaceId } from "../../src/lib/id"
import { TestClient, createChannel, createThread, createWorkspace, loginAs, sendMessage } from "../client"
import { getTestDatabaseTarget } from "../test-database"

const testRunId = Math.random().toString(36).substring(7)
const BRIDGE_KEY = "test-bridge-key"

describe("Stream connection wake", () => {
  let pool: Pool
  let n = 0

  beforeAll(() => {
    pool = new Pool({ connectionString: getTestDatabaseTarget().connectionUrl })
  })

  afterAll(async () => {
    await pool.end()
  })

  /** A host and a partner workspace, both in this region with Connect on, sharing one channel. */
  async function setup() {
    n++
    const hostClient = new TestClient()
    await loginAs(hostClient, `wake-host-${n}-${testRunId}@test.com`, "Host Admin")
    const host = await createWorkspace(hostClient, `Wake host ${n} ${testRunId}`)
    await setConnectFlag(hostClient, host.id, "on")
    const channel = await createChannel(hostClient, host.id, `wake-${n}-${testRunId}`, "public")
    // Sharing before the poker has read the channel's creation would let that event poke the new connection.
    await pokerCaughtUp()

    const partnerClient = new TestClient()
    await loginAs(partnerClient, `wake-partner-${n}-${testRunId}@test.com`, "Partner Admin")
    const partner = await createWorkspace(partnerClient, `Wake partner ${n} ${testRunId}`)
    await setConnectFlag(partnerClient, partner.id, "on")

    const connection: StreamConnectionSnapshot = {
      id: streamConnectionId(),
      revision: 2,
      state: "active",
      hostWorkspaceId: host.id,
      hostWorkspaceName: host.name,
      hostRegion: "local",
      hostStreamId: channel.id,
      invitedBy: "usr_inviter",
      partnerWorkspaceId: partner.id,
      partnerWorkspaceName: partner.name,
      partnerRegion: "local",
      partnerVisibility: "private",
      acceptedBy: "usr_accepter",
      peerWorkspaceIds: [],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }
    await syncConnection(hostClient, connection)
    return { hostClient, partnerClient, host, partner, channel, connection }
  }

  async function setConnectFlag(client: TestClient, wsId: string, value: "on" | "off") {
    const { status } = await client.internalRequest("POST", "/internal/feature-flags", {
      workspaceId: wsId,
      subjectType: "workspace",
      subjectId: wsId,
      overrides: { streamConnections: value },
    })
    expect(status).toBe(204)
  }

  async function syncConnection(client: TestClient, snapshot: StreamConnectionSnapshot) {
    const { status } = await client.internalRequest("POST", "/internal/stream-connections", snapshot)
    expect(status).toBe(204)
  }

  /**
   * Waits until the poke handler has finished the latest outbox event, pokes
   * included. The cursor holds back behind sequence gaps, so an event past one
   * shows as processed only in the listener's processed-id window.
   */
  async function pokerCaughtUp(timeoutMs = 10_000) {
    const { rows } = await pool.query<{ max: string }>("SELECT COALESCE(MAX(id), 0)::text AS max FROM outbox")
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const listener = await pool.query<{ done: boolean }>(
        `SELECT last_processed_id >= $1::bigint OR processed_ids ? $2 AS done
         FROM outbox_listeners WHERE listener_id = 'stream-connection-poke'`,
        [rows[0].max, rows[0].max]
      )
      if (listener.rows[0]?.done) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error("The poke handler didn't catch up with the outbox")
  }

  function hostHeaders(callerWorkspaceId: string): Record<string, string> {
    return { [INTERNAL_API_KEY_HEADER]: BRIDGE_KEY, [BRIDGE_WORKSPACE_HEADER]: callerWorkspaceId }
  }

  async function poke(targetWorkspaceId: string, connectionId: string, headers: Record<string, string>) {
    const { status, data } = await new TestClient().request<unknown>(
      "POST",
      `/api/workspaces/${targetWorkspaceId}/stream-connections/${connectionId}/bridge/poke`,
      undefined,
      headers
    )
    return { status, code: typeof data === "object" && data !== null ? (data as { code?: string }).code : undefined }
  }

  async function pulls(partnerWorkspaceId: string, connectionId: string) {
    const result = await pool.query<{ payload: unknown; deferred: boolean }>(
      `SELECT payload, process_after > inserted_at AS deferred FROM queue_messages
       WHERE queue_name = $1 AND workspace_id = $2 AND payload->>'connectionId' = $3`,
      [JobQueues.STREAM_CONNECTION_PULL, partnerWorkspaceId, connectionId]
    )
    return result.rows
  }

  async function clearPulls(partnerWorkspaceId: string, connectionId: string) {
    await pool.query(
      `DELETE FROM queue_messages WHERE queue_name = $1 AND workspace_id = $2 AND payload->>'connectionId' = $3`,
      [JobQueues.STREAM_CONNECTION_PULL, partnerWorkspaceId, connectionId]
    )
  }

  async function waitForPull(partnerWorkspaceId: string, connectionId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const rows = await pulls(partnerWorkspaceId, connectionId)
      if (rows.length > 0) return rows
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return pulls(partnerWorkspaceId, connectionId)
  }

  test("should queue a pull in the partner workspace when the host posts in the shared channel or one of its threads", async () => {
    const { hostClient, host, partner, channel, connection } = await setup()
    const expected = { payload: { workspaceId: partner.id, connectionId: connection.id }, deferred: true }

    const root = await sendMessage(hostClient, host.id, channel.id, "kickoff")
    const afterChannelMessage = await waitForPull(partner.id, connection.id)

    const thread = await createThread(hostClient, host.id, channel.id, root.id)
    await pokerCaughtUp()
    await clearPulls(partner.id, connection.id)
    await sendMessage(hostClient, host.id, thread.id, "in the thread")
    const afterThreadMessage = await waitForPull(partner.id, connection.id)

    expect({ afterChannelMessage: afterChannelMessage[0], afterThreadMessage: afterThreadMessage[0] }).toEqual({
      afterChannelMessage: expected,
      afterThreadMessage: expected,
    })
  }, 30_000)

  test("should refuse with the same 404 every poke but the host's for an active connection the partner has on", async () => {
    const { hostClient, partnerClient, host, partner, connection } = await setup()
    const notFound = { status: 404, code: "STREAM_CONNECTION_NOT_FOUND" }

    const refusals = {
      noKey: await poke(partner.id, connection.id, { [BRIDGE_WORKSPACE_HEADER]: host.id }),
      noCaller: await poke(partner.id, connection.id, { [INTERNAL_API_KEY_HEADER]: BRIDGE_KEY }),
      otherCaller: await poke(partner.id, connection.id, hostHeaders(workspaceId())),
      otherConnection: await poke(partner.id, streamConnectionId(), hostHeaders(host.id)),
      hostSide: await poke(host.id, connection.id, hostHeaders(partner.id)),
      flagOff: await (async () => {
        await setConnectFlag(partnerClient, partner.id, "off")
        const outcome = await poke(partner.id, connection.id, hostHeaders(host.id))
        await setConnectFlag(partnerClient, partner.id, "on")
        return outcome
      })(),
      revoked: await (async () => {
        await syncConnection(hostClient, { ...connection, revision: connection.revision + 1, state: "revoked" })
        return poke(partner.id, connection.id, hostHeaders(host.id))
      })(),
    }

    expect({ refusals, queued: await pulls(partner.id, connection.id) }).toEqual({
      refusals: {
        noKey: { status: 401, code: "UNAUTHORIZED" },
        noCaller: notFound,
        otherCaller: notFound,
        otherConnection: notFound,
        hostSide: notFound,
        flagOff: notFound,
        revoked: notFound,
      },
      queued: [],
    })
  })

  test("should fold a burst of pokes into one pull per second when they arrive together", async () => {
    const { host, partner, connection } = await setup()

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => poke(partner.id, connection.id, hostHeaders(host.id)))
    )
    const queued = await pulls(partner.id, connection.id)

    expect(outcomes.map((outcome) => outcome.status)).toEqual([204, 204, 204, 204, 204])
    // A burst can straddle a second boundary, so it may take two windows, never more.
    expect(queued.length).toBeGreaterThanOrEqual(1)
    expect(queued.length).toBeLessThanOrEqual(2)
  })
})
