import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { AttachmentSafetyStatuses, type JSONContent } from "@threa/types"
import { MessageRepository } from "../../messaging"
import { AttachmentRepository, AttachmentReferenceRepository } from "../../attachments"
import { MemoRepository } from "../../memos"
import { stripInaccessibleAgentRefs } from "./strip-inaccessible-refs"

const pool = {} as any

function sharedMessageNode(streamId: string, messageId: string): JSONContent {
  return {
    type: "sharedMessage",
    attrs: { streamId, messageId, authorName: "Alice" },
  }
}

function quoteReplyNode(streamId: string, messageId: string, snippet: string): JSONContent {
  return {
    type: "quoteReply",
    attrs: {
      streamId,
      messageId,
      authorName: "Alice",
      authorId: "user_alice",
      actorType: "user",
      snippet,
    },
  }
}

function attachmentRefNode(id: string, filename = "diagram.png", mimeType = "image/png"): JSONContent {
  return {
    type: "attachmentReference",
    attrs: { id, filename, mimeType, sizeBytes: 100, status: "uploaded", imageIndex: 1, error: null },
  }
}

function memoEmbedNode(memoId: string, title = "Auth rewrite"): JSONContent {
  return { type: "memoEmbed", attrs: { memoId, title } }
}

function paragraph(...children: JSONContent[]): JSONContent {
  return { type: "paragraph", content: children }
}

function doc(...children: JSONContent[]): JSONContent {
  return { type: "doc", content: children }
}

