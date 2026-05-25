/**
 * E2E tests for slash command visibility.
 *
 * Verifies that command events (dispatched, completed, failed) are only
 * visible to the user who dispatched them, not other channel members.
 */

import { describe, test, expect } from "bun:test"
import { BotInvocationCapabilities, BotTraits, WORKSPACE_PERMISSION_SCOPES } from "@threa/types"
import {
  TestClient,
  loginAs,
  createWorkspace,
  createChannel,
  createScratchpad,
  joinWorkspace,
  joinStream,
  dispatchCommand,
  getBootstrap,
  listEvents,
  getUserId,
  createBot,
  createBotKey,
  botApiPost,
} from "../client"

const testRunId = Math.random().toString(36).substring(7)
const testEmail = (name: string) => `${name}-${testRunId}@test.com`

describe("Command Visibility E2E", () => {
  test("command events are only visible to the command author via bootstrap", async () => {
    // Setup: Create two users in the same workspace and channel
    const clientA = new TestClient()
    const clientB = new TestClient()

    const userA = await loginAs(clientA, testEmail("cmd-vis-a"), "User A")
    const userB = await loginAs(clientB, testEmail("cmd-vis-b"), "User B")

    // User A creates workspace and channel
    const workspace = await createWorkspace(clientA, `Cmd Vis WS ${testRunId}`)
    const channel = await createChannel(clientA, workspace.id, `cmd-vis-${testRunId}`, "public")

    // User B joins workspace and channel
    await joinWorkspace(clientB, workspace.id)
    await joinStream(clientB, workspace.id, channel.id)

    // User A dispatches a command. Args resolve to nothing, so execution will
    // emit command_failed — these tests assert on the dispatch event only.
    const cmdResult = await dispatchCommand(clientA, workspace.id, channel.id, "/invite @ghost")
    expect(cmdResult.success).toBe(true)
    expect(cmdResult.command).toBe("invite")
    expect(cmdResult.args).toBe("@ghost")

    // User A fetches bootstrap - should see command_dispatched event
    const bootstrapA = await getBootstrap(clientA, workspace.id, channel.id)
    const eventTypesA = bootstrapA.events.map((e) => e.eventType)
    expect(eventTypesA).toContain("command_dispatched")

    // Verify the command event has correct actor (workspace user ID)
    const userIdA = await getUserId(clientA, workspace.id, userA.id)
    const cmdEventA = bootstrapA.events.find((e) => e.eventType === "command_dispatched")
    expect(cmdEventA?.actorId).toBe(userIdA)

    // User B fetches bootstrap - should NOT see command events
    const bootstrapB = await getBootstrap(clientB, workspace.id, channel.id)
    const eventTypesB = bootstrapB.events.map((e) => e.eventType)
    expect(eventTypesB).not.toContain("command_dispatched")
    expect(eventTypesB).not.toContain("command_completed")
    expect(eventTypesB).not.toContain("command_failed")
  })

  test("command events are only visible to the command author via listEvents", async () => {
    const clientA = new TestClient()
    const clientB = new TestClient()

    await loginAs(clientA, testEmail("cmd-list-a"), "User A")
    await loginAs(clientB, testEmail("cmd-list-b"), "User B")

    const workspace = await createWorkspace(clientA, `Cmd List WS ${testRunId}`)
    const channel = await createChannel(clientA, workspace.id, `cmd-list-${testRunId}`, "public")

    await joinWorkspace(clientB, workspace.id)
    await joinStream(clientB, workspace.id, channel.id)

    // User A dispatches a command
    await dispatchCommand(clientA, workspace.id, channel.id, "/invite @ghost")

    // User A lists events - should see command events
    const eventsA = await listEvents(clientA, workspace.id, channel.id)
    const eventTypesA = eventsA.map((e) => e.eventType)
    expect(eventTypesA).toContain("command_dispatched")

    // User B lists events - should NOT see command events
    const eventsB = await listEvents(clientB, workspace.id, channel.id)
    const eventTypesB = eventsB.map((e) => e.eventType)
    expect(eventTypesB).not.toContain("command_dispatched")
  })

  test("each user only sees their own command events", async () => {
    const clientA = new TestClient()
    const clientB = new TestClient()

    const userA = await loginAs(clientA, testEmail("cmd-both-a"), "User A")
    const userB = await loginAs(clientB, testEmail("cmd-both-b"), "User B")

    const workspace = await createWorkspace(clientA, `Cmd Both WS ${testRunId}`)
    const channel = await createChannel(clientA, workspace.id, `cmd-both-${testRunId}`, "public")

    await joinWorkspace(clientB, workspace.id)
    await joinStream(clientB, workspace.id, channel.id)

    // Both users dispatch commands
    const cmdA = await dispatchCommand(clientA, workspace.id, channel.id, "/invite @ghost-a")
    const cmdB = await dispatchCommand(clientB, workspace.id, channel.id, "/invite @ghost-b")

    // Resolve workspace user IDs for comparison
    const userIdA = await getUserId(clientA, workspace.id, userA.id)
    const userIdB = await getUserId(clientB, workspace.id, userB.id)

    // User A's bootstrap should only show their command
    const bootstrapA = await getBootstrap(clientA, workspace.id, channel.id)
    const cmdEventsA = bootstrapA.events.filter((e) => e.eventType === "command_dispatched")
    expect(cmdEventsA.length).toBe(1)
    expect(cmdEventsA[0].actorId).toBe(userIdA)
    expect((cmdEventsA[0].payload as { commandId: string }).commandId).toBe(cmdA.commandId)

    // User B's bootstrap should only show their command
    const bootstrapB = await getBootstrap(clientB, workspace.id, channel.id)
    const cmdEventsB = bootstrapB.events.filter((e) => e.eventType === "command_dispatched")
    expect(cmdEventsB.length).toBe(1)
    expect(cmdEventsB[0].actorId).toBe(userIdB)
    expect((cmdEventsB[0].payload as { commandId: string }).commandId).toBe(cmdB.commandId)
  })
})

