import { useRef, useState } from "react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ServicesProvider, type SavedService } from "@/contexts"
import * as inputMode from "@/hooks/use-input-mode"
import { MessageContextMenu } from "./message-context-menu"
import { ReminderPicker, reminderAnchorRect } from "./reminder-picker"

const savedService: SavedService = {
  list: vi.fn().mockResolvedValue({ saved: [], nextCursor: null }),
  create: vi.fn().mockResolvedValue({
    id: "saved_1",
    workspaceId: "workspace_1",
    userId: "usr_1",
    messageId: "msg_1",
    streamId: "stream_1",
    conversationId: null,
    status: "saved",
    title: null,
    note: null,
    remindAt: null,
    reminderSentAt: null,
    savedAt: new Date().toISOString(),
    statusChangedAt: new Date().toISOString(),
    message: null,
    unavailableReason: null,
  }),
  update: vi.fn().mockResolvedValue({}),
  delete: vi.fn().mockResolvedValue(undefined),
}

function Wrapper({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ServicesProvider services={{ saved: savedService }}>{children}</ServicesProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

function MenuWithReminder() {
  const [open, setOpen] = useState(false)
  const anchorRect = useRef<DOMRect | null>(null)
  return (
    <>
      <MessageContextMenu
        context={{
          contentMarkdown: "Hello world",
          actorType: "user",
          replyUrl: "/w/workspace_1/s/stream_1",
          onRequestReminder: () => {
            anchorRect.current = reminderAnchorRect()
            setOpen(true)
          },
        }}
      />
      {open && (
        <ReminderPicker
          open={open}
          onOpenChange={setOpen}
          anchorRect={anchorRect.current}
          workspaceId="workspace_1"
          messageId="msg_1"
          saved={null}
        />
      )}
    </>
  )
}

afterEach(() => vi.restoreAllMocks())

describe("ReminderPicker", () => {
  it("should replace the message action menu with a reminder popover on desktop", async () => {
    vi.spyOn(inputMode, "useInputMode").mockReturnValue("mouse")
    render(<MenuWithReminder />, { wrapper: Wrapper })
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Message actions" }))
    await user.click(screen.getByText("Set reminder…"))

    expect(screen.queryByText("Save & remind")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "In 15 minutes" }))
    await waitFor(() =>
      expect(savedService.create).toHaveBeenCalledWith("workspace_1", expect.objectContaining({ messageId: "msg_1" }))
    )
    await waitFor(() => expect(screen.queryByText("Remind me")).not.toBeInTheDocument())
  })

  it("should keep the bottom sheet on touch devices", () => {
    vi.spyOn(inputMode, "useInputMode").mockReturnValue("touch")
    render(
      <ReminderPicker
        open
        onOpenChange={vi.fn()}
        anchorRect={null}
        workspaceId="workspace_1"
        messageId="msg_1"
        saved={null}
      />,
      { wrapper: Wrapper }
    )

    expect(screen.getByText("Save & remind")).toBeInTheDocument()
  })
})
