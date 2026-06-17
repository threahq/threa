/**
 * E2E coverage for `claude-code-channel` runtime sessions (the Claude Code
 * channel in `extensions/claude-code-remote/`).
 *
 * Verifies the session API for the new kind: create, idempotent reuse on a
 * repeat create (what every channel restart in the same directory does — it
 * must return the same scratchpad, not a fresh one or a 500), rejection of
 * link-free kinds, and the dispatch → claim → complete round-trip.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { BotTraits, WORKSPACE_PERMISSION_SCOPES } from "@threa/types"
import { botApiPost, createBot, createBotKey, createWorkspace, loginAs, sendMessage, TestClient } from "../client"

setDefaultTimeout(60_000)

const testRunId = Math.random().toString(36).substring(7)

interface SessionLinkData {
  linkId: string
  rootStreamId: string
  activeStreamId: string
  runtimeSessionId: string
  streamUrlPath: string
}

interface ClaimedInvocationData {
  id: string
  claimToken: string
  promptMarkdown: string
  requiredCapability: string
}

describe("claude-code-channel runtime sessions", () => {
  test("creates a session for the new kind and reuses it idempotently on relaunch", async () => {
    const client = new TestClient()
    await loginAs(client, `cc-session-${testRunId}@test.com`, "CC Session User")
    const workspace = await createWorkspace(client, `CC Session WS ${testRunId}`)

    const bot = await createBot(client, workspace.id, {
      type: "personal",
      name: `CC ${testRunId}`,
      slug: `cc-${testRunId}`,
      traits: [BotTraits.ACTIVE_SCRATCHPAD, BotTraits.MENTIONABLE],
    })
    const apiKey = await createBotKey(client, workspace.id, bot.id, [
      WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE,
      WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE,
    ])

    const body = {
      runtimeKind: "claude-code-channel",
      instanceId: `cc-inst-${testRunId}`,
      runtimeSessionId: `cc-sess-${testRunId}`,
      displayName: "Claude Code - test",
      localCwd: "/tmp/threa-cc-test",
    }

    const first = await botApiPost<{ data: SessionLinkData }>(
      client,
      workspace.id,
      "/bot-runtime/sessions",
      apiKey,
      body
    )
    expect(first.status).toBe(200)
    expect(first.data.data.linkId).toBeTruthy()
    expect(first.data.data.activeStreamId).toBeTruthy()

    const second = await botApiPost<{ data: SessionLinkData }>(
      client,
      workspace.id,
      "/bot-runtime/sessions",
      apiKey,
      body
    )
    expect(second.status).toBe(200)
    // Same scratchpad, not a fresh one (and not a 500).
    expect(second.data.data.linkId).toBe(first.data.data.linkId)
    expect(second.data.data.activeStreamId).toBe(first.data.data.activeStreamId)
  })

  test("rejects a link-free runtime kind", async () => {
    const client = new TestClient()
    await loginAs(client, `cc-reject-${testRunId}@test.com`, "CC Reject User")
    const workspace = await createWorkspace(client, `CC Reject WS ${testRunId}`)
    const bot = await createBot(client, workspace.id, {
      type: "personal",
      name: `CCR ${testRunId}`,
      slug: `ccr-${testRunId}`,
      traits: [BotTraits.ACTIVE_SCRATCHPAD],
    })
    const apiKey = await createBotKey(client, workspace.id, bot.id, [WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE])

    const res = await botApiPost(client, workspace.id, "/bot-runtime/sessions", apiKey, {
      runtimeKind: "openclaw",
      instanceId: `oc-inst-${testRunId}`,
      runtimeSessionId: `oc-sess-${testRunId}`,
      displayName: "Openclaw",
    })
    expect(res.status).toBe(400)
  })

  test("a user message round-trips: active-scratchpad dispatch → claim → reply", async () => {
    const client = new TestClient()
    await loginAs(client, `cc-rt-${testRunId}@test.com`, "CC Roundtrip User")
    const workspace = await createWorkspace(client, `CC Roundtrip WS ${testRunId}`)
    const bot = await createBot(client, workspace.id, {
      type: "personal",
      name: `CCRT ${testRunId}`,
      slug: `ccrt-${testRunId}`,
      traits: [BotTraits.ACTIVE_SCRATCHPAD, BotTraits.MENTIONABLE],
    })
    const apiKey = await createBotKey(client, workspace.id, bot.id, [
      WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE,
      WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE,
      WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE,
    ])

    const instanceId = `ccrt-inst-${testRunId}`
    const runtimeSessionId = `ccrt-sess-${testRunId}`
    const session = await botApiPost<{ data: SessionLinkData }>(client, workspace.id, "/bot-runtime/sessions", apiKey, {
      runtimeKind: "claude-code-channel",
      instanceId,
      runtimeSessionId,
      displayName: "Claude Code - rt",
      localCwd: "/tmp/threa-cc-rt",
    })
    expect(session.status).toBe(200)
    const streamId = session.data.data.activeStreamId

    // The user posts in the scratchpad; the bot is its active actor, so this
    // dispatches an active-scratchpad invocation targeted to our session.
    await sendMessage(client, workspace.id, streamId, "Reply with exactly: forty-two")

    const claimBody = {
      runtimeKind: "claude-code-channel",
      instanceId,
      runtimeSessionId,
      supportedCapabilities: ["active-scratchpad", "mentionable"],
      claimTtlSeconds: 120,
    }
    let claimed: ClaimedInvocationData | null = null
    for (let i = 0; i < 30 && !claimed; i++) {
      const res = await botApiPost<{ data: ClaimedInvocationData | null }>(
        client,
        workspace.id,
        "/bot-invocations/claim",
        apiKey,
        claimBody
      )
      if (res.status === 200 && res.data.data) claimed = res.data.data
      else await new Promise((resolve) => setTimeout(resolve, 200))
    }
    expect(claimed).not.toBeNull()
    expect(claimed!.requiredCapability).toBe("active-scratchpad")
    expect(claimed!.promptMarkdown).toContain("forty-two")

    const completed = await botApiPost<{ data: { invocationId: string; message: { content: string } | null } }>(
      client,
      workspace.id,
      `/bot-invocations/${claimed!.id}/complete`,
      apiKey,
      { instanceId, claimToken: claimed!.claimToken, finalMessageMarkdown: "forty-two" }
    )
    expect(completed.status).toBe(200)
    expect(completed.data.data.message?.content).toContain("forty-two")
  })
})
