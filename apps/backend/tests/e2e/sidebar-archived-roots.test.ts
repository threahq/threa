import { describe, test, expect } from "bun:test"
import {
  TestClient,
  loginAs,
  createWorkspace,
  createScratchpad,
  sendMessage,
  createThread,
  archiveStream,
  getWorkspaceBootstrap,
  getBootstrap,
} from "../client"

const testRunId = Math.random().toString(36).substring(7)
const testEmail = (name: string) => `${name}-${testRunId}@test.com`

/**
 * Archiving a stream marks only that row; its thread descendants stay "active".
 * The workspace bootstrap feeds the sidebar, so a thread whose root
 * scratchpad/channel was archived must be excluded from the bootstrap's stream
 * list — otherwise it surfaces in the sidebar with no signal that its root is
 * archived (the root itself is excluded as archived, so the client can't tell).
 */
describe("Workspace bootstrap excludes threads rooted in archived streams", () => {
  test("omits a thread whose root scratchpad is archived, keeps a thread under an active root", async () => {
    const client = new TestClient()
    await loginAs(client, testEmail("archived-root"), "Archived Root Test")
    const workspace = await createWorkspace(client, `Archived Root WS ${testRunId}`)

    const archivedRoot = await createScratchpad(client, workspace.id, "off")
    const archivedMsg = await sendMessage(client, workspace.id, archivedRoot.id, "parent in soon-archived root")
    const archivedThread = await createThread(client, workspace.id, archivedRoot.id, archivedMsg.id)

    const activeRoot = await createScratchpad(client, workspace.id, "off")
    const activeMsg = await sendMessage(client, workspace.id, activeRoot.id, "parent in active root")
    const activeThread = await createThread(client, workspace.id, activeRoot.id, activeMsg.id)

    await archiveStream(client, workspace.id, archivedRoot.id)

    const bootstrap = await getWorkspaceBootstrap(client, workspace.id)
    const streamIds = new Set(bootstrap.streams.map((s) => s.id))

    // The archived root itself is excluded (active-only bootstrap).
    expect(streamIds.has(archivedRoot.id)).toBe(false)
    // The thread under the archived root is excluded — the fix under test.
    expect(streamIds.has(archivedThread.id)).toBe(false)
    // The active root and its thread still appear.
    expect(streamIds.has(activeRoot.id)).toBe(true)
    expect(streamIds.has(activeThread.id)).toBe(true)
  })

  test("per-stream bootstrap surfaces rootArchivedAt for a thread under an archived root", async () => {
    const client = new TestClient()
    await loginAs(client, testEmail("root-archived-at"), "Root ArchivedAt Test")
    const workspace = await createWorkspace(client, `Root ArchivedAt WS ${testRunId}`)

    const root = await createScratchpad(client, workspace.id, "off")
    const parentMsg = await sendMessage(client, workspace.id, root.id, "parent")
    const thread = await createThread(client, workspace.id, root.id, parentMsg.id)
    await archiveStream(client, workspace.id, root.id)

    const threadBootstrap = await getBootstrap(client, workspace.id, thread.id)
    expect(threadBootstrap.stream.id).toBe(thread.id)
    // The thread is active on its own row; the bootstrap carries the root's
    // archived timestamp so the client can hide the composer without the root
    // being resident in the workspace stream cache.
    expect(threadBootstrap.stream.archivedAt).toBeNull()
    expect(threadBootstrap.rootArchivedAt).not.toBeNull()
  })

  test("sending to a thread under an archived root is rejected with 403", async () => {
    const client = new TestClient()
    await loginAs(client, testEmail("send-block"), "Send Block Test")
    const workspace = await createWorkspace(client, `Send Block WS ${testRunId}`)

    const root = await createScratchpad(client, workspace.id, "off")
    const parentMsg = await sendMessage(client, workspace.id, root.id, "parent")
    const thread = await createThread(client, workspace.id, root.id, parentMsg.id)
    await archiveStream(client, workspace.id, root.id)

    const { status, data } = await client.post(`/api/workspaces/${workspace.id}/messages`, {
      streamId: thread.id,
      content: "reply after archive",
    })
    expect(status).toBe(403)
    expect((data as { error?: string }).error).toBe("Cannot send messages to a thread under an archived stream")
  })
})
