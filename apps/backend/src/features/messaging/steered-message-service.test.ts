import { describe, expect, it, mock } from "bun:test"
import { MessageErrorCodes } from "@threa/types"
import { SteeredMessageService } from "./steered-message-service"

describe("SteeredMessageService", () => {
  it("fails before writing invocations when steer is unavailable", async () => {
    const createInvocationInTransaction = mock(async () => ({ invocation: {}, wasNewlyInserted: true }))
    const service = new SteeredMessageService({
      commandAvailabilityService: {
        resolveCommandInTransaction: mock(async () => null),
      } as never,
      botRuntimeService: { createInvocationInTransaction } as never,
    })

    await expect(
      service.dispatchInTransaction({} as never, {
        workspaceId: "ws_1",
        streamId: "stream_1",
        userId: "usr_1",
        message: { id: "msg_1", contentMarkdown: "hello /steer" } as never,
      })
    ).rejects.toMatchObject({ status: 409, code: MessageErrorCodes.STEER_UNAVAILABLE })
    expect(createInvocationInTransaction).not.toHaveBeenCalled()
  })
})
