import { describe, it, expect, vi, beforeEach } from "vitest"
import { spyOnExport } from "@/test/spy"
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react"
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
import { ShareErrorCodes, StreamConnectionErrorCodes, type JSONContent } from "@threahq/types"
import { SHARE_PRIVACY_WARNING_MESSAGE } from "@/lib/share-privacy-toast"

type ToastOptions = {
  action?: { label: string; onClick?: (event: never) => void }
  cancel?: { label: string; onClick?: (event: never) => void }
}

let inputModeMockValue: inputModeModule.InputMode = "mouse"
let drawerPointerDownOutside: ((event: { target: EventTarget; preventDefault: () => void }) => void) | undefined
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
    onPointerDownOutside,
  }: {
    children: React.ReactNode
    className?: string
    onPointerDownOutside?: typeof drawerPointerDownOutside
  }) => {
    drawerPointerDownOutside = onPointerDownOutside
    return (
      <div data-testid="drawer-content" className={className}>
        {children}
      </div>
    )
  }) as unknown as typeof drawerModule.DrawerContent)
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

  it("should warn before an edit exposes a share and save it with consent on Save anyway", async () => {
    const warningToast = vi.spyOn(toast, "warning").mockReturnValue("w1")
    const update = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED, "Confirm"))
      .mockResolvedValueOnce({})
    vi.spyOn(contextsModule, "useMessageService").mockReturnValue({
      update,
    } as unknown as ReturnType<typeof contextsModule.useMessageService>)
    const onSave = vi.fn()

    await submitEdit(onSave)

    await waitFor(() => expect(warningToast).toHaveBeenCalled())
    const [message, options] = warningToast.mock.calls[0] as [string, ToastOptions]
    expect({ message, action: options.action?.label, cancel: options.cancel?.label, saved: onSave.mock.calls }).toEqual(
      { message: SHARE_PRIVACY_WARNING_MESSAGE, action: "Save anyway", cancel: "Cancel", saved: [] }
    )

    options.action?.onClick?.({} as never)

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(update.mock.calls).toEqual([
      ["ws_1", "msg_1", { contentJson: editedContent }],
      ["ws_1", "msg_1", { contentJson: editedContent, confirmedPrivacyWarning: true }],
    ])
  })

  it("should withdraw the Save anyway question once the user changes the edit", async () => {
    vi.spyOn(toast, "warning").mockReturnValue("w2")
    const dismiss = vi.spyOn(toast, "dismiss").mockReturnValue("w2")
    vi.spyOn(contextsModule, "useMessageService").mockReturnValue({
      update: vi.fn().mockRejectedValue(new ApiError(409, ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED, "Confirm")),
    } as unknown as ReturnType<typeof contextsModule.useMessageService>)

    await submitEdit(vi.fn())
    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    expect(dismiss).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole("textbox", { name: "Edit message" }), {
      target: {
        value: JSON.stringify({
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "More" }] }],
        }),
      },
    })

    await waitFor(() => expect(dismiss.mock.calls).toEqual([["share-privacy-edit-msg_1"]]))
  })

  function refuseForPrivacy() {
    vi.spyOn(contextsModule, "useMessageService").mockReturnValue({
      update: vi.fn().mockRejectedValue(new ApiError(409, ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED, "Confirm")),
    } as unknown as ReturnType<typeof contextsModule.useMessageService>)
  }

  it("should ask again on the next Save after the Save anyway toast was swiped away", async () => {
    const warningToast = vi.spyOn(toast, "warning").mockReturnValue("w4")
    refuseForPrivacy()

    await submitEdit(vi.fn())
    await waitFor(() => expect(warningToast).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(warningToast).toHaveBeenCalledTimes(2))
  })

  it("should withdraw the Save anyway question when the edit form closes", async () => {
    vi.spyOn(toast, "warning").mockReturnValue("w5")
    const dismiss = vi.spyOn(toast, "dismiss").mockReturnValue("w5")
    refuseForPrivacy()

    await submitEdit(vi.fn())
    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    cleanup()

    expect(dismiss.mock.calls).toEqual([["share-privacy-edit-msg_1"]])
  })

  it("should keep the mobile edit drawer open when the Save anyway toast is pressed", () => {
    inputModeMockValue = "touch"
    renderForm()
    const toaster = document.createElement("section")
    toaster.setAttribute("data-sonner-toaster", "")
    const toastButton = toaster.appendChild(document.createElement("button"))
    const outside = document.createElement("button")
    const toastPress = { target: toastButton, preventDefault: vi.fn() }
    const outsidePress = { target: outside, preventDefault: vi.fn() }

    drawerPointerDownOutside?.(toastPress)
    drawerPointerDownOutside?.(outsidePress)

    expect({
      toast: toastPress.preventDefault.mock.calls.length,
      outside: outsidePress.preventDefault.mock.calls.length,
    }).toEqual({ toast: 1, outside: 0 })
  })

  it("should keep consent on an edit queued after Save anyway fails without a server verdict", async () => {
    const warningToast = vi.spyOn(toast, "warning").mockReturnValue("w3")
    vi.spyOn(toast, "info").mockReturnValue("i3")
    vi.spyOn(contextsModule, "useMessageService").mockReturnValue({
      update: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(409, ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED, "Confirm"))
        .mockRejectedValueOnce(new TypeError("Failed to fetch")),
    } as unknown as ReturnType<typeof contextsModule.useMessageService>)
    const onSave = vi.fn()

    await submitEdit(onSave)
    await waitFor(() => expect(warningToast).toHaveBeenCalled())
    ;(warningToast.mock.calls[0][1] as ToastOptions).action?.onClick?.({} as never)

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect((await db.pendingOperations.toArray()).map(({ payload }) => payload)).toEqual([
      { messageId: "msg_1", contentJson: editedContent, confirmedPrivacyWarning: true },
    ])
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

  const withShare = (authorName: string): JSONContent => ({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Edited" }] },
      {
        type: "sharedMessage",
        attrs: {
          messageId: "msg_src",
          streamId: "stream_src",
          authorName,
          authorId: authorName ? "usr_ada" : "",
          actorType: "user",
        },
      },
    ],
  })
  const stampAuthor = () =>
    fireEvent.change(screen.getByRole("textbox", { name: "Edit message" }), {
      target: { value: JSON.stringify(withShare("Ada")) },
    })

  it("should close an edit the form only stamped a share's author onto without saving it", async () => {
    vi.mocked(prosemirrorModule.serializeToMarkdown).mockRestore()
    const update = vi.fn().mockResolvedValue({})
    vi.spyOn(contextsModule, "useMessageService").mockReturnValue({
      update,
    } as unknown as ReturnType<typeof contextsModule.useMessageService>)
    const onCancel = vi.fn()
    renderForm({ onCancel, initialContentJson: withShare("") })

    stampAuthor()
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    expect({ cancelled: onCancel.mock.calls.length, updates: update.mock.calls }).toEqual({ cancelled: 1, updates: [] })
  })

  it("should keep the Save anyway question when only a share's author gets stamped", async () => {
    vi.spyOn(toast, "warning").mockReturnValue("w6")
    const dismiss = vi.spyOn(toast, "dismiss").mockReturnValue("w6")
    refuseForPrivacy()
    const user = userEvent.setup()
    renderForm()
    fireEvent.change(screen.getByRole("textbox", { name: "Edit message" }), {
      target: { value: JSON.stringify(withShare("")) },
    })
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(toast.warning).toHaveBeenCalled())

    stampAuthor()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(dismiss).not.toHaveBeenCalled()
  })

  it("should ask about what the form shows when the server refuses a save the user kept typing over", async () => {
    const warningToast = vi.spyOn(toast, "warning").mockReturnValue("w7")
    const dismiss = vi.spyOn(toast, "dismiss").mockReturnValue("w7")
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
            refuse = () => reject(new ApiError(409, ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED, "Confirm"))
          })
      )
      .mockResolvedValue({})
    vi.spyOn(contextsModule, "useMessageService").mockReturnValue({
      update,
    } as unknown as ReturnType<typeof contextsModule.useMessageService>)
    const onSave = vi.fn()

    await submitEdit(onSave)
    fireEvent.change(screen.getByRole("textbox", { name: "Edit message" }), {
      target: { value: JSON.stringify(typedLater) },
    })
    refuse()
    await waitFor(() => expect(warningToast).toHaveBeenCalled())
    expect(dismiss).not.toHaveBeenCalled()
    ;(warningToast.mock.calls[0][1] as ToastOptions).action?.onClick?.({} as never)

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(update.mock.calls.map(([, , body]) => body)).toEqual([
      { contentJson: editedContent },
      { contentJson: typedLater, confirmedPrivacyWarning: true },
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
