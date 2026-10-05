import { describe, it, expect, vi, beforeEach } from "vitest"
import { spyOnExport } from "@/test/spy"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TooltipProvider } from "@/components/ui/tooltip"
import * as inputModeModule from "@/hooks/use-input-mode"
import * as drawerModule from "@/components/ui/drawer"
import * as editorModule from "@/components/editor"
import * as prosemirrorModule from "@threahq/prosemirror"
import * as contextsModule from "@/contexts"
import * as authModule from "@/auth"
import { toast } from "sonner"
import { ApiError } from "@/api"
// eslint-disable-next-line no-restricted-imports -- test reads the real outbox the form writes to
import { db } from "@/db"
import type { MentionStreamContext } from "@/hooks/use-mentionables"
import { clearStreams, seedStream } from "@/test/workspace-rows"
import { MessageEditForm } from "./message-edit-form"
import { StreamConnectionErrorCodes, type JSONContent } from "@threahq/types"

let inputModeMockValue: inputModeModule.InputMode = "mouse"
let editorStreamContext: MentionStreamContext | undefined

beforeEach(() => {
  vi.restoreAllMocks()
  inputModeMockValue = "mouse"

  vi.spyOn(inputModeModule, "useInputMode").mockImplementation(() => inputModeMockValue)
  vi.spyOn(authModule, "useUser").mockReturnValue({ id: "workos_usr_1" } as ReturnType<typeof authModule.useUser>)

  spyOnExport(drawerModule, "Drawer").mockReturnValue((({ children }: { children: React.ReactNode }) => (
    <div data-testid="drawer-root">{children}</div>
  )) as unknown as typeof drawerModule.Drawer)
  spyOnExport(drawerModule, "DrawerContent").mockReturnValue((({
    children,
    className,
  }: {
    children: React.ReactNode
    className?: string
  }) => (
    <div data-testid="drawer-content" className={className}>
      {children}
    </div>
  )) as unknown as typeof drawerModule.DrawerContent)
  spyOnExport(drawerModule, "DrawerTitle").mockReturnValue((({
    children,
    className,
  }: {
    children: React.ReactNode
    className?: string
  }) => <h2 className={className}>{children}</h2>) as unknown as typeof drawerModule.DrawerTitle)

  spyOnExport(editorModule, "RichEditor").mockReturnValue((({
    value,
    onChange,
    onSubmit,
    placeholder,
    ariaLabel,
    ariaDescribedBy,
    streamContext,
  }: {
    value: JSONContent
    onChange: (v: JSONContent) => void
    onSubmit: () => void
    placeholder?: string
    ariaLabel: string
    ariaDescribedBy?: string
    streamContext?: MentionStreamContext
  }) => {
    editorStreamContext = streamContext
    return (
      <textarea
        data-testid="rich-editor"
        defaultValue={JSON.stringify(value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        onChange={(e) => {
          try {
            onChange(JSON.parse(e.target.value))
          } catch {
            // ignore parse errors in test
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            onSubmit()
          }
        }}
      />
    )
  }) as unknown as typeof editorModule.RichEditor)
  vi.spyOn(editorModule, "EditorToolbar").mockImplementation(
    (() => null) as unknown as typeof editorModule.EditorToolbar
  )
  vi.spyOn(editorModule, "EditorActionBar").mockImplementation((({
    trailingContent,
  }: {
    trailingContent: React.ReactNode
  }) => <div>{trailingContent}</div>) as unknown as typeof editorModule.EditorActionBar)
  vi.spyOn(editorModule, "DocumentEditorModal").mockImplementation(
    (() => null) as unknown as typeof editorModule.DocumentEditorModal
  )

  vi.spyOn(prosemirrorModule, "serializeToMarkdown").mockImplementation((json: JSONContent) => {
    const text = json.content?.[0]?.content?.[0]?.text
    return text ?? ""
  })
  vi.spyOn(prosemirrorModule, "parseMarkdown").mockImplementation(
    (md: string) =>
      ({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: md }] }],
      }) as ReturnType<typeof prosemirrorModule.parseMarkdown>
  )

  vi.spyOn(contextsModule, "useMessageService").mockReturnValue({
    update: vi.fn().mockResolvedValue({}),
  } as unknown as ReturnType<typeof contextsModule.useMessageService>)
})

const initialContentJson: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }],
}

function renderForm(props: Partial<React.ComponentProps<typeof MessageEditForm>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      {/* No socket is provided, so the stream bootstrap is read from the cache and never fetched. */}
      <contextsModule.ServicesProvider services={{ streams: {} as contextsModule.StreamService }}>
        <TooltipProvider>
          <MessageEditForm
            messageId="msg_1"
            workspaceId="ws_1"
            streamId="stream_1"
            initialContentJson={initialContentJson}
            onSave={vi.fn()}
            onCancel={vi.fn()}
            {...props}
          />
        </TooltipProvider>
      </contextsModule.ServicesProvider>
    </QueryClientProvider>
  )
}

