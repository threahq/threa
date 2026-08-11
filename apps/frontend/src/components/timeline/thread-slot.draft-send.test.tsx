import { beforeEach, describe, it, expect, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { MemoryRouter } from "react-router-dom"
import type { JSONContent, ThreadSummary } from "@threa/types"
// eslint-disable-next-line no-restricted-imports -- test seeds/inspects IDB directly to drive the real draft registry
import { db } from "@/db"
import { resolveLoadedDraft, upsertLoadedDraft } from "@/hooks/use-draft-message"
import { resetDraftStoreCache } from "@/stores/draft-store"
import { resetDraftResolutionGuard } from "@/sync/draft-resolution-guard"
import { useThreadDraft, __clearBoardDraftsRegistry } from "@/hooks/use-scope-draft-preview"
import * as hooksModule from "@/hooks"
import * as workspaceEmojiModule from "@/hooks/use-workspace-emoji"
import * as relativeTimeModule from "@/components/relative-time"
import { ThreadSlot } from "./thread-slot"

const workspaceId = "ws_1"
const anchorId = "msg_anchor"
const scope = `thread:${anchorId}`
const threadId = "stream_thread"

const doc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})

const summary: ThreadSummary = {
  lastReplyAt: "2026-04-19T12:00:00.000Z",
  participants: [{ id: "user_alice", type: "user" }],
  latestReply: {
    messageId: "msg_sent",
    actorId: "user_alice",
    actorType: "user",
    contentMarkdown: "typed but unsent",
  },
}

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.spyOn(hooksModule, "useActors").mockReturnValue({
    getActorName: (id: string) => `Name-${id.slice(-4)}`,
    getActorAvatar: (id: string) => ({ fallback: id.slice(0, 2).toUpperCase(), avatarUrl: null }),
  } as unknown as ReturnType<typeof hooksModule.useActors>)
  vi.spyOn(workspaceEmojiModule, "useWorkspaceEmoji").mockReturnValue({
    toEmoji: () => null,
  } as unknown as ReturnType<typeof workspaceEmojiModule.useWorkspaceEmoji>)
  vi.spyOn(relativeTimeModule, "RelativeTime").mockImplementation((({ date }: { date: string }) => (
    <time dateTime={date}>{date}</time>
  )) as unknown as typeof relativeTimeModule.RelativeTime)
  __clearBoardDraftsRegistry()
  resetDraftResolutionGuard()
  resetDraftStoreCache()
  await db.drafts.clear()
  await db.composerLoaded.clear()
  await db.pendingOperations.clear()
})

/**
 * The in-stream slot wired to the real drafts registry, with the two halves of a
 * draft send driven separately: "reply landed" is what `queueDraftMessage` does
 * (optimistic replyCount + threadId on the anchor), "resolve" is the real
 * `resolveLoadedDraft` the composer calls. Order between them is the thing under
 * test.
 */
function SendHarness() {
  const [replyLanded, setReplyLanded] = useState(false)
  const draft = useThreadDraft(workspaceId, anchorId, replyLanded ? threadId : undefined)
  return (
    <>
      <button onClick={() => setReplyLanded(true)}>reply landed</button>
      <button onClick={() => void resolveLoadedDraft(workspaceId, scope)}>resolve draft</button>
      <div data-testid="slot-host">
        <ThreadSlot
          activity={undefined}
          replyCount={replyLanded ? 1 : 0}
          threadHref={replyLanded ? "/panel/thread_1" : null}
          summary={replyLanded ? summary : undefined}
          workspaceId={workspaceId}
          draft={draft}
          draftHref="/panel/draft:stream_1:msg_1"
        />
      </div>
    </>
  )
}

describe("thread draft send transition", () => {
  it("keeps the slot element and skips the grow-in when the reply lands before the draft resolves", async () => {
    const user = userEvent.setup()
    await upsertLoadedDraft(workspaceId, scope, { contentJson: doc("typed but unsent"), attachments: [] })

    render(
      <MemoryRouter>
        <SendHarness />
      </MemoryRouter>
    )
    const host = screen.getByTestId("slot-host")
    await waitFor(() => expect(screen.getByText("typed but unsent")).toBeInTheDocument())
    // Past the slot's 300ms hydration grace, so a genuine visible flip WOULD
    // animate — otherwise the animation assertion below proves nothing.
    await new Promise((resolve) => setTimeout(resolve, 350))
    const slotBeforeSend = host.firstChild
    expect(slotBeforeSend).not.toBeNull()

    await user.click(screen.getByText("reply landed"))
    await user.click(screen.getByText("resolve draft"))

    await waitFor(() => expect(screen.queryByText("Draft")).toBeNull())
    expect(screen.getByText("1 reply")).toBeInTheDocument()
    expect(host.firstChild).toBe(slotBeforeSend)
    expect(host.querySelector(".animate-thread-grow")).toBeNull()
    expect(await db.drafts.get({ scope })).toBeUndefined()
  })

  it("loses the slot element (and replays the grow-in) when the draft resolves before the reply lands", async () => {
    const user = userEvent.setup()
    await upsertLoadedDraft(workspaceId, scope, { contentJson: doc("typed but unsent"), attachments: [] })

    render(
      <MemoryRouter>
        <SendHarness />
      </MemoryRouter>
    )
    const host = screen.getByTestId("slot-host")
    await waitFor(() => expect(screen.getByText("typed but unsent")).toBeInTheDocument())
    await new Promise((resolve) => setTimeout(resolve, 350))
    const slotBeforeSend = host.firstChild

    await user.click(screen.getByText("resolve draft"))
    await waitFor(() => expect(host.firstChild).toBeNull())
    await user.click(screen.getByText("reply landed"))

    expect(screen.getByText("1 reply")).toBeInTheDocument()
    expect(host.firstChild).not.toBe(slotBeforeSend)
    expect(host.querySelector(".animate-thread-grow")).not.toBeNull()
  })
})
