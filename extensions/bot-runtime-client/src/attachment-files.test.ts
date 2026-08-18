import { describe, expect, test } from "bun:test"
import { attachmentLocalPath, safeAttachmentFilename } from "./attachment-files"

describe("safeAttachmentFilename", () => {
  test("replaces path separators and other unsafe characters", () => {
    expect(safeAttachmentFilename("a/b\\c:d?.txt")).toBe("a_b_c_d_.txt")
  })

  test("falls back when the name reduces to empty", () => {
    expect(safeAttachmentFilename("")).toBe("attachment")
  })

  test("truncates an over-long name to 180 bytes but keeps its extension", () => {
    const name = safeAttachmentFilename(`${"a".repeat(400)}.png`)
    expect(name.endsWith(".png")).toBe(true)
    expect(new TextEncoder().encode(name).length).toBe(180)
  })

  test("counts bytes, not code units, so a multibyte name fits a path component", () => {
    const name = safeAttachmentFilename(`${"\u6f22".repeat(120)}.jpg`)
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(180)
    expect(name.endsWith("\u6f22.jpg")).toBe(true)
  })

  test("truncates whole when the suffix is too long to be an extension", () => {
    const name = safeAttachmentFilename(`report.${"z".repeat(300)}`)
    expect(new TextEncoder().encode(name).length).toBe(180)
  })
})

describe("attachmentLocalPath", () => {
  test("nests the file under its attachment id, keeping the original name", () => {
    expect(attachmentLocalPath("/base", "attach_1", "image.png")).toBe("/base/attach_1/image.png")
  })

  test("keeps two same-named attachments apart", () => {
    expect(attachmentLocalPath("/base", "attach_1", "image.png")).not.toBe(
      attachmentLocalPath("/base", "attach_2", "image.png")
    )
  })

  test("sanitizes both segments, including a traversal-shaped one", () => {
    expect(attachmentLocalPath("/base", "..", "../x/y.png")).toBe("/base/_/.._x_y.png")
  })
})
