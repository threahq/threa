import { beforeEach, describe, expect, it, vi } from "vitest"
import { spyOnExport } from "@/test/spy"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { forwardRef, useImperativeHandle } from "react"
import { AISettings } from "./ai-settings"
import type { JSONContent } from "@threahq/types"
import * as contextsModule from "@/contexts"
import * as editorModule from "@/components/editor"
import { MemoryRouter } from "react-router-dom"
import { SettingsProvider } from "@/contexts/settings-context"
import { settingDef } from "./settings-registry"

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

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsProvider>
        <AISettings />
      </SettingsProvider>
    </MemoryRouter>
  )
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
        ariaErrorMessage?: string
      }
    >(function MockRichEditor({ value, onChange, onSubmit, ariaLabel, ariaErrorMessage }, ref) {
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
          aria-invalid={ariaErrorMessage ? true : undefined}
          aria-errormessage={ariaErrorMessage}
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
  })

  it("saves edited instructions on Cmd+Enter, with no Save or Reset button", async () => {
    const user = userEvent.setup()
    renderAt("/")

    const editor = screen.getByLabelText("Instructions for your scratchpads")
    await user.clear(editor)
    await user.type(editor, "Be concise and practical.")
    await user.keyboard("{Meta>}{Enter}{/Meta}")

    expect({
      calls: updatePreferenceMock.mock.calls,
      buttons: screen.queryAllByRole("button", { name: /^(Save|Reset)$/ }),
    }).toEqual({
      calls: [["scratchpadCustomPrompt", "Be concise and practical.", { errorShownInPlace: true }]],
      buttons: [],
    })
  })

  it("saves on leaving the editor and clears the instructions when it's emptied", async () => {
    const user = userEvent.setup()
    renderAt("/")

    await user.clear(screen.getByLabelText("Instructions for your scratchpads"))
    expect(updatePreferenceMock).not.toHaveBeenCalled()
    await user.click(document.body)

    expect(updatePreferenceMock.mock.calls).toEqual([["scratchpadCustomPrompt", null, { errorShownInPlace: true }]])
  })

  it("shows the instructions as a plain field, with no composer toolbar", () => {
    renderAt("/")
    const field = screen.getByLabelText("Instructions for your scratchpads").parentElement as HTMLElement
    expect(within(field).queryAllByRole("button")).toEqual([])
  })

  it("puts back the saved instructions on Escape without closing anything", async () => {
    const user = userEvent.setup()
    renderAt("/")

    const editor = screen.getByLabelText("Instructions for your scratchpads") as HTMLTextAreaElement
    await user.clear(editor)
    await user.type(editor, "Temporary draft")
    const outerEscape = vi.fn()
    document.addEventListener("keydown", outerEscape, { capture: true })
    await user.keyboard("{Escape}")
    document.removeEventListener("keydown", outerEscape, { capture: true })

    expect({ value: editor.value, outerEscape: outerEscape.mock.calls.length }).toEqual({
      value: "Current instructions",
      outerEscape: 0,
    })
  })

  it("keeps the draft and says so in place when saving fails", async () => {
    updatePreferenceMock.mockRejectedValueOnce(new Error("offline"))
    const user = userEvent.setup()
    renderAt("/")

    const editor = screen.getByLabelText("Instructions for your scratchpads") as HTMLTextAreaElement
    await user.type(editor, " please")
    await user.click(document.body)

    const alert = await screen.findByRole("alert")
    expect({
      alert: alert.textContent,
      value: editor.value,
      invalid: editor.getAttribute("aria-invalid"),
      errorMessage: editor.getAttribute("aria-errormessage"),
    }).toEqual({
      alert: "Couldn't save your instructions",
      value: "Current instructions please",
      invalid: "true",
      errorMessage: alert.id,
    })
  })

  it("shows the saved instructions in an open editor, with no disclosure to open first", () => {
    mockPreferences.scratchpadCustomPrompt = "Be brief and kind."
    renderAt("/")

    expect({
      trigger: screen.queryByRole("button", { name: /^Instructions for your scratchpads/ }),
      editor: screen.getByLabelText("Instructions for your scratchpads").textContent,
    }).toEqual({ trigger: null, editor: "Be brief and kind." })
  })

  it("says where the instructions apply and has no encryption controls", async () => {
    renderAt("/")

    expect({
      scope: screen.getByText(settingDef("ai-instructions").description!) !== null,
      encryption: screen.queryByText(/encrypt/i),
      streamLink: screen.queryByRole("link", { name: /agent settings for this stream/i }),
    }).toEqual({ scope: true, encryption: null, streamLink: null })
  })

  it("links the open stream's companion settings", async () => {
    renderAt("/w/ws_1/s/stream_1")

    expect(screen.getByRole("link", { name: /agent settings for this stream/i })).toHaveAttribute(
      "href",
      "/w/ws_1/s/stream_1?stream-settings=companion&sid=stream_1"
    )
  })
})
