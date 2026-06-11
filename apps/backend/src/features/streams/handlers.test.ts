import { describe, expect, it } from "bun:test"
import type { LinkPreviewSummary } from "@threa/types"
import type { StreamEvent } from "./event-repository"
import { applyLinkPreviewStateToEvents } from "./handlers"

function createMessageEvent(messageId: string): StreamEvent {
  return {
    id: `evt_${messageId}`,
    streamId: "stream_1",
    sequence: 1n,
    broadcastSequence: 1n,
    eventType: "message_created",
    actorId: "user_1",
    actorType: "user",
    createdAt: new Date(),
    payload: {
      messageId,
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "hello",
    },
  }
}

describe("applyLinkPreviewStateToEvents", () => {
  it("attaches preview summaries to matching message events", () => {
    const preview: LinkPreviewSummary = {
      id: "preview_1",
      url: "https://example.com/article",
      title: "Preview title",
      description: null,
      imageUrl: null,
      faviconUrl: null,
      siteName: "Example",
      contentType: "website",
      position: 0,
    }

    const [event] = applyLinkPreviewStateToEvents(
      [createMessageEvent("msg_1")],
      new Map([["msg_1", [preview]]]),
      new Set()
    )

    expect((event.payload as { linkPreviews?: LinkPreviewSummary[] }).linkPreviews).toEqual([preview])
  })

  it("filters dismissed previews out of the event payload", () => {
    const visiblePreview: LinkPreviewSummary = {
      id: "preview_visible",
      url: "https://example.com/visible",
      title: "Visible",
      description: null,
      imageUrl: null,
      faviconUrl: null,
      siteName: "Example",
      contentType: "website",
      position: 0,
    }
    const dismissedPreview: LinkPreviewSummary = {
      id: "preview_dismissed",
      url: "https://example.com/dismissed",
      title: "Dismissed",
      description: null,
      imageUrl: null,
      faviconUrl: null,
      siteName: "Example",
      contentType: "website",
      position: 1,
    }

    const [event] = applyLinkPreviewStateToEvents(
      [createMessageEvent("msg_1")],
      new Map([["msg_1", [visiblePreview, dismissedPreview]]]),
      new Set(["msg_1:preview_dismissed"])
    )

    expect((event.payload as { linkPreviews?: LinkPreviewSummary[] }).linkPreviews).toEqual([visiblePreview])
  })
})
