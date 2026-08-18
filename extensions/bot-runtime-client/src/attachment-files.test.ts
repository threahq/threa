import { describe, expect, test } from "bun:test"
import { attachmentLocalPath, safeAttachmentFilename } from "./attachment-files"

describe("safeAttachmentFilename", () => {
  test("replaces path separators and other unsafe characters", () => {
    expect(safeAttachmentFilename("a/b\\c:d?.txt")).toBe("a_b_c_d_.txt")
  })

  test("falls back when the name reduces to empty", () => {
    expect(safeAttachmentFilename("")).toBe("attachment")
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
