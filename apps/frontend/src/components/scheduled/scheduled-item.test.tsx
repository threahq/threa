import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ScheduledMessageView } from "@threahq/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { messagesApi } from "@/api/messages"
import * as hooksModule from "@/hooks"
import * as streamNameModule from "@/hooks/use-stream-name"
import { unsharedReferenceKeys } from "@/hooks/use-unshared-references"
import { ScheduledItem } from "./scheduled-item"

const SENT: ScheduledMessageView = {
  id: "sched_sent",
  workspaceId: "ws_test",
  userId: "usr_author",
  streamId: "stream_dst",
  parentMessageId: null,
  contentJson: { type: "doc", content: [{ type: "paragraph" }] },
  contentMarkdown: "Have a look",
  attachmentIds: [],
  metadata: null,
  scheduledFor: new Date(Date.now() - 60_000).toISOString(),
  status: "sent",
  sentMessageId: "msg_sent",
  lastError: null,
  editActiveUntil: null,
  clientMessageId: "client-1",
  version: 2,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  statusChangedAt: new Date().toISOString(),
}

function renderItem(scheduled: ScheduledMessageView) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ScheduledItem scheduled={scheduled} workspaceId="ws_test" />
      </MemoryRouter>
    </QueryClientProvider>
  )
  return queryClient
}

describe("ScheduledItem unshared-reference prompt", () => {
  beforeEach(() => {
    vi.spyOn(streamNameModule, "useStreamName").mockReturnValue("general")
    vi.spyOn(hooksModule, "useFormattedDate").mockReturnValue({
      formatRelative: () => "1m",
      formatFull: () => "now",
    } as unknown as ReturnType<typeof hooksModule.useFormattedDate>)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("should prompt on a sent row whose share went out unrecorded, outside the row's link", async () => {
    vi.spyOn(messagesApi, "listUnsharedReferences").mockResolvedValue({
      references: [
        { messageId: "msg_sent", streamId: "stream_dst", sourceMessageId: "msg_q", flavor: "quote" },
        { messageId: "msg_sent", streamId: "stream_dst", sourceMessageId: "msg_p", flavor: "pointer" },
      ],
    })
    renderItem(SENT)

    expect(await screen.findByRole("status")).toHaveTextContent("Readers can't see the shared message")
    expect(screen.getByRole("link").contains(screen.getByRole("button", { name: "Share it" }))).toBe(false)
  })

  it("should not prompt on a pending row", async () => {
    vi.spyOn(messagesApi, "listUnsharedReferences").mockResolvedValue({
      references: [{ messageId: "msg_sent", streamId: "stream_dst", sourceMessageId: "msg_p", flavor: "pointer" }],
    })
    const queryClient = renderItem({
      ...SENT,
      status: "pending",
      scheduledFor: new Date(Date.now() + 60_000).toISOString(),
    })

    await waitFor(() =>
      expect(queryClient.getQueryState(unsharedReferenceKeys.list("ws_test"))?.status).toBe("success")
    )
    expect(screen.queryByTestId("unshared-reference-prompt")).not.toBeInTheDocument()
  })
})