interface LinkedPiSession {
  bot: { id: string; ownerUserId: string | null }
  apiKey: string
  streamId: string
  runtimeSessionId: string
  instanceId: string
}

async function createLinkedPiSession(
  client: TestClient,
  workspaceId: string,
  suffix: string
): Promise<LinkedPiSession> {
  const bot = await createBot(client, workspaceId, {
    type: "personal",
    name: `Pi ${suffix}`,
    slug: `pi-${suffix}`,
    traits: [BotTraits.ACTIVE_SCRATCHPAD, BotTraits.MENTIONABLE],
  })

  const apiKey = await createBotKey(client, workspaceId, bot.id, [
    WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE,
    WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE,
  ])

  const instanceId = `inst-${suffix}`
  const runtimeSessionId = `sess-${suffix}`

  const session = await botApiPost<{
    data: { activeStreamId: string; rootStreamId: string; runtimeSessionId: string }
  }>(client, workspaceId, "/bot-runtime/sessions", apiKey, {
    runtimeKind: "pi-local",
    instanceId,
    runtimeSessionId,
    displayName: `Pi ${suffix}`,
    localCwd: "/tmp/threa-test",
  })
  if (session.status !== 200) {
    throw new Error(`Create runtime session failed: ${JSON.stringify(session.data)}`)
  }

  // Advertise session-control capabilities. /bot-runtime/sessions does not set
  // capabilities on its own, so the availability service won't surface
  // session-control commands until presence has been heartbeated.
  const presence = await botApiPost(client, workspaceId, "/bot-runtime/presence", apiKey, {
    runtimeKind: "pi-local",
    instanceId,
    runtimeSessionId,
    displayName: `Pi ${suffix}`,
    status: "available",
    acceptingInvocations: true,
    capabilities: {
      runtimeSessionId,
      supportsActiveScratchpad: true,
      supportsPersistentSessions: true,
      supportsSessionControlCommands: true,
      sessionControlCommands: ["compact", "model", "thinking", "skill"],
    },
  })
  if (presence.status !== 200) {
    throw new Error(`Presence heartbeat failed: ${JSON.stringify(presence.data)}`)
  }

  return {
    bot,
    apiKey,
    streamId: session.data.data.activeStreamId,
    runtimeSessionId,
    instanceId,
  }
}

