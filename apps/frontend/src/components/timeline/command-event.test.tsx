import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import type { StreamEvent } from "@threahq/types"
import * as hooksModule from "@/hooks"
import * as dispatchQueueModule from "@/hooks/use-command-dispatch-queue"
import { peekShareHandoffBatch, resetShareHandoffStoreCache } from "@/stores/composer-handoff-store"
import { CommandEvent } from "./command-event"

beforeEach(() => {
  vi.restoreAllMocks()
  resetShareHandoffStoreCache()
  vi.spyOn(hooksModule, "useFormattedDate").mockReturnValue({
    formatTime: () => "10:00",
  } as unknown as ReturnType<typeof hooksModule.useFormattedDate>)
  vi.spyOn(dispatchQueueModule, "useCommandDispatchCancellation").mockReturnValue({
    canCancel: false,
    cancel: async () => false,
  })
})

let pathname = ""
function Probe({ children }: { children: ReactNode }) {
  pathname = useLocation().pathname
  return <>{children}</>
}

function renderChip(events: StreamEvent[]) {
  pathname = ""
  return render(
    <MemoryRouter initialEntries={["/w/ws_1/board"]}>
      <Routes>
        <Route
          path="*"
          element={
            <Probe>
              <CommandEvent events={events} workspaceId="ws_1" />
            </Probe>
          }
        />
      </Routes>
    </MemoryRouter>
  )
}

/** The mounted host timeline: the scroller `StreamContent` stamps. */
function mountHostScroller(streamId: string): () => void {
  const el = document.createElement("div")
  el.setAttribute("data-stream-scroller", streamId)
  document.body.appendChild(el)
  return () => el.remove()
}

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
          workspaceId="ws_1"
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
          workspaceId="ws_1"
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

  it('shows a summarized completion instead of a bare "completed"', async () => {
    render(
      <MemoryRouter>
        <CommandEvent
          workspaceId="ws_1"
          events={[
            event("1", "command_dispatched", { commandId: "cmd_1", name: "stop", args: "" }),
            event("2", "command_completed", {
              commandId: "cmd_1",
              result: { invocationId: "binv_1" },
              summary: "Interrupted the running turn",
            }),
          ]}
        />
      </MemoryRouter>
    )

    const header = screen.getByRole("button", { name: /stop/ })
    expect(header.textContent).toContain("Interrupted the running turn")
    expect(header.textContent).not.toContain("completed")

    await userEvent.click(header)

    expect(screen.getByText("Completed: Interrupted the running turn")).toBeInTheDocument()
  })

  it("should name the reply mode when /replies completes", async () => {
    renderChip([
      event("1", "command_dispatched", { commandId: "cmd_1", name: "replies", args: "thread" }),
      event("2", "command_completed", { commandId: "cmd_1", result: { replyMode: "thread" } }),
    ])

    await userEvent.click(screen.getByRole("button", { name: /replies/ }))

    expect(screen.getByText("Completed: replies go in a thread on each message")).toBeInTheDocument()
  })

  it("should say the reply goes in a thread when /thread completes", async () => {
    renderChip([
      event("1", "command_dispatched", { commandId: "cmd_1", name: "thread", args: "why?" }),
      event("2", "command_completed", { commandId: "cmd_1", result: { replyInThread: true } }),
    ])

    await userEvent.click(screen.getByRole("button", { name: /thread/ }))

    expect(screen.getByText("Completed: the reply goes in a thread on your message")).toBeInTheDocument()
  })

  it('falls back to "completed" when the command sent no summary', () => {
    render(
      <MemoryRouter>
        <CommandEvent
          workspaceId="ws_1"
          events={[
            event("1", "command_dispatched", { commandId: "cmd_1", name: "invite", args: "@ada" }),
            event("2", "command_completed", { commandId: "cmd_1" }),
          ]}
        />
      </MemoryRouter>
    )

    expect(screen.getByRole("button", { name: /invite/ }).textContent).toContain("completed")
  })

  it("keeps the header to the first line of a multi-line reason", () => {
    render(
      <MemoryRouter>
        <CommandEvent
          workspaceId="ws_1"
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

  it("should queue the command doc for the host stream when the composer is mounted", async () => {
    const unmount = mountHostScroller("stream_1")
    try {
      renderChip([
        event("1", "command_dispatched", { commandId: "cmd_1", name: "spawn", args: "claude fixer" }),
        event("2", "command_failed", { commandId: "cmd_1", error: "boom" }),
      ])

      await userEvent.click(screen.getByRole("button", { name: "Put back in composer" }))

      expect(peekShareHandoffBatch("stream_1")?.handoffs).toEqual([
        {
          kind: "content",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "slashCommand", attrs: { name: "spawn" } },
                { type: "text", text: " claude fixer" },
              ],
            },
          ],
          attachments: [],
        },
      ])
      expect(pathname).toBe("/w/ws_1/board")
    } finally {
      unmount()
    }
  })

  it("should navigate to the stream when its composer is not mounted", async () => {
    renderChip([
      event("1", "command_dispatched", { commandId: "cmd_1", name: "done", args: "" }),
      event("2", "command_failed", { commandId: "cmd_1", error: "boom" }),
    ])

    await userEvent.click(screen.getByRole("button", { name: "Put back in composer" }))

    expect(peekShareHandoffBatch("stream_1")?.handoffs).toEqual([
      {
        kind: "content",
        content: [{ type: "paragraph", content: [{ type: "slashCommand", attrs: { name: "done" } }] }],
        attachments: [],
      },
    ])
    expect(pathname).toBe("/w/ws_1/s/stream_1")
  })

  it("should hide the restore button when the command is running or completed", () => {
    const running = renderChip([event("1", "command_dispatched", { commandId: "cmd_1", name: "spawn", args: "" })])
    expect(screen.queryByRole("button", { name: "Put back in composer" })).not.toBeInTheDocument()
    running.unmount()

    renderChip([
      event("1", "command_dispatched", { commandId: "cmd_1", name: "spawn", args: "" }),
      event("2", "command_completed", { commandId: "cmd_1" }),
    ])
    expect(screen.queryByRole("button", { name: "Put back in composer" })).not.toBeInTheDocument()
  })
})
