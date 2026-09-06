/**
 * E2E coverage for the two halves of a thread-scoped runtime session:
 * `attachTo` on session-create (a thread under an existing scratchpad instead
 * of a fresh one) and `POST /bot-runtime/sessions/end` (winding that thread's
 * session down on purpose). Both are the public surface `/spawn` and `/done`
 * drive from harnessd.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { BotTraits, WORKSPACE_PERMISSION_SCOPES } from "@threahq/types"
import {
  botApiPost,
  createBot,
  createBotKey,
  createWorkspace,
  getStream,
  loginAs,
  sendMessage,
  TestClient,
} from "../client"

setDefaultTimeout(60_000)

const testRunId = Math.random().toString(36).substring(7)

interface SessionLinkData {
  linkId: string
  rootStreamId: string
  activeStreamId: string
  runtimeSessionId: string
  streamUrlPath: string
}

async function harness(prefix: string) {
  const client = new TestClient()
  await loginAs(client, `${prefix}-${testRunId}@test.com`, `Attach User ${prefix}`)
  const workspace = await createWorkspace(client, `Attach WS ${prefix} ${testRunId}`)
  const bot = await createBot(client, workspace.id, {
    type: "personal",
    name: `Attach ${prefix} ${testRunId}`,
    slug: `attach-${prefix}-${testRunId}`,
    traits: [BotTraits.ACTIVE_SCRATCHPAD, BotTraits.MENTIONABLE],
  })
  const apiKey = await createBotKey(client, workspace.id, bot.id, [
    WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE,
    WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE,
    WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE,
  ])
  const desk = await botApiPost<{ data: SessionLinkData }>(client, workspace.id, "/bot-runtime/sessions", apiKey, {
    runtimeKind: "claude-code-channel",
    instanceId: `${prefix}-desk-inst-${testRunId}`,
    runtimeSessionId: `${prefix}-desk-sess-${testRunId}`,
    displayName: "Desk",
    localCwd: "/tmp/threa-attach-desk",
  })
  expect(desk.status).toBe(200)
  return { client, workspaceId: workspace.id, apiKey, root: desk.data.data.rootStreamId }
}

describe("POST /bot-runtime/sessions with attachTo", () => {
  test("opens a thread under the scratchpad, ends it on request, and spawns a fresh one after", async () => {
    const { client, workspaceId, apiKey, root } = await harness("spawn")
    const anchor = await sendMessage(client, workspaceId, root, "/spawn claude fix the sidebar")

    const identity = {
      runtimeKind: "claude-code-channel" as const,
      instanceId: `spawn-inst-${testRunId}`,
      runtimeSessionId: `spawn-sess-${testRunId}`,
    }
    const attached = await botApiPost<{ data: SessionLinkData }>(client, workspaceId, "/bot-runtime/sessions", apiKey, {
      ...identity,
      displayName: "fix the sidebar",
      localCwd: "/tmp/threa-attach-thread",
      attachTo: { rootStreamId: root, anchorId: anchor.id },
    })
    expect(attached.status).toBe(200)
    // A thread under the desk's scratchpad, not a scratchpad of its own.
    expect(attached.data.data.rootStreamId).toBe(root)
    expect(attached.data.data.activeStreamId).not.toBe(root)

    // The session name titles the thread. Nothing else ever will: no user
    // message lands in an agent's own thread, so dynamic naming never fires.
    const thread = await getStream(client, workspaceId, attached.data.data.activeStreamId)
    expect(thread.displayName).toBe("fix the sidebar")

    // Repeating the create resumes the same thread session (every channel
    // restart in the same directory does this).
    const again = await botApiPost<{ data: SessionLinkData }>(client, workspaceId, "/bot-runtime/sessions", apiKey, {
      ...identity,
      displayName: "fix the sidebar",
      localCwd: "/tmp/threa-attach-thread",
      attachTo: { rootStreamId: root, anchorId: anchor.id },
    })
    expect(again.status).toBe(200)
    expect(again.data.data.linkId).toBe(attached.data.data.linkId)

    const ended = await botApiPost(client, workspaceId, "/bot-runtime/sessions/end", apiKey, {
      instanceId: identity.instanceId,
      runtimeSessionId: identity.runtimeSessionId,
    })
    expect(ended.status).toBe(200)

    // `/done` retires the identity (it suffixes `runtime_session_id`), so the
    // same channel restarting on the same directory gets a new thread rather
    // than reviving the finished one.
    const secondAnchor = await sendMessage(client, workspaceId, root, "/spawn claude fix the header")
    const afterDone = await botApiPost<{ data: SessionLinkData }>(
      client,
      workspaceId,
      "/bot-runtime/sessions",
      apiKey,
      {
        ...identity,
        displayName: "fix the header",
        localCwd: "/tmp/threa-attach-thread",
        attachTo: { rootStreamId: root, anchorId: secondAnchor.id },
      }
    )
    expect(afterDone.status).toBe(200)
    expect(afterDone.data.data.rootStreamId).toBe(root)
    expect(afterDone.data.data.linkId).not.toBe(attached.data.data.linkId)
    expect(afterDone.data.data.activeStreamId).not.toBe(attached.data.data.activeStreamId)
  })

  test("refuses an anchor that is not in the given scratchpad", async () => {
    const { client, workspaceId, apiKey, root } = await harness("anchor")
    const other = await botApiPost<{ data: SessionLinkData }>(client, workspaceId, "/bot-runtime/sessions", apiKey, {
      runtimeKind: "claude-code-channel",
      instanceId: `anchor-other-inst-${testRunId}`,
      runtimeSessionId: `anchor-other-sess-${testRunId}`,
      displayName: "Other desk",
      localCwd: "/tmp/threa-attach-other",
    })
    const strayAnchor = await sendMessage(client, workspaceId, other.data.data.rootStreamId, "not in this scratchpad")

    const res = await botApiPost<{ code?: string }>(client, workspaceId, "/bot-runtime/sessions", apiKey, {
      runtimeKind: "claude-code-channel",
      instanceId: `anchor-inst-${testRunId}`,
      runtimeSessionId: `anchor-sess-${testRunId}`,
      displayName: "wrong anchor",
      localCwd: "/tmp/threa-attach-wrong",
      attachTo: { rootStreamId: root, anchorId: strayAnchor.id },
    })
    expect(res).toMatchObject({ status: 404, data: { code: "MESSAGE_NOT_FOUND" } })
  })
})
