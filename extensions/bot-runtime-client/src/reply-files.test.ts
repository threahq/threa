import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { decryptAttachmentBytes } from "./crypto"
import {
  extractAttachmentDirectives,
  hasReplyAttachments,
  redactAttachDirectives,
  uploadReplyAttachments,
  uploadSealedReplyAttachments,
  type UploadedAttachment,
} from "./reply-files"

function summary(partial: Partial<UploadedAttachment> & { id: string }): UploadedAttachment {
  return { filename: "f.txt", mimeType: "text/plain", sizeBytes: 1, ...partial }
}

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reply-files-"))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

const noUploads = {
  async uploadAttachment(): Promise<UploadedAttachment> {
    throw new Error("should not be called")
  },
}

describe("redactAttachDirectives", () => {
  test("hides the path on every directive line and leaves prose alone", () => {
    expect(redactAttachDirectives("Made it\nTHREA_ATTACH: /home/a/out.png\nsee THREA_ATTACH: inline")).toBe(
      "Made it\nTHREA_ATTACH: [local path omitted]\nsee THREA_ATTACH: inline"
    )
  })

  test("hides embedded local image paths", () => {
    expect(redactAttachDirectives("Look: ![shot](/home/a/shot.png)")).toBe("Look: [image: local path omitted]")
  })
})

describe("extractAttachmentDirectives", () => {
  test("pulls THREA_ATTACH lines out and keeps the rest", () => {
    expect(extractAttachmentDirectives("Here you go\nTHREA_ATTACH: ./out.png\nThanks")).toEqual({
      markdown: "Here you go\nThanks",
      paths: ["./out.png"],
    })
  })

  test("trims directive whitespace and collects multiple paths", () => {
    expect(extractAttachmentDirectives("THREA_ATTACH:   a.txt  \nTHREA_ATTACH: b/c.pdf")).toEqual({
      markdown: "",
      paths: ["a.txt", "b/c.pdf"],
    })
  })

  test("leaves text with no directives untouched", () => {
    expect(extractAttachmentDirectives("just a reply")).toEqual({ markdown: "just a reply", paths: [] })
  })
})

describe("uploadReplyAttachments", () => {
  test("uploads each directive file and rewrites the reply with links", async () => {
    const dir = tempDir()
    const filePath = join(dir, "chart.png")
    writeFileSync(filePath, new Uint8Array([1, 2, 3]))
    const uploads: Array<{ filename: string; type: string }> = []
    const client = {
      async uploadAttachment(form: FormData): Promise<UploadedAttachment> {
        const file = form.get("file") as Blob & { name?: string }
        uploads.push({ filename: file.name ?? "", type: file.type })
        return summary({ id: "att_1", filename: "chart.png", mimeType: "image/png", sizeBytes: 3 })
      },
    }
    const result = await uploadReplyAttachments(client, `Here is the chart\nTHREA_ATTACH: ${filePath}`, dir)
    expect({ uploads, ids: result.uploaded.map((a) => a.id), markdown: result.markdown }).toEqual({
      uploads: [{ filename: "chart.png", type: "image/png" }],
      ids: ["att_1"],
      markdown: "Here is the chart\n\nAttachments:\n- [chart.png](attachment:att_1)",
    })
  })

  test("records a failure for a missing file without throwing", async () => {
    const result = await uploadReplyAttachments(noUploads, "Done\nTHREA_ATTACH: ./nope.txt", tempDir())
    expect({ ...result, markdown: result.markdown.replace(/ENOENT.*$/, "ENOENT") }).toEqual({
      markdown: "Done\n\nAttachment upload failed:\n- ./nope.txt: ENOENT",
      uploaded: [],
      failed: [expect.stringMatching(/^\.\/nope\.txt: ENOENT\b/)],
    })
  })

  test("returns the reply unchanged when there are no directives", async () => {
    const result = await uploadReplyAttachments(noUploads, "plain reply", "/tmp")
    expect(result).toEqual({ markdown: "plain reply", uploaded: [], failed: [] })
  })

  test("uploads an image embedded from disk and links it in place", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "shot.png"), new Uint8Array([1, 2, 3]))
    const uploads: string[] = []
    const client = {
      async uploadAttachment(form: FormData): Promise<UploadedAttachment> {
        uploads.push((form.get("file") as Blob & { name?: string }).name ?? "")
        return summary({ id: "att_img", filename: "shot.png", mimeType: "image/png" })
      },
    }
    const result = await uploadReplyAttachments(
      client,
      "Direction 1:\n![First direction](shot.png)\n\nDirection 2:\n![](./missing.png)\n\n`![code](shot.png)`",
      dir
    )
    expect({
      uploads,
      ids: result.uploaded.map((a) => a.id),
      // The rest of the error is the runtime's wording.
      markdown: result.markdown.replace(/ENOENT.*$/, "ENOENT"),
    }).toEqual({
      uploads: ["shot.png"],
      ids: ["att_img"],
      markdown:
        'Direction 1:\n[First direction](attachment:att_img "threa-attachment:filename=shot.png&mimeType=image%2Fpng&sizeBytes=1")\n\n' +
        "Direction 2:\n\n\n`![code](shot.png)`\n\n" +
        "Attachment upload failed:\n- ./missing.png: ENOENT",
    })
  })

  test("leaves the markdown empty when there was nothing to say and nothing to attach", async () => {
    const result = await uploadReplyAttachments(noUploads, "", "/tmp")
    expect(result).toEqual({ markdown: "", uploaded: [], failed: [] })
  })
})

