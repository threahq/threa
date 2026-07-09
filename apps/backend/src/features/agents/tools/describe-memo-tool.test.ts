import { describe, it, expect } from "bun:test"
import type { MemoExplorerDetail, MemoExplorerService } from "../../memos"
import { createDescribeMemoTool } from "./describe-memo-tool"
import type { WorkspaceToolDeps } from "./tool-deps"

const toolOpts = { toolCallId: "test" }

function makeMemoExplorer(getById: MemoExplorerService["getById"]): MemoExplorerService {
  return { getById } as unknown as MemoExplorerService
}

function makeDeps(memoExplorer: MemoExplorerService): WorkspaceToolDeps {
  return {
    db: {} as WorkspaceToolDeps["db"],
    workspaceId: "workspace_test",
    accessibleStreamIds: ["stream_1", "stream_2"],
    invokingUserId: "usr_test",
    searchService: {} as WorkspaceToolDeps["searchService"],
    storage: {} as WorkspaceToolDeps["storage"],
    attachmentService: {} as WorkspaceToolDeps["attachmentService"],
    memoExplorer,
  }
}

describe("describe_memo tool", () => {
  it("returns memo abstract + key points + source messages with the ids needed for pointer URLs", async () => {
    const detail: MemoExplorerDetail = {
      memo: {
        id: "memo_abc",
        workspaceId: "workspace_test",
        memoType: "message",
        sourceMessageId: null,
        sourceConversationId: null,
        title: "Deploy plan recap",
        abstract: "We agreed to ship Friday with feature flag default-off.",
        keyPoints: ["Ship Friday", "Flag default-off"],
        sourceMessageIds: ["msg_1", "msg_2"],
        participantIds: ["user_alice"],
        knowledgeType: "decision",
        tags: ["deploy"],
        parentMemoId: null,
        status: "active",
        version: 1,
        revisionReason: null,
        createdAt: new Date("2026-04-30T09:00:00Z"),
        updatedAt: new Date("2026-04-30T09:00:00Z"),
        archivedAt: null,
      },
      distance: 0,
      sourceStream: { id: "stream_1", type: "channel", name: "general" },
      rootStream: { id: "stream_1", type: "channel", name: "general" },
      successorMemoId: null,
      sourceMessages: [
        {
          id: "msg_1",
          streamId: "stream_1",
          streamName: "general",
          authorId: "user_alice",
          authorType: "user",
          authorName: "Alice",
          content: "Let's ship this Friday.",
          createdAt: new Date("2026-04-30T08:50:00Z"),
        },
        {
          id: "msg_2",
          streamId: "stream_1",
          streamName: "general",
          authorId: "user_alice",
          authorType: "user",
          authorName: "Alice",
          content: "Default-off, we'll flip after smoke tests.",
          createdAt: new Date("2026-04-30T08:55:00Z"),
        },
      ],
    }

    const memoExplorer = makeMemoExplorer(async () => detail)
    const tool = createDescribeMemoTool(makeDeps(memoExplorer))

    const { output } = await tool.config.execute({ memoId: "memo_abc" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.id).toBe("memo_abc")
    expect(parsed.title).toBe("Deploy plan recap")
    expect(parsed.abstract).toContain("Friday")
    expect(parsed.keyPoints).toEqual(["Ship Friday", "Flag default-off"])
    expect(parsed.tags).toEqual(["deploy"])
    expect(parsed.sourceStream).toEqual({ id: "stream_1", type: "channel", name: "general" })
    expect(parsed.sources).toHaveLength(2)
    expect(parsed.sources[0]).toMatchObject({
      messageId: "msg_1",
      streamId: "stream_1",
      authorId: "user_alice",
      authorType: "user",
      authorName: "Alice",
    })
    expect(parsed.sources[0].contentMarkdownPreview).toContain("Friday")
    expect(parsed.sources[0].createdAt).toBe("2026-04-30T08:50:00.000Z")
  })

  it("returns a not-found error when the explorer rejects the memo (out-of-scope or archived)", async () => {
    const memoExplorer = makeMemoExplorer(async () => null)
    const tool = createDescribeMemoTool(makeDeps(memoExplorer))

    const { output } = await tool.config.execute({ memoId: "memo_inaccessible" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.error).toContain("not found")
    expect(parsed.memoId).toBe("memo_inaccessible")
  })

  it("forwards workspaceId and accessibleStreamIds to MemoExplorerService.getById for access gating", async () => {
    let captured: { workspaceId?: string; memoId?: string; streamIds?: string[] } = {}
    const memoExplorer = makeMemoExplorer(async (workspaceId, memoId, permissions) => {
      captured = { workspaceId, memoId, streamIds: permissions.accessibleStreamIds }
      return null
    })
    const tool = createDescribeMemoTool(makeDeps(memoExplorer))

    await tool.config.execute({ memoId: "memo_xyz" }, toolOpts)

    expect(captured.workspaceId).toBe("workspace_test")
    expect(captured.memoId).toBe("memo_xyz")
    expect(captured.streamIds).toEqual(["stream_1", "stream_2"])
  })

  it("truncates long source-message previews to 400 chars with an ellipsis", async () => {
    const longText = "x".repeat(500)
    const detail: MemoExplorerDetail = {
      memo: {
        id: "memo_long",
        workspaceId: "workspace_test",
        memoType: "message",
        sourceMessageId: null,
        sourceConversationId: null,
        title: "t",
        abstract: "a",
        keyPoints: [],
        sourceMessageIds: ["msg_1"],
        participantIds: [],
        knowledgeType: "decision",
        tags: [],
        parentMemoId: null,
        status: "active",
        version: 1,
        revisionReason: null,
        createdAt: new Date("2026-04-30T09:00:00Z"),
        updatedAt: new Date("2026-04-30T09:00:00Z"),
        archivedAt: null,
      },
      distance: 0,
      sourceStream: { id: "stream_1", type: "channel", name: "g" },
      rootStream: null,
      successorMemoId: null,
      sourceMessages: [
        {
          id: "msg_1",
          streamId: "stream_1",
          streamName: "g",
          authorId: "u_1",
          authorType: "user",
          authorName: "A",
          content: longText,
          createdAt: new Date("2026-04-30T08:00:00Z"),
        },
      ],
    }

    const memoExplorer = makeMemoExplorer(async () => detail)
    const tool = createDescribeMemoTool(makeDeps(memoExplorer))

    const { output } = await tool.config.execute({ memoId: "memo_long" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.sources[0].contentMarkdownPreview).toHaveLength(400)
    expect(parsed.sources[0].contentMarkdownPreview.endsWith("...")).toBe(true)
  })
})
