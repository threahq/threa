import { describe, it, expect, spyOn } from "bun:test"
import { AttachmentExtractionRepository, EXCEL_MAX_ROWS_PER_REQUEST } from "../../attachments"
import type { AttachmentService } from "../../attachments"
import { createReadAttachmentTool } from "./read-attachment-tool"
import type { WorkspaceToolDeps } from "./tool-deps"

const toolOpts = { toolCallId: "test" }

function makeAttachmentService(
  getAccessible: AttachmentService["getAccessible"] = async () => null
): AttachmentService {
  return { getAccessible } as unknown as AttachmentService
}

function makeDeps(overrides?: Partial<WorkspaceToolDeps>): WorkspaceToolDeps {
  return {
    db: {} as WorkspaceToolDeps["db"],
    workspaceId: "workspace_test",
    accessibleStreamIds: ["stream_1", "stream_2"],
    invokingUserId: "usr_test",
    searchFlag: "on",
    searchService: {} as WorkspaceToolDeps["searchService"],
    storage: { getObject: async () => Buffer.from("test") } as unknown as WorkspaceToolDeps["storage"],
    attachmentService: makeAttachmentService(),
    memoExplorer: {} as WorkspaceToolDeps["memoExplorer"],
    ...overrides,
  }
}

const textAttachment = {
  id: "attach_1",
  filename: "snippet.txt",
  mimeType: "text/plain",
  sizeBytes: 2259,
  processingStatus: "completed",
  streamId: "stream_1",
  messageId: "msg_1",
  storagePath: "uploads/snippet.txt",
  createdAt: new Date("2026-02-03T10:00:00Z"),
}

const imageAttachment = {
  ...textAttachment,
  id: "attach_img",
  filename: "chart.png",
  mimeType: "image/png",
  storagePath: "uploads/chart.png",
}

