import { describe, test, expect } from "bun:test"
import { isPdfAttachment, PDF_SIZE_THRESHOLDS, PDF_TEXT_THRESHOLDS } from "./config"

describe("PDF Processing Config", () => {
  describe("isPdfAttachment", () => {
    test("returns true for application/pdf mime type", () => {
      expect(isPdfAttachment("application/pdf", "document.pdf")).toBe(true)
    })

    test("returns true for application/pdf mime type regardless of filename", () => {
      expect(isPdfAttachment("application/pdf", "document.txt")).toBe(true)
      expect(isPdfAttachment("application/pdf", "")).toBe(true)
    })

    test("returns true for .pdf extension with application/octet-stream mime type", () => {
      expect(isPdfAttachment("application/octet-stream", "document.pdf")).toBe(true)
    })

    test("returns true for .PDF extension (case insensitive) with application/octet-stream", () => {
      expect(isPdfAttachment("application/octet-stream", "DOCUMENT.PDF")).toBe(true)
      expect(isPdfAttachment("application/octet-stream", "Report.Pdf")).toBe(true)
    })

    test("returns false for .pdf extension with non-octet-stream mime type", () => {
      // Only checks extension if mime type is application/octet-stream
      expect(isPdfAttachment("text/plain", "document.pdf")).toBe(false)
      expect(isPdfAttachment("", "report.pdf")).toBe(false)
    })

    test("returns false for non-PDF images", () => {
      expect(isPdfAttachment("image/png", "image.png")).toBe(false)
      expect(isPdfAttachment("image/jpeg", "photo.jpg")).toBe(false)
      expect(isPdfAttachment("image/gif", "animation.gif")).toBe(false)
    })

    test("returns false for other document types", () => {
      expect(isPdfAttachment("application/msword", "document.doc")).toBe(false)
      expect(
        isPdfAttachment("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document.docx")
      ).toBe(false)
      expect(isPdfAttachment("text/plain", "notes.txt")).toBe(false)
    })

    test("returns false for files without .pdf extension when mime type is octet-stream", () => {
      expect(isPdfAttachment("application/octet-stream", "noextension")).toBe(false)
      expect(isPdfAttachment("application/octet-stream", "document.doc")).toBe(false)
    })

    test("handles edge cases", () => {
      // Filename with multiple dots and octet-stream
      expect(isPdfAttachment("application/octet-stream", "my.document.v2.pdf")).toBe(true)

      // Filename that looks like PDF but isn't with non-octet-stream
      expect(isPdfAttachment("text/plain", "pdf-guide.txt")).toBe(false)
    })
  })

  describe("PDF_SIZE_THRESHOLDS", () => {
    test("has correct threshold values", () => {
      expect(PDF_SIZE_THRESHOLDS.small).toBe(8)
      expect(PDF_SIZE_THRESHOLDS.medium).toBe(25)
    })

    test("small threshold is less than medium threshold", () => {
      expect(PDF_SIZE_THRESHOLDS.small).toBeLessThan(PDF_SIZE_THRESHOLDS.medium)
    })
  })

  describe("PDF_TEXT_THRESHOLDS", () => {
    test("has correct threshold values", () => {
      expect(PDF_TEXT_THRESHOLDS.textRich).toBe(100)
      expect(PDF_TEXT_THRESHOLDS.scanned).toBe(50)
    })

    test("scanned threshold is less than textRich threshold", () => {
      expect(PDF_TEXT_THRESHOLDS.scanned).toBeLessThan(PDF_TEXT_THRESHOLDS.textRich)
    })
  })
})
