import { describe, expect, it, spyOn } from "bun:test"
import { awaitLinkPreviewProcessing, renderLinkPreviewContext } from "./ai-context"
import { LinkPreviewRepository, type LinkPreview } from "./repository"

function preview(overrides: Partial<LinkPreview> = {}): LinkPreview {
  return {
    id: "lp_1",
    workspaceId: "ws_1",
    url: "https://x.com/example/status/123",
    normalizedUrl: "https://x.com/example/status/123",
    title: "Example",
    description: "The actual subject of the linked post.",
    imageUrl: "https://example.com/image.jpg",
    faviconUrl: null,
    siteName: "X",
    contentType: "website",
    status: "completed",
    previewType: null,
    previewData: null,
    targetWorkspaceId: null,
    targetStreamId: null,
    targetMessageId: null,
    targetMemoId: null,
    targetConversationId: null,
    targetDelegationId: null,
    fetchedAt: new Date(),
    refreshVersion: 0,
    expiresAt: null,
    createdAt: new Date(),
    ...overrides,
  }
}

describe("renderLinkPreviewContext", () => {
  it("renders the same textual metadata used by a link-preview card", () => {
    expect(renderLinkPreviewContext([preview()])).toBe(
      '<link-preview url="https://x.com/example/status/123" site="X" title="Example">\nThe actual subject of the linked post.\n</link-preview>'
    )
  })

  it("escapes metadata and omits empty cards", () => {
    expect(
      renderLinkPreviewContext([
        preview({
          url: "https://example.com/?a=1&b=2",
          title: 'A <title> "quoted"',
          description: "x & y",
          siteName: null,
        }),
        preview({ id: "lp_2", title: null, description: null, siteName: null }),
      ])
    ).toBe(
      '<link-preview url="https://example.com/?a=1&amp;b=2" title="A &lt;title&gt; &quot;quoted&quot;">\nx &amp; y\n</link-preview>'
    )
  })
})

describe("awaitLinkPreviewProcessing", () => {
  it("waits for the extraction peer to create a row before treating it as complete", async () => {
    const completed = preview()
    const find = spyOn(LinkPreviewRepository, "findByMessageIds")
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map([["msg_1", [completed]]]))

    const result = await awaitLinkPreviewProcessing(
      {} as never,
      "ws_1",
      [
        {
          id: "msg_1",
          contentMarkdown: "https://x.com/example/status/123",
          contentJson: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "https://x.com/example/status/123" }],
              },
            ],
          },
        },
      ],
      500
    )

    expect(result).toEqual({
      allCompleted: true,
      completedUrls: ["https://x.com/example/status/123"],
      failedOrTimedOutUrls: [],
      previewsByMessage: new Map([["msg_1", [completed]]]),
    })
    expect(find).toHaveBeenCalledTimes(2)
    find.mockRestore()
  })
})
