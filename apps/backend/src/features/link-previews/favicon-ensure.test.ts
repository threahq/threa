import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { JobQueues, type Job } from "../../lib/queue"
import type { LinkFaviconEnsureJobData } from "../../lib/queue/job-queue"
import * as config from "./config"
import { createLinkFaviconEnsureWorker, enqueueDocLinkFaviconEnsures, linkFaviconEnsureQueueId } from "./favicon-ensure"
import { LinkFaviconRepository } from "./favicon-repository"
import { LinkFaviconService } from "./favicon-service"

afterEach(() => {
  mock.restore()
})

describe("enqueueDocLinkFaviconEnsures", () => {
  function setup(uncached: Array<{ host: string; origin: string }>) {
    const list = spyOn(LinkFaviconRepository, "listUncachedDocLinkOrigins").mockResolvedValue(uncached)
    spyOn(config, "getAppOrigins").mockReturnValue(["https://app.threa.example"])
    const send = mock(async () => "job_1")
    const enqueue = (blockIds: string[]) =>
      enqueueDocLinkFaviconEnsures(
        { db: {} as any, jobQueue: { send } as any },
        { workspaceId: "ws_test", docId: "stream_doc", blockIds }
      )
    return { list, send, enqueue }
  }

  test("should queue one ensure job per uncached host on the touched blocks and none for the app's own origin", async () => {
    const { list, send, enqueue } = setup([
      { host: "app.threa.example", origin: "https://app.threa.example" },
      { host: "example.com", origin: "https://example.com" },
      { host: "dev.test:8080", origin: "http://dev.test:8080" },
    ])
    const now = Date.now()

    await enqueue(["blk_1"])

    expect({ list: list.mock.calls.map((call) => call.slice(1)), sends: send.mock.calls as unknown[] }).toEqual({
      list: [["ws_test", "stream_doc", ["blk_1"]]],
      sends: [
        [
          JobQueues.LINK_FAVICON_ENSURE,
          { workspaceId: "ws_test", pageUrl: "https://example.com/" },
          { messageId: linkFaviconEnsureQueueId("ws_test", "example.com", now) },
        ],
        [
          JobQueues.LINK_FAVICON_ENSURE,
          { workspaceId: "ws_test", pageUrl: "http://dev.test:8080/" },
          { messageId: linkFaviconEnsureQueueId("ws_test", "dev.test:8080", now) },
        ],
      ],
    })
  })

  test("should queue at most twenty jobs when one update links more hosts", async () => {
    const { send, enqueue } = setup(
      Array.from({ length: 25 }, (_, i) => ({ host: `h${i}.example`, origin: `https://h${i}.example` }))
    )

    await enqueue(["blk_1"])

    expect(send.mock.calls.length).toBe(20)
  })

  test("should not look up origins when no block was touched", async () => {
    const { list, send, enqueue } = setup([])

    await enqueue([])

    expect({ lists: list.mock.calls.length, sends: send.mock.calls.length }).toEqual({ lists: 0, sends: 0 })
  })

  test("should collapse ids for one host within a window and split them across windows", () => {
    const start = 1_800_000_000_000 - (1_800_000_000_000 % 600_000)
    expect({
      same: linkFaviconEnsureQueueId("ws", "h", start) === linkFaviconEnsureQueueId("ws", "h", start + 599_999),
      next: linkFaviconEnsureQueueId("ws", "h", start) === linkFaviconEnsureQueueId("ws", "h", start + 600_000),
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
