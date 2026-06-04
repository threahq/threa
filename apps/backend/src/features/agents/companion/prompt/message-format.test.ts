import { describe, expect, test } from "bun:test"
import { AuthorTypes, StreamTypes } from "@threa/types"
import type { MessageWithAttachments, StreamContext } from "../../context-builder"
import { formatMessagesWithTemporal } from "./message-format"

const baseTemporal = {
  currentTime: "2026-04-30T10:00:00Z",
  timezone: "UTC",
  utcOffset: "UTC+0",
  dateFormat: "YYYY-MM-DD" as const,
  timeFormat: "24h" as const,
}

const userMsg = (overrides: Partial<MessageWithAttachments> = {}): MessageWithAttachments =>
  ({
    id: "msg_user_1",
    streamId: "stream_x",
    sequence: "1",
    authorId: "user_alice",
    authorType: AuthorTypes.USER,
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "Hello there",
    replyCount: 0,
    sentVia: null,
    reactions: {},
    metadata: {},
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-04-30T10:00:00Z"),
    ...overrides,
  }) as MessageWithAttachments

const personaMsg = (overrides: Partial<MessageWithAttachments> = {}): MessageWithAttachments =>
  ({
    id: "msg_persona_1",
    streamId: "stream_x",
    sequence: "2",
    authorId: "persona_ariadne",
    authorType: AuthorTypes.PERSONA,
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "Got it.",
    replyCount: 0,
    sentVia: null,
    reactions: {},
    metadata: {},
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-04-30T10:01:00Z"),
    ...overrides,
  }) as MessageWithAttachments

const baseContext: StreamContext = {
  streamType: StreamTypes.SCRATCHPAD,
  streamInfo: {
    id: "stream_x",
    name: "Ideas",
    description: null,
    slug: null,
  },
  conversationHistory: [],
  temporal: baseTemporal,
}

describe("formatMessagesWithTemporal — ID tagging for pointer URLs", () => {
  test("user messages get a [msg:… author:…] tag before the timestamp", () => {
    const formatted = formatMessagesWithTemporal([userMsg()], baseContext)
    expect(formatted).toHaveLength(1)
    const content = formatted[0].content as string
    expect(content).toContain("[msg:msg_user_1 author:user_alice]")
    // Tag → date boundary → timestamp → content. The id tag comes first so it
    // anchors the message even when a [Date: …] marker is interposed.
    expect(content).toMatch(/^\[msg:msg_user_1 author:user_alice\] \[Date: [\d-]+\]\n\(10:00\) Hello there/)
    expect(content).toContain("Hello there")
  })

  test("persona messages also get [msg:… author:…] so self-quotes have a complete pointer URL", () => {
    const formatted = formatMessagesWithTemporal([personaMsg()], baseContext)
    const content = formatted[0].content as string
    expect(content).toContain("[msg:msg_persona_1 author:persona_ariadne]")
    expect(content).not.toContain("(10:01)")
    expect(content).toContain("Got it.")
  })

  test("attachment descriptions surface the attachment id and a per-prompt image index", () => {
    const msg = userMsg({
      attachments: [
        {
          id: "att_image_a",
          filename: "diagram.png",
          mimeType: "image/png",
          extraction: null,
        },
        {
          id: "att_pdf_a",
          filename: "report.pdf",
          mimeType: "application/pdf",
          extraction: null,
        },
        {
          id: "att_image_b",
          filename: "chart.png",
          mimeType: "image/png",
          extraction: null,
        },
      ],
    })

    const formatted = formatMessagesWithTemporal([msg], baseContext)
    const content = formatted[0].content as string

    // First image attachment in conversation order is #1, second image is #2.
    // Counter does not advance for non-image attachments.
    expect(content).toContain("[Image: diagram.png (attach:att_image_a #1)]")
    expect(content).toContain("[Attachment: report.pdf (application/pdf, attach:att_pdf_a)]")
    expect(content).toContain("[Image: chart.png (attach:att_image_b #2)]")
  })

  test("falls back to no temporal prefix when context.temporal is absent but still tags ids", () => {
    const formatted = formatMessagesWithTemporal([userMsg(), personaMsg()], { ...baseContext, temporal: undefined })
    const userContent = formatted[0].content as string
    const personaContent = formatted[1].content as string
    // Trailing space after the id tag so output reads "[msg:…] Hello", not glued.
    expect(userContent).toContain("[msg:msg_user_1 author:user_alice] Hello")
    expect(userContent).not.toContain("(10:00)")
    expect(personaContent).toContain("[msg:msg_persona_1 author:persona_ariadne] Got it.")
  })
})

describe("formatMessagesWithTemporal — reactions awareness", () => {
  test("annotates a message with its reactions, naming reactors via the resolved actor map", () => {
    const msg = userMsg({ reactions: { ":+1:": ["user_alice"], ":tada:": ["persona_ariadne"] } })
    const actorNames = new Map([
      ["user_alice", "Alice"],
      ["persona_ariadne", "Ariadne"],
    ])

    const formatted = formatMessagesWithTemporal([msg], baseContext, actorNames)
    const content = formatted[0].content as string

    expect(content).toContain("[Reactions: :+1: by Alice; :tada: by Ariadne]")
  })

  test("falls back to 'someone' for reactor ids that can't be resolved", () => {
    const msg = userMsg({ reactions: { ":eyes:": ["usr_ghost"] } })

    const formatted = formatMessagesWithTemporal([msg], baseContext)
    const content = formatted[0].content as string

    expect(content).toContain("[Reactions: :eyes: by someone]")
  })

  test("messages without reactions get no reactions annotation", () => {
    const formatted = formatMessagesWithTemporal([userMsg()], baseContext)
    expect(formatted[0].content as string).not.toContain("[Reactions:")
  })
})
