import { describe, it, expect, vi } from "vitest"
import {
  getVisibleActions,
  groupVisibleActions,
  messageActions,
  resolveActionLabel,
  type MessageActionContext,
} from "./message-actions"

function createContext(overrides: Partial<MessageActionContext> = {}): MessageActionContext {
  return {
    contentMarkdown: "# Hello\n\nThis is **bold** and `code`.",
    actorType: "user",
    replyUrl: "/panel/draft:stream_1:msg_1",
    ...overrides,
  }
}

describe("getVisibleActions", () => {
  it("should return reply-in-thread and the copy entries for user messages", () => {
    const actions = getVisibleActions(createContext())
    const ids = actions.map((a) => a.id)

    expect(ids).toEqual(["reply-in-thread", "copy-as-markdown", "copy-as-plain-text"])
  })

  it("should include show-trace for persona messages with sessionId and traceUrl", () => {
    const actions = getVisibleActions(
      createContext({
        actorType: "persona",
        sessionId: "session_123",
        traceUrl: "/trace/session_123",
      })
    )
    const ids = actions.map((a) => a.id)

    expect(ids).toEqual(["show-trace", "reply-in-thread", "copy-as-markdown", "copy-as-plain-text"])
  })

  it("should not include show-trace for persona messages without sessionId", () => {
    const actions = getVisibleActions(createContext({ actorType: "persona", traceUrl: "/trace/x" }))
    const ids = actions.map((a) => a.id)

    expect(ids).not.toContain("show-trace")
  })

  it("should not include show-trace for persona messages without traceUrl", () => {
    const actions = getVisibleActions(createContext({ actorType: "persona", sessionId: "session_123" }))
    const ids = actions.map((a) => a.id)

    expect(ids).not.toContain("show-trace")
  })

  it("should not include show-trace for user messages", () => {
    const actions = getVisibleActions(createContext({ sessionId: "session_123", traceUrl: "/trace/x" }))
    const ids = actions.map((a) => a.id)

    expect(ids).not.toContain("show-trace")
  })

  it("should not include reply-in-thread when viewing as thread parent", () => {
    const actions = getVisibleActions(createContext({ isThreadParent: true }))
    const ids = actions.map((a) => a.id)

    expect(ids).not.toContain("reply-in-thread")
    expect(ids).toEqual(["copy-as-markdown", "copy-as-plain-text"])
  })

  it("should include copy-link when permalink fields are present", () => {
    const actions = getVisibleActions(createContext({ messageId: "msg_1", workspaceId: "ws_1", streamId: "stream_1" }))
    expect(actions.map((a) => a.id)).toContain("copy-link")
  })

  describe("edit action visibility", () => {
    it("should show edit action when author matches current user", () => {
      const actions = getVisibleActions(createContext({ authorId: "member_1", currentUserId: "member_1" }))

      expect(actions.find((a) => a.id === "edit-message")).toBeDefined()
    })

    it("should not show edit action when author differs from current user", () => {
      const actions = getVisibleActions(createContext({ authorId: "member_1", currentUserId: "member_2" }))

      expect(actions.find((a) => a.id === "edit-message")).toBeUndefined()
    })

    it("should not show edit action for persona messages", () => {
      const actions = getVisibleActions(
        createContext({ actorType: "persona", authorId: "persona_1", currentUserId: "member_1" })
      )

      expect(actions.find((a) => a.id === "edit-message")).toBeUndefined()
    })

    it("should not show edit action when authorId is missing", () => {
      const actions = getVisibleActions(createContext({ currentUserId: "member_1" }))

      expect(actions.find((a) => a.id === "edit-message")).toBeUndefined()
    })

    it("should not show edit action for own messages in an E2E stream (E2EE-1)", () => {
      const actions = getVisibleActions(
        createContext({ authorId: "member_1", currentUserId: "member_1", e2eEnabled: true })
      )

      expect(actions.find((a) => a.id === "edit-message")).toBeUndefined()
    })
  })

  describe("see revisions action visibility", () => {
    it("should show see-revisions when message has editedAt", () => {
      const actions = getVisibleActions(createContext({ editedAt: "2026-02-17T12:00:00Z" }))

      expect(actions.find((a) => a.id === "see-revisions")).toBeDefined()
    })

    it("should not show see-revisions when message has no editedAt", () => {
      const actions = getVisibleActions(createContext())

      expect(actions.find((a) => a.id === "see-revisions")).toBeUndefined()
    })
  })

  describe("delete action visibility", () => {
    it("should show delete action when author matches current user", () => {
      const actions = getVisibleActions(createContext({ authorId: "member_1", currentUserId: "member_1" }))

      const deleteAction = actions.find((a) => a.id === "delete-message")
      expect(deleteAction).toBeDefined()
      expect(deleteAction!.variant).toBe("destructive")
    })

    it("should not show delete action when author differs from current user", () => {
      const actions = getVisibleActions(createContext({ authorId: "member_1", currentUserId: "member_2" }))

      expect(actions.find((a) => a.id === "delete-message")).toBeUndefined()
    })

    it("should not show delete action for persona messages", () => {
      const actions = getVisibleActions(
        createContext({ actorType: "persona", authorId: "persona_1", currentUserId: "member_1" })
      )

      expect(actions.find((a) => a.id === "delete-message")).toBeUndefined()
    })
  })

  describe("action ordering for own messages", () => {
    it("should place edit before copy and delete after copy", () => {
      const actions = getVisibleActions(createContext({ authorId: "member_1", currentUserId: "member_1" }))

      const ids = actions.map((a) => a.id)
      const editIdx = ids.indexOf("edit-message")
      const copyIdx = ids.indexOf("copy-as-markdown")
      const deleteIdx = ids.indexOf("delete-message")

      expect(editIdx).toBeLessThan(copyIdx)
      expect(deleteIdx).toBeGreaterThan(copyIdx)
    })

    it("should place see-revisions between edit and copy for edited messages", () => {
      const actions = getVisibleActions(
        createContext({ authorId: "member_1", currentUserId: "member_1", editedAt: "2026-02-17T12:00:00Z" })
      )

      const ids = actions.map((a) => a.id)
      const editIdx = ids.indexOf("edit-message")
      const revisionsIdx = ids.indexOf("see-revisions")
      const copyIdx = ids.indexOf("copy-as-markdown")

      expect(editIdx).toBeLessThan(revisionsIdx)
      expect(revisionsIdx).toBeLessThan(copyIdx)
    })
  })
})

