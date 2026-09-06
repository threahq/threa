import { describe, test, expect } from "vitest"
import type { StreamType } from "@threahq/types"
import { getStreamName, streamFallbackLabel } from "@/lib/streams"
import { getThreadRootContext } from "./breadcrumb-helpers"

describe("getStreamName", () => {
  test("should return #slug for channels with slug", () => {
    expect(getStreamName({ type: "channel", slug: "general", displayName: null })).toBe("#general")
  })

  test("should return null for channels without slug", () => {
    expect(getStreamName({ type: "channel", slug: null, displayName: null })).toBeNull()
  })

  test("should return displayName for threads", () => {
    expect(getStreamName({ type: "thread", slug: null, displayName: "Fixing the auth bug" })).toBe(
      "Fixing the auth bug"
    )
  })

  test("should return null for threads without displayName", () => {
    expect(getStreamName({ type: "thread", slug: null, displayName: null })).toBeNull()
  })

  test("should return displayName for scratchpads", () => {
    expect(getStreamName({ type: "scratchpad", slug: null, displayName: "My Notes" })).toBe("My Notes")
  })

  test("should return null for scratchpads without displayName", () => {
    expect(getStreamName({ type: "scratchpad", slug: null, displayName: null })).toBeNull()
  })

  test("should return pre-resolved displayName for DMs", () => {
    expect(getStreamName({ type: "dm", slug: null, displayName: "Max and Sam" })).toBe("Max and Sam")
  })

  test("should return null for DMs without pre-resolved displayName", () => {
    expect(getStreamName({ type: "dm", slug: null, displayName: null })).toBeNull()
  })
})

describe("streamFallbackLabel", () => {
  test("should return context-appropriate labels for scratchpads", () => {
    expect(streamFallbackLabel("scratchpad", "sidebar")).toBe("New scratchpad")
    expect(streamFallbackLabel("scratchpad", "activity")).toBe("a scratchpad")
    expect(streamFallbackLabel("scratchpad", "breadcrumb")).toBe("Untitled")
  })

  test("should return context-appropriate labels for threads", () => {
    expect(streamFallbackLabel("thread", "sidebar")).toBe("New thread")
    expect(streamFallbackLabel("thread", "activity")).toBe("a thread")
    expect(streamFallbackLabel("thread", "breadcrumb")).toBe("Thread")
  })

  test("should return context-appropriate labels for DMs", () => {
    expect(streamFallbackLabel("dm", "sidebar")).toBe("Direct message")
    expect(streamFallbackLabel("dm", "activity")).toBe("a conversation")
    expect(streamFallbackLabel("dm", "breadcrumb")).toBe("DM")
  })

  test("should return context-appropriate labels for channels", () => {
    expect(streamFallbackLabel("channel", "sidebar")).toBe("Untitled")
    expect(streamFallbackLabel("channel", "activity")).toBe("a channel")
  })
})

describe("getThreadRootContext", () => {
  const allStreams: { id: string; type: StreamType; displayName: string | null; slug?: string | null }[] = [
    { id: "stream_ch", type: "channel", displayName: "General", slug: "general" },
    { id: "stream_sp", type: "scratchpad", displayName: "My Notes", slug: null },
    { id: "stream_dm", type: "dm", displayName: "Alice, Bob", slug: null },
  ]

  test("should return #slug for channel root", () => {
    expect(getThreadRootContext({ rootStreamId: "stream_ch" }, allStreams)).toBe("#general")
  })

  test("should return displayName for scratchpad root", () => {
    expect(getThreadRootContext({ rootStreamId: "stream_sp" }, allStreams)).toBe("My Notes")
  })

  test("should return displayName for DM root with pre-resolved name", () => {
    expect(getThreadRootContext({ rootStreamId: "stream_dm" }, allStreams)).toBe("Alice, Bob")
  })

  test("should return fallback for DM root without displayName", () => {
    const streams: { id: string; type: StreamType; displayName: string | null }[] = [
      { id: "stream_x", type: "dm", displayName: null },
    ]
    expect(getThreadRootContext({ rootStreamId: "stream_x" }, streams)).toBe("Direct message")
  })

  test("should return fallback for scratchpad root without displayName", () => {
    const streams: { id: string; type: StreamType; displayName: string | null }[] = [
      { id: "stream_x", type: "scratchpad", displayName: null },
    ]
    expect(getThreadRootContext({ rootStreamId: "stream_x" }, streams)).toBe("New scratchpad")
  })

  test("should return null when rootStreamId is null", () => {
    expect(getThreadRootContext({ rootStreamId: null }, allStreams)).toBeNull()
  })

  test("should return null when root stream not found", () => {
    expect(getThreadRootContext({ rootStreamId: "stream_missing" }, allStreams)).toBeNull()
  })
})
