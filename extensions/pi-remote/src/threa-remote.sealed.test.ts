import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent"
import {
  base64ToBytes,
  decryptAttachmentBytes,
  encryptAttachmentBytes,
  openMessageAsString,
  parseSealedPayload,
  type AttachmentRef,
  type StreamEnvelope,
} from "@threa/bot-runtime-client"
import { __testing } from "./threa-remote"

// The full-vs-redacted trace policy for sealed (E2EE) turns. The crypto itself
// (BIK, claim hydration, seal/open) is covered by @threa/bot-runtime-client's
// suite; these tests pin the harness-side policy: full detail is emitted ONLY
// when the turn is sealed, and the config toggle can only opt a sealed turn
// back to redacted — never unlock full detail for plaintext.

type SealedInvocation = Parameters<typeof __testing.shouldEmitFullTrace>[0]

const BASE_CONFIG = { baseUrl: "https://x", workspaceId: "ws_1", apiKey: "k" }

const sealingState = {
  streamId: "stream_root",
  replyKeyGeneration: 1,
  replySenderId: "bot_1",
  replySsk: new Uint8Array(32),
  callbackToken: "cb",
}

function invocation(overrides: Record<string, unknown> = {}): SealedInvocation {
  return {
    id: "binv_1",
    activeStreamId: "stream_a",
    sourceMessageId: "msg_1",
    promptMarkdown: "hi",
    claimToken: "tok",
    claimExpiresAt: null,
    ...overrides,
  } as SealedInvocation
}

function bashCall(command: string): ToolCallEvent {
  return { type: "tool_call", toolCallId: "tc_1", toolName: "bash", input: { command } } as unknown as ToolCallEvent
}

function bashResult(output: string, isError = false): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "tc_1",
    toolName: "bash",
    isError,
    content: [{ type: "text", text: output }],
  } as unknown as ToolResultEvent
}

afterEach(() => __testing.setConfigForTesting(undefined))

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-sealed-attach-"))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

describe("sealed attachments (outbound)", () => {
  test("completeSealedWithMarkdown encrypts + uploads directives and seals the refs into the reply", async () => {
    __testing.setConfigForTesting(BASE_CONFIG)
    const dir = tempDir()
    const filePath = join(dir, "report.csv")
    const plaintext = new TextEncoder().encode("a,b\n1,2\n")
    writeFileSync(filePath, plaintext)

    const uploads: Array<{ filename: string; type: string; e2e: unknown; bytes: Uint8Array }> = []
    const completions: Array<Record<string, unknown>> = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input)
      if (url.endsWith("/attachments")) {
        const form = init?.body as FormData
        const file = form.get("file") as Blob & { name?: string }
        uploads.push({
          filename: file.name ?? "",
          type: file.type,
          e2e: form.get("e2e"),
          bytes: new Uint8Array(await file.arrayBuffer()),
        })
        return jsonResponse({
          data: { id: "att_pi_1", filename: "encrypted", mimeType: "application/octet-stream", sizeBytes: 1 },
        })
      }
      if (url.endsWith("/sealed-complete")) {
        completions.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return jsonResponse({ data: {} })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch)

    try {
      await __testing.completeSealedWithMarkdown(
        invocation() as never,
        sealingState as never,
        `Done — data attached.\nTHREA_ATTACH: ${filePath}`,
        dir
      )
    } finally {
      fetchSpy.mockRestore()
    }

    // Ciphertext-only upload under the placeholder name, flagged e2e.
    expect(uploads).toHaveLength(1)
    expect(uploads[0]!.e2e).toBe("true")
    expect(uploads[0]!.filename).toBe("encrypted")
    expect(Array.from(uploads[0]!.bytes)).not.toEqual(Array.from(plaintext))
    // The completion binds the row and the sealed payload carries the ref.
    expect(completions).toHaveLength(1)
    const reply = (
      completions[0] as {
        reply: { messageId: string; ciphertext: string; envelope: StreamEnvelope; attachmentIds?: string[] }
      }
    ).reply
    expect(reply.attachmentIds).toEqual(["att_pi_1"])
    const payload = parseSealedPayload(
      await openMessageAsString({
        key: sealingState.replySsk,
        envelope: reply.envelope,
        ciphertext: base64ToBytes(reply.ciphertext),
      })
    )
    expect(payload.contentMarkdown).toBe("Done — data attached.")
    expect(payload.attachmentRefs).toHaveLength(1)
    const ref = payload.attachmentRefs[0]!
    expect(ref).toMatchObject({ attachmentId: "att_pi_1", filename: "report.csv", mimeType: "text/csv", sizeBytes: 8 })
    const decrypted = await decryptAttachmentBytes({ ciphertext: uploads[0]!.bytes, key: ref.key, iv: ref.iv })
    expect(new TextDecoder().decode(decrypted)).toBe("a,b\n1,2\n")
  })

  test("a missing directive file becomes a sealed failure note, not a dropped turn", async () => {
    __testing.setConfigForTesting(BASE_CONFIG)
    const completions: Array<Record<string, unknown>> = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input)
      if (url.endsWith("/sealed-complete")) {
        completions.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return jsonResponse({ data: {} })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch)

    try {
      await __testing.completeSealedWithMarkdown(
        invocation() as never,
        sealingState as never,
        "Answer.\nTHREA_ATTACH: ./missing.bin",
        tempDir()
      )
    } finally {
      fetchSpy.mockRestore()
    }

    const reply = (
      completions[0] as { reply: { ciphertext: string; envelope: StreamEnvelope; attachmentIds?: string[] } }
    ).reply
    expect(reply.attachmentIds).toBeUndefined()
    const payload = parseSealedPayload(
      await openMessageAsString({
        key: sealingState.replySsk,
        envelope: reply.envelope,
        ciphertext: base64ToBytes(reply.ciphertext),
      })
    )
    expect(payload.contentMarkdown).toContain("Answer.")
    expect(payload.contentMarkdown).toContain("Attachment upload failed:")
    expect(payload.attachmentRefs).toEqual([])
  })
})

