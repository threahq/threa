// A mention-driven bot: any runtime kind (here `custom`) can claim the work
// Threa creates when someone @mentions the bot, do it, and reply.
//
//   THREA_WORKSPACE_ID=ws_… THREA_API_KEY=threa_bk_… bun examples/mention-bot.ts
//
// The socket delivers "work is claimable" nudges and carries presence and claim
// renewals; the claim, the reply, and the poll backstop are plain HTTP.

import { BotRuntimeTransport } from "@threahq/bot-runtime-client"
import { ThreaClient } from "@threahq/remote-session"

const baseUrl = process.env.THREA_BASE_URL ?? "https://app.threa.io"
const workspaceId = process.env.THREA_WORKSPACE_ID!
const apiKey = process.env.THREA_API_KEY!
const instanceId = process.env.THREA_INSTANCE_ID ?? "mention-bot-1"
const runtimeKind = "custom"

const client = new ThreaClient({ baseUrl, workspaceId, apiKey })
const transport = new BotRuntimeTransport({
  baseUrl,
  workspaceId,
  apiKey,
  hello: { instanceId, runtimeKind, supportedCapabilities: ["mentionable"] },
  callbacks: { onInvocationAvailable: () => void drain(), onBootstrap: () => void drain() },
  log: (line) => console.error(`[transport] ${line}`),
})

const presence = (status: "available" | "busy" | "offline") =>
  transport.updatePresence({
    runtimeKind,
    instanceId,
    status,
    acceptingInvocations: status !== "offline",
    capabilities: {},
  })

let draining = false
async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    for (;;) {
      const invocation = await client.claim({
        runtimeKind,
        instanceId,
        supportedCapabilities: ["mentionable"],
        claimTtlSeconds: 120,
      })
      if (!invocation) return
      await presence("busy")
      // Renew while working so a slow answer never loses the claim; if the
      // server says the claim is gone, the reply has nowhere to land.
      let claimLost = false
      const renew = setInterval(async () => {
        const { notFound } = await transport.renewClaim(invocation.id, invocation.claimToken, 120)
        if (notFound) {
          claimLost = true
          clearInterval(renew)
          console.error(`[bot] claim ${invocation.id} lost (expired or reassigned); dropping the reply`)
        }
      }, 40_000)
      try {
        await transport.recordSteps(invocation.id, invocation.claimToken, [
          { stepType: "thinking", content: "Composing a reply" },
        ])
        const reply = await answer(invocation.promptMarkdown)
        if (claimLost) continue
        await client.complete(invocation.id, {
          instanceId,
          claimToken: invocation.claimToken,
          finalMessageMarkdown: reply,
        })
      } catch (error) {
        await client
          .fail(invocation.id, {
            instanceId,
            claimToken: invocation.claimToken,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
          .catch((failure) => console.error(`[bot] could not fail ${invocation.id}: ${failure}`))
      } finally {
        clearInterval(renew)
        await presence("available")
      }
    }
  } catch (error) {
    // A transient claim failure is logged; the socket nudge or the backstop
    // poll runs the loop again. Nothing here should end the process.
    console.error(`[bot] claim loop: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    draining = false
  }
}

// Replace with your agent.
async function answer(prompt: string): Promise<string> {
  return `You said: ${prompt}`
}

const backstop = setInterval(() => void drain(), 30_000)
const heartbeat = setInterval(() => void presence(draining ? "busy" : "available"), 20_000)
let stopping = false
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (stopping) return
    stopping = true
    clearInterval(backstop)
    clearInterval(heartbeat)
    transport.disconnect()
    await presence("offline")
    process.exit(0)
  })
}

await presence("available")
await transport.connect()
await drain()
