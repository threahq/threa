import { describe, test, expect, beforeAll } from "bun:test"
import {
  TestClient,
  loginAs,
  createWorkspace,
  createChannel,
  sendMessage,
  getWorkspaceBootstrap,
  getSyncCatchUp,
} from "../client"

/**
 * The workspace bootstrap carries the sync-log head it was read against so the
 * client can seed its catch-up cursor on first connect (and avoid a redundant
 * second bootstrap). This verifies the field is present and stays consistent
 * with the value the catch-up endpoint reports.
 */
describe("Workspace bootstrap sync head", () => {
  let client: TestClient
  let workspaceId: string
  let streamId: string

  beforeAll(async () => {
    client = new TestClient()
    await loginAs(client, "sync-head-test@example.com", "Sync Head Test User")
    const workspace = await createWorkspace(client, "Sync Head Workspace")
    workspaceId = workspace.id
    const channel = await createChannel(client, workspaceId, "sync-head")
    streamId = channel.id
  })

  test("bootstrap returns a syncHead consistent with the catch-up endpoint", async () => {
    await sendMessage(client, workspaceId, streamId, "drives a sync-log entry")

    // The sync-log entry is written by the outbox dispatcher after the message
    // commits, so poll until the head reflects it.
    let bootstrapHead = "0"
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      bootstrapHead = (await getWorkspaceBootstrap(client, workspaceId)).syncHead ?? "0"
      if (BigInt(bootstrapHead) > 0n) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(BigInt(bootstrapHead) > 0n).toBe(true)

    const catchUp = await getSyncCatchUp(client, workspaceId, "0")

    // The bootstrap head is read before the snapshot, so it is a lower bound of
    // the catch-up head read moments later — never ahead of it.
    expect(BigInt(bootstrapHead)).toBeLessThanOrEqual(BigInt(catchUp.head))
  })
})
