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
})
