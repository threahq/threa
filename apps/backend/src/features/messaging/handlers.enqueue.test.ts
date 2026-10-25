import { afterEach, describe, expect, it, mock } from "bun:test"
import type { Pool } from "pg"
import { CommandKinds } from "@threahq/types"
import { createMessageHandlers, createMessageSchema } from "./handlers"
import { EnqueuedMessageService } from "./enqueued-message-service"

afterEach(() => mock.restore())

function setup({ e2eEnabled = false } = {}) {
  const order: string[] = []
  const message = { id: "msg_1", streamId: "stream_1", contentMarkdown: "I want option 2", ciphertext: null }
  const createMessageForPrincipalReturningConversation = mock(
    async (_principal: unknown, _params: unknown, onCreated?: (db: unknown, message: unknown) => Promise<void>) => {
      order.push("message")
      await onCreated?.({}, message)
      return { message }
    }
  )
  const enqueueMessageInTransaction = mock(async (_db: unknown, params: unknown) => {
    order.push("enqueue")
    return params !== undefined
  })
  const handlers = createMessageHandlers({
    pool: {} as Pool,
    eventService: { createMessageForPrincipalReturningConversation } as never,
    streamService: {
      resolveMessageWriteTarget: mock(async () => ({ kind: "local", stream: { id: "stream_1", e2eEnabled } })),
    } as never,
    enqueuedMessageService: new EnqueuedMessageService({
      commandAvailabilityService: {
        resolveCommandInTransaction: mock(async () => ({
          executionKind: CommandKinds.BOT_RUNTIME,
          runtime: { botId: "bot_1" },
        })),
      } as never,
      botRuntimeService: { enqueueMessageInTransaction } as never,
    }),
    streamConnectionForwardService: null,
  })
  const response = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json() {
      return this
    },
  }
  const sendBody = (content: Record<string, unknown>) =>
    handlers.create(
      {
        user: { id: "usr_1" },
        workspaceId: "ws_1",
        body: { streamId: "stream_1", ...content, enqueue: true, clientMessageId: "temp_1" },
      } as never,
      response as never
    )
  const send = (firstInline: Record<string, unknown>) =>
    sendBody({ contentJson: { type: "doc", content: [{ type: "paragraph", content: [firstInline] }] } })
  return { order, enqueueMessageInTransaction, response, send, sendBody }
}

describe("message + enqueue send", () => {
  const encrypted = {
    ciphertext: "Y2lwaGVydGV4dA==",
    envelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "msg_1" },
    e2eVersion: 2,
  }

  it("accepts the cleartext enqueue flag beside an E2E message and attachments", () => {
    expect(
      createMessageSchema.safeParse({ streamId: "stream_1", ...encrypted, attachmentIds: ["att_1"], enqueue: true })
        .success
    ).toBe(true)
  })

  it("queues an E2E message in its creating callback", async () => {
    const { order, response, sendBody } = setup({ e2eEnabled: true })

    await sendBody(encrypted)

    expect({ order, status: response.statusCode }).toEqual({ order: ["message", "enqueue"], status: 201 })
  })

  it("persists the authored message, then queues it in the same callback", async () => {
    const { order, enqueueMessageInTransaction, response, send } = setup()

    await send({ type: "text", text: "I want option 2" })

    expect({
      order,
      enqueued: enqueueMessageInTransaction.mock.calls.map(([, params]) => params),
      status: response.statusCode,
    }).toEqual({
      order: ["message", "enqueue"],
      enqueued: [{ workspaceId: "ws_1", sourceMessageId: "msg_1", botId: "bot_1" }],
      status: 201,
    })
  })
})