describe("sealed attachments (inbound)", () => {
  test("downloadSealedContextAttachments fetches, decrypts, and writes the real filenames", async () => {
    __testing.setConfigForTesting(BASE_CONFIG)
    const dir = tempDir()
    const plaintext = new TextEncoder().encode("inbound secret")
    const encrypted = await encryptAttachmentBytes(plaintext)
    const ref: AttachmentRef = {
      attachmentId: "att_in_1",
      key: encrypted.key,
      iv: encrypted.iv,
      filename: "notes.md",
      mimeType: "text/markdown",
      sizeBytes: plaintext.length,
    }
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("/attachments/att_in_1/url"))
        return jsonResponse({ data: { url: "https://signed.example/att_in_1" } })
      if (url.startsWith("https://signed.example/")) return new Response(encrypted.ciphertext)
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch)

    let lines: { contextLines: string[]; sourceLines: string[] }
    try {
      lines = await __testing.downloadSealedContextAttachments([ref], [], invocation() as never, dir)
    } finally {
      fetchSpy.mockRestore()
    }

    expect(lines.contextLines).toHaveLength(1)
    expect(lines.contextLines[0]).toContain("notes.md (text/markdown, 14 bytes)")
    expect(lines.contextLines[0]).toContain("[attached to the source message]")
    expect(lines.sourceLines).toHaveLength(1)
    expect(lines.sourceLines[0]).not.toContain("[attached to the source message]")
    const localPath = join(dir, ".threa-attachments", "binv_1", "notes.md")
    expect(new TextDecoder().decode(readFileSync(localPath))).toBe("inbound secret")
  })

  test("de-duplicates a ref that appears on both the trigger and history", async () => {
    __testing.setConfigForTesting(BASE_CONFIG)
    const dir = tempDir()
    const encrypted = await encryptAttachmentBytes(new Uint8Array([7]))
    const ref: AttachmentRef = {
      attachmentId: "att_dupe",
      key: encrypted.key,
      iv: encrypted.iv,
      filename: "dupe.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
    }
    let urlFetches = 0
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("/attachments/att_dupe/url")) {
        urlFetches += 1
        return jsonResponse({ data: { url: "https://signed.example/att_dupe" } })
      }
      if (url.startsWith("https://signed.example/")) return new Response(encrypted.ciphertext)
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch)

    let lines: { contextLines: string[]; sourceLines: string[] }
    try {
      lines = await __testing.downloadSealedContextAttachments([ref], [ref], invocation() as never, dir)
    } finally {
      fetchSpy.mockRestore()
    }

    expect(lines.contextLines).toHaveLength(1)
    expect(lines.sourceLines).toHaveLength(1)
    expect(urlFetches).toBe(1)
  })

  test("keeps history-only attachments out of steer context", async () => {
    __testing.setConfigForTesting(BASE_CONFIG)
    const dir = tempDir()
    const encrypted = await encryptAttachmentBytes(new Uint8Array([9]))
    const ref: AttachmentRef = {
      attachmentId: "att_history",
      key: encrypted.key,
      iv: encrypted.iv,
      filename: "old.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
    }
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("/attachments/att_history/url")) {
        return jsonResponse({ data: { url: "https://signed.example/att_history" } })
      }
      if (url.startsWith("https://signed.example/")) return new Response(encrypted.ciphertext)
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch)

    let lines: { contextLines: string[]; sourceLines: string[] }
    try {
      lines = await __testing.downloadSealedContextAttachments([], [ref], invocation() as never, dir)
    } finally {
      fetchSpy.mockRestore()
    }

    expect(lines.contextLines).toHaveLength(1)
    expect(lines.sourceLines).toEqual([])
  })
})

