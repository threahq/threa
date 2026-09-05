import { describe, it, expect, spyOn } from "bun:test"
import { AttachmentRepository } from "../../attachments"
import { createSearchAttachmentsTool } from "./search-attachments-tool"
import type { WorkspaceToolDeps } from "./tool-deps"

const toolOpts = { toolCallId: "test" }

function makeDeps(overrides?: Partial<WorkspaceToolDeps>): WorkspaceToolDeps {
  return {
    db: {} as WorkspaceToolDeps["db"],
    workspaceId: "workspace_test",
    accessibleStreamIds: ["stream_1", "stream_2"],
    invokingUserId: "usr_test",
    searchFlag: "on",
    searchService: {} as WorkspaceToolDeps["searchService"],
    storage: { getObject: async () => Buffer.from("test") } as unknown as WorkspaceToolDeps["storage"],
    attachmentService: {} as WorkspaceToolDeps["attachmentService"],
    memoExplorer: {} as WorkspaceToolDeps["memoExplorer"],
    ...overrides,
  }
}

describe("search_attachments tool", () => {
  it("should return search results when attachments found", async () => {
    const searchSpy = spyOn(AttachmentRepository, "searchWithExtractions").mockResolvedValue([
      {
        id: "attach_1",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        storagePath: "uploads/report.pdf",
        processingStatus: "completed",
        streamId: "stream_1",
        messageId: "msg_1",
        createdAt: new Date("2026-02-03T10:00:00Z"),
        extraction: { contentType: "document", summary: "Quarterly financial report with revenue analysis" },
      } as any,
    ])

    const tool = createSearchAttachmentsTool(makeDeps())
    const { output } = await tool.config.execute({ query: "financial report", limit: 10 }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.query).toBe("financial report")
    expect(parsed.results).toHaveLength(1)
    expect(parsed.results[0]).toMatchObject({
      id: "attach_1",
      filename: "report.pdf",
      mimeType: "application/pdf",
      contentType: "document",
    })

    searchSpy.mockRestore()
  })

  it("should return empty message when no results", async () => {
    const searchSpy = spyOn(AttachmentRepository, "searchWithExtractions").mockResolvedValue([])

    const tool = createSearchAttachmentsTool(makeDeps())
    const { output } = await tool.config.execute({ query: "nonexistent", limit: 10 }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.query).toBe("nonexistent")
    expect(parsed.results).toHaveLength(0)
    expect(parsed.message).toBe("No matching attachments found")

    searchSpy.mockRestore()
  })

  it("should truncate long summaries", async () => {
    const longSummary = "A".repeat(300)
    const searchSpy = spyOn(AttachmentRepository, "searchWithExtractions").mockResolvedValue([
      {
        id: "attach_1",
        filename: "doc.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        storagePath: "uploads/doc.pdf",
        processingStatus: "completed",
        streamId: "stream_1",
        messageId: "msg_1",
        createdAt: new Date("2026-02-03T10:00:00Z"),
        extraction: { contentType: "document", summary: longSummary },
      } as any,
    ])

    const tool = createSearchAttachmentsTool(makeDeps())
    const { output } = await tool.config.execute({ query: "doc", limit: 10 }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.results[0].summary.length).toBeLessThanOrEqual(200)
    expect(parsed.results[0].summary.endsWith("...")).toBe(true)

    searchSpy.mockRestore()
  })

  it("should enforce maximum result limit", async () => {
    const searchSpy = spyOn(AttachmentRepository, "searchWithExtractions").mockResolvedValue([])

    const tool = createSearchAttachmentsTool(makeDeps())
    await tool.config.execute({ query: "test", limit: 100 }, toolOpts)

    expect(searchSpy).toHaveBeenCalled()
    const callArgs = searchSpy.mock.calls[0]
    expect((callArgs[1] as any).limit).toBeLessThanOrEqual(20)

    searchSpy.mockRestore()
  })

  it("should handle errors gracefully", async () => {
    const searchSpy = spyOn(AttachmentRepository, "searchWithExtractions").mockRejectedValue(
      new Error("Database error")
    )

    const tool = createSearchAttachmentsTool(makeDeps())
    const { output } = await tool.config.execute({ query: "test", limit: 10 }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.error).toContain("Search failed")
    expect(parsed.query).toBe("test")

    searchSpy.mockRestore()
  })
})
