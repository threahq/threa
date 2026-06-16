import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { SnippetEditorDialog } from "./snippet-editor-dialog"
import * as useMobileModule from "@/hooks/use-mobile"

beforeEach(() => {
  vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
})

afterEach(() => vi.restoreAllMocks())

describe("SnippetEditorDialog", () => {
  it("seeds the textarea and filename from the incoming paste", () => {
    render(
      <SnippetEditorDialog
        open
        onOpenChange={() => {}}
        initialText={"const x = 1\nconst y = 2"}
        defaultFilename="snippet-1.txt"
        onSave={() => {}}
      />
    )

    expect((screen.getByLabelText("Snippet contents") as HTMLTextAreaElement).value).toBe("const x = 1\nconst y = 2")
    expect((screen.getByLabelText("Snippet filename") as HTMLInputElement).value).toBe("snippet-1.txt")
  })

  it("shows a format badge that tracks the filename extension", () => {
    render(
      <SnippetEditorDialog
        open
        onOpenChange={() => {}}
        initialText={`{ "a": 1 }`}
        defaultFilename="snippet-1.json"
        onSave={() => {}}
      />
    )

    expect(screen.getByLabelText("Detected format: JSON")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Snippet filename"), { target: { value: "data.csv" } })
    expect(screen.getByLabelText("Detected format: CSV")).toBeTruthy()
  })

  it("saves the edited text and filename", () => {
    const onSave = vi.fn()
    render(
      <SnippetEditorDialog
        open
        onOpenChange={() => {}}
        initialText="original"
        defaultFilename="snippet-1.txt"
        onSave={onSave}
      />
    )

    fireEvent.change(screen.getByLabelText("Snippet contents"), { target: { value: "edited body" } })
    fireEvent.change(screen.getByLabelText("Snippet filename"), { target: { value: "  query.sql  " } })
    fireEvent.click(screen.getByRole("button", { name: "Attach snippet" }))

    expect(onSave).toHaveBeenCalledWith({ text: "edited body", filename: "query.sql" })
  })

  it("disables save when the body or filename is empty", () => {
    render(<SnippetEditorDialog open onOpenChange={() => {}} initialText="" defaultFilename="" onSave={() => {}} />)
    expect((screen.getByRole("button", { name: "Attach snippet" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("closes without saving on Cancel", () => {
    const onOpenChange = vi.fn()
    const onSave = vi.fn()
    render(
      <SnippetEditorDialog
        open
        onOpenChange={onOpenChange}
        initialText="body"
        defaultFilename="snippet-1.txt"
        onSave={onSave}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSave).not.toHaveBeenCalled()
  })
})
