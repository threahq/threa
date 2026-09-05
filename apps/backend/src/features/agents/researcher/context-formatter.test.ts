import { describe, expect, test } from "bun:test"
import type { AuthorType } from "@threa/types"
import { StreamRepository } from "../../streams"
import { UserRepository } from "../../workspaces"
import { PersonaRepository } from "../persona-repository"
import {
  formatRetrievedContext,
  type EnrichedAttachmentResult,
  type EnrichedMemoResult,
  type EnrichedMessageResult,
} from "./context-formatter"

const WORKSPACE = "ws_1"

function memo(overrides: Partial<EnrichedMemoResult> = {}): EnrichedMemoResult {
  return {
    memo: {
      id: "memo_1",
      title: "Deploy runbook",
      abstract: "How deploys work",
      keyPoints: ["Ship on Tuesday"],
      sourceMessageIds: ["msg_1"],
      authoredByKind: "user",
    } as unknown as EnrichedMemoResult["memo"],
    distance: 0.1,
    sourceStream: { id: "stream_1", type: "channel", name: "General" },
    ...overrides,
  }
}

function message(overrides: Partial<EnrichedMessageResult> = {}): EnrichedMessageResult {
  return {
    id: "msg_1",
    streamId: "stream_1",
    content: "We decided to use Bun everywhere",
    authorId: "usr_1",
    authorType: "user" as AuthorType,
    authorName: "Kris",
    streamName: "General",
    streamType: "channel",
    createdAt: new Date("2026-07-01T10:00:00Z"),
    ...overrides,
  }
}

describe("formatRetrievedContext", () => {
  test("returns null with no results", () => {
    expect(formatRetrievedContext([], [], [], WORKSPACE)).toBeNull()
  })

  test("messages carry the input-only id tag AND a copyable deep link", () => {
    const text = formatRetrievedContext([], [message()], [], WORKSPACE)
    expect(text).toContain("[msg:msg_1 stream:stream_1 author:usr_1 type:user]")
    expect(text).toContain("Link: /w/ws_1/s/stream_1?m=msg_1")
  })

  test("memos link into the memory explorer", () => {
    const text = formatRetrievedContext([memo()], [], [], WORKSPACE)
    expect(text).toContain("(memo:memo_1 from General stream:stream_1)")
    expect(text).toContain("Link: /w/ws_1/memory?memo=memo_1")
  })

  test("attachments link to their stream when one is present, and not otherwise", () => {
    const withStream: EnrichedAttachmentResult = {
      id: "att_1",
      filename: "notes.pdf",
      mimeType: "application/pdf",
      streamId: "stream_1",
      contentType: null,
      summary: null,
      createdAt: new Date("2026-07-01T10:00:00Z"),
    }
    const text = formatRetrievedContext([], [], [withStream], WORKSPACE)
    expect(text).toContain("Link: /w/ws_1/s/stream_1")

    const withoutStream = { ...withStream, streamId: null }
    const text2 = formatRetrievedContext([], [], [withoutStream], WORKSPACE)
    expect(text2).not.toContain("Link:")
  })
})
