import type { ChangeEvent } from "react"
import { describe, expect, it, vi } from "vitest"
import { handleMobileInlineAttachmentPicker } from "./mobile-inline-attachment-picker"

function pickerEvent(files: File[]): ChangeEvent<HTMLInputElement> {
  return {
    target: { files, value: "selected" },
  } as unknown as ChangeEvent<HTMLInputElement>
}

describe("handleMobileInlineAttachmentPicker", () => {
  it("inserts selected files inline and resets the picker", () => {
    const file = new File(["notes"], "notes.txt", { type: "text/plain" })
    const event = pickerEvent([file])
    const insertFiles = vi.fn((_files: File[]) => true)
    const fallback = vi.fn()

    handleMobileInlineAttachmentPicker({ event, isMobile: true, inlineEnabled: true, insertFiles, fallback })

    expect({
      insertedFiles: insertFiles.mock.calls[0]?.[0],
      fallbackCalls: fallback.mock.calls,
      inputValue: event.target.value,
    }).toEqual({ insertedFiles: [file], fallbackCalls: [], inputValue: "" })
  })

  it("inserts inline on desktop when the pick came from /attachment", () => {
    const file = new File(["notes"], "notes.txt", { type: "text/plain" })
    const event = pickerEvent([file])
    const insertFiles = vi.fn((_files: File[]) => true)
    const fallback = vi.fn()

    handleMobileInlineAttachmentPicker({
      event,
      isMobile: false,
      inlineEnabled: false,
      forceInline: true,
      insertFiles,
      fallback,
    })

    expect({ insertedFiles: insertFiles.mock.calls[0]?.[0], fallbackCalls: fallback.mock.calls }).toEqual({
      insertedFiles: [file],
      fallbackCalls: [],
    })
  })

  it.each([
    ["desktop", false, true, true],
    ["disabled", true, false, true],
    ["editor unavailable", true, true, false],
  ])("uses the attachment-row fallback when inline insertion is %s", (_case, isMobile, inlineEnabled, inserted) => {
    const file = new File(["notes"], "notes.txt", { type: "text/plain" })
    const event = pickerEvent([file])
    const fallback = vi.fn()

    handleMobileInlineAttachmentPicker({
      event,
      isMobile,
      inlineEnabled,
      insertFiles: () => inserted,
      fallback,
    })

    expect(fallback).toHaveBeenCalledWith(event)
  })
})