describe("MessageEditForm", () => {
  it("should render editor with save and cancel buttons", () => {
    renderForm()

    expect(screen.getByRole("textbox", { name: "Edit message" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
  })

  it("should expose the mobile editor with instructions", () => {
    inputModeMockValue = "touch"
    renderForm({ authorName: "Alice" })

    const editor = screen.getByRole("textbox", { name: "Edit message" })
    const instructions = screen.getByText(/Press Escape to leave the editor\./)

    expect(editor).toHaveAttribute("aria-describedby", instructions.getAttribute("id"))
    expect(screen.getByText("Alice")).toBeInTheDocument()
  })

  it("should call onCancel when cancel button is clicked", async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()

    renderForm({ onCancel })

    await user.click(screen.getByRole("button", { name: "Cancel" }))

    expect(onCancel).toHaveBeenCalledOnce()
  })

  it("should call onCancel when Escape is pressed", () => {
    const onCancel = vi.fn()

    renderForm({ onCancel })

    fireEvent.keyDown(document, { key: "Escape" })

    expect(onCancel).toHaveBeenCalledOnce()
  })

  it("should show hint text for keyboard shortcuts", () => {
    renderForm()

    expect(screen.getByText("Esc")).toBeInTheDocument()
    expect(screen.getByText("↵")).toBeInTheDocument()
  })

  it("should call onCancel without saving when content is unchanged", async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    const onSave = vi.fn()

    renderForm({ onCancel, onSave })

    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onSave).not.toHaveBeenCalled()
  })

  it("should call onDelete when submitting with empty content", async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    const onSave = vi.fn()

    const emptyContent: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }
    renderForm({ onDelete, onSave, initialContentJson: emptyContent })

    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(onDelete).toHaveBeenCalledOnce()
    expect(onSave).not.toHaveBeenCalled()
  })

  it("should not crash when submitting empty content without onDelete", async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()

    const emptyContent: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }
    renderForm({ onSave, initialContentJson: emptyContent })

    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(onSave).not.toHaveBeenCalled()
  })
})

describe("MessageEditForm saving", () => {
  const editedContent: JSONContent = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Edited" }] }],
  }

  async function submitEdit(onSave: () => void) {
    const user = userEvent.setup()
    renderForm({ onSave })
    fireEvent.change(screen.getByRole("textbox", { name: "Edit message" }), {
      target: { value: JSON.stringify(editedContent) },
    })
    await user.click(screen.getByRole("button", { name: "Save" }))
  }

  beforeEach(async () => {
    await db.pendingOperations.clear()
  })

  it("should toast an error and neither save nor queue the edit when the server refuses it permanently", async () => {
    const errorToast = vi.spyOn(toast, "error").mockReturnValue("e1")
    const infoToast = vi.spyOn(toast, "info").mockReturnValue("i1")
    vi.spyOn(contextsModule, "useMessageService").mockReturnValue({
      update: vi.fn().mockRejectedValue(new ApiError(403, StreamConnectionErrorCodes.WRITE_REFUSED, "Refused")),
    } as unknown as ReturnType<typeof contextsModule.useMessageService>)
    const onSave = vi.fn()

    await submitEdit(onSave)

    await waitFor(() => expect(errorToast).toHaveBeenCalled())
    expect({
      errors: errorToast.mock.calls,
      infos: infoToast.mock.calls,
      saved: onSave.mock.calls,
      queued: await db.pendingOperations.toArray(),
    }).toEqual({ errors: [["Couldn't save your edit."]], infos: [], saved: [], queued: [] })
  })

  it("should keep what the user typed while the save was in flight when the server refuses it", async () => {
    vi.spyOn(toast, "error").mockReturnValue("e3")
    const typedLater: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Edited again" }] }],
    }
    let refuse = () => {}
    const update = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            refuse = () => reject(new ApiError(403, StreamConnectionErrorCodes.WRITE_REFUSED, "Refused"))
          })
      )
      .mockResolvedValue(undefined)
    vi.spyOn(contextsModule, "useMessageService").mockReturnValue({
      update,
    } as unknown as ReturnType<typeof contextsModule.useMessageService>)
    const user = userEvent.setup()

    await submitEdit(vi.fn())
    fireEvent.change(screen.getByRole("textbox", { name: "Edit message" }), {
      target: { value: JSON.stringify(typedLater) },
    })
    refuse()
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled())
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    expect(update.mock.calls.map(([, , body]) => body)).toEqual([
      { contentJson: editedContent },
      { contentJson: typedLater },
    ])
  })

  it("should queue the edit and close the form when the request fails without a server verdict", async () => {
    const errorToast = vi.spyOn(toast, "error").mockReturnValue("e2")
    const infoToast = vi.spyOn(toast, "info").mockReturnValue("i2")
    vi.spyOn(contextsModule, "useMessageService").mockReturnValue({
      update: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    } as unknown as ReturnType<typeof contextsModule.useMessageService>)
    const onSave = vi.fn()

    await submitEdit(onSave)

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect({
      errors: errorToast.mock.calls,
      infos: infoToast.mock.calls,
      queued: (await db.pendingOperations.toArray()).map(({ type, payload }) => ({ type, payload })),
    }).toEqual({
      errors: [],
      infos: [["Edit queued — will be saved when back online"]],
      queued: [{ type: "edit_message", payload: { messageId: "msg_1", contentJson: editedContent } }],
    })
  })
})

describe("MessageEditForm mention rules", () => {
  beforeEach(async () => {
    editorStreamContext = undefined
    await clearStreams()
  })

  it("should give the editor the stream's mention rules when editing in a copy of another workspace's channel", async () => {
    await seedStream("ws_1", "stream_1", { originWorkspaceId: "ws_host" })

    renderForm()

    await waitFor(() => expect(editorStreamContext).toMatchObject({ streamType: "channel", sharedCopy: true }))
  })
})
