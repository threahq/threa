import { describe, expect, test } from "bun:test"
import type { AuthorType } from "@threahq/types"
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

function memo(
  overrides: Partial<EnrichedMemoResult> = {},
  latestSourceAt: Date | null = new Date("2026-07-01T10:00:00Z")
): EnrichedMemoResult {
  return {
    memo: {
      id: "memo_1",
      title: "Deploy runbook",
      abstract: "How deploys work",
      keyPoints: ["Ship on Tuesday"],
      sourceMessageIds: ["msg_1"],
      authoredByKind: "user",
      createdAt: new Date("2026-05-15T10:00:00Z"),
      latestSourceAt,
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

  test("a same-day message and memo stay ordered on the asker's clock, offset stated", () => {
    const text = formatRetrievedContext(
      [memo()],
      [message({ createdAt: new Date("2026-07-01T10:05:30Z") })],
      [],
      WORKSPACE,
      "Europe/Stockholm"
    )
    expect([text?.match(/_, as of [^\n]+/)?.[0], text?.match(/\*\* \(([^)]+)\):/)?.[1]]).toEqual([
      "_, as of 2026-07-01 12:00 UTC+2",
      "2026-07-01 12:05 UTC+2",
    ])
  })

  test("messages group by conversation: the room first, a thread under its channel with its opening post on top", () => {
    const text = formatRetrievedContext(
      [],
      [
        message({
          id: "msg_reply",
          streamId: "stream_thread",
          streamName: "thread",
          content: "Signed off",
          thread: { channelName: "Launch", title: null, rootMessageId: "msg_root" },
        }),
        message({ id: "msg_other", streamId: "stream_other", streamName: "Random", content: "Unrelated" }),
        message({
          id: "msg_root",
          streamId: "stream_launch",
          streamName: "Launch",
          content: "Checklist",
          createdAt: new Date("2026-06-30T09:00:00Z"),
        }),
        message({
          id: "msg_room",
          streamId: "stream_room",
          streamName: "Ops",
          content: "Room note",
          inCurrentRoom: true,
        }),
      ],
      [],
      WORKSPACE
    )
    expect({
      headers: [...(text ?? "").matchAll(/^#### .+$/gm)].map((m) => m[0]),
      threadOrder: [...(text ?? "").matchAll(/^> (?:\[[^\]]+\] )?(.+)$/gm)]
        .map((m) => m[1])
        .filter((line) => line === "Checklist" || line === "Signed off" || line.includes("started the thread")),
    }).toEqual({
      headers: ["#### _Ops_ (the room this question was asked in)", "#### Thread in _Launch_", "#### _Random_"],
      threadOrder: [expect.stringContaining("started the thread"), "Checklist", "Signed off"],
    })
  })

  test("memos link into the memory explorer", () => {
    const text = formatRetrievedContext([memo()], [], [], WORKSPACE)
    expect(text).toContain("(memo:memo_1 from General stream:stream_1)")
    expect(text).toContain("Link: /w/ws_1/memory?memo=memo_1")
  })

  test("memos are dated by their newest source message, and undated when none resolve", () => {
    const text = formatRetrievedContext([memo(), memo({}, null)], [], [], WORKSPACE)
    expect(text).toEqual(
      expect.stringContaining(
        "A memo condenses the messages on its Sources line. Where those messages appear among the Related Messages below, answer from what they say: anything a memo states beyond them is its own reading, not something anyone said. Each memo is as of its newest source message. A message posted after that date that explicitly changes or reverses what the memo states overrides it. A question, proposal or passing remark does not.\n\n**Deploy runbook**"
      )
    )
    expect(text?.match(/^\*\*Deploy runbook\*\* _\([^\n]*$/gm)).toEqual([
      "**Deploy runbook** _(memo:memo_1 from General stream:stream_1)_, as of 2026-07-01 10:00 UTC+0",
      "**Deploy runbook** _(memo:memo_1 from General stream:stream_1)_",
    ])
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
