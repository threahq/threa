import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { BotInvocationCapabilities, BotTraits, WORKSPACE_PERMISSION_SCOPES, type BotRuntimeKind } from "@threahq/types"
import {
  botApiPost,
  createBot,
  createBotKey,
  createWorkspace,
  dispatchCommand,
  loginAs,
  sendMessage,
  TestClient,
} from "../client"

setDefaultTimeout(60_000)

interface Runtime {
  botId: string
  apiKey: string
  runtimeKind: BotRuntimeKind
  instanceId: string
  runtimeSessionId: string
}

interface Link {
  linkId: string
  rootStreamId: string
  activeStreamId: string
}

interface Claim {
  id: string
  sourceMessageId: string
  responseStreamId: string
  runtimeSessionId: string
  claimToken: string
  metadata: { command?: { name: string } }
}

describe("cross-bot runtime HTTP lifecycle", () => {
  for (const [parentKind, childKind, childCommand] of [
    ["claude-code-channel", "pi-local", "pi"],
    ["pi-local", "claude-code-channel", "claude"],
  ] as const) {
    test(`should preserve ${parentKind} parent through a ${childKind} child spawn, brief, turns, and done`, async () => {
      const suffix = crypto.randomUUID().slice(0, 8)
      const client = new TestClient()
      await loginAs(client, `cross-runtime-${suffix}@test.com`, "Cross-runtime owner")
      const workspace = await createWorkspace(client, `Cross-runtime ${suffix}`)

      async function runtime(kind: BotRuntimeKind, role: string): Promise<Runtime> {
        const bot = await createBot(client, workspace.id, {
          type: "personal",
          name: `${role} ${suffix}`,
          slug: `${role}-${suffix}`,
          traits: [BotTraits.ACTIVE_SCRATCHPAD, BotTraits.MENTIONABLE],
        })
        const apiKey = await createBotKey(client, workspace.id, bot.id, [
          WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE,
          WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE,
          WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE,
        ])
        return {
          botId: bot.id,
          apiKey,
          runtimeKind: kind,
          instanceId: `${role}-inst-${suffix}`,
          runtimeSessionId: `${role}-sess-${suffix}`,
        }
      }

      async function announce(target: Runtime) {
        const result = await botApiPost(client, workspace.id, "/bot-runtime/presence", target.apiKey, {
          runtimeKind: target.runtimeKind,
          instanceId: target.instanceId,
          status: "available",
          acceptingInvocations: true,
          capabilities: {
            runtimeSessionId: target.runtimeSessionId,
            supportsActiveScratchpad: true,
            supportsPersistentSessions: true,
            supportsSessionControlCommands: true,
            sessionControlCommands: ["spawn", "status", "done"],
          },
        })
        expect(result.status).toBe(200)
      }

      async function claim(target: Runtime): Promise<Claim> {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const result = await botApiPost<{ data: Claim | null }>(
            client,
            workspace.id,
            "/bot-invocations/claim",
            target.apiKey,
            {
              runtimeKind: target.runtimeKind,
              instanceId: target.instanceId,
              runtimeSessionId: target.runtimeSessionId,
              supportedCapabilities: [
                BotInvocationCapabilities.ACTIVE_SCRATCHPAD,
                BotInvocationCapabilities.SESSION_CONTROL,
              ],
              claimTtlSeconds: 120,
            }
          )
          expect(result.status).toBe(200)
          if (result.data.data) return result.data.data
          await Bun.sleep(250)
        }
        throw new Error(`No invocation reached ${target.runtimeKind} ${target.instanceId}`)
      }

      async function complete(target: Runtime, invocation: Claim) {
        const result = await botApiPost(
          client,
          workspace.id,
          `/bot-invocations/${invocation.id}/complete`,
          target.apiKey,
          {
            instanceId: target.instanceId,
            claimToken: invocation.claimToken,
            noResponse: true,
          }
        )
        expect(result.status).toBe(200)
      }

      async function proveTurn(target: Runtime, streamId: string, content: string) {
        const message = await sendMessage(client, workspace.id, streamId, content)
        const invocation = await claim(target)
        expect(invocation).toMatchObject({
          sourceMessageId: message.id,
          responseStreamId: streamId,
          runtimeSessionId: target.runtimeSessionId,
        })
        await complete(target, invocation)
      }

      const parent = await runtime(parentKind, "parent")
      const child = await runtime(childKind, "child")
      const root = await botApiPost<{ data: Link }>(client, workspace.id, "/bot-runtime/sessions", parent.apiKey, {
        runtimeKind: parent.runtimeKind,
        instanceId: parent.instanceId,
        runtimeSessionId: parent.runtimeSessionId,
        displayName: "Parent desk",
      })
      expect(root.status).toBe(200)
      const rootId = root.data.data.rootStreamId
      await announce(parent)
      await proveTurn(parent, rootId, "Parent before spawn")

      const dispatch = await dispatchCommand(client, workspace.id, rootId, `/spawn ${childCommand} child\nSay hello`)
      expect(dispatch.success).toBe(true)
      const spawn = await claim(parent)
      expect(spawn).toMatchObject({
        runtimeSessionId: parent.runtimeSessionId,
        metadata: { command: { name: "spawn" } },
      })
      expect(spawn.sourceMessageId.startsWith("msg_")).toBe(true)
      await complete(parent, spawn)

      const attached = await botApiPost<{ data: Link }>(client, workspace.id, "/bot-runtime/sessions", child.apiKey, {
        runtimeKind: child.runtimeKind,
        instanceId: child.instanceId,
        runtimeSessionId: child.runtimeSessionId,
        displayName: "Child session",
        attachTo: { rootStreamId: rootId, anchorId: spawn.sourceMessageId },
      })
      expect(attached.status).toBe(200)
      const thread = attached.data.data.activeStreamId
      await announce(child)
      const notice = await botApiPost(client, workspace.id, `/streams/${thread}/messages`, child.apiKey, {
        content: "Child session is ready for a prompt",
      })
      expect(notice.status).toBe(201)
      await proveTurn(child, thread, "First user brief after the child notice")

      const brief = await botApiPost(client, workspace.id, "/bot-runtime/sessions/brief", child.apiKey, {
        instanceId: child.instanceId,
        runtimeSessionId: child.runtimeSessionId,
        content: "Say hello",
      })
      expect(brief.status).toBe(201)
      const briefClaim = await claim(child)
      expect(briefClaim).toMatchObject({
        sourceMessageId: spawn.sourceMessageId,
        responseStreamId: thread,
        runtimeSessionId: child.runtimeSessionId,
      })
      await complete(child, briefClaim)
      await proveTurn(parent, rootId, "Parent during child session")
      await proveTurn(child, thread, "Child follow-up")

      const doneDispatch = await dispatchCommand(client, workspace.id, thread, "/done")
      expect(doneDispatch.success).toBe(true)
      const done = await claim(child)
      expect(done).toMatchObject({ runtimeSessionId: child.runtimeSessionId, metadata: { command: { name: "done" } } })
      await complete(child, done)
      const ended = await botApiPost(client, workspace.id, "/bot-runtime/sessions/end", child.apiKey, {
        instanceId: child.instanceId,
        runtimeSessionId: child.runtimeSessionId,
      })
      expect(ended).toMatchObject({
        status: 200,
        data: { data: { linkId: attached.data.data.linkId, activeStreamId: thread, status: "ended" } },
      })
      const doneNotice = await botApiPost(client, workspace.id, `/streams/${thread}/messages`, parent.apiKey, {
        content: "Child session ended",
      })
      expect(doneNotice.status).toBe(201)
      await proveTurn(parent, rootId, "Parent after child session")
    })
  }
})
