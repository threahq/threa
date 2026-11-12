import { afterEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test"
import { JobQueues, QueueRepository, type Job } from "../../lib/queue"
import type { LinkFaviconEnsureJobData } from "../../lib/queue/job-queue"
import * as config from "./config"
import { createLinkFaviconEnsureWorker, enqueueDocLinkFaviconEnsures, linkFaviconEnsureQueueId } from "./favicon-ensure"
import { LinkFaviconRepository } from "./favicon-repository"
import { LinkFaviconService } from "./favicon-service"

afterEach(() => {
  mock.restore()
  setSystemTime()
})

describe("enqueueDocLinkFaviconEnsures", () => {
  const NOW = new Date("2026-05-12T10:00:00Z")
  const WINDOW_MS = 600_000

  function setup(uncached: Array<{ host: string; origin: string }>) {
    setSystemTime(NOW)
    const list = spyOn(LinkFaviconRepository, "listUncachedDocLinkOrigins").mockResolvedValue(uncached)
    spyOn(config, "getAppOrigins").mockReturnValue(["https://app.threa.example"])
    const batchInsert = spyOn(QueueRepository, "batchInsert").mockResolvedValue([])
    const enqueue = (blockIds: string[]) =>
      enqueueDocLinkFaviconEnsures({} as any, { workspaceId: "ws_test", docId: "stream_doc", blockIds })
    const queued = () => batchInsert.mock.calls.flatMap(([, messages]) => messages)
    return { list, queued, enqueue }
  }

  test("should queue one ensure job per uncached host on the touched blocks and none for the app's own origin", async () => {
    const { list, queued, enqueue } = setup([
      { host: "app.threa.example", origin: "https://app.threa.example" },
      { host: "example.com", origin: "https://example.com" },
      { host: "dev.test:8080", origin: "http://dev.test:8080" },
    ])

    await enqueue(["blk_1"])

    const job = (host: string, pageUrl: string) => ({
      id: linkFaviconEnsureQueueId("ws_test", host, NOW.getTime()),
      queueName: JobQueues.LINK_FAVICON_ENSURE,
      workspaceId: "ws_test",
      payload: { workspaceId: "ws_test", pageUrl },
      processAfter: NOW,
      insertedAt: NOW,
    })
    expect({ list: list.mock.calls.map((call) => call.slice(1)), queued: queued() }).toEqual({
      list: [["ws_test", "stream_doc", ["blk_1"]]],
      queued: [job("example.com", "https://example.com/"), job("dev.test:8080", "http://dev.test:8080/")],
    })
  })

  test("should queue the first twenty hosts when one update links more", async () => {
    const { queued, enqueue } = setup(
      Array.from({ length: 25 }, (_, i) => ({ host: `h${i}.example`, origin: `https://h${i}.example` }))
    )

    await enqueue(["blk_1"])

    expect(queued().map((message) => (message.payload as LinkFaviconEnsureJobData).pageUrl)).toEqual(
      Array.from({ length: 20 }, (_, i) => `https://h${i}.example/`)
    )
  })

  test("should not look up origins when no block was touched", async () => {
    const { list, queued, enqueue } = setup([])

    await enqueue([])

    expect({ lists: list.mock.calls, queued: queued() }).toEqual({ lists: [], queued: [] })
  })

  test("should collapse ids for one host within a window and split them across windows", () => {
    const start = Math.floor(NOW.getTime() / WINDOW_MS) * WINDOW_MS
    expect({
      same: linkFaviconEnsureQueueId("ws", "h", start) === linkFaviconEnsureQueueId("ws", "h", start + WINDOW_MS - 1),
      next: linkFaviconEnsureQueueId("ws", "h", start) === linkFaviconEnsureQueueId("ws", "h", start + WINDOW_MS),
    }).toEqual({ same: true, next: false })
  })
})

describe("createLinkFaviconEnsureWorker", () => {
  const job = {
    id: "job_1",
    data: { workspaceId: "ws_1", pageUrl: "https://example.com/" },
  } as Job<LinkFaviconEnsureJobData>

  function htmlResponse(html: string): Response {
    const response = new Response(html, { status: 200, headers: { "content-type": "text/html" } })
    Object.defineProperty(response, "url", { value: "https://example.com/" })
    return response
  }

  function setup() {
    const linkFaviconService = new LinkFaviconService({ pool: {} as any })
    const ensureForPage = spyOn(linkFaviconService, "ensureForPage").mockResolvedValue()
    return { worker: createLinkFaviconEnsureWorker({ linkFaviconService }), ensureForPage }
  }

  test("should ensure the page's declared icon when the page declares one", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      htmlResponse('<html><head><link rel="icon" href="https://cdn.example.com/icon.png"></head></html>')
    )
    const { worker, ensureForPage } = setup()

    await worker(job)

    expect(ensureForPage.mock.calls).toEqual([["ws_1", "https://example.com/", "https://cdn.example.com/icon.png"]])
  })

  test("should ensure with no declared icon when the page fetch fails", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"))
    const { worker, ensureForPage } = setup()

    await worker(job)

    expect(ensureForPage.mock.calls).toEqual([["ws_1", "https://example.com/", null]])
  })
})
