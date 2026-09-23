import { describe, it, expect } from "vitest"
import { isClearInboxShortcutEvent, resolveClearInboxTargetStreamId } from "./inbox-clear-shortcut"

function keydownOn(target: HTMLElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "e", bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, "target", { value: target })
  return event
}

describe("isClearInboxShortcutEvent", () => {
  it("matches a plain E on a non-editable target", () => {
    const event = keydownOn(document.body)
    expect(isClearInboxShortcutEvent(event, "e")).toBe(true)
  })

  it("rejects with no binding", () => {
    const event = keydownOn(document.body)
    expect(isClearInboxShortcutEvent(event, null)).toBe(false)
  })

  it("rejects a mismatched key", () => {
    const event = keydownOn(document.body, { key: "r" })
    expect(isClearInboxShortcutEvent(event, "e")).toBe(false)
  })

  it("rejects a held modifier", () => {
    const event = keydownOn(document.body, { ctrlKey: true })
    expect(isClearInboxShortcutEvent(event, "e")).toBe(false)
  })

  it("rejects a repeat keystroke", () => {
    const event = keydownOn(document.body, { repeat: true })
    expect(isClearInboxShortcutEvent(event, "e")).toBe(false)
  })

  it("rejects an IME composition keystroke", () => {
    const event = keydownOn(document.body, { isComposing: true })
    expect(isClearInboxShortcutEvent(event, "e")).toBe(false)
  })

  it("rejects an already-handled event", () => {
    const event = keydownOn(document.body)
    event.preventDefault()
    expect(isClearInboxShortcutEvent(event, "e")).toBe(false)
  })

  it.each(["INPUT", "TEXTAREA", "SELECT"] as const)("rejects a focused <%s>", (tag) => {
    const el = document.createElement(tag)
    const event = keydownOn(el)
    expect(isClearInboxShortcutEvent(event, "e")).toBe(false)
  })

  it("rejects a contentEditable target", () => {
    const el = document.createElement("div")
    Object.defineProperty(el, "isContentEditable", { value: true })
    const event = keydownOn(el)
    expect(isClearInboxShortcutEvent(event, "e")).toBe(false)
  })

  it("rejects a target inside an open dialog", () => {
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    const child = document.createElement("div")
    dialog.appendChild(child)
    document.body.appendChild(dialog)
    const event = keydownOn(child)
    expect(isClearInboxShortcutEvent(event, "e")).toBe(false)
    dialog.remove()
  })

  it("rejects a target inside an open menu", () => {
    const menu = document.createElement("div")
    menu.setAttribute("role", "menu")
    const child = document.createElement("div")
    menu.appendChild(child)
    document.body.appendChild(menu)
    const event = keydownOn(child)
    expect(isClearInboxShortcutEvent(event, "e")).toBe(false)
    menu.remove()
  })
})

describe("resolveClearInboxTargetStreamId", () => {
  const isInInbox = (streamId: string) => streamId === "stream_inbox" || streamId === "stream_hover"

  it("prefers the hovered row when it's still in the Inbox", () => {
    expect(
      resolveClearInboxTargetStreamId({ hoveredStreamId: "stream_hover", activeStreamId: "stream_inbox", isInInbox })
    ).toBe("stream_hover")
  })

  it("falls back to the open stream when it's in the Inbox", () => {
    expect(resolveClearInboxTargetStreamId({ hoveredStreamId: null, activeStreamId: "stream_inbox", isInInbox })).toBe(
      "stream_inbox"
    )
  })

  it("returns null when the open stream isn't in the Inbox", () => {
    expect(
      resolveClearInboxTargetStreamId({ hoveredStreamId: null, activeStreamId: "stream_other", isInInbox })
    ).toBeNull()
  })

  it("returns null with no hover and no open stream", () => {
    expect(resolveClearInboxTargetStreamId({ hoveredStreamId: null, activeStreamId: null, isInInbox })).toBeNull()
  })

  it("ignores a stale hover target that's no longer in the Inbox, falling back to the open stream", () => {
    const isInInboxOnlyActive = (streamId: string) => streamId === "stream_inbox"
    expect(
      resolveClearInboxTargetStreamId({
        hoveredStreamId: "stream_stale_hover",
        activeStreamId: "stream_inbox",
        isInInbox: isInInboxOnlyActive,
      })
    ).toBe("stream_inbox")
  })

  it("ignores a stale hover target when the open stream also isn't in the Inbox", () => {
    const isInInboxNeither = (_streamId: string) => false
    expect(
      resolveClearInboxTargetStreamId({
        hoveredStreamId: "stream_stale_hover",
        activeStreamId: "stream_other",
        isInInbox: isInInboxNeither,
      })
    ).toBeNull()
  })
})
