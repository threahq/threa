import { afterEach, describe, expect, it, vi } from "vitest"
import {
  consumeSnippetRequest,
  queueSnippetRequest,
  resetSnippetRequestStoreCache,
  subscribeSnippetRequest,
} from "./snippet-request-store"

afterEach(() => {
  resetSnippetRequestStoreCache()
})

describe("snippet request store", () => {
  it("should hand a queued request to its own workspace once when it is consumed", () => {
    queueSnippetRequest("ws_1", "stream_1")

    expect([consumeSnippetRequest("ws_1", "stream_1"), consumeSnippetRequest("ws_1", "stream_1")]).toEqual([
      true,
      false,
    ])
  })

  it("should keep a request invisible to another workspace when both hold the same stream id", () => {
    const onB = vi.fn()
    subscribeSnippetRequest("ws_b", "stream_shared", onB)

    queueSnippetRequest("ws_a", "stream_shared")

    expect({
      consumedByB: consumeSnippetRequest("ws_b", "stream_shared"),
      listenerBCalls: onB.mock.calls.length,
      consumedByA: consumeSnippetRequest("ws_a", "stream_shared"),
    }).toEqual({ consumedByB: false, listenerBCalls: 0, consumedByA: true })
  })
})
