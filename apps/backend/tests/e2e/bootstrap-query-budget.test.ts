import { describe, test, expect, setDefaultTimeout } from "bun:test"
import {
  TestClient,
  loginAs,
  createWorkspace,
  createChannel,
  createThread,
  sendMessage,
  addReaction,
  joinWorkspace,
  joinStream,
  queryCount,
} from "../client"

const testRunId = Math.random().toString(36).slice(2, 8)
const testEmail = (name: string) => `${name}-query-budget-${testRunId}@test.com`

setDefaultTimeout(120_000)

const WORKSPACE_BOOTSTRAP_QUERY_CEILING = 37
const STREAM_BOOTSTRAP_QUERY_CEILING = 28

/** The second of two calls, so first-touch work (lazy upserts, cache fills) is out of the count. */
async function warmQueryCount(client: TestClient, path: string): Promise<number> {
  await client.get(path)
  const { status, headers } = await client.get(path)
  expect(status).toBe(200)
  return queryCount(headers)
}

async function setUpWorkspace(label: string) {
  const ownerClient = new TestClient()
  const memberClient = new TestClient()
  await loginAs(ownerClient, testEmail(`owner-${label}`), `Owner ${label}`)
  const workspace = await createWorkspace(ownerClient, `Query Budget ${label} ${testRunId}`)
  await loginAs(memberClient, testEmail(`member-${label}`), `Member ${label}`)
  await joinWorkspace(memberClient, workspace.id, "member")
  return { ownerClient, memberClient, workspaceId: workspace.id }
}

/** One channel the member posts into, with a reacted message and a thread reply. */
async function addActiveChannel(
  ctx: Awaited<ReturnType<typeof setUpWorkspace>>,
  name: string,
  messages: number
): Promise<string> {
  const { ownerClient, memberClient, workspaceId } = ctx
  const channel = await createChannel(ownerClient, workspaceId, name, "public")
  await joinStream(memberClient, workspaceId, channel.id)
  await addMessages(ctx, channel.id, name, messages)
  return channel.id
}

async function addMessages(
  ctx: Awaited<ReturnType<typeof setUpWorkspace>>,
  streamId: string,
  label: string,
  messages: number
): Promise<void> {
  const { ownerClient, memberClient, workspaceId } = ctx
  for (let i = 0; i < messages; i++) {
    const message = await sendMessage(memberClient, workspaceId, streamId, `${label} message ${i}`)
    if (i % 5 === 0) {
      await addReaction(ownerClient, workspaceId, message.id, ":+1:")
      const thread = await createThread(memberClient, workspaceId, streamId, message.id)
      await sendMessage(ownerClient, workspaceId, thread.id, `${label} reply ${i}`)
    }
  }
}

describe("Bootstrap query budget", () => {
  test("should issue the same number of queries for the workspace bootstrap when the workspace has 10x the channels", async () => {
    const ctx = await setUpWorkspace("workspace")
    const path = `/api/workspaces/${ctx.workspaceId}/bootstrap`

    for (let i = 0; i < 2; i++) await addActiveChannel(ctx, `small-${i}-${testRunId}`, 1)
    const small = await warmQueryCount(ctx.ownerClient, path)

    for (let i = 2; i < 20; i++) await addActiveChannel(ctx, `large-${i}-${testRunId}`, 1)
    const large = await warmQueryCount(ctx.ownerClient, path)

    expect(small).toBeGreaterThan(0)
    expect(large).toBe(small)
    expect(large).toBeLessThanOrEqual(WORKSPACE_BOOTSTRAP_QUERY_CEILING)
  })

  test("should issue the same number of queries for the stream bootstrap when the stream has 20x the messages", async () => {
    const ctx = await setUpWorkspace("stream")
    const streamId = await addActiveChannel(ctx, `stream-${testRunId}`, 2)
    const path = `/api/workspaces/${ctx.workspaceId}/streams/${streamId}/bootstrap`

    const small = await warmQueryCount(ctx.ownerClient, path)

    await addMessages(ctx, streamId, "more", 38)
    const large = await warmQueryCount(ctx.ownerClient, path)

    expect(small).toBeGreaterThan(0)
    expect(large).toBe(small)
    expect(large).toBeLessThanOrEqual(STREAM_BOOTSTRAP_QUERY_CEILING)
  })
})
