import { describe, test, expect, setDefaultTimeout } from "bun:test"
import {
  TestClient,
  loginAs,
  createWorkspace,
  createChannel,
  sendMessage,
  joinWorkspace,
  joinStream,
  getBootstrap,
  getWorkspaceBootstrap,
  getUserId,
} from "../client"

const testRunId = Math.random().toString(36).slice(2, 8)
const testEmail = (name: string) => `${name}-stream-bootstrap-${testRunId}@test.com`

setDefaultTimeout(30_000)

interface MessageCreatedPayload {
  contentMarkdown?: string
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForBootstrap(
  client: TestClient,
  workspaceId: string,
  streamId: string,
  params: { after?: string } | undefined,
  predicate: (bootstrap: Awaited<ReturnType<typeof getBootstrap>>) => boolean,
  timeoutMs = 5000
) {
  const start = Date.now()
  let lastBootstrap = await getBootstrap(client, workspaceId, streamId, params)

  while (Date.now() - start < timeoutMs) {
    if (predicate(lastBootstrap)) return lastBootstrap
    await sleep(200)
    lastBootstrap = await getBootstrap(client, workspaceId, streamId, params)
  }

  return lastBootstrap
}

function getMessageContents(bootstrap: Awaited<ReturnType<typeof getBootstrap>>): string[] {
  return bootstrap.events
    .filter((event) => event.eventType === "message_created")
    .map((event) => ((event.payload as MessageCreatedPayload).contentMarkdown ?? "").trim())
}

describe("Stream Bootstrap E2E", () => {
  test("returns incremental append data with authoritative counts and latest head", async () => {
    const ownerClient = new TestClient()
    const memberClient = new TestClient()

    const owner = await loginAs(ownerClient, testEmail("owner-append"), "Owner Append")
    const workspace = await createWorkspace(ownerClient, `Stream Bootstrap Append ${testRunId}`)

    const member = await loginAs(memberClient, testEmail("member-append"), "Member Append")
    await joinWorkspace(memberClient, workspace.id, "member")
    const memberUserId = await getUserId(memberClient, workspace.id, member.id)

    const workspaceBootstrap = await getWorkspaceBootstrap(ownerClient, workspace.id)
    const memberSlug = workspaceBootstrap.users.find((user) => user.id === memberUserId)?.slug
    expect(memberSlug).toBeTruthy()

    const channel = await createChannel(ownerClient, workspace.id, `append-${testRunId}`, "public")
    await joinStream(memberClient, workspace.id, channel.id)

    const initialBootstrap = await getBootstrap(memberClient, workspace.id, channel.id)

    const plainMessage = `plain ${testRunId}`
    const mentionMessage = `hey @${memberSlug} ${testRunId}`
    await sendMessage(ownerClient, workspace.id, channel.id, plainMessage)
    await sendMessage(ownerClient, workspace.id, channel.id, mentionMessage)

    const incrementalBootstrap = await waitForBootstrap(
      memberClient,
      workspace.id,
      channel.id,
      { after: initialBootstrap.latestSequence },
      (bootstrap) => bootstrap.syncMode === "append" && bootstrap.unreadCount === 2 && bootstrap.mentionCount === 1
    )

    const memberWorkspaceBootstrap = await getWorkspaceBootstrap(memberClient, workspace.id)

    expect(incrementalBootstrap.syncMode).toBe("append")
    expect(incrementalBootstrap.unreadCount).toBe(memberWorkspaceBootstrap.unreadCounts[channel.id] ?? 0)
    expect(incrementalBootstrap.mentionCount).toBe(memberWorkspaceBootstrap.mentionCounts[channel.id] ?? 0)
    expect(incrementalBootstrap.activityCount).toBe(memberWorkspaceBootstrap.activityCounts[channel.id] ?? 0)
    // The mention resolves to a real member, so it comes back in pointer form (INV-64).
    const mentionMessageResolved = `hey [@${memberSlug}](user:${memberUserId}) ${testRunId}`
    expect(getMessageContents(incrementalBootstrap)).toEqual([plainMessage, mentionMessageResolved])

    const fullBootstrap = await getBootstrap(memberClient, workspace.id, channel.id)
    expect(incrementalBootstrap.latestSequence).toBe(fullBootstrap.latestSequence)

    // The latest window remains a replace-style bootstrap even after append catch-up.
    expect(fullBootstrap.syncMode).toBe("replace")
  })

  test("falls back to replace with the latest 50 events when the cursor is too old", async () => {
    const ownerClient = new TestClient()
    const memberClient = new TestClient()

    await loginAs(ownerClient, testEmail("owner-overflow"), "Owner Overflow")
    const workspace = await createWorkspace(ownerClient, `Stream Bootstrap Overflow ${testRunId}`)

    await loginAs(memberClient, testEmail("member-overflow"), "Member Overflow")
    await joinWorkspace(memberClient, workspace.id, "member")

    const channel = await createChannel(ownerClient, workspace.id, `overflow-${testRunId}`, "public")
    await joinStream(memberClient, workspace.id, channel.id)

    const initialBootstrap = await getBootstrap(memberClient, workspace.id, channel.id)

    for (let index = 1; index <= 51; index++) {
      await sendMessage(ownerClient, workspace.id, channel.id, `overflow ${index} ${testRunId}`)
    }

    const overflowBootstrap = await waitForBootstrap(
      memberClient,
      workspace.id,
      channel.id,
      { after: initialBootstrap.latestSequence },
      (bootstrap) => bootstrap.syncMode === "replace" && getMessageContents(bootstrap).length === 50
    )

    const messageContents = getMessageContents(overflowBootstrap)
    expect(overflowBootstrap.syncMode).toBe("replace")
    expect(overflowBootstrap.hasOlderEvents).toBe(true)
    expect(messageContents).toHaveLength(50)
    expect(messageContents).not.toContain(`overflow 1 ${testRunId}`)
    expect(messageContents).toContain(`overflow 2 ${testRunId}`)
    expect(messageContents).toContain(`overflow 51 ${testRunId}`)

    const fullBootstrap = await getBootstrap(memberClient, workspace.id, channel.id)
    expect(overflowBootstrap.latestSequence).toBe(fullBootstrap.latestSequence)
  })
})