describe("read_attachment — whole-file read", () => {
  it("returns extracted text and structured data for a document (no image bytes)", async () => {
    const deps = makeDeps({ attachmentService: makeAttachmentService(async () => textAttachment as any) })
    const extractionSpy = spyOn(AttachmentExtractionRepository, "findByAttachmentId").mockResolvedValue({
      contentType: "document",
      summary: "A Cargo.lock merge conflict snippet",
      fullText: "<<<<<<< conflict ... =======",
      structuredData: null,
      sourceType: "text",
      textMetadata: { totalLines: 36 },
    } as any)

    const tool = createReadAttachmentTool(deps, { supportsVision: true })
    const result = await tool.config.execute({ attachmentId: "attach_1" }, toolOpts)
    const parsed = JSON.parse(result.output)

    expect(result.multimodal).toBeUndefined()
    expect(parsed).toMatchObject({
      id: "attach_1",
      filename: "snippet.txt",
      mimeType: "text/plain",
      createdAt: "2026-02-03T10:00:00.000Z",
    })
    expect(parsed.extraction).toMatchObject({
      summary: "A Cargo.lock merge conflict snippet",
      fullText: "<<<<<<< conflict ... =======",
    })

    extractionSpy.mockRestore()
  })

  it("attaches the image for a visual file on a vision-capable model", async () => {
    const imageData = Buffer.from("fake-png-data")
    const deps = makeDeps({
      attachmentService: makeAttachmentService(async () => imageAttachment as any),
      storage: { getObject: async () => imageData } as unknown as WorkspaceToolDeps["storage"],
    })
    const extractionSpy = spyOn(AttachmentExtractionRepository, "findByAttachmentId").mockResolvedValue(null as any)

    const tool = createReadAttachmentTool(deps, { supportsVision: true })
    const result = await tool.config.execute({ attachmentId: "attach_img" }, toolOpts)

    expect(result.multimodal).toEqual([{ type: "image", url: `data:image/png;base64,${imageData.toString("base64")}` }])

    extractionSpy.mockRestore()
  })

  it("does not fetch image bytes when the model lacks vision", async () => {
    let fetched = false
    const deps = makeDeps({
      attachmentService: makeAttachmentService(async () => imageAttachment as any),
      storage: {
        getObject: async () => {
          fetched = true
          return Buffer.from("x")
        },
      } as unknown as WorkspaceToolDeps["storage"],
    })
    const extractionSpy = spyOn(AttachmentExtractionRepository, "findByAttachmentId").mockResolvedValue({
      contentType: "photo",
      summary: "a chart",
      fullText: null,
      structuredData: null,
    } as any)

    const tool = createReadAttachmentTool(deps, { supportsVision: false })
    const result = await tool.config.execute({ attachmentId: "attach_img" }, toolOpts)

    expect(result.multimodal).toBeUndefined()
    expect(fetched).toBe(false)
    expect(JSON.parse(result.output).extraction.summary).toBe("a chart")

    extractionSpy.mockRestore()
  })

  it("returns an error when the attachment is not found or not accessible", async () => {
    const tool = createReadAttachmentTool(makeDeps(), { supportsVision: true })
    const { output } = await tool.config.execute({ attachmentId: "nonexistent" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.error).toContain("not found or not accessible")
    expect(parsed.attachmentId).toBe("nonexistent")
  })

  it("handles an attachment that has not been extracted yet", async () => {
    const pending = { ...textAttachment, processingStatus: "pending" }
    const deps = makeDeps({ attachmentService: makeAttachmentService(async () => pending as any) })
    const extractionSpy = spyOn(AttachmentExtractionRepository, "findByAttachmentId").mockResolvedValue(null as any)

    const tool = createReadAttachmentTool(deps, { supportsVision: true })
    const { output } = await tool.config.execute({ attachmentId: "attach_1" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.extraction).toBeNull()
    expect(parsed.processingStatus).toBe("pending")

    extractionSpy.mockRestore()
  })

  it("wraps unexpected errors", async () => {
    const deps = makeDeps({
      attachmentService: makeAttachmentService(async () => {
        throw new Error("Access denied")
      }),
    })

    const tool = createReadAttachmentTool(deps, { supportsVision: true })
    const { output } = await tool.config.execute({ attachmentId: "attach_1" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.error).toContain("Failed to read attachment")
    expect(parsed.attachmentId).toBe("attach_1")
  })
})

describe("read_attachment — section paging", () => {
  it("returns a line range for a large text file", async () => {
    const deps = makeDeps({
      attachmentService: makeAttachmentService(async () => textAttachment as any),
      storage: {
        getObject: async () => Buffer.from("line0\nline1\nline2\nline3"),
      } as unknown as WorkspaceToolDeps["storage"],
    })
    const extractionSpy = spyOn(AttachmentExtractionRepository, "findByAttachmentId").mockResolvedValue({
      sourceType: "text",
      textMetadata: { totalLines: 4 },
    } as any)

    const tool = createReadAttachmentTool(deps, { supportsVision: false })
    const { output } = await tool.config.execute(
      { attachmentId: "attach_1", section: { kind: "lines", startLine: 1, endLine: 3 } },
      toolOpts
    )
    const parsed = JSON.parse(output)

    expect(parsed.content).toBe("line1\nline2")
    expect(parsed.lineRange).toBe("1-2 of 4")

    extractionSpy.mockRestore()
  })

  it("reports an out-of-range line request against the real file length", async () => {
    const deps = makeDeps({ attachmentService: makeAttachmentService(async () => textAttachment as any) })
    const extractionSpy = spyOn(AttachmentExtractionRepository, "findByAttachmentId").mockResolvedValue({
      sourceType: "text",
      textMetadata: { totalLines: 2 },
    } as any)

    const tool = createReadAttachmentTool(deps, { supportsVision: false })
    const { output } = await tool.config.execute(
      { attachmentId: "attach_1", section: { kind: "lines", startLine: 0, endLine: 100 } },
      toolOpts
    )

    expect(JSON.parse(output).error).toContain("out of range")

    extractionSpy.mockRestore()
  })
})

describe("read_attachment — input schema", () => {
  const schema = createReadAttachmentTool(makeDeps(), { supportsVision: false }).config.inputSchema

  it("rejects an Excel row range exceeding the per-request maximum", () => {
    const result = schema.safeParse({
      attachmentId: "attach_1",
      section: { kind: "rows", sheetName: "Sheet1", startRow: 0, endRow: EXCEL_MAX_ROWS_PER_REQUEST + 1 },
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ["section", "endRow"],
        message: `Cannot read more than ${EXCEL_MAX_ROWS_PER_REQUEST} rows at once`,
      })
    )
  })

  it("rejects an open-ended Excel read above the maximum (startRow defaults to 0)", () => {
    const result = schema.safeParse({
      attachmentId: "attach_1",
      section: { kind: "rows", sheetName: "Sheet1", endRow: EXCEL_MAX_ROWS_PER_REQUEST + 1 },
    })

    expect(result.success).toBe(false)
  })

  it("accepts a whole-file read with no section", () => {
    expect(schema.safeParse({ attachmentId: "attach_1" }).success).toBe(true)
  })
})