describe("message action behaviors", () => {
  it("show-trace should return traceUrl from getHref", () => {
    const ctx = createContext({
      actorType: "persona",
      sessionId: "session_123",
      traceUrl: "/trace/session_123",
    })

    const traceAction = messageActions.find((a) => a.id === "show-trace")!

    expect(traceAction.getHref!(ctx)).toBe("/trace/session_123")
  })

  it("reply-in-thread should return replyUrl from getHref", () => {
    const ctx = createContext({ replyUrl: "/panel/thread_456" })

    const replyAction = messageActions.find((a) => a.id === "reply-in-thread")!

    expect(replyAction.getHref!(ctx)).toBe("/panel/thread_456")
  })

  it("copy-as-markdown writes raw markdown to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    const action = messageActions.find((a) => a.id === "copy-as-markdown")!
    await action.action!(createContext({ contentMarkdown: "# Title\n\n**bold** text" }))

    expect(writeText).toHaveBeenCalledWith("# Title\n\n**bold** text")
  })

  it("copy-as-plain-text strips markdown before writing", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    const action = messageActions.find((a) => a.id === "copy-as-plain-text")!
    await action.action!(createContext({ contentMarkdown: "# Title\n\n**bold** and `code`" }))

    expect(writeText).toHaveBeenCalledWith("Title\n\nbold and code")
  })

  it("edit action should invoke onEdit callback", () => {
    const onEdit = vi.fn()
    const ctx = createContext({
      authorId: "member_1",
      currentUserId: "member_1",
      onEdit,
    })

    const editAction = getVisibleActions(ctx).find((a) => a.id === "edit-message")!
    editAction.action!(ctx)

    expect(onEdit).toHaveBeenCalledOnce()
  })

  it("see-revisions action should invoke onShowHistory callback", () => {
    const onShowHistory = vi.fn()
    const ctx = createContext({ editedAt: "2026-02-17T12:00:00Z", onShowHistory })

    const action = getVisibleActions(ctx).find((a) => a.id === "see-revisions")!
    action.action!(ctx)

    expect(onShowHistory).toHaveBeenCalledOnce()
  })

  it("delete action should invoke onDelete callback", () => {
    const onDelete = vi.fn()
    const ctx = createContext({
      authorId: "member_1",
      currentUserId: "member_1",
      onDelete,
    })

    const deleteAction = getVisibleActions(ctx).find((a) => a.id === "delete-message")!
    deleteAction.action!(ctx)

    expect(onDelete).toHaveBeenCalledOnce()
  })
})

