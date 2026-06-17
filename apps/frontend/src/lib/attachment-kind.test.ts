import { describe, expect, it } from "vitest"
import { isTextPreviewableAttachment } from "./attachment-kind"

describe("isTextPreviewableAttachment", () => {
  it("matches text/* and known text-based application mimes", () => {
    expect(isTextPreviewableAttachment({ mimeType: "text/plain", filename: "notes.txt" })).toBe(true)
    expect(isTextPreviewableAttachment({ mimeType: "text/csv", filename: "rows.csv" })).toBe(true)
    expect(isTextPreviewableAttachment({ mimeType: "application/json", filename: "data.json" })).toBe(true)
    expect(isTextPreviewableAttachment({ mimeType: "application/x-yaml", filename: "config.yaml" })).toBe(true)
    // Charset parameters are ignored.
    expect(isTextPreviewableAttachment({ mimeType: "text/plain; charset=utf-8", filename: "log" })).toBe(true)
  })

  it("falls back to the filename extension for octet-stream uploads", () => {
    expect(isTextPreviewableAttachment({ mimeType: "application/octet-stream", filename: "main.rs" })).toBe(true)
    expect(isTextPreviewableAttachment({ mimeType: "application/octet-stream", filename: "query.sql" })).toBe(true)
  })

  it("excludes the dedicated markdown/html/pdf viewers", () => {
    expect(isTextPreviewableAttachment({ mimeType: "text/markdown", filename: "readme.md" })).toBe(false)
    expect(isTextPreviewableAttachment({ mimeType: "text/html", filename: "page.html" })).toBe(false)
    expect(isTextPreviewableAttachment({ mimeType: "application/pdf", filename: "report.pdf" })).toBe(false)
  })

  it("excludes binary and unknown formats", () => {
    expect(isTextPreviewableAttachment({ mimeType: "application/zip", filename: "bundle.zip" })).toBe(false)
    expect(isTextPreviewableAttachment({ mimeType: "image/png", filename: "photo.png" })).toBe(false)
    expect(
      isTextPreviewableAttachment({
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "memo.docx",
      })
    ).toBe(false)
    expect(isTextPreviewableAttachment({ mimeType: "application/octet-stream", filename: "data.bin" })).toBe(false)
  })
})