describe("shouldEmitFullTrace", () => {
  test("true only for a sealed turn with the toggle unset or on", () => {
    __testing.setConfigForTesting(BASE_CONFIG)
    expect(__testing.shouldEmitFullTrace(invocation({ sealing: sealingState }))).toBe(true)
    __testing.setConfigForTesting({ ...BASE_CONFIG, sealedFullTrace: true })
    expect(__testing.shouldEmitFullTrace(invocation({ sealing: sealingState }))).toBe(true)
  })

  test("the toggle opts a sealed turn back to redacted", () => {
    __testing.setConfigForTesting({ ...BASE_CONFIG, sealedFullTrace: false })
    expect(__testing.shouldEmitFullTrace(invocation({ sealing: sealingState }))).toBe(false)
  })

  test("never true for a plaintext turn, whatever the toggle says", () => {
    __testing.setConfigForTesting({ ...BASE_CONFIG, sealedFullTrace: true })
    expect(__testing.shouldEmitFullTrace(invocation())).toBe(false)
    expect(__testing.shouldEmitFullTrace(undefined)).toBe(false)
  })
})

describe("full trace detail (sealed turns)", () => {
  test("tool_call carries the real shell command when full", () => {
    const payload = JSON.parse(__testing.formatToolCallTrace(bashCall("rm -rf ./build && make"), true)) as {
      sections: Array<{ label: string; body: string; lang: string | null }>
    }
    expect(payload.sections).toEqual([{ label: "Arguments", body: "rm -rf ./build && make", lang: "bash" }])
  })

  test("tool_call stays redacted by default (missed call sites fail safe)", () => {
    const payload = JSON.parse(__testing.formatToolCallTrace(bashCall("secret command"))) as {
      sections: Array<{ body: string }>
    }
    expect(payload.sections[0]!.body).toBe("Shell command omitted for safety.")
    expect(JSON.stringify(payload)).not.toContain("secret command")
  })

  test("tool_result carries the real output when full, a size summary otherwise", () => {
    const full = JSON.parse(__testing.formatToolResultTrace(bashResult("total 42\n-rw-r--r-- secrets.txt"), true)) as {
      sections: Array<{ label: string; body: string }>
    }
    expect(full.sections[0]).toMatchObject({ label: "Output", body: "total 42\n-rw-r--r-- secrets.txt" })

    const redacted = JSON.parse(__testing.formatToolResultTrace(bashResult("total 42\n-rw-r--r-- secrets.txt"))) as {
      sections: Array<{ body: string }>
    }
    expect(redacted.sections[0]!.body).toContain("omitted for safety")
    expect(JSON.stringify(redacted)).not.toContain("secrets.txt")
  })

  test("tool errors keep real details when full, drop them when redacted", () => {
    const full = JSON.parse(
      __testing.formatToolResultTrace(bashResult("ENOENT: /home/kris/.aws/credentials", true), true)
    ) as { sections: Array<{ label: string; body: string }> }
    expect(full.sections[0]).toMatchObject({ label: "Error output", body: "ENOENT: /home/kris/.aws/credentials" })

    const redacted = JSON.parse(
      __testing.formatToolResultTrace(bashResult("ENOENT: /home/kris/.aws/credentials", true))
    ) as { sections: Array<{ body: string }> }
    expect(JSON.stringify(redacted)).not.toContain(".aws")
  })

  test("non-bash args serialize as pretty JSON when full", () => {
    const event = {
      type: "tool_call",
      toolCallId: "tc_2",
      toolName: "edit",
      input: { path: "src/index.ts", patch: "- a\n+ b" },
    } as unknown as ToolCallEvent
    const { body, lang } = __testing.fullToolArgumentSummary(event)
    expect(lang).toBe("json")
    expect(JSON.parse(body)).toEqual({ path: "src/index.ts", patch: "- a\n+ b" })
  })

  test("a full trace uses the roomier sealed clamp instead of the 10K plaintext cap", () => {
    const bigOutput = "x".repeat(30_000)
    const payload = __testing.formatToolResultTrace(bashResult(bigOutput), true)
    expect(payload.length).toBeGreaterThan(10_000)
    expect(payload).toContain(bigOutput.slice(0, 1000))
  })
})
