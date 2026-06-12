import { describe, expect, it, mock } from "bun:test"
import {
  TurnDeliveries,
  isDeclaredUnsupported,
  type SynchronousTurnDriver,
  type TurnDispatchBinding,
} from "@threa/agent-runtime"
import { ExternalTurnDriver } from "./external-turn-driver"
import type { BotRuntimeService } from "./service"

const binding: TurnDispatchBinding = {
  workspaceId: "ws_1",
  actorId: "bot_alice",
  rootStreamId: "stream_root",
  activeStreamId: "stream_active",
  responseStreamId: "stream_resp",
  sourceMessageId: "msg_src",
  authorUserId: "usr_owner",
  trigger: "mention",
  requiredCapability: "mentionable",
  mentionedActorSlugs: ["alice"],
  targetInstanceId: null,
  targetRuntimeSessionId: null,
  metadata: {},
}

function makeDriver(result: { wasNewlyInserted: boolean }) {
  const createInvocation = mock(async (_params: unknown) => ({
    invocation: { id: "inv_1" },
    wasNewlyInserted: result.wasNewlyInserted,
  }))
  const driver = new ExternalTurnDriver({ service: { createInvocation } as unknown as BotRuntimeService })
  return { driver, createInvocation }
}

const externalRequest = (content: string) => ({
  delivery: TurnDeliveries.EXTERNAL,
  messages: [{ role: "user" as const, content }],
})

describe("ExternalTurnDriver", () => {
  it("maps the binding onto createInvocation exactly and returns a dispatched receipt", async () => {
    const { driver, createInvocation } = makeDriver({ wasNewlyInserted: true })

    const receipt = await driver.dispatchTurn(externalRequest("hello @alice"), binding)

    expect(createInvocation.mock.calls[0]?.[0]).toEqual({
      workspaceId: "ws_1",
      rootStreamId: "stream_root",
      activeStreamId: "stream_active",
      sourceMessageId: "msg_src",
      responseStreamId: "stream_resp",
      actorId: "bot_alice",
      trigger: "mention",
      requiredCapability: "mentionable",
      promptMarkdown: "hello @alice",
      authorUserId: "usr_owner",
      mentionedActorSlugs: ["alice"],
      targetInstanceId: null,
      targetRuntimeSessionId: null,
      metadata: {},
    })
    expect(receipt).toEqual({ invocationId: "inv_1", status: "dispatched" })
  })

  it("returns a deduplicated receipt on an idempotent re-dispatch", async () => {
    const { driver } = makeDriver({ wasNewlyInserted: false })

    const receipt = await driver.dispatchTurn(externalRequest("hello again"), binding)

    expect(receipt).toEqual({ invocationId: "inv_1", status: "deduplicated" })
  })

  it("refuses a non-external delivery before any dispatch", async () => {
    const { driver, createInvocation } = makeDriver({ wasNewlyInserted: true })

    await expect(
      driver.dispatchTurn({ ...externalRequest("hi"), delivery: TurnDeliveries.PLAINTEXT }, binding)
    ).rejects.toThrow('serves "external" turns')
    expect(createInvocation).not.toHaveBeenCalled()
  })

  it("rejects a request that ships loop history instead of the single trigger prompt", async () => {
    const { driver, createInvocation } = makeDriver({ wasNewlyInserted: true })

    await expect(
      driver.dispatchTurn(
        {
          delivery: TurnDeliveries.EXTERNAL,
          messages: [
            { role: "user", content: "earlier history" },
            { role: "user", content: "the prompt" },
          ],
        },
        binding
      )
    ).rejects.toThrow("single plain-text user prompt")
    expect(createInvocation).not.toHaveBeenCalled()
  })

  it("declares its sink edges: durable verbs for commit and trace, loud gaps for the rest", () => {
    const { driver } = makeDriver({ wasNewlyInserted: true })

    const declaredGaps = Object.fromEntries(
      Object.entries(driver.sinkResolution).map(([edge, resolution]) => [edge, isDeclaredUnsupported(resolution)])
    )
    expect(declaredGaps).toEqual({
      commitMessage: false,
      observers: false,
      newMessages: true,
      shouldAbort: true,
      toolSignalProvider: true,
    })
  })

  it("is not a synchronous driver — there is no runTurn to await", () => {
    const { driver } = makeDriver({ wasNewlyInserted: true })

    // @ts-expect-error — ExternalTurnDriver cannot resolve a TurnResult in one call; the turn completes in a later request.
    const synchronous: SynchronousTurnDriver = driver
    expect("runTurn" in synchronous).toBe(false)
  })
})