describe("uploadSealedReplyAttachments", () => {
  test("encrypts the file, uploads only ciphertext with e2e=true, and returns a ref that decrypts it", async () => {
    const dir = tempDir()
    const filePath = join(dir, "chart.png")
    const plaintext = new Uint8Array([1, 2, 3, 4, 5])
    writeFileSync(filePath, plaintext)
    const uploads: Array<{ filename: string; type: string; e2e: unknown; bytes: Uint8Array }> = []
    const client = {
      async uploadAttachment(form: FormData): Promise<UploadedAttachment> {
        const file = form.get("file") as Blob & { name?: string }
        uploads.push({
          filename: file.name ?? "",
          type: file.type,
          e2e: form.get("e2e"),
          bytes: new Uint8Array(await file.arrayBuffer()),
        })
        return summary({ id: "att_e2e", filename: "encrypted", mimeType: "application/octet-stream", sizeBytes: 21 })
      },
    }

    const result = await uploadSealedReplyAttachments(client, `Here you go\nTHREA_ATTACH: ${filePath}`, dir)

    const [ref] = result.refs
    const decrypted = await decryptAttachmentBytes({ ciphertext: uploads[0]!.bytes, key: ref!.key, iv: ref!.iv })
    // The wire sees the placeholder name/mime only; the ref carries the real metadata, and no link is added.
    expect({
      wire: uploads.map(({ filename, type, e2e }) => ({ filename, type, e2e })),
      result,
      decrypted: Array.from(new Uint8Array(decrypted)),
    }).toEqual({
      wire: [{ filename: "encrypted", type: "application/octet-stream", e2e: "true" }],
      result: {
        markdown: "Here you go",
        refs: [
          {
            attachmentId: "att_e2e",
            key: expect.any(String),
            iv: expect.any(String),
            filename: "chart.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        attachmentIds: ["att_e2e"],
      },
      decrypted: Array.from(plaintext),
    })
    expect(Array.from(uploads[0]!.bytes)).not.toEqual(Array.from(plaintext))
  })

  test("records a failure note for a missing file without uploading anything", async () => {
    const result = await uploadSealedReplyAttachments(noUploads, "Done\nTHREA_ATTACH: ./nope.txt", tempDir())
    expect({ ...result, markdown: result.markdown.replace(/ENOENT.*$/, "ENOENT") }).toEqual({
      markdown: "Done\n\nAttachment upload failed:\n- ./nope.txt: ENOENT",
      refs: [],
      attachmentIds: [],
    })
  })

  test("uploads an embedded image as a sealed ref and removes its markup", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "shot.png"), new Uint8Array([9, 9]))
    const e2eFlags: unknown[] = []
    const client = {
      async uploadAttachment(form: FormData): Promise<UploadedAttachment> {
        e2eFlags.push(form.get("e2e"))
        return summary({ id: "att_e2e_img", filename: "encrypted" })
      },
    }
    const result = await uploadSealedReplyAttachments(client, "Look:\n![shot](shot.png)", dir)
    expect({
      e2eFlags,
      markdown: result.markdown,
      ids: result.attachmentIds,
      filename: result.refs[0]?.filename,
    }).toEqual({
      e2eFlags: ["true"],
      markdown: "Look:",
      ids: ["att_e2e_img"],
      filename: "shot.png",
    })
  })

  test("directives claim the 16-id cap before embedded images", async () => {
    const dir = tempDir()
    const lines = ["Done"]
    for (let i = 0; i < 16; i++) {
      writeFileSync(join(dir, `img-${i}.png`), `image ${i}`)
      lines.push(`![img ${i}](img-${i}.png)`)
    }
    writeFileSync(join(dir, "extra.txt"), "extra")
    lines.push("THREA_ATTACH: extra.txt")
    let uploadCount = 0
    const client = {
      async uploadAttachment(): Promise<UploadedAttachment> {
        uploadCount += 1
        return summary({ id: `att_${uploadCount}` })
      },
    }
    const result = await uploadSealedReplyAttachments(client, lines.join("\n"), dir)
    expect({ uploadCount, ids: result.attachmentIds.length, markdown: result.markdown }).toEqual({
      uploadCount: 16,
      ids: 16,
      markdown: "Done\n\nAttachment upload failed:\n- img-15.png: over the 16-attachment limit for one message",
    })
  })

  test("clamps to the server's 16-id cap: overflow directives become failure notes, not a 400 loop", async () => {
    const dir = tempDir()
    const paths: string[] = []
    for (let i = 0; i < 17; i++) {
      const filePath = join(dir, `file-${String(i).padStart(2, "0")}.txt`)
      writeFileSync(filePath, `content ${i}`)
      paths.push(filePath)
    }
    let uploadCount = 0
    const client = {
      async uploadAttachment(): Promise<UploadedAttachment> {
        uploadCount += 1
        return summary({ id: `att_${uploadCount}` })
      },
    }
    const result = await uploadSealedReplyAttachments(
      client,
      ["Done", ...paths.map((p) => `THREA_ATTACH: ${p}`)].join("\n"),
      dir
    )
    expect({ uploadCount, ids: result.attachmentIds.length, markdown: result.markdown }).toEqual({
      uploadCount: 16,
      ids: 16,
      markdown: `Done\n\nAttachment upload failed:\n- ${paths[16]}: over the 16-attachment limit for one message`,
    })
  })
})

