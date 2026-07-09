import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import { MessageRepository } from "../messaging"
import { AttachmentRepository, AttachmentReferenceRepository } from "../attachments"
import { MemoRepository } from "../memos"
import { validateDelegationContextRefs } from "./context-refs"

const pool = {} as Pool
const WS = "ws_1"
const IN_SCOPE = ["stream_1", "stream_2"]

function run(refs: string[]) {
  return validateDelegationContextRefs({ pool, workspaceId: WS, accessibleStreamIds: IN_SCOPE, refs })
}

describe("validateDelegationContextRefs", () => {
  afterEach(() => mock.restore())

  it("accepts a shared-message ref whose message exists in-workspace, in its claimed stream, in scope", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_1", { streamId: "stream_1" }]]) as never
    )

    const result = await run(["shared-message:stream_1/msg_1"])

    expect(result).toEqual({ accepted: ["shared-message:stream_1/msg_1"], dropped: [] })
  })

  it("drops shared-message refs that are missing, stream-mismatched, or out of the user's scope — in ONE batched lookup", async () => {
    const findByIds = spyOn(MessageRepository, "findByIdsInWorkspace").mockImplementation(
      async (_db, _ws, ids) =>
        new Map(
          (ids as string[])
            .filter((id) => id !== "msg_missing")
            .map((id) => [id, { streamId: id === "msg_elsewhere" ? "stream_other" : "stream_secret" }])
        ) as never
    )

    const result = await run([
      "shared-message:stream_1/msg_missing",
      "shared-message:stream_1/msg_elsewhere",
      "shared-message:stream_secret/msg_private",
    ])

    expect(result.accepted).toEqual([])
    expect(result.dropped).toEqual([
      { ref: "shared-message:stream_1/msg_missing", reason: "message-not-found" },
      { ref: "shared-message:stream_1/msg_elsewhere", reason: "stream-mismatch" },
      { ref: "shared-message:stream_secret/msg_private", reason: "stream-out-of-scope" },
    ])
    // Batched per kind (the strip-inaccessible-refs shape) — never one round trip per ref.
    expect(findByIds).toHaveBeenCalledTimes(1)
  })

  it("accepts active memos and drops missing/retired ones (LLMs hallucinate ids)", async () => {
    spyOn(MemoRepository, "findByIdsInWorkspace").mockImplementation(
      async (_db, _ws, ids) =>
        new Map(
          (ids as string[])
            .filter((id) => id !== "memo_missing")
            .map((id) => [id, { status: id === "memo_retired" ? "superseded" : "active" }])
        ) as never
    )

    const result = await run(["memo:memo_ok", "memo:memo_retired", "memo:memo_missing"])

    expect(result.accepted).toEqual(["memo:memo_ok"])
    expect(result.dropped).toEqual([
      { ref: "memo:memo_retired", reason: "memo-not-active" },
      { ref: "memo:memo_missing", reason: "memo-not-found" },
    ])
  })

  it("gates attachments on workspace + malware-clean + stream reach (direct or via references)", async () => {
    spyOn(AttachmentRepository, "findByIds").mockImplementation(
      async (_db, ids) =>
        (ids as string[]).map((id) => ({
          id,
          workspaceId: WS,
          safetyStatus: id === "att_dirty" ? "pending" : "clean",
          streamId: id === "att_ok" ? "stream_1" : "stream_secret",
        })) as never
    )
    spyOn(AttachmentReferenceRepository, "findReferencingStreamIds").mockImplementation(async (_db, _ws, id) =>
      id === "att_reachable_via_ref" ? ["stream_2"] : []
    )

    const result = await run([
      "attachment:att_ok",
      "attachment:att_dirty",
      "attachment:att_reachable_via_ref",
      "attachment:att_unreachable",
    ])

    expect(result.accepted).toEqual(["attachment:att_ok", "attachment:att_reachable_via_ref"])
    expect(result.dropped).toEqual([
      { ref: "attachment:att_dirty", reason: "attachment-not-clean" },
      { ref: "attachment:att_unreachable", reason: "attachment-out-of-scope" },
    ])
  })

  it("drops unsupported schemes and malformed pointer URLs without touching the DB", async () => {
    const messages = spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map() as never)

    const result = await run(["https://example.com/doc", "quote:stream_1/msg_1", "shared-message:only-one-segment"])

    expect(result.accepted).toEqual([])
    expect(result.dropped.map((d) => d.reason)).toEqual([
      "unsupported-scheme",
      "unsupported-scheme",
      "unsupported-scheme",
    ])
    expect(messages).not.toHaveBeenCalled()
  })
})
