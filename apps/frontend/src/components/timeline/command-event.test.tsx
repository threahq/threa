import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import type { StreamEvent } from "@threahq/types"
import * as hooksModule from "@/hooks"
import * as dispatchQueueModule from "@/hooks/use-command-dispatch-queue"
import { CommandEvent } from "./command-event"

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(hooksModule, "useFormattedDate").mockReturnValue({
    formatTime: () => "10:00",
  } as unknown as ReturnType<typeof hooksModule.useFormattedDate>)
  vi.spyOn(dispatchQueueModule, "useCommandDispatchCancellation").mockReturnValue({
    canCancel: false,
    cancel: async () => false,
  })
})

function event(id: string, eventType: StreamEvent["eventType"], payload: Record<string, unknown>): StreamEvent {
  return {
    id,
    streamId: "stream_1",
    sequence: id,
    broadcastSequence: null,
    eventType,
    actorId: "usr_kris",
    actorType: "user",
    createdAt: "2026-09-09T10:00:00.000Z",
    payload,
  } as StreamEvent
}

const USAGE =
  "Usage: `/spawn [claude|pi] [/model <model>] [/thinking <level>] <name>` with the prompt on the following lines."

describe("CommandEvent", () => {
  it("shows a rejected command as failed with its reason, in the header and expanded", async () => {
    render(
      <MemoryRouter>
        <CommandEvent
          events={[
            event("1", "command_dispatched", { commandId: "cmd_1", name: "spawn", args: "" }),
            event("2", "command_failed", { commandId: "cmd_1", error: USAGE }),
          ]}
        />
      </MemoryRouter>
    )

    const header = screen.getByRole("button", { name: /spawn/ })
    expect(header.textContent).toContain(
      "failed: Usage: /spawn [claude|pi] [/model <model>] [/thinking <level>] <name> with the prompt on the following lines."
    )
    expect(screen.queryByText("completed")).not.toBeInTheDocument()

    await userEvent.click(header)

    expect(screen.getByText("Failed")).toBeInTheDocument()
    expect(screen.getByText("/spawn [claude|pi] [/model <model>] [/thinking <level>] <name>").tagName).toBe("CODE")
  })

  it("shows the latest progress step while running and keeps every step once expanded", async () => {
    render(
      <MemoryRouter>
        <CommandEvent
          events={[
            event("1", "command_dispatched", { commandId: "cmd_1", name: "done", args: "" }),
            event("2", "command_progress", { commandId: "cmd_1", step: "Committing and pushing" }),
            event("3", "command_progress", { commandId: "cmd_1", step: "Removing the worktree" }),
          ]}
        />
      </MemoryRouter>
    )

    const header = screen.getByRole("button", { name: /done/ })
    expect(header.textContent).toContain("Removing the worktree...")
    expect(header.textContent).not.toContain("running...")
    expect(header.textContent).not.toContain("Committing and pushing")

    await userEvent.click(header)

    expect(screen.getByText("Committing and pushing")).toBeInTheDocument()
    expect(screen.getByText("Removing the worktree")).toBeInTheDocument()
  })

  it("keeps the header to the first line of a multi-line reason", () => {
    render(
      <MemoryRouter>
        <CommandEvent
          events={[
            event("1", "command_dispatched", { commandId: "cmd_1", name: "done", args: "" }),
            event("2", "command_failed", { commandId: "cmd_1", error: "Worktree is dirty.\n\n- foo.ts\n- bar.ts" }),
          ]}
        />
      </MemoryRouter>
    )

    expect(screen.getByRole("button", { name: /done/ }).textContent).toContain("failed: Worktree is dirty.")
    expect(screen.getByRole("button", { name: /done/ }).textContent).not.toContain("foo.ts")
  })
})