describe("stripInaccessibleAgentRefs", () => {
  afterEach(() => {
    mock.restore()
  })

  it("keeps refs whose source stream is in the agent's scope and resolves in the workspace", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_a", { id: "msg_a", streamId: "stream_a" } as any]])
    )
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
      { id: "att_a", workspaceId: "ws_1", streamId: "stream_a", safetyStatus: AttachmentSafetyStatuses.CLEAN } as any,
    ])

    const result = await stripInaccessibleAgentRefs({
      pool,
      workspaceId: "ws_1",
      targetStreamId: "stream_target",
      accessibleStreamIds: ["stream_a", "stream_target"],
      contentJson: doc(sharedMessageNode("stream_a", "msg_a"), paragraph(attachmentRefNode("att_a"))),
    })

    expect(result.dropped).toEqual([])
    // Both refs survive in the cleaned tree.
    expect(JSON.stringify(result.contentJson)).toContain("msg_a")
    expect(JSON.stringify(result.contentJson)).toContain("att_a")
  })

  it("drops sharedMessage when the source message id resolves to nothing in the workspace", async () => {
    // INV-8 collapses cross-workspace ids and in-workspace deny into "not
    // found" — both surface as an empty map here.
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([])

    const result = await stripInaccessibleAgentRefs({
      pool,
      workspaceId: "ws_1",
      targetStreamId: "stream_target",
      accessibleStreamIds: ["stream_a", "stream_target"],
      contentJson: doc(sharedMessageNode("stream_a", "msg_phantom")),
    })

    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]).toMatchObject({
      type: "sharedMessage",
      reason: "message-not-found",
      ids: { messageId: "msg_phantom" },
    })
    // The dropped node is removed from the tree.
    expect(JSON.stringify(result.contentJson)).not.toContain("msg_phantom")
    expect(JSON.stringify(result.contentJson)).not.toContain("sharedMessage")
  })

  it("drops sharedMessage when the source stream is outside the agent's scope", async () => {
    // The message exists in workspace, but the source stream is not in the
    // scope-restricted AgentAccessSpec reach (e.g. private channel msg from
    // a public-channel-invoked agent).
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_secret", { id: "msg_secret", streamId: "stream_private" } as any]])
    )
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([])

    const result = await stripInaccessibleAgentRefs({
      pool,
      workspaceId: "ws_1",
      targetStreamId: "stream_target",
      accessibleStreamIds: ["stream_target"],
      contentJson: doc(sharedMessageNode("stream_private", "msg_secret")),
    })

    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]).toMatchObject({
      type: "sharedMessage",
      reason: "stream-out-of-scope",
      ids: { messageId: "msg_secret", streamId: "stream_private" },
    })
  })

  it("drops sharedMessage when the message exists but in a different stream than the ref claims", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_a", { id: "msg_a", streamId: "stream_actual" } as any]])
    )
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([])

    const result = await stripInaccessibleAgentRefs({
      pool,
      workspaceId: "ws_1",
      targetStreamId: "stream_target",
      accessibleStreamIds: ["stream_actual", "stream_claimed", "stream_target"],
      contentJson: doc(sharedMessageNode("stream_claimed", "msg_a")),
    })

    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]).toMatchObject({
      type: "sharedMessage",
      reason: "stream-mismatch",
    })
  })

  it("validates cross-stream quoteReply but passes same-stream quoteReply through unchecked", async () => {
    const findSpy = spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([])

    const result = await stripInaccessibleAgentRefs({
      pool,
      workspaceId: "ws_1",
      // Target stream IS the quote's source stream — same-stream quote.
      targetStreamId: "stream_target",
      accessibleStreamIds: ["stream_target"],
      contentJson: doc(
        // Same-stream quote: target == source. Should not be validated.
        quoteReplyNode("stream_target", "msg_local", "local snippet"),
        // Cross-stream quote pointing at a missing message: should be dropped.
        quoteReplyNode("stream_other", "msg_phantom", "remote snippet")
      ),
    })

    // Only the cross-stream quote was validated, and its msg id was looked up.
    expect(findSpy.mock.calls[0]?.[2]).toEqual(["msg_phantom"])

    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]).toMatchObject({
      type: "quoteReply",
      reason: "message-not-found",
      ids: { messageId: "msg_phantom" },
    })
    // Same-stream quote survives.
    expect(JSON.stringify(result.contentJson)).toContain("msg_local")
    expect(JSON.stringify(result.contentJson)).toContain("local snippet")
  })

  it("drops attachmentReference when the attachment id is unknown or in another workspace", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
      { id: "att_other_ws", workspaceId: "ws_other", streamId: "stream_x" } as any,
    ])

    const result = await stripInaccessibleAgentRefs({
      pool,
      workspaceId: "ws_1",
      targetStreamId: "stream_target",
      accessibleStreamIds: ["stream_target"],
      contentJson: doc(paragraph(attachmentRefNode("att_phantom"), attachmentRefNode("att_other_ws"))),
    })

    expect(result.dropped).toHaveLength(2)
    expect(result.dropped.map((d) => d.reason).sort()).toEqual(["attachment-cross-workspace", "attachment-not-found"])
  })

  it("falls back to reference-projection scope when the attachment's own stream is out of scope", async () => {
    // Attachment lives in stream_source (not in scope), but referenced from
    // stream_visible (in scope). Mirrors AttachmentService.getAccessible —
    // the ref projection lets the agent re-surface what she could already see.
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
      {
        id: "att_a",
        workspaceId: "ws_1",
        streamId: "stream_source",
        safetyStatus: AttachmentSafetyStatuses.CLEAN,
      } as any,
    ])
    const refSpy = spyOn(AttachmentReferenceRepository, "findReferencingStreamIds").mockResolvedValue([
      "stream_visible",
    ])

    const result = await stripInaccessibleAgentRefs({
      pool,
      workspaceId: "ws_1",
      targetStreamId: "stream_target",
      accessibleStreamIds: ["stream_visible", "stream_target"],
      contentJson: doc(paragraph(attachmentRefNode("att_a"))),
    })

    expect(refSpy).toHaveBeenCalled()
    expect(result.dropped).toEqual([])
    expect(JSON.stringify(result.contentJson)).toContain("att_a")
  })

  it("drops attachment when neither direct stream nor any referencing stream is in scope", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
      {
        id: "att_secret",
        workspaceId: "ws_1",
        streamId: "stream_private",
        safetyStatus: AttachmentSafetyStatuses.CLEAN,
      } as any,
    ])
    spyOn(AttachmentReferenceRepository, "findReferencingStreamIds").mockResolvedValue(["stream_other_private"])

    const result = await stripInaccessibleAgentRefs({
      pool,
      workspaceId: "ws_1",
      targetStreamId: "stream_target",
      accessibleStreamIds: ["stream_target"],
      contentJson: doc(paragraph(attachmentRefNode("att_secret"))),
    })

    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]).toMatchObject({
      type: "attachmentReference",
      reason: "attachment-out-of-scope",
      ids: { id: "att_secret" },
    })
  })

  it("drops attachments whose safetyStatus isn't clean — mirrors event-service's malware-scan gate", async () => {
    // Defense in depth: the strip helper must reject malware-scan-quarantined
    // attachments BEFORE event-service throws on them, otherwise they'd
    // survive strip and crash the whole message at write time.
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
      {
        id: "att_quarantined",
        workspaceId: "ws_1",
        streamId: "stream_target",
        safetyStatus: "quarantined",
      } as any,
    ])

    const result = await stripInaccessibleAgentRefs({
      pool,
      workspaceId: "ws_1",
      targetStreamId: "stream_target",
      // Stream IS in scope — only the safety check should fail it.
      accessibleStreamIds: ["stream_target"],
      contentJson: doc(paragraph(attachmentRefNode("att_quarantined"))),
    })

    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]).toMatchObject({
      type: "attachmentReference",
      reason: "attachment-not-clean",
      ids: { id: "att_quarantined" },
    })
  })

  it("keeps memoEmbed when the memo resolves to an active memo in the workspace", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([])
    spyOn(MemoRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["memo_a", { id: "memo_a", status: "active" } as any]])
    )

    const result = await stripInaccessibleAgentRefs({
      pool,
      workspaceId: "ws_1",
      targetStreamId: "stream_target",
      // Deliberately no stream reach for the memo's source — memoEmbed visibility
      // is enforced per-recipient at render time, so scope is not re-checked here.
      accessibleStreamIds: ["stream_target"],
      contentJson: doc(memoEmbedNode("memo_a")),
    })

    expect(result.dropped).toEqual([])
    expect(JSON.stringify(result.contentJson)).toContain("memo_a")
  })

  it("drops memoEmbed when the memo id resolves to nothing in the workspace", async () => {
    // INV-8: hallucinated ids and cross-workspace memos both collapse into an
    // empty map and surface as "not found".
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([])
    spyOn(MemoRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())

    const result = await stripInaccessibleAgentRefs({
      pool,
      workspaceId: "ws_1",
      targetStreamId: "stream_target",
      accessibleStreamIds: ["stream_target"],
      contentJson: doc(memoEmbedNode("memo_phantom")),
    })

    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]).toMatchObject({
      type: "memoEmbed",
      reason: "memo-not-found",
      ids: { memoId: "memo_phantom" },
    })
    expect(JSON.stringify(result.contentJson)).not.toContain("memo_phantom")
    expect(JSON.stringify(result.contentJson)).not.toContain("memoEmbed")
  })

  it("drops memoEmbed when the memo exists but is no longer active", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([])
    spyOn(MemoRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["memo_archived", { id: "memo_archived", status: "archived" } as any]])
    )

    const result = await stripInaccessibleAgentRefs({
      pool,
      workspaceId: "ws_1",
      targetStreamId: "stream_target",
      accessibleStreamIds: ["stream_target"],
      contentJson: doc(memoEmbedNode("memo_archived")),
    })

    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]).toMatchObject({
      type: "memoEmbed",
      reason: "memo-not-active",
      ids: { memoId: "memo_archived" },
    })
  })

  it("re-serializes the cleaned tree to markdown so contentJson and contentMarkdown stay in sync", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([])

    const result = await stripInaccessibleAgentRefs({
      pool,
      workspaceId: "ws_1",
      targetStreamId: "stream_target",
      accessibleStreamIds: ["stream_target"],
      contentJson: doc(
        paragraph({ type: "text", text: "Take a look:" }),
        sharedMessageNode("stream_phantom", "msg_phantom"),
        paragraph({ type: "text", text: "Thoughts?" })
      ),
    })

    expect(result.contentMarkdown).toContain("Take a look:")
    expect(result.contentMarkdown).toContain("Thoughts?")
    expect(result.contentMarkdown).not.toContain("shared-message:")
    expect(result.contentMarkdown).not.toContain("msg_phantom")
  })
})