test("should upload explicit report and video links with their actual bytes", async () => {
  const dir = tempDir()
  const uploads: { name: string; type: string; bytes: string }[] = []
  for (const name of ["report.md", "walkthrough.webm"]) writeFileSync(join(dir, name), `synthetic ${name}`)
  const result = await uploadReplyAttachments(
    {
      async uploadAttachment(form) {
        const file = form.get("file") as File
        uploads.push({ name: file.name, type: file.type, bytes: await file.text() })
        return { id: `att_${uploads.length}`, filename: file.name, mimeType: file.type, sizeBytes: file.size }
      },
    },
    `[Report](${dir}/report.md) [Video](file://${dir}/walkthrough.webm)`,
    dir
  )
  expect({ uploads, markdown: result.markdown, failed: result.failed }).toEqual({
    uploads: [
      { name: "report.md", type: "text/markdown", bytes: "synthetic report.md" },
      { name: "walkthrough.webm", type: "video/webm", bytes: "synthetic walkthrough.webm" },
    ],
    markdown:
      '[Report](attachment:att_1 "threa-attachment:filename=report.md&mimeType=text%2Fmarkdown&sizeBytes=19") [Video](attachment:att_2 "threa-attachment:filename=walkthrough.webm&mimeType=video%2Fwebm&sizeBytes=26")',
    failed: [],
  })
})

