import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import { CommandKinds } from "@threahq/types"
import { createMessageHandlers, createMessageSchema } from "./handlers"
import { SteeredMessageService } from "./steered-message-service"
import { StreamEventRepository } from "../streams"
import { OutboxRepository } from "../../lib/outbox"

afterEach(() => mock.restore())

describe("message + steer composite send", () => {
  it("accepts the cleartext steer flag beside an E2E message and attachments", () => {
    expect(
      createMessageSchema.safeParse({
        streamId: "stream_1",
        ciphertext: "Y2lwaGVydGV4dA==",
        envelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "msg_1" },
        e2eVersion: 2,
        attachmentIds: ["att_1"],
        steer: true,
      }).success
    ).toBe(true)
  })

  it("persists the authored message, then creates the normal turn, command event, and steer in one callback", async () => {
    const order: string[] = []
    const message = {
      id: "msg_1",
      streamId: "stream_1",
      contentMarkdown: "/steer I want option 2",
      ciphertext: null,
    }
    const createMessageForPrincipalReturningConversation = mock(
      async (
        principal: { kind: string; userId: string },
        params: { contentMarkdown: string },
        onCreated?: (db: unknown, message: unknown) => Promise<void>
      ) => {
        order.push("message")
        expect(principal).toEqual({ kind: "user", userId: "usr_1" })
        expect(params.contentMarkdown).toBe("/steer I want option 2")
        await onCreated?.({ query: mock(async () => ({ rows: [], rowCount: 0 })) }, message)
        return { message }
      }
    )
    const eventService = { createMessageForPrincipalReturningConversation }
    const commandAvailabilityService = {
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
        },
      })),
    }
    const createInvocationInTransaction = mock(async (_db, params: { trigger: string }) => {
      order.push(params.trigger === "active-scratchpad" ? "message-invocation" : "steer-invocation")
      return { invocation: {}, wasNewlyInserted: true }
    })
    spyOn(StreamEventRepository, "insert").mockImplementation(async (_db, params) => {
      order.push("command-event")
      return {
        id: "evt_command",
        streamId: params.streamId,
        sequence: 2n,
        broadcastSequence: null,
        eventType: params.eventType,
        payload: params.payload,
        actorId: params.actorId ?? null,
        actorType: params.actorType ?? null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      }
    })
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

    const steeredMessageService = new SteeredMessageService({
      commandAvailabilityService: commandAvailabilityService as never,
      botRuntimeService: { createInvocationInTransaction } as never,
    })
    const handlers = createMessageHandlers({
      pool: {} as Pool,
      eventService: eventService as never,
      streamService: {
        resolveWritableMessageStream: mock(async () => ({ id: "stream_1", e2eEnabled: false })),
      } as never,
      commandRegistry: {} as never,
      steeredMessageService,
    })
    const response = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code
        return this
      },
      json(body: unknown) {
        this.body = body
        return this
      },
    }

    await handlers.create(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        body: {
          streamId: "stream_1",
          contentJson: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "/steer I want option 2" }] }],
          },
          steer: true,
          clientMessageId: "temp_1",
        },
      } as never,
      response as never
    )

    expect(createMessageForPrincipalReturningConversation).toHaveBeenCalledTimes(1)
    expect(order).toEqual(["message", "message-invocation", "command-event", "steer-invocation"])
    expect(createInvocationInTransaction.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      expect.objectContaining({
        sourceMessageId: "msg_1",
        trigger: "active-scratchpad",
        promptMarkdown: "/steer I want option 2",
      }),
      expect.objectContaining({
        sourceMessageId: "msg_1",
        trigger: "session-control",
        requiredCapability: "active-scratchpad",
        promptMarkdown: "/steer",
        metadata: {
          command: expect.objectContaining({ name: "steer", args: "", executionKind: "bot-runtime" }),
          steeredMessage: true,
        },
      }),
    ])
    expect(response.statusCode).toBe(201)
  })
})
