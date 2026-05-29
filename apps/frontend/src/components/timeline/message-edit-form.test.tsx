import { describe, it, expect, vi, beforeEach } from "vitest"
import { spyOnExport } from "@/test/spy"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TooltipProvider } from "@/components/ui/tooltip"
import * as mobileModule from "@/hooks/use-mobile"
import * as drawerModule from "@/components/ui/drawer"
import * as editorModule from "@/components/editor"
import * as prosemirrorModule from "@threa/prosemirror"
import * as contextsModule from "@/contexts"
import { MessageEditForm } from "./message-edit-form"
import type { JSONContent } from "@threa/types"

let isMobileMockValue = false

beforeEach(() => {
  vi.restoreAllMocks()
  isMobileMockValue = false

  vi.spyOn(mobileModule, "useIsMobile").mockImplementation(() => isMobileMockValue)

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
  }: {
    value: JSONContent
    onChange: (v: JSONContent) => void
    onSubmit: () => void
    placeholder?: string
    ariaLabel: string
    ariaDescribedBy?: string
  }) => (
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
  )) as unknown as typeof editorModule.RichEditor)
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
    isMobileMockValue = true
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

    // Click Save without changing the content
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

    // Should not throw — just no-ops gracefully
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(onSave).not.toHaveBeenCalled()
  })
})
