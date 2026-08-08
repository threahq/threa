import { describe, expect, spyOn, test } from "bun:test"
import { MessageRepository } from "../messaging"
import { prependThreadNamingAnchor, renderNamingEventAnchor } from "./naming-context"

const db = {} as never
const stream = { parentAnchorId: "msg_root" } as never
const message = (id: string, contentMarkdown: string) => ({ id, contentMarkdown }) as never

describe("thread naming context", () => {
  test("prepends the canonical message anchor", async () => {
    const findRoot = spyOn(MessageRepository, "findThreadRoot").mockResolvedValue(message("msg_root", "Anchor"))
    await expect(prependThreadNamingAnchor(db, stream, [message("msg_reply", "Reply")])).resolves.toEqual([
      message("msg_root", "Anchor"),
      message("msg_reply", "Reply"),
    ])
    findRoot.mockRestore()
  })

  test("returns replies when no anchor resolves", async () => {
    const findRoot = spyOn(MessageRepository, "findThreadRoot").mockResolvedValue(null)
    await expect(prependThreadNamingAnchor(db, stream, [message("msg_reply", "Reply")])).resolves.toEqual([
      message("msg_reply", "Reply"),
    ])
    findRoot.mockRestore()
  })

  test("allowlists structured event fields without dumping payload JSON", () => {
    expect(
      renderNamingEventAnchor("delegation:created", {
        title: "Audit",
        brief: "Check access",
        assigneeActorId: "bot_1",
        assigneeActorType: "bot",
        secret: "do not leak",
      })
    ).toBe("Delegation: Audit\n\nCheck access")
    expect(renderNamingEventAnchor("delegation:completed", { title: "Audit", summary: "Done" })).toBeNull()
    expect(renderNamingEventAnchor("unknown", { title: "Audit", secret: "do not leak" })).toBeNull()
    expect(renderNamingEventAnchor("call_started", { mode: "audio_only", secret: "do not leak" })).toBe(
      "Call started (audio)"
    )
  })
})