describe("share-to-root action", () => {
  it("is hidden when onShareToRoot is not supplied", () => {
    const actions = getVisibleActions(createContext())
    expect(actions.find((a) => a.id === "share-to-root")).toBeUndefined()
  })

  it("is visible when onShareToRoot is supplied", () => {
    const actions = getVisibleActions(createContext({ onShareToRoot: () => {} }))
    expect(actions.find((a) => a.id === "share-to-root")).toBeDefined()
  })

  it("invokes the onShareToRoot callback when run", () => {
    const onShareToRoot = vi.fn()
    const ctx = createContext({ onShareToRoot })
    const action = getVisibleActions(ctx).find((a) => a.id === "share-to-root")!
    action.action!(ctx)
    expect(onShareToRoot).toHaveBeenCalledOnce()
  })

  it("uses the provided shareToRootLabel when set", () => {
    const ctx = createContext({
      onShareToRoot: () => {},
      shareToRootLabel: "Share to #general",
    })
    const action = getVisibleActions(ctx).find((a) => a.id === "share-to-root")!
    expect(resolveActionLabel(action, ctx)).toBe("Share to #general")
  })

  it("falls back to a generic label when shareToRootLabel is absent", () => {
    const ctx = createContext({ onShareToRoot: () => {} })
    const action = getVisibleActions(ctx).find((a) => a.id === "share-to-root")!
    expect(resolveActionLabel(action, ctx)).toBe("Share to channel")
  })
})

describe("share-to-parent action", () => {
  it("is hidden when onShareToParent is not supplied (one-level threads only show root entry)", () => {
    const actions = getVisibleActions(createContext({ onShareToRoot: () => {} }))
    expect(actions.find((a) => a.id === "share-to-parent")).toBeUndefined()
  })

  it("is visible when onShareToParent is supplied (nested-thread case)", () => {
    const actions = getVisibleActions(createContext({ onShareToRoot: () => {}, onShareToParent: () => {} }))
    expect(actions.find((a) => a.id === "share-to-parent")).toBeDefined()
  })

  it("invokes the onShareToParent callback when run", () => {
    const onShareToParent = vi.fn()
    const ctx = createContext({ onShareToParent })
    const action = getVisibleActions(ctx).find((a) => a.id === "share-to-parent")!
    action.action!(ctx)
    expect(onShareToParent).toHaveBeenCalledOnce()
  })

  it("uses the provided shareToParentLabel when set", () => {
    const ctx = createContext({
      onShareToParent: () => {},
      shareToParentLabel: "Share to thread (Design review)",
    })
    const action = getVisibleActions(ctx).find((a) => a.id === "share-to-parent")!
    expect(resolveActionLabel(action, ctx)).toBe("Share to thread (Design review)")
  })

  it("falls back to a generic label when shareToParentLabel is absent", () => {
    const ctx = createContext({ onShareToParent: () => {} })
    const action = getVisibleActions(ctx).find((a) => a.id === "share-to-parent")!
    expect(resolveActionLabel(action, ctx)).toBe("Share to parent thread")
  })
})

describe("share action (modal)", () => {
  it("is hidden when onShare is not supplied", () => {
    const actions = getVisibleActions(createContext())
    expect(actions.find((a) => a.id === "share")).toBeUndefined()
  })

  it("is visible when onShare is supplied", () => {
    const actions = getVisibleActions(createContext({ onShare: () => {} }))
    expect(actions.find((a) => a.id === "share")).toBeDefined()
  })

  it("renders 'Share message' as the label", () => {
    const ctx = createContext({ onShare: () => {} })
    const action = getVisibleActions(ctx).find((a) => a.id === "share")!
    expect(resolveActionLabel(action, ctx)).toBe("Share message")
  })

  it("invokes the onShare callback when run", () => {
    const onShare = vi.fn()
    const ctx = createContext({ onShare })
    const action = getVisibleActions(ctx).find((a) => a.id === "share")!
    action.action!(ctx)
    expect(onShare).toHaveBeenCalledOnce()
  })

  it("is the primary (default) entry in the share group when all three callbacks are present", () => {
    const ctx = createContext({
      onShare: () => {},
      onShareToRoot: () => {},
      onShareToParent: () => {},
    })
    const items = groupVisibleActions(getVisibleActions(ctx))
    const shareGroup = items.find((i) => i.kind === "group" && i.members[0]?.id === "share")
    expect(shareGroup).toBeDefined()
    if (shareGroup?.kind !== "group") throw new Error("expected group")
    expect(shareGroup.members.map((m) => m.id)).toEqual(["share", "share-to-root", "share-to-parent"])
  })
})

