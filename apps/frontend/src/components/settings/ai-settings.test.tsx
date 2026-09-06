import { beforeEach, describe, expect, it, vi } from "vitest"
import { spyOnExport } from "@/test/spy"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { forwardRef, useImperativeHandle } from "react"
import { AISettings } from "./ai-settings"
import type { JSONContent } from "@threahq/types"
import * as contextsModule from "@/contexts"
import * as editorModule from "@/components/editor"
import * as encryptionModule from "@/components/encryption"

const updatePreferenceMock = vi.fn().mockResolvedValue(undefined)

let mockPreferences: {
  scratchpadCustomPrompt: string | null
} = {
  scratchpadCustomPrompt: "Current instructions",
}

function extractText(node: JSONContent | undefined): string {
  if (!node) return ""
  if (node.type === "text") return node.text ?? ""
  return (node.content ?? []).map((child) => extractText(child)).join("")
}

function createDoc(text: string): JSONContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }],
  }
}

describe("AISettings", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockPreferences = {
      scratchpadCustomPrompt: "Current instructions",
    }
    updatePreferenceMock.mockClear()

    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: mockPreferences,
      updatePreference: updatePreferenceMock,
      isLoading: false,
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)

    const MockRichEditor = forwardRef<
      {
        focus: () => void
        insertMention: () => void
        insertSlash: () => void
        insertEmoji: () => void
        openSnippetEditor: () => void
        getEditor: () => null
      },
      {
        value: JSONContent
        onChange: (value: JSONContent) => void
        onSubmit: () => void
        ariaLabel: string
      }
    >(function MockRichEditor({ value, onChange, onSubmit, ariaLabel }, ref) {
      useImperativeHandle(ref, () => ({
        focus: () => undefined,
        insertMention: () => undefined,
        insertSlash: () => undefined,
        insertEmoji: () => undefined,
        openSnippetEditor: () => undefined,
        getEditor: () => null,
      }))

      return (
        <textarea
          aria-label={ariaLabel}
          value={extractText(value)}
          onChange={(event) => onChange(createDoc(event.target.value))}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.metaKey) {
              event.preventDefault()
              onSubmit()
            }
          }}
        />
      )
    })

    spyOnExport(editorModule, "RichEditor").mockReturnValue(MockRichEditor as unknown as typeof editorModule.RichEditor)

    const MockEditorActionBar = (({ onFormatOpenChange, formatOpen, trailingContent }: Record<string, unknown>) => (
      <div>
        <button type="button" onClick={() => (onFormatOpenChange as (v: boolean) => void)(!formatOpen)}>
          Formatting
        </button>
        {trailingContent as React.ReactNode}
      </div>
    )) as unknown as typeof editorModule.EditorActionBar

    spyOnExport(editorModule, "EditorActionBar").mockReturnValue(MockEditorActionBar)

    // The encryption section reaches for AuthProvider + workspace cache + router
    // params, none of which this AI-focused test sets up. Stub the export with
    // a no-op component — the section has its own coverage in
    // `encrypted-scratchpads-section.test.tsx`.
    const EncryptedScratchpadsSectionStub = () => null
    spyOnExport(encryptionModule, "EncryptedScratchpadsSection").mockReturnValue(
      EncryptedScratchpadsSectionStub as typeof encryptionModule.EncryptedScratchpadsSection
    )
  })

  it("saves updated scratchpad instructions", async () => {
    const user = userEvent.setup()
    render(<AISettings />)

    const editor = screen.getByLabelText("Scratchpad custom prompt editor")
    await user.clear(editor)
    await user.type(editor, "Be concise and practical.")
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(updatePreferenceMock).toHaveBeenCalledWith("scratchpadCustomPrompt", "Be concise and practical.")
  })

  it("clears the saved prompt when saving an empty editor", async () => {
    const user = userEvent.setup()
    render(<AISettings />)

    const editor = screen.getByLabelText("Scratchpad custom prompt editor")
    await user.clear(editor)
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(updatePreferenceMock).toHaveBeenCalledWith("scratchpadCustomPrompt", null)
  })

  it("resets unsaved edits back to the saved prompt", async () => {
    const user = userEvent.setup()
    render(<AISettings />)

    const editor = screen.getByLabelText("Scratchpad custom prompt editor") as HTMLTextAreaElement
    await user.clear(editor)
    await user.type(editor, "Temporary draft")
    await user.click(screen.getByRole("button", { name: "Reset" }))

    expect(editor.value).toBe("Current instructions")
  })
})
