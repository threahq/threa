import { describe, expect, test } from "bun:test"
import { gunzipSync } from "node:zlib"
import type { PostHogOptions } from "posthog-node"
import { DisabledAnalyticsReporter, PostHogAnalyticsReporter } from "./reporter"

type FetchFn = NonNullable<PostHogOptions["fetch"]>
type FetchOptions = Parameters<FetchFn>[1]
type FetchResponse = Awaited<ReturnType<FetchFn>>

interface RecordedRequest {
  url: string
  options: FetchOptions
}

function toBuffer(body: FetchOptions["body"]): Buffer {
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (typeof body === "string") return Buffer.from(body, "utf-8")
  throw new Error(`unsupported body type: ${typeof body}`)
}

function parseCapturedBody(body: FetchOptions["body"], headers: Record<string, string> | undefined): unknown {
  const buffer = toBuffer(body)
  const encoding = headers?.["Content-Encoding"] ?? headers?.["content-encoding"]
  const text = encoding === "gzip" ? gunzipSync(buffer).toString("utf-8") : buffer.toString("utf-8")
  return JSON.parse(text)
}

function okResponse(): FetchResponse {
  return { status: 200, text: async () => "", json: async () => ({}) } as FetchResponse
}

function createRecordingReporter(): { reporter: PostHogAnalyticsReporter; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const reporter = new PostHogAnalyticsReporter({
    config: { projectToken: "phc_test", host: "https://eu.i.posthog.com", logsLevel: null },
    service: "backend",
    region: "eu-north-1",
    fetch: async (url, options) => {
      requests.push({ url, options })
      return okResponse()
    },
  })
  return { reporter, requests }
}

describe("PostHogAnalyticsReporter", () => {
  test("should send a captured exception with distinct id and properties to the configured host", async () => {
    const { reporter, requests } = createRecordingReporter()

    reporter.captureException(new Error("boom"), { distinctId: "user_1", properties: { path: "/x" } })
    await reporter.shutdown()

    expect(requests.length).toBeGreaterThan(0)
    const request = requests[requests.length - 1]!
    expect(request.url.startsWith("https://eu.i.posthog.com")).toBe(true)

    const body = parseCapturedBody(request.options.body, request.options.headers as Record<string, string>) as {
      batch: Array<{
        event: string
        distinct_id: string
        properties: Record<string, unknown> & { $exception_list?: Array<{ value: string }> }
      }>
    }

    expect(body.batch.length).toBe(1)
    const event = body.batch[0]!
    expect(event.event).toBe("$exception")
    expect(event.distinct_id).toBe("user_1")
    expect(event.properties.service).toBe("backend")
    expect(event.properties.region).toBe("eu-north-1")
    expect(event.properties.path).toBe("/x")
    expect(event.properties.$exception_list?.[0]?.value).toBe("boom")
    expect(event.properties.$process_person_profile).toBe(false)
  })

  test("should send a captured event with distinct id, properties and workspace group to the configured host", async () => {
    const { reporter, requests } = createRecordingReporter()

    reporter.captureEvent({
      distinctId: "usr_1",
      event: "message_sent",
      properties: { workspaceId: "ws_1", streamId: "stream_1", messageId: "msg_1" },
      groups: { workspace: "ws_1" },
    })
    await reporter.shutdown()

    expect(requests.length).toBeGreaterThan(0)
    const request = requests[requests.length - 1]!
    const body = parseCapturedBody(request.options.body, request.options.headers as Record<string, string>) as {
      batch: Array<{ event: string; distinct_id: string; properties: Record<string, unknown> }>
    }

    expect(body.batch.length).toBe(1)
    expect(body.batch[0]).toMatchObject({
      event: "message_sent",
      distinct_id: "usr_1",
      properties: {
        service: "backend",
        region: "eu-north-1",
        workspaceId: "ws_1",
        streamId: "stream_1",
        messageId: "msg_1",
        $groups: { workspace: "ws_1" },
      },
    })
  })

  test("should resolve shutdown within the bound when the transport hangs", async () => {
    const reporter = new PostHogAnalyticsReporter({
      config: { projectToken: "phc_test", host: "https://eu.i.posthog.com", logsLevel: null },
      service: "backend",
      region: null,
      shutdownTimeoutMs: 50,
      fetch: () => new Promise<FetchResponse>(() => {}),
    })

    reporter.captureException(new Error("boom"))

    const start = Date.now()
    await reporter.shutdown()
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(1000)
  })
})

describe("DisabledAnalyticsReporter", () => {
  test("should no-op captureException, captureEvent and resolve shutdown", async () => {
    const reporter = new DisabledAnalyticsReporter()

    expect(() => reporter.captureException(new Error("boom"), { distinctId: "user_1" })).not.toThrow()
    expect(() => reporter.captureEvent({ distinctId: "usr_1", event: "message_sent" })).not.toThrow()
    await expect(reporter.shutdown()).resolves.toBeUndefined()
  })
})