describe("groupVisibleActions", () => {
  it("returns single items for ungrouped actions and groups same-id ones", () => {
    const ctx = createContext()
    const items = groupVisibleActions(getVisibleActions(ctx))
    // No share/save/copy-link callbacks, so just reply + copy-as-markdown + copy-as-plain-text.
    // copy-as-markdown + copy-as-plain-text share groupId="copy" → one group.
    expect(items.map((i) => i.kind)).toEqual(["single", "group"])
    const reply = items[0]
    expect(reply.kind === "single" && reply.action.id).toBe("reply-in-thread")
    const copyGroup = items[1]
    if (copyGroup.kind !== "group") throw new Error("expected group")
    // Members include the default first.
    expect(copyGroup.members.map((m) => m.id)).toEqual(["copy-as-markdown", "copy-as-plain-text"])
  })

  it("groups reply actions with reply-in-thread as the default when quote reply is available", () => {
    const ctx = createContext({ onQuoteReply: () => {} })
    const items = groupVisibleActions(getVisibleActions(ctx))
    const replyGroup = items.find((i) => i.kind === "group" && i.members[0]?.id === "reply-in-thread")
    expect(replyGroup).toBeDefined()
    if (replyGroup?.kind !== "group") throw new Error("expected reply group")
    expect(replyGroup.members.map((m) => m.id)).toEqual(["reply-in-thread", "quote-reply"])
  })
  it("groups save and reminder with save as the default when both are visible", () => {
    const ctx = createContext({ onToggleSave: () => {}, onRequestReminder: () => {} })
    const items = groupVisibleActions(getVisibleActions(ctx))
    const saveGroup = items.find((i) => i.kind === "group" && i.members[0]?.id === "save-message")
    expect(saveGroup).toBeDefined()
    if (saveGroup?.kind !== "group") throw new Error("expected save group")
    expect(saveGroup.members.map((m) => m.id)).toEqual(["save-message", "set-reminder"])
  })

  it("degrades to standalone reminder when the message is already saved", () => {
    const ctx = createContext({ isSaved: true, onToggleSave: () => {}, onRequestReminder: () => {} })
    const items = groupVisibleActions(getVisibleActions(ctx))
    expect(items.find((i) => i.kind === "group" && i.members[0]?.id === "save-message")).toBeUndefined()
    expect(items.find((i) => i.kind === "single" && i.action.id === "set-reminder")).toBeDefined()
    expect(items.find((i) => i.kind === "single" && i.action.id === "unsave-message")).toBeDefined()
  })

  it("collapses adjacent same-groupId actions into a group whose first member is the default", () => {
    const ctx = createContext({ onShareToRoot: () => {}, onShareToParent: () => {} })
    const items = groupVisibleActions(getVisibleActions(ctx))
    const shareGroup = items.find((i) => i.kind === "group" && i.members[0]?.id === "share-to-root")
    expect(shareGroup).toBeDefined()
    if (shareGroup?.kind !== "group") throw new Error("expected group")
    expect(shareGroup.members.map((m) => m.id)).toEqual(["share-to-root", "share-to-parent"])
  })

  it("degrades a single-member group to a single item (no chevron)", () => {
    // Only share-to-root visible, share-to-parent gone — group should collapse.
    const ctx = createContext({ onShareToRoot: () => {} })
    const items = groupVisibleActions(getVisibleActions(ctx))
    const shareItem = items.find((i) => i.kind === "single" && i.action.id === "share-to-root")
    expect(shareItem).toBeDefined()
    expect(items.find((i) => i.kind === "group" && i.members[0]?.id === "share-to-root")).toBeUndefined()
  })

  it("keeps copy-link as a separate top-level row (not part of the copy group)", () => {
    const ctx = createContext({ messageId: "msg_1", workspaceId: "ws_1", streamId: "stream_1" })
    const items = groupVisibleActions(getVisibleActions(ctx))

    const copyGroup = items.find((i) => i.kind === "group" && i.members[0]?.id === "copy-as-markdown")
    if (copyGroup?.kind !== "group") throw new Error("expected copy group")
    expect(copyGroup.members.map((m) => m.id)).toEqual(["copy-as-markdown", "copy-as-plain-text"])

    const linkRow = items.find((i) => i.kind === "single" && i.action.id === "copy-link")
    expect(linkRow).toBeDefined()
  })
})
