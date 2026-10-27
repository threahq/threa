import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encryptAttachmentBytes, type AttachmentRef } from "@threahq/bot-runtime-client"
import {
  downloadInboundAttachments,
  downloadSealedInboundAttachments,
  formatInboundAttachmentManifest,
  selectInboundAttachments,
  selectSealedInboundRefs,
  type DownloadedAttachment,
} from "./attachments"
import type { AttachmentSummary, StreamMessageSummary } from "./client"

function summary(partial: Partial<AttachmentSummary> & { id: string }): AttachmentSummary {
  return { filename: "f.txt", mimeType: "text/plain", sizeBytes: 1, ...partial }
}

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-attach-"))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe("selectInboundAttachments", () => {
  const messages: StreamMessageSummary[] = [
    { id: "m_old", attachments: [summary({ id: "a_old", filename: "old.png" })] },
    { id: "m_ctx", attachments: [summary({ id: "a_ctx", filename: "ctx.txt" })] },
    { id: "m_src", attachments: [summary({ id: "a_src", filename: "src.pdf" })] },
    { id: "m_unrelated", attachments: [summary({ id: "a_unrelated" })] },
  ]

  test("keeps only source + shown-context messages, source first", () => {
    const selected = selectInboundAttachments(messages, "m_src", ["m_ctx"])
    expect(selected.map((s) => s.attachment.id)).toEqual(["a_src", "a_ctx"])
    expect(selected[0]!.isSource).toBe(true)
    expect(selected[1]!.isSource).toBe(false)
  })

  test("de-duplicates an attachment that appears on multiple in-scope messages", () => {
    const dupe: StreamMessageSummary[] = [
      { id: "m_src", attachments: [summary({ id: "a_dupe" })] },
      { id: "m_ctx", attachments: [summary({ id: "a_dupe" })] },
    ]
    const selected = selectInboundAttachments(dupe, "m_src", ["m_ctx"])
    expect(selected).toHaveLength(1)
    expect(selected[0]!.attachment.id).toBe("a_dupe")
  })

  test("returns nothing when no in-scope message has attachments", () => {
    expect(selectInboundAttachments(messages, "m_none", [])).toEqual([])
  })

  test("keeps the source marker when a file is shared with an earlier-listed context message", () => {
    const shared: StreamMessageSummary[] = [
      { id: "m_ctx", attachments: [summary({ id: "a_shared" })] },
      { id: "m_src", attachments: [summary({ id: "a_shared" })] },
    ]
    const selected = selectInboundAttachments(shared, "m_src", ["m_ctx"])
    expect(selected).toHaveLength(1)
    expect(selected[0]!.isSource).toBe(true)
  })
})

describe("formatInboundAttachmentManifest", () => {
  test("is empty for no downloads", () => {
    expect(formatInboundAttachmentManifest([])).toBe("")
  })

  test("lists each path and marks the source attachment", () => {
    const downloaded: DownloadedAttachment[] = [
      {
        attachment: summary({ id: "a_src", filename: "src.pdf", mimeType: "application/pdf", sizeBytes: 10 }),
        messageId: "m_src",
        isSource: true,
        localPath: ".threa-attachments/binv/src.pdf",
      },
      {
        attachment: summary({ id: "a_ctx", filename: "ctx.txt", mimeType: "text/plain", sizeBytes: 5 }),
        messageId: "m_ctx",
        isSource: false,
        localPath: ".threa-attachments/binv/ctx.txt",
      },
    ]
    const text = formatInboundAttachmentManifest(downloaded)
    expect(text).toContain("src.pdf (application/pdf, 10 bytes) → .threa-attachments/binv/src.pdf")
    expect(text).toContain("[attached to the message you just received]")
    expect(text).toContain("ctx.txt (text/plain, 5 bytes) → .threa-attachments/binv/ctx.txt")
  })
})