test("should encrypt explicit video links into decryptable sealed refs", async () => {
  const dir = tempDir()
  writeFileSync(join(dir, "video.webm"), "synthetic video")
  let ciphertext = new Uint8Array()
  const result = await uploadSealedReplyAttachments(
    {
      async uploadAttachment(form) {
        ciphertext = new Uint8Array(await (form.get("file") as Blob).arrayBuffer())
        return summary({ id: "att_video" })
      },
    },
    `[Video](${dir}/video.webm)`,
    dir
  )
  expect(result.refs[0]).toBeDefined()
  const ref = result.refs[0]!
  const decrypted = await decryptAttachmentBytes({ ciphertext, key: ref.key, iv: ref.iv })
  expect({
    markdown: result.markdown,
    ids: result.attachmentIds,
    mime: ref.mimeType,
    bytes: new TextDecoder().decode(decrypted),
  }).toEqual({
    markdown: "",
    ids: ["att_video"],
    mime: "video/webm",
    bytes: "synthetic video",
  })
})

test("should leave relative references, source links, URLs, and code samples alone", async () => {
  const markdown =
    "[doc](docs/report.md) [code](/tmp/source.ts:12) [section](/tmp/report.md#L12) [file-section](file:///tmp/report.md#L12) [encoded-section](/tmp/report.md%23L12) [encoded-source](/tmp/source.ts%3A12) [web](https://example.com/report.pdf) `[example](/tmp/report.md)`\n\n```md\n[file](/tmp/video.webm)\n```"
  expect({
    result: await uploadReplyAttachments(noUploads, markdown, "/tmp"),
    has: hasReplyAttachments(markdown),
  }).toEqual({
    result: { markdown, uploaded: [], failed: [] },
    has: false,
  })
  expect(hasReplyAttachments("[report](/tmp/report.md)")).toBe(true)
  expect(redactAttachDirectives("[report](/tmp/report.md)")).toBe("[file: local path omitted]")
})

test("should upload escaped and encoded deliverable paths with decoded labels", async () => {
  const dir = tempDir()
  writeFileSync(join(dir, "a(1).md"), "parentheses")
  writeFileSync(join(dir, "my report.md"), "spaces")
  const uploads: { name: string; bytes: string }[] = []
  const markdown = `[Report \\[one\\]](${dir}/a\\(1\\).md) [Report two](${dir}/my%20report.md)`
  const result = await uploadReplyAttachments(
    {
      async uploadAttachment(form) {
        const file = form.get("file") as File
        uploads.push({ name: file.name, bytes: await file.text() })
        return { id: `att_${uploads.length}`, filename: file.name, mimeType: file.type, sizeBytes: file.size }
      },
    },
    markdown,
    dir
  )
  expect({ uploads, markdown: result.markdown, failed: result.failed, has: hasReplyAttachments(markdown) }).toEqual({
    uploads: [
      { name: "a(1).md", bytes: "parentheses" },
      { name: "my report.md", bytes: "spaces" },
    ],
    markdown:
      '[Report \\[one\\]](attachment:att_1 "threa-attachment:filename=a%281%29.md&mimeType=text%2Fmarkdown&sizeBytes=11") [Report two](attachment:att_2 "threa-attachment:filename=my+report.md&mimeType=text%2Fmarkdown&sizeBytes=6")',
    failed: [],
    has: true,
  })
  expect(redactAttachDirectives(markdown)).toBe("[file: local path omitted] [file: local path omitted]")
})

test("should upload and redact a deliverable with a multiline label without another attachment", async () => {
  const dir = tempDir()
  writeFileSync(join(dir, "report.pdf"), "synthetic report")
  const markdown = `[Download\nreport](${dir}/report.pdf)`
  let bytes = ""
  const result = await uploadReplyAttachments(
    {
      async uploadAttachment(form) {
        const file = form.get("file") as File
        bytes = await file.text()
        return { id: "att_report", filename: file.name, mimeType: file.type, sizeBytes: file.size }
      },
    },
    markdown,
    dir
  )
  expect({ bytes, markdown: result.markdown, failed: result.failed, has: hasReplyAttachments(markdown) }).toEqual({
    bytes: "synthetic report",
    markdown:
      '[Download report](attachment:att_report "threa-attachment:filename=report.pdf&mimeType=application%2Fpdf&sizeBytes=16")',
    failed: [],
    has: true,
  })
  expect(redactAttachDirectives(markdown)).toBe("[file: local path omitted]")
})
