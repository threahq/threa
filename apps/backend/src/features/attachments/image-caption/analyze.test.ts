import { describe, expect, test } from "bun:test"
import type { AI } from "@threahq/agent-runtime"
import { defaultConfigResolver } from "../../../lib/ai/static-config-resolver"
import { analyzeImage } from "./analyze"

const analysis = {
  contentType: "screenshot" as const,
  summary: "A summary",
  extractedText: null,
  structuredData: null,
}

function aiCapturingMediaType(): { ai: AI; mediaTypes: string[] } {
  const mediaTypes: string[] = []
  const ai = {
    generateObject: async (params: { messages: Array<{ content: unknown }> }) => {
      for (const message of params.messages) {
        if (!Array.isArray(message.content)) continue
        for (const part of message.content as Array<{ type: string; mimeType?: string }>) {
          if (part.type === "image" && part.mimeType) mediaTypes.push(part.mimeType)
        }
      }
      return { value: analysis }
    },
  } as unknown as AI
  return { ai, mediaTypes }
}

function header(bytes: number[]): Buffer {
  return Buffer.concat([Buffer.from(bytes), Buffer.alloc(16)])
}

const PNG = header([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = header([0xff, 0xd8, 0xff, 0xe0])
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(16)])
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBP", "latin1"),
  Buffer.alloc(16),
])
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(16)])

async function mediaTypeFor(buffer: Buffer, mimeType: string): Promise<string | undefined> {
  const { ai, mediaTypes } = aiCapturingMediaType()
  await analyzeImage({ ai, configResolver: defaultConfigResolver }, buffer, mimeType, { workspaceId: "ws_1" })
  return mediaTypes[0]
}

describe("analyzeImage media type", () => {
  test("keeps a declared image mime type", async () => {
    expect(await mediaTypeFor(PNG, "image/png")).toBe("image/png")
  })

  test.each([
    ["jpeg", JPEG, "image/jpeg"],
    ["png", PNG, "image/png"],
    ["gif", GIF, "image/gif"],
    ["webp", WEBP, "image/webp"],
    ["heic", HEIC, "image/heic"],
  ])("reads %s off the bytes when the upload is octet-stream", async (_name, buffer, expected) => {
    expect(await mediaTypeFor(buffer as Buffer, "application/octet-stream")).toBe(expected as string)
  })

  test("throws rather than guessing when the bytes match no image format", async () => {
    const { ai } = aiCapturingMediaType()
    await expect(
      analyzeImage(
        { ai, configResolver: defaultConfigResolver },
        Buffer.from("not an image at all"),
        "application/octet-stream",
        { workspaceId: "ws_1" }
      )
    ).rejects.toThrow(/Unrecognised image bytes/)
  })
})