describe("selectSealedInboundRefs", () => {
  const ref = (attachmentId: string): AttachmentRef => ({
    attachmentId,
    key: "a2V5",
    iv: "aXY=",
    filename: `${attachmentId}.txt`,
    mimeType: "text/plain",
    sizeBytes: 1,
  })

  test("orders trigger refs first and marks them as source", () => {
    const selected = selectSealedInboundRefs([ref("a_prompt")], [ref("a_hist")])
    expect(selected.map((s) => s.ref.attachmentId)).toEqual(["a_prompt", "a_hist"])
    expect(selected[0]!.isSource).toBe(true)
    expect(selected[1]!.isSource).toBe(false)
  })

  test("de-duplicates by attachment id, keeping the source marker", () => {
    const selected = selectSealedInboundRefs([ref("a_dupe")], [ref("a_dupe")])
    expect(selected).toHaveLength(1)
    expect(selected[0]!.isSource).toBe(true)
  })
})

describe("downloadSealedInboundAttachments", () => {
  test("fetches the ciphertext, decrypts with the ref's key, and writes the real filename", async () => {
    const dir = tempDir()
    const plaintext = new Uint8Array([42, 43, 44])
    const encrypted = await encryptAttachmentBytes(plaintext)
    const ref: AttachmentRef = {
      attachmentId: "a_sealed",
      key: encrypted.key,
      iv: encrypted.iv,
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
    }
    const client = {
      async getAttachmentDownloadUrl(id: string): Promise<string> {
        return `https://signed.example/${id}`
      },
    }
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(encrypted.ciphertext))
    try {
      const downloaded = await downloadSealedInboundAttachments(client, {
        refs: [{ ref, isSource: true }],
        invocationId: "binv_s",
        cwd: dir,
        log: () => undefined,
      })
      expect(downloaded).toHaveLength(1)
      expect(downloaded[0]!.localPath).toBe(join(dir, ".threa-attachments", "binv_s", "a_sealed", "notes.txt"))
      expect(Array.from(readFileSync(downloaded[0]!.localPath))).toEqual([42, 43, 44])
      expect(downloaded[0]!.attachment).toMatchObject({ id: "a_sealed", filename: "notes.txt" })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("skips a ref whose key does not open the bytes and keeps the rest", async () => {
    const dir = tempDir()
    const good = await encryptAttachmentBytes(new Uint8Array([1]))
    const bad = await encryptAttachmentBytes(new Uint8Array([2]))
    const refs = [
      {
        ref: {
          attachmentId: "a_ok",
          key: good.key,
          iv: good.iv,
          filename: "ok.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
        },
        isSource: true,
      },
      {
        // Wrong key for this ciphertext — the GCM tag check must reject it.
        ref: {
          attachmentId: "a_bad",
          key: good.key,
          iv: bad.iv,
          filename: "bad.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
        },
        isSource: false,
      },
    ]
    const client = {
      async getAttachmentDownloadUrl(id: string): Promise<string> {
        return `https://signed.example/${id}`
      },
    }
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      return new Response(String(input).endsWith("a_ok") ? good.ciphertext : bad.ciphertext)
    }) as typeof fetch)
    const logs: string[] = []
    try {
      const downloaded = await downloadSealedInboundAttachments(client, {
        refs,
        invocationId: "binv_s2",
        cwd: dir,
        log: (m) => logs.push(m),
      })
      expect(downloaded.map((d) => d.attachment.id)).toEqual(["a_ok"])
      expect(logs.join("\n")).toContain("a_bad")
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("writes nothing when there are no refs", async () => {
    const dir = tempDir()
    const client = {
      async getAttachmentDownloadUrl(): Promise<string> {
        throw new Error("should not be called")
      },
    }
    const downloaded = await downloadSealedInboundAttachments(client, {
      refs: [],
      invocationId: "binv_s3",
      cwd: dir,
      log: () => undefined,
    })
    expect(downloaded).toEqual([])
    expect(existsSync(join(dir, ".threa-attachments"))).toBe(false)
  })
})

describe("downloadInboundAttachments", () => {
  test("downloads in-scope attachments to disk and reports their paths", async () => {
    const dir = tempDir()
    const client = {
      async listStreamMessages(): Promise<StreamMessageSummary[]> {
        return [{ id: "m_src", attachments: [summary({ id: "a_src", filename: "src.pdf" })] }]
      },
      async getAttachmentDownloadUrl(id: string): Promise<string> {
        return `https://signed.example/${id}`
      },
    }
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([9, 8, 7])))
    try {
      const downloaded = await downloadInboundAttachments(client, {
        streamId: "stream_1",
        sourceMessageId: "m_src",
        contextMessageIds: [],
        invocationId: "binv_1",
        cwd: dir,
        scanLimit: 30,
        log: () => undefined,
      })
      expect(downloaded).toHaveLength(1)
      const localPath = downloaded[0]!.localPath
      expect(localPath).toBe(join(dir, ".threa-attachments", "binv_1", "a_src", "src.pdf"))
      expect(existsSync(localPath)).toBe(true)
      expect(Array.from(readFileSync(localPath))).toEqual([9, 8, 7])
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("keeps two same-named attachments side by side", async () => {
    const dir = tempDir()
    const client = {
      async listStreamMessages(): Promise<StreamMessageSummary[]> {
        return [
          { id: "m_src", attachments: [summary({ id: "a_new", filename: "image.png" })] },
          { id: "m_ctx", attachments: [summary({ id: "a_old", filename: "image.png" })] },
        ]
      },
      async getAttachmentDownloadUrl(id: string): Promise<string> {
        return `https://signed.example/${id}`
      },
    }
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      return new Response(new Uint8Array(String(input).endsWith("a_new") ? [1] : [2]))
    }) as typeof fetch)
    try {
      const downloaded = await downloadInboundAttachments(client, {
        streamId: "stream_1",
        sourceMessageId: "m_src",
        contextMessageIds: ["m_ctx"],
        invocationId: "binv_dupe",
        cwd: dir,
        scanLimit: 30,
        log: () => undefined,
      })
      const byId = new Map(downloaded.map((d) => [d.attachment.id, d.localPath]))
      expect(Array.from(readFileSync(byId.get("a_new")!))).toEqual([1])
      expect(Array.from(readFileSync(byId.get("a_old")!))).toEqual([2])
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("skips an attachment whose download fails and keeps the rest", async () => {
    const dir = tempDir()
    const client = {
      async listStreamMessages(): Promise<StreamMessageSummary[]> {
        return [
          {
            id: "m_src",
            attachments: [summary({ id: "a_ok", filename: "ok.txt" }), summary({ id: "a_bad", filename: "bad.txt" })],
          },
        ]
      },
      async getAttachmentDownloadUrl(id: string): Promise<string> {
        return `https://signed.example/${id}`
      },
    }
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      return String(input).endsWith("a_bad") ? new Response("nope", { status: 500 }) : new Response(new Uint8Array([1]))
    }) as typeof fetch)
    const logs: string[] = []
    try {
      const downloaded = await downloadInboundAttachments(client, {
        streamId: "stream_1",
        sourceMessageId: "m_src",
        contextMessageIds: [],
        invocationId: "binv_2",
        cwd: dir,
        scanLimit: 30,
        log: (m) => logs.push(m),
      })
      expect(downloaded.map((d) => d.attachment.id)).toEqual(["a_ok"])
      expect(logs.join("\n")).toContain("a_bad")
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("returns nothing (and writes nothing) when no in-scope message has attachments", async () => {
    const dir = tempDir()
    const client = {
      async listStreamMessages(): Promise<StreamMessageSummary[]> {
        return [{ id: "m_other", attachments: [summary({ id: "a_x" })] }]
      },
      async getAttachmentDownloadUrl(): Promise<string> {
        throw new Error("should not be called")
      },
    }
    const downloaded = await downloadInboundAttachments(client, {
      streamId: "stream_1",
      sourceMessageId: "m_src",
      contextMessageIds: [],
      invocationId: "binv_3",
      cwd: dir,
      scanLimit: 30,
      log: () => undefined,
    })
    expect(downloaded).toEqual([])
    expect(existsSync(join(dir, ".threa-attachments"))).toBe(false)
  })
})
