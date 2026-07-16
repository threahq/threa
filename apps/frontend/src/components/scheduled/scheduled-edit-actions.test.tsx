import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ScheduledEditActions } from "./scheduled-edit-dialog"

function renderActions(overrides: Partial<Parameters<typeof ScheduledEditActions>[0]> = {}) {
  const onDelete = vi.fn()
  const onSendNow = vi.fn()
  const onSave = vi.fn()
  render(
    <TooltipProvider>
      <ScheduledEditActions
        isPending
        isPast={false}
        compact={false}
        canSubmit
        busy={false}
        isSaving={false}
        saveLabel="Save"
        deleteLabel="Cancel"
        onDelete={onDelete}
        onSendNow={onSendNow}
        onSave={onSave}
        {...overrides}
      />
    </TooltipProvider>
  )
  return { onDelete, onSendNow, onSave }
}

describe("ScheduledEditActions", () => {
  it("exposes Delete, Send now, and Save for a pending row and wires each click", async () => {
    const { onDelete, onSendNow, onSave } = renderActions()

    await userEvent.click(screen.getByRole("button", { name: /cancel/i }))
    await userEvent.click(screen.getByRole("button", { name: /send now/i }))
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }))

    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onSendNow).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("shows only the destructive action (labelled Remove) for a failed row", () => {
    renderActions({ isPending: false, deleteLabel: "Remove" })

    expect(screen.getByRole("button", { name: /remove/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /send now/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument()
  })

  it("hides the duplicate Send now once the row is past-due (primary already means send now)", () => {
    renderActions({ isPast: true, saveLabel: "Send" })

    expect(screen.queryByRole("button", { name: /send now/i })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^send$/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument()
  })

  it("keeps Send now reachable by accessible name when collapsed to an icon on mobile", () => {
    renderActions({ compact: true })

    // Icon-only on mobile, but still labelled so it's operable + discoverable.
    expect(screen.getByRole("button", { name: /send now/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^save$/i })).toBeInTheDocument()
  })

  it("disables Send now and Save when the row can't be submitted (local / empty time)", () => {
    renderActions({ canSubmit: false })

    expect(screen.getByRole("button", { name: /send now/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled()
    // The destructive action stays available — a local placeholder can still be dropped.
    expect(screen.getByRole("button", { name: /cancel/i })).not.toBeDisabled()
  })
})
