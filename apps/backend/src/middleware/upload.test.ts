import { describe, expect, it } from "bun:test"
import type { AddressInfo } from "node:net"
import express from "express"
import { createErrorHandler } from "@threahq/backend-common"
import type { AnalyticsEvent, AnalyticsReporter, ExceptionContext } from "@threahq/backend-common"
import { createAvatarUploadMiddleware, createUploadMiddleware, MAX_FILE_SIZE } from "./upload"

function makeRecordingReporter(): AnalyticsReporter & { captured: unknown[] } {
  const captured: unknown[] = []
  return {
    captured,
    captureException(error: unknown, _context?: ExceptionContext) {
      captured.push(error)
    },
    captureEvent(_event: AnalyticsEvent) {},
    async shutdown() {},
  }
}

async function postAvatar(form: FormData): Promise<{ status: number; body: unknown; captured: unknown[] }> {
  const analyticsReporter = makeRecordingReporter()
  const app = express()
  app.post("/avatar", createAvatarUploadMiddleware(), (_req, res) => void res.json({ ok: true }))
  app.use(createErrorHandler({ analyticsReporter }))

  const server = app.listen(0)
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/avatar`, {
      method: "POST",
      body: form,
    })
    return { status: response.status, body: await response.json(), captured: analyticsReporter.captured }
  } finally {
    server.close()
  }
}

describe("upload middleware", () => {
  it("creates an express middleware handler", () => {
    const handler = createUploadMiddleware({
      s3Config: {
        bucket: "test-bucket",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
      },
    })

    expect(typeof handler).toBe("function")
  })

  it("enforces the 100MB max file size", () => {
    expect(MAX_FILE_SIZE).toBe(100 * 1024 * 1024)
  })

  it("answers a disallowed file type with 400 and reports no exception", async () => {
    const form = new FormData()
    form.append("avatar", new Blob(["not-an-image"], { type: "application/pdf" }), "resume.pdf")

    const { status, body, captured } = await postAvatar(form)

    expect({ status, body, captured }).toEqual({
      status: 400,
      body: { error: "Invalid file type: application/pdf. Allowed: JPEG, PNG, GIF, WebP", code: "INVALID_FILE_TYPE" },
      captured: [],
    })
  })

  it("answers a multer rejection with 400 and reports no exception", async () => {
    const form = new FormData()
    form.append("wrong-field", new Blob([new Uint8Array(8)], { type: "image/png" }), "avatar.png")

    const { status, body, captured } = await postAvatar(form)

    expect({ status, body, captured }).toEqual({
      status: 400,
      body: { error: "Unexpected field", code: "LIMIT_UNEXPECTED_FILE" },
      captured: [],
    })
  })
})