describe("Stream-scoped Pi session-control commands", () => {
  test("Pi session-control commands are only listed in linked Pi scratchpads", async () => {
    const client = new TestClient()
    await loginAs(client, testEmail("pi-cmd-list"), "Pi Command User")
    const workspace = await createWorkspace(client, `Pi Cmd WS ${testRunId}`)
    const linked = await createLinkedPiSession(client, workspace.id, `list-${testRunId}`)

    const linkedBootstrap = await getBootstrap(client, workspace.id, linked.streamId)
    const linkedNames = linkedBootstrap.commands?.map((c) => c.name) ?? []
    expect(linkedNames).toContain("compact")
    expect(linkedNames).toContain("model")
    expect(linkedNames).toContain("thinking")
    expect(linkedNames).toContain("skill")

    // A separate scratchpad with no active Pi runtime should not expose
    // session-control commands.
    const scratchpad = await createScratchpad(client, workspace.id, "off")
    const unlinkedBootstrap = await getBootstrap(client, workspace.id, scratchpad.id)
    const unlinkedNames = unlinkedBootstrap.commands?.map((c) => c.name) ?? []
    expect(unlinkedNames).not.toContain("compact")
    expect(unlinkedNames).not.toContain("thinking")

    // Channels keep /invite but never offer session-control commands.
    const channel = await createChannel(client, workspace.id, `pi-cmd-${testRunId}`, "public")
    const channelBootstrap = await getBootstrap(client, workspace.id, channel.id)
    const channelNames = channelBootstrap.commands?.map((c) => c.name) ?? []
    expect(channelNames).toContain("invite")
    expect(channelNames).not.toContain("compact")
  })

  test("runtime command dispatch creates a targeted session-control invocation", async () => {
    const client = new TestClient()
    await loginAs(client, testEmail("pi-cmd-dispatch"), "Pi Command User")
    const workspace = await createWorkspace(client, `Pi Cmd Dispatch WS ${testRunId}`)
    const linked = await createLinkedPiSession(client, workspace.id, `dispatch-${testRunId}`)

    const dispatch = await dispatchCommand(client, workspace.id, linked.streamId, "/thinking high")
    expect(dispatch.success).toBe(true)
    expect(dispatch.command).toBe("thinking")
    expect((dispatch.event.payload as { executionKind?: string }).executionKind).toBe("bot-runtime")

    const claim = await botApiPost<{
      data: {
        id: string
        requiredCapability: string
        metadata: Record<string, unknown>
        runtimeSessionId: string | null
        claimToken: string
      } | null
    }>(client, workspace.id, "/bot-invocations/claim", linked.apiKey, {
      runtimeKind: "pi-local",
      instanceId: linked.instanceId,
      runtimeSessionId: linked.runtimeSessionId,
      supportedCapabilities: [BotInvocationCapabilities.SESSION_CONTROL],
      claimTtlSeconds: 120,
    })

    expect(claim.status).toBe(200)
    expect(claim.data.data).not.toBeNull()
    expect(claim.data.data?.requiredCapability).toBe(BotInvocationCapabilities.SESSION_CONTROL)
    expect(claim.data.data?.runtimeSessionId).toBe(linked.runtimeSessionId)
    const command = claim.data.data?.metadata.command as { name?: string; id?: string } | undefined
    expect(command?.name).toBe("thinking")
    expect(command?.id).toBe(dispatch.commandId)
  })

  test("session-control invocation completion writes command_completed", async () => {
    const client = new TestClient()
    await loginAs(client, testEmail("pi-cmd-complete"), "Pi Command User")
    const workspace = await createWorkspace(client, `Pi Cmd Complete WS ${testRunId}`)
    const linked = await createLinkedPiSession(client, workspace.id, `complete-${testRunId}`)

    const dispatch = await dispatchCommand(client, workspace.id, linked.streamId, "/thinking high")

    const claim = await botApiPost<{
      data: {
        id: string
        metadata: Record<string, unknown>
        claimToken: string
      } | null
    }>(client, workspace.id, "/bot-invocations/claim", linked.apiKey, {
      runtimeKind: "pi-local",
      instanceId: linked.instanceId,
      runtimeSessionId: linked.runtimeSessionId,
      supportedCapabilities: [BotInvocationCapabilities.SESSION_CONTROL],
      claimTtlSeconds: 120,
    })
    expect(claim.status).toBe(200)
    const invocation = claim.data.data
    if (!invocation) throw new Error("Expected to claim the dispatched invocation")
    const metadataCommand = invocation.metadata.command as { id: string }
    expect(metadataCommand.id).toBe(dispatch.commandId)

    const complete = await botApiPost(
      client,
      workspace.id,
      `/bot-invocations/${invocation.id}/complete`,
      linked.apiKey,
      {
        instanceId: linked.instanceId,
        claimToken: invocation.claimToken,
        finalMessageMarkdown: "Thinking level changed: `low` → `high`",
      }
    )
    expect(complete.status).toBe(200)

    const events = await listEvents(client, workspace.id, linked.streamId)
    const completed = events.find((event) => event.eventType === "command_completed")
    expect(completed).toBeDefined()
    expect((completed?.payload as { commandId?: string } | undefined)?.commandId).toBe(dispatch.commandId)
  })
})
