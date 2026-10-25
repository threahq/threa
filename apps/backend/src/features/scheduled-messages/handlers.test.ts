import { describe, expect, it, mock } from "bun:test"
import type { Request, Response } from "express"
import type { JSONContent } from "@threahq/types"
import { createScheduledMessagesHandlers } from "./handlers"

const widgetDoc: JSONContent = { type: "doc", content: [{ type: "widget" }] }

const validationError = {
  message: "Validation failed",
  status: 400,
  code: "VALIDATION_ERROR",
  details: { contentJson: ["Unknown node type: widget"] },
}

function setup() {
  const schedule = mock(async (_params: unknown) => ({ id: "sched_1" }))
  const update = mock(async (_params: unknown) => ({ id: "sched_1" }))
  const handlers = createScheduledMessagesHandlers({ scheduledMessagesService: { schedule, update } as never })
  const res = { status: () => res, json: () => res } as unknown as Response
  const request = (extra: Record<string, unknown>) =>
    ({ user: { id: "usr_1" }, workspaceId: "ws_1", ...extra }) as unknown as Request
  const create = (contentJson: JSONContent) =>
    handlers.create(
      request({ body: { streamId: "stream_1", contentJson, scheduledFor: "2030-01-01T00:00:00.000Z" } }),
      res
    )
  const edit = (contentJson: JSONContent) =>
    handlers.update(request({ params: { id: "sched_1" }, body: { contentJson, expectedVersion: 1 } }), res)
  return { schedule, update, create, edit }
}

describe("scheduled message handlers validate contentJson against the editor schema", () => {
  it("should reject with 400 and the node error before scheduling when the doc has an unknown node type", async () => {
    const { schedule, create } = setup()

    const result = create(widgetDoc)

    await expect(result).rejects.toMatchObject(validationError)
    expect(schedule).not.toHaveBeenCalled()
  })

  it("should reject with 400 and the node error before updating when the edited doc has an unknown node type", async () => {
    const { update, edit } = setup()

    const result = edit(widgetDoc)

    await expect(result).rejects.toMatchObject(validationError)
    expect(update).not.toHaveBeenCalled()
  })

  it("should schedule the client's contentJson unchanged when the doc is valid", async () => {
    const { schedule, create } = setup()
    const contentJson: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "later", marks: [{ type: "bold" }] }] }],
    }

    await create(contentJson)

    expect(schedule.mock.calls[0]?.[0]).toMatchObject({ contentJson, contentMarkdown: "**later**" })
  })
})
