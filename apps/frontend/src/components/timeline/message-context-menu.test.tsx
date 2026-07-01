import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { MessageContextMenu } from "./message-context-menu"
import type { MessageActionContext } from "./message-actions"

function createContext(overrides: Partial<MessageActionContext> = {}): MessageActionContext {
  return {
    contentMarkdown: "Hello world",
    actorType: "user",
    replyUrl: "/panel/draft:stream_1:msg_1",
    ...overrides,
  }
}

function renderMenu(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

describe("MessageContextMenu", () => {
  it("should render a trigger button with message actions label", () => {
    renderMenu(<MessageContextMenu context={createContext()} />)

    expect(screen.getByRole("button", { name: "Message actions" })).toBeInTheDocument()
  })

  it("should show menu items when trigger is clicked", async () => {
    const user = userEvent.setup()
    renderMenu(<MessageContextMenu context={createContext()} />)

    await user.click(screen.getByRole("button", { name: "Message actions" }))

    expect(screen.getByText("Reply in thread")).toBeInTheDocument()
    expect(screen.getByText("Copy as Markdown")).toBeInTheDocument()
  })

  it("should render navigation actions as links", async () => {
    const user = userEvent.setup()
    renderMenu(<MessageContextMenu context={createContext({ replyUrl: "/panel/thread_123" })} />)

    await user.click(screen.getByRole("button", { name: "Message actions" }))

    const replyLink = screen.getByText("Reply in thread").closest("a")
    expect(replyLink).toHaveAttribute("href", "/panel/thread_123")
  })

  it("should show trace option for persona messages with sessionId", async () => {
    const user = userEvent.setup()
    renderMenu(
      <MessageContextMenu
        context={createContext({
          actorType: "persona",
          sessionId: "session_123",
          traceUrl: "/trace/session_123",
        })}
      />
    )

    await user.click(screen.getByRole("button", { name: "Message actions" }))

    const traceLink = screen.getByText("Show trace and sources").closest("a")
    expect(traceLink).toHaveAttribute("href", "/trace/session_123")
  })

  it("should not show trace option for user messages", async () => {
    const user = userEvent.setup()
    renderMenu(<MessageContextMenu context={createContext()} />)

    await user.click(screen.getByRole("button", { name: "Message actions" }))

    expect(screen.queryByText("Show trace and sources")).not.toBeInTheDocument()
  })

  it("should show edit and delete actions for own messages", async () => {
    const user = userEvent.setup()
    renderMenu(
      <MessageContextMenu
        context={createContext({
          authorId: "member_1",
          currentUserId: "member_1",
          onEdit: () => {},
          onDelete: () => {},
        })}
      />
    )

    await user.click(screen.getByRole("button", { name: "Message actions" }))

    expect(screen.getByText("Edit message")).toBeInTheDocument()
    expect(screen.getByText("Delete message")).toBeInTheDocument()
  })

  it("should not show edit or delete actions for other members' messages", async () => {
    const user = userEvent.setup()
    renderMenu(
      <MessageContextMenu
        context={createContext({
          authorId: "member_other",
          currentUserId: "member_1",
        })}
      />
    )

    await user.click(screen.getByRole("button", { name: "Message actions" }))

    expect(screen.queryByText("Edit message")).not.toBeInTheDocument()
    expect(screen.queryByText("Delete message")).not.toBeInTheDocument()
  })
})
