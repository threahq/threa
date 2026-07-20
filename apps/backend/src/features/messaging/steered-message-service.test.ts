import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { CommandKinds, MessageErrorCodes } from "@threa/types"
import { OutboxRepository } from "../../lib/outbox"
import { StreamEventRepository } from "../streams"
import { SteeredMessageService } from "./steered-message-service"

afterEach(() => mock.restore())

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

  it("uses mention routing when the source mentions the active mentionable bot", async () => {
    const createInvocationInTransaction = mock(async (_db: unknown, _params: unknown) => ({
      invocation: {},
      wasNewlyInserted: true,
    }))
    spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    const service = new SteeredMessageService({
      commandAvailabilityService: {
        resolveCommandInTransaction: mock(async () => ({
          executionKind: CommandKinds.BOT_RUNTIME,
          runtime: {
            botId: "bot_1",
            runtimeKind: "pi-local",
            rootStreamId: "stream_1",
            activeStreamId: "stream_1",
            responseStreamId: "stream_1",
            targetInstanceId: "pi_1",
            targetRuntimeSessionId: "session_1",
            supportsMentionable: true,
          },
        })),
      } as never,
      botRuntimeService: { createInvocationInTransaction } as never,
    })

    await service.dispatchInTransaction({} as never, {
      workspaceId: "ws_1",
      streamId: "stream_1",
      userId: "usr_1",
      message: {
        id: "msg_1",
        contentMarkdown: "@pi /steer focus here",
        contentJson: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "mention", attrs: { id: "bot_1", slug: "pi", mentionType: "bot" } },
                { type: "text", text: " /steer focus here" },
              ],
            },
          ],
        },
      } as never,
    })

    expect(createInvocationInTransaction.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        actorId: "bot_1",
        trigger: "mention",
        requiredCapability: "mentionable",
        mentionedActorSlugs: ["pi"],
      })
    )
  })
})
