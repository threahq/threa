import { afterEach, describe, expect, it, mock } from "bun:test"
import { CommandKinds, MessageErrorCodes } from "@threahq/types"
import { EnqueuedMessageService } from "./enqueued-message-service"

afterEach(() => mock.restore())

const params = {
  workspaceId: "ws_1",
  streamId: "stream_1",
  userId: "usr_1",
  message: { id: "msg_1" } as never,
}

function serviceResolving(resolved: unknown, enqueued: boolean) {
  const enqueueMessageInTransaction = mock(async () => enqueued)
  const service = new EnqueuedMessageService({
    commandAvailabilityService: { resolveCommandInTransaction: mock(async () => resolved) } as never,
    botRuntimeService: { enqueueMessageInTransaction } as never,
  })
  return { service, enqueueMessageInTransaction }
}

describe("EnqueuedMessageService", () => {
  it("fails before writing when no linked runtime offers enqueue", async () => {
    const { service, enqueueMessageInTransaction } = serviceResolving(null, true)

    await expect(service.enqueueInTransaction({} as never, params)).rejects.toMatchObject({
      status: 409,
      code: MessageErrorCodes.ENQUEUE_UNAVAILABLE,
    })
    expect(enqueueMessageInTransaction).not.toHaveBeenCalled()
  })

  it("fails when the router would not deliver the message to the linked bot", async () => {
    const { service, enqueueMessageInTransaction } = serviceResolving(
      { executionKind: CommandKinds.BOT_RUNTIME, runtime: { botId: "bot_1" } },
      false
    )

    await expect(service.enqueueInTransaction({} as never, params)).rejects.toMatchObject({
      status: 409,
      code: MessageErrorCodes.ENQUEUE_UNAVAILABLE,
    })
    expect(enqueueMessageInTransaction.mock.calls).toEqual([
      [{}, { workspaceId: "ws_1", sourceMessageId: "msg_1", botId: "bot_1" }] as never,
    ])
  })
})
