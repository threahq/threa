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
        canSubmit
        busy={false}
        isSaving={false}
        saveLabel="Save"
        deleteLabel="Delete"
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

    await userEvent.click(screen.getByRole("button", { name: /delete/i }))
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

  it("disables Send now and Save when the row can't be submitted (local / empty time)", () => {
    renderActions({ canSubmit: false })

    expect(screen.getByRole("button", { name: /send now/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled()
    // Delete stays available — a local placeholder can still be dropped.
    expect(screen.getByRole("button", { name: /delete/i })).not.toBeDisabled()
  })
})
