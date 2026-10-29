import React, { useState } from "react"
import { LinkPreviewList } from "./link-preview-list"
import * as contextsModule from "@/contexts"
import { __resetCollapseCacheForTests } from "@/lib/markdown/collapse-cache"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import { MediaGalleryProvider } from "@/contexts"
import { attachmentsApi, linkPreviewsApi } from "@/api"
import { AttachmentList } from "./attachment-list"
import type { AttachmentSummary, LinkPreviewSummary } from "@threahq/types"

const mockGetDownloadUrl = vi.fn()

beforeEach(() => {
  vi.restoreAllMocks()
  mockGetDownloadUrl.mockReset()
  mockGetDownloadUrl.mockResolvedValue("https://example.com/download")
  vi.spyOn(attachmentsApi, "getDownloadUrl").mockImplementation(
    (...args: Parameters<typeof attachmentsApi.getDownloadUrl>) => mockGetDownloadUrl(...args)
  )
})

const workspaceId = "ws_123"

const img = (id: string, filename: string): AttachmentSummary => ({
  id,
  filename,
  mimeType: "image/png",
  sizeBytes: 1024,
})

function renderWithDataRouter() {
  const attachments = [img("img_1", "photo1.png"), img("img_2", "photo2.png"), img("img_3", "photo3.png")]
  const router = createMemoryRouter(
    [
      {
        path: "/s",
        element: (
          <MediaGalleryProvider>
            <AttachmentList attachments={attachments} workspaceId={workspaceId} />
          </MediaGalleryProvider>
        ),
      },
    ],
    { initialEntries: ["/s"] }
  )
  render(<RouterProvider router={router} />)
  return router
}

