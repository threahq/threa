import { describe, expect, test } from "bun:test"
import { gunzipSync } from "node:zlib"
import type { PostHogOptions } from "posthog-node"
import { DisabledErrorReporter, PostHogErrorReporter } from "./error-reporter"

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

describe("PostHogErrorReporter", () => {
  test("should send a captured exception with distinct id and properties to the configured host", async () => {
    const requests: RecordedRequest[] = []
    const reporter = new PostHogErrorReporter({
      config: { projectToken: "phc_test", host: "https://eu.i.posthog.com" },
      service: "backend",
      region: "eu-north-1",
      fetch: async (url, options) => {
        requests.push({ url, options })
        return okResponse()
      },
    })

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
  })

  test("should resolve shutdown within the bound when the transport hangs", async () => {
    const reporter = new PostHogErrorReporter({
      config: { projectToken: "phc_test", host: "https://eu.i.posthog.com" },
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

describe("DisabledErrorReporter", () => {
  test("should no-op captureException and resolve shutdown", async () => {
    const reporter = new DisabledErrorReporter()

    expect(() => reporter.captureException(new Error("boom"), { distinctId: "user_1" })).not.toThrow()
    await expect(reporter.shutdown()).resolves.toBeUndefined()
  })
})
