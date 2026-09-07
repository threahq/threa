import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import type { BotRuntimeKind } from "@threahq/types"
import { BotChannelAccessRepository } from "../../src/features/api-keys"
import {
  BotRuntimeService,
  BotRuntimeSessionLinkRepository,
  StreamActiveActorRepository,
} from "../../src/features/bot-runtimes"
import { CommandAvailabilityService, CommandRegistry } from "../../src/features/commands"
import { BotRepository } from "../../src/features/public-api"
import { MessageRepository } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository, StreamService } from "../../src/features/streams"
import { botChannelAccessId, messageId, streamId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupIsolatedTestDatabase, testContentJson } from "./setup"

interface Scenario {
  workspace: string
  root: string
  thread: string
  owner: string
  rootBot: string
  childBot: string
  rootInstance: string
  rootSession: string
  childInstance: string
  childSession: string
  anchorId: string
}

describe("cross-bot linked scratchpad routing", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let sequence = 0n

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("cross_bot_routing")
    pool = isolated.pool
    cleanup = isolated.cleanup
  }, 30_000)

  afterAll(async () => {
    await cleanup?.()
  }, 30_000)

  async function createBot(workspace: string, owner: string, name: string): Promise<string> {
    const id = `bot_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`
    await BotRepository.create(pool, {
      id,
      workspaceId: workspace,
      type: "personal",
      ownerUserId: owner,
      traits: ["active-scratchpad", "mentionable"],
      slug: `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`,
      name,
    })
    return id
  }

  async function insertMessage(stream: string, author: string, markdown: string) {
    sequence += 1n
    return MessageRepository.insert(pool, {
      id: messageId(),
      streamId: stream,
      sequence,
      authorId: author,
      authorType: "user",
      contentJson: testContentJson(markdown),
      contentMarkdown: markdown,
    })
  }

  async function seedScenario(rootKind: BotRuntimeKind, childKind: BotRuntimeKind): Promise<Scenario> {
    const workspace = workspaceId()
    const root = streamId()
    const owner = (await addTestMember(pool, workspace, `workos-${crypto.randomUUID()}`)).id
    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)",
      [root, workspace, owner]
    )
    await StreamMemberRepository.insert(pool, root, owner)
    const rootBot = await createBot(workspace, owner, "Root bot")
    const childBot = await createBot(workspace, owner, "Child bot")
    await BotChannelAccessRepository.grantAccess(pool, {
      id: botChannelAccessId(),
      workspaceId: workspace,
      botId: rootBot,
      streamId: root,
      grantedBy: owner,
    })
    const service = new BotRuntimeService({ pool, streamService: new StreamService(pool) })
    const rootInstance = `root-${crypto.randomUUID()}`
    const rootSession = `root-session-${crypto.randomUUID()}`
    await service.createOrLinkPiRemoteSession({
      workspaceId: workspace,
      botId: rootBot,
      runtimeKind: rootKind,
      instanceId: rootInstance,
      runtimeSessionId: rootSession,
      rootStreamId: root,
      activeStreamId: root,
      linkedBy: owner,
    })
    const anchor = await insertMessage(root, owner, "child anchor")
    const childInstance = `child-${crypto.randomUUID()}`
    const childSession = `child-session-${crypto.randomUUID()}`
    const attached = await service.attachRuntimeSessionToThread({
      workspaceId: workspace,
      botId: childBot,
      ownerUserId: owner,
      runtimeKind: childKind,
      instanceId: childInstance,
      runtimeSessionId: childSession,
      rootStreamId: root,
      anchorId: anchor.id,
      displayName: "Child work",
      traits: ["active-scratchpad"],
    })
    await service.upsertPresenceFromBotKey({
      workspaceId: workspace,
      botId: childBot,
      runtimeKind: childKind,
      instanceId: childInstance,
      status: "available",
      acceptingInvocations: true,
      capabilities: {
        runtimeSessionId: childSession,
        supportsSessionControlCommands: true,
        sessionControlCommands: ["status"],
      },
    })
    return {
      workspace,
      root,
      thread: attached.stream.id,
      owner,
      rootBot,
      childBot,
      rootInstance,
      rootSession,
      childInstance,
      childSession,
      anchorId: anchor.id,
    }
  }

  for (const [rootKind, childKind] of [
    ["claude-code-channel", "pi-local"],
    ["pi-local", "claude-code-channel"],
  ] as const) {
    test(`should preserve and route ${rootKind} root with ${childKind} child`, async () => {
      const scenario = await seedScenario(rootKind, childKind)
      const service = new BotRuntimeService({ pool, streamService: new StreamService(pool) })

      expect(await StreamActiveActorRepository.findByRootStream(pool, scenario.workspace, scenario.root)).toMatchObject(
        {
          actorId: scenario.rootBot,
        }
      )

      const rootMessage = await insertMessage(scenario.root, scenario.owner, "root turn")
      const childMessage = await insertMessage(scenario.thread, scenario.owner, "child turn")
      await service.reconcileInvocationSource({ workspaceId: scenario.workspace, sourceMessageId: rootMessage.id })
      await service.reconcileInvocationSource({ workspaceId: scenario.workspace, sourceMessageId: childMessage.id })

      const routed = await pool.query<{
        source_message_id: string
        actor_id: string
        target_instance_id: string | null
        target_runtime_session_id: string | null
      }>(
        `SELECT source_message_id, actor_id, target_instance_id, target_runtime_session_id
         FROM bot_invocations
         WHERE workspace_id = $1 AND source_message_id = ANY($2)
         ORDER BY source_message_id`,
        [scenario.workspace, [rootMessage.id, childMessage.id]]
      )
      expect(routed.rows).toEqual(
        [
          {
            source_message_id: rootMessage.id,
            actor_id: scenario.rootBot,
            target_instance_id: scenario.rootInstance,
            target_runtime_session_id: scenario.rootSession,
          },
          {
            source_message_id: childMessage.id,
            actor_id: scenario.childBot,
            target_instance_id: scenario.childInstance,
            target_runtime_session_id: scenario.childSession,
          },
        ].sort((left, right) => left.source_message_id.localeCompare(right.source_message_id))
      )

      const command = await new CommandAvailabilityService({
        pool,
        commandRegistry: new CommandRegistry(),
      }).resolveCommand({
        workspaceId: scenario.workspace,
        userId: scenario.owner,
        streamId: scenario.thread,
        name: "status",
      })
      expect(command).toMatchObject({
        executionKind: "bot-runtime",
        runtime: {
          botId: scenario.childBot,
          targetInstanceId: scenario.childInstance,
          targetRuntimeSessionId: scenario.childSession,
        },
      })

      const brief = await service.briefRuntimeSession({
        workspaceId: scenario.workspace,
        botId: scenario.childBot,
        ownerUserId: scenario.owner,
        instanceId: scenario.childInstance,
        runtimeSessionId: scenario.childSession,
        contentMarkdown: "child brief",
      })
      expect(brief?.invocation).toMatchObject({
        actorId: scenario.childBot,
        trigger: "brief",
        targetInstanceId: scenario.childInstance,
        targetRuntimeSessionId: scenario.childSession,
      })

      await service.endRuntimeSession({
        workspaceId: scenario.workspace,
        botId: scenario.childBot,
        instanceId: scenario.childInstance,
        runtimeSessionId: scenario.childSession,
      })
      expect(await StreamActiveActorRepository.findByRootStream(pool, scenario.workspace, scenario.root)).toMatchObject(
        {
          actorId: scenario.rootBot,
        }
      )
      expect(
        await BotRuntimeSessionLinkRepository.findActiveByStream(pool, {
          workspaceId: scenario.workspace,
          botId: scenario.rootBot,
          rootStreamId: scenario.root,
          activeStreamId: scenario.root,
        })
      ).toMatchObject({ runtimeSessionId: scenario.rootSession })
    })
  }

  test("should reject a competing bot attach to an already linked thread", async () => {
    const scenario = await seedScenario("claude-code-channel", "pi-local")
    const competitor = await createBot(scenario.workspace, scenario.owner, "Competitor")

    await expect(
      new BotRuntimeService({ pool, streamService: new StreamService(pool) }).attachRuntimeSessionToThread({
        workspaceId: scenario.workspace,
        botId: competitor,
        ownerUserId: scenario.owner,
        runtimeKind: "pi-local",
        instanceId: `competitor-${crypto.randomUUID()}`,
        runtimeSessionId: `competitor-session-${crypto.randomUUID()}`,
        rootStreamId: scenario.root,
        anchorId: scenario.anchorId,
        displayName: "Competing work",
        traits: ["active-scratchpad"],
      })
    ).rejects.toMatchObject({ status: 409, code: "THREAD_SESSION_EXISTS" })
  })

  test("should serialize competing cross-bot attaches", async () => {
    const workspace = workspaceId()
    const root = streamId()
    const owner = (await addTestMember(pool, workspace, `workos-${crypto.randomUUID()}`)).id
    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)",
      [root, workspace, owner]
    )
    await StreamMemberRepository.insert(pool, root, owner)
    const firstBot = await createBot(workspace, owner, "First competitor")
    const secondBot = await createBot(workspace, owner, "Second competitor")
    const anchor = await insertMessage(root, owner, "contested anchor")
    const attach = (botId: string) =>
      new BotRuntimeService({ pool, streamService: new StreamService(pool) }).attachRuntimeSessionToThread({
        workspaceId: workspace,
        botId,
        ownerUserId: owner,
        runtimeKind: "pi-local",
        instanceId: `competitor-${botId}`,
        runtimeSessionId: `competitor-session-${botId}`,
        rootStreamId: root,
        anchorId: anchor.id,
        displayName: "Competing work",
        traits: ["active-scratchpad"],
      })

    const results = await Promise.allSettled([attach(firstBot), attach(secondBot)])
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"])
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
    expect(rejected?.reason).toMatchObject({ status: 409, code: "THREAD_SESSION_EXISTS" })
  })

  test("should keep one owner when competing attaches reuse an existing empty thread", async () => {
    const scenario = await seedScenario("claude-code-channel", "pi-local")
    const service = new BotRuntimeService({ pool, streamService: new StreamService(pool) })
    await service.endRuntimeSession({
      workspaceId: scenario.workspace,
      botId: scenario.childBot,
      instanceId: scenario.childInstance,
      runtimeSessionId: scenario.childSession,
    })
    const originalRead = StreamRepository.findByIdForWorkspaceForShare
    let reads = 0
    let releaseReads!: () => void
    const bothRead = new Promise<void>((resolve) => {
      releaseReads = resolve
    })
    const readSpy = spyOn(StreamRepository, "findByIdForWorkspaceForShare").mockImplementation(async (...args) => {
      const result = await originalRead(...args)
      if (args[1] === scenario.root) {
        reads += 1
        if (reads === 2) releaseReads()
        await bothRead
      }
      return result
    })
    try {
      const attach = (botId: string) =>
        service.attachRuntimeSessionToThread({
          workspaceId: scenario.workspace,
          botId,
          ownerUserId: scenario.owner,
          runtimeKind: "pi-local",
          instanceId: `existing-${botId}`,
          runtimeSessionId: `existing-session-${botId}`,
          rootStreamId: scenario.root,
          anchorId: scenario.anchorId,
          displayName: "Existing thread",
          traits: ["active-scratchpad"],
        })
      const results = await Promise.allSettled([attach(scenario.rootBot), attach(scenario.childBot)])
      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"])
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
      expect(rejected?.reason).toMatchObject({ status: 409, code: "THREAD_SESSION_EXISTS" })
    } finally {
      readSpy.mockRestore()
    }
  })

  test("should fail routing when legacy data has competing active bot links", async () => {
    const scenario = await seedScenario("claude-code-channel", "pi-local")
    await BotRuntimeSessionLinkRepository.upsert(pool, {
      id: `brsl_${crypto.randomUUID().replaceAll("-", "")}`,
      workspaceId: scenario.workspace,
      botId: scenario.rootBot,
      runtimeKind: "claude-code-channel",
      instanceId: `legacy-${crypto.randomUUID()}`,
      runtimeSessionId: `legacy-session-${crypto.randomUUID()}`,
      rootStreamId: scenario.root,
      activeStreamId: scenario.thread,
      linkedBy: scenario.owner,
    })
    const message = await insertMessage(scenario.thread, scenario.owner, "ambiguous child turn")

    await expect(
      new BotRuntimeService({ pool }).reconcileInvocationSource({
        workspaceId: scenario.workspace,
        sourceMessageId: message.id,
      })
    ).rejects.toMatchObject({ status: 409, code: "RUNTIME_ROUTE_AMBIGUOUS" })
  })

  test("should reattach an archived child without replacing the root actor", async () => {
    const scenario = await seedScenario("claude-code-channel", "pi-local")
    const service = new BotRuntimeService({ pool })
    await pool.query("UPDATE streams SET archived_at = NOW() WHERE workspace_id = $1 AND id = $2", [
      scenario.workspace,
      scenario.root,
    ])
    await service.endSessionsForArchivedStream({ workspaceId: scenario.workspace, rootStreamId: scenario.root })
    await pool.query("UPDATE streams SET archived_at = NULL WHERE workspace_id = $1 AND id = $2", [
      scenario.workspace,
      scenario.root,
    ])

    expect(
      await service.reattachArchivedRuntimeSession({
        workspaceId: scenario.workspace,
        botId: scenario.childBot,
        runtimeKind: "pi-local",
        instanceId: scenario.childInstance,
        runtimeSessionId: scenario.childSession,
      })
    ).toMatchObject({ status: "reattached" })
    expect(await StreamActiveActorRepository.findByRootStream(pool, scenario.workspace, scenario.root)).toMatchObject({
      actorId: scenario.rootBot,
    })
  })
})