describe("AttachmentList gallery under a data router (createBrowserRouter machinery)", () => {
  it("opens the clicked image, not the first, on first open", async () => {
    const user = userEvent.setup()
    renderWithDataRouter()

    const third = await screen.findByRole("button", { name: /photo3\.png/i })
    await user.click(third)

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())
    expect(screen.getByText("3 / 3")).toBeInTheDocument()
  })

  it("opens the correct image after closing a previous one via the back button", async () => {
    const user = userEvent.setup()
    const router = renderWithDataRouter()

    // Open the 3rd image.
    await user.click(await screen.findByRole("button", { name: /photo3\.png/i }))
    await waitFor(() => expect(screen.getByText("3 / 3")).toBeInTheDocument())

    // Close it — closeMedia pops history (navigate(-1)).
    const closeButtons = screen.getAllByRole("button", { name: /close/i })
    await user.click(closeButtons[0])
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(router.state.location.search).toBe("")

    // Re-open a different image — must land on it, not the first.
    await user.click(await screen.findByRole("button", { name: /photo2\.png/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())
    expect(screen.getByText("2 / 3")).toBeInTheDocument()
  })
})

const linkedImage = (id: string, title: string): LinkPreviewSummary => ({
  id,
  url: `https://example.com/${id}.png`,
  title,
  description: null,
  imageUrl: null,
  faviconUrl: null,
  siteName: "Example",
  contentType: "image",
  position: 0,
})

function MessageMedia({
  messageId = "msg_1",
  previews,
  attachments = [],
}: {
  messageId?: string
  previews: LinkPreviewSummary[]
  attachments?: AttachmentSummary[]
}) {
  return (
    <LinkPreviewList
      workspaceId={workspaceId}
      messageId={messageId}
      previews={previews}
      hydrateFromApi={false}
      renderBeforePreviews={(items) => (
        <AttachmentList attachments={attachments} workspaceId={workspaceId} additionalGalleryItems={items} />
      )}
    />
  )
}

function renderMessages(children: React.ReactNode) {
  const router = createMemoryRouter(
    [{ path: "/s", element: <MediaGalleryProvider>{children}</MediaGalleryProvider> }],
    { initialEntries: ["/s"] }
  )
  const result = render(<RouterProvider router={router} />)
  return { router, ...result }
}

describe("linked image galleries", () => {
  beforeEach(() => {
    __resetCollapseCacheForTests()
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { linkPreviewDefault: "open" },
    } as ReturnType<typeof contextsModule.usePreferences>)
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(null)
    vi.spyOn(linkPreviewsApi, "dismiss").mockResolvedValue(undefined)
  })

  it("should open the clicked URL image and close with one Back after cycling", async () => {
    const user = userEvent.setup()
    const { router } = renderMessages(
      <MessageMedia previews={[linkedImage("first", "First"), linkedImage("second", "Second")]} />
    )
    await user.click(screen.getByRole("button", { name: "Open image preview: Second" }))
    expect(await screen.findByText("2 / 2")).toBeInTheDocument()
    expect(router.state.location.search).toBe("?media=link-preview%3Amsg_1%3Asecond")
    await user.click(screen.getByRole("button", { name: "Previous" }))
    expect(await screen.findByText("1 / 2")).toBeInTheDocument()
    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(router.state.location.search).toBe("")
  })

  it("should traverse attachments and linked images in both directions and reopen after Escape or close", async () => {
    const user = userEvent.setup()
    const { router } = renderMessages(
      <MessageMedia
        attachments={[img("img_1", "Attached.png")]}
        previews={[linkedImage("first", "First"), linkedImage("second", "Second")]}
      />
    )
    await user.click(screen.getByRole("button", { name: "Open image preview: First" }))
    expect(await screen.findByText("2 / 3")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Previous" }))
    expect(router.state.location.search).toBe("?media=img_1")
    await user.click(screen.getByRole("button", { name: "Next" }))
    expect(await screen.findByText("2 / 3")).toBeInTheDocument()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: "Open image preview: Second" }))
    expect(await screen.findByText("3 / 3")).toBeInTheDocument()
    await user.click(screen.getAllByRole("button", { name: /close/i })[0])
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: "Attached.png" }))
    expect(await screen.findByText("1 / 3")).toBeInTheDocument()
  })

  it("should claim a repeated URL only for the clicked message", async () => {
    const user = userEvent.setup()
    const preview = linkedImage("same", "Same")
    const { router } = renderMessages(
      <>
        <MessageMedia messageId="msg_1" previews={[preview]} />
        <MessageMedia messageId="msg_2" previews={[preview]} />
      </>
    )
    await user.click(screen.getAllByRole("button", { name: "Open image preview: Same" })[1])
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(router.state.location.search).toBe("?media=link-preview%3Amsg_2%3Asame")
    expect(screen.getAllByRole("dialog")).toHaveLength(1)
  })

  it("should remove dismissed images from both the cards and gallery", async () => {
    const user = userEvent.setup()
    renderMessages(<MessageMedia previews={[linkedImage("first", "First"), linkedImage("second", "Second")]} />)
    await user.click(screen.getAllByRole("button", { name: "Dismiss preview" })[0])
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Open image preview: First" })).not.toBeInTheDocument()
    )
    await user.click(screen.getByRole("button", { name: "Open image preview: Second" }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Previous" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument()
  })

  it("should close a removed image and stop claiming its URL", async () => {
    const user = userEvent.setup()
    function EditableMessage() {
      const [previews, setPreviews] = useState([linkedImage("first", "First"), linkedImage("second", "Second")])
      return (
        <>
          <button onClick={() => setPreviews([])}>Remove images</button>
          <MessageMedia previews={previews} />
        </>
      )
    }
    const { router } = renderMessages(<EditableMessage />)
    await user.click(screen.getByRole("button", { name: "Open image preview: Second" }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    // Simulate the incoming edit while the gallery is open.
    await act(async () => {
      screen.getByRole("button", { name: "Remove images", hidden: true }).click()
    })
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /Open image preview/ })).not.toBeInTheDocument()
    await act(async () => {
      await router.navigate(-1)
    })
    expect(router.state.location.search).toBe("")
  })

  it("should keep the selected image when an earlier preview is removed", async () => {
    const user = userEvent.setup()
    function EditableMessage() {
      const [previews, setPreviews] = useState([
        linkedImage("first", "First"),
        linkedImage("second", "Second"),
        linkedImage("third", "Third"),
      ])
      return (
        <>
          <button onClick={() => setPreviews((items) => items.slice(1))}>Remove first image</button>
          <MessageMedia previews={previews} />
        </>
      )
    }
    const { router } = renderMessages(<EditableMessage />)
    await user.click(screen.getByRole("button", { name: "Open image preview: Second" }))
    expect(await screen.findByText("2 / 3")).toBeInTheDocument()
    await act(async () => {
      screen.getByRole("button", { name: "Remove first image", hidden: true }).click()
    })
    expect(await screen.findByText("1 / 2")).toBeInTheDocument()
    expect(router.state.location.search).toBe("?media=link-preview%3Amsg_1%3Asecond")
    await user.click(screen.getByRole("button", { name: "Next" }))
    expect(router.state.location.search).toBe("?media=link-preview%3Amsg_1%3Athird")
  })
})
