import { describe, test, expect, spyOn, mock, beforeEach, afterEach } from "bun:test"
import { conversationAssigner } from "./conversation-assigner"
import { ConversationRepository, type Conversation } from "./repository"
import * as assignmentEvents from "./assignment-events"
import * as streams from "../streams"
import type { Message } from "../messaging"

// The assigner only passes `client` through to the (spied) repositories, so a
// dummy stands in for a real PoolClient.
const CLIENT = {} as never
const WORKSPACE_ID = "ws_1"

function makeReply(): Message {
  // The thread's first reply, sent into the (already promoted) thread stream.
  return { id: "msg_reply", streamId: "thr_1", authorId: "usr_1" } as unknown as Message
}

function makeSource(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv_src",
    streamId: "chan_1",
    workspaceId: WORKSPACE_ID,
    messageIds: ["msg_open"],
    ...overrides,
  } as unknown as Conversation
}

describe("conversationAssigner — threadFromMessage", () => {
  let insert: ReturnType<typeof spyOn>
  let emitAssignmentEvents: ReturnType<typeof spyOn>
  let findByIdForUpdate: ReturnType<typeof spyOn>
  let removePrimaryMessage: ReturnType<typeof spyOn>
  let resolveIfEmpty: ReturnType<typeof spyOn>
  let emitRetired: ReturnType<typeof spyOn>
  let checkStreamAccess: ReturnType<typeof spyOn>

  beforeEach(() => {
    insert = spyOn(ConversationRepository, "insert").mockResolvedValue(undefined as never)
    spyOn(ConversationRepository, "addPrimaryMessage").mockResolvedValue(undefined as never)
    spyOn(ConversationRepository, "bumpActivityForIds").mockResolvedValue(undefined as never)
    emitAssignmentEvents = spyOn(assignmentEvents, "emitAssignmentEvents").mockResolvedValue(undefined as never)
    findByIdForUpdate = spyOn(ConversationRepository, "findByIdForUpdate")
    removePrimaryMessage = spyOn(ConversationRepository, "removePrimaryMessage").mockResolvedValue(undefined as never)
    resolveIfEmpty = spyOn(ConversationRepository, "resolveIfEmpty").mockResolvedValue(undefined as never)
    emitRetired = spyOn(assignmentEvents, "emitConversationRetired").mockResolvedValue(undefined as never)
    // The thread (the reply's stream `thr_1`) hangs off `msg_open` in `chan_1` —
    // so the only retire-able source is the lone conversation owning that message.
    spyOn(streams.StreamRepository, "findById").mockResolvedValue({
      id: "thr_1",
      parentStreamId: "chan_1",
      parentMessageId: "msg_open",
    } as never)
    // Default: the actor can reach the source stream (the legit board-reply case).
    checkStreamAccess = spyOn(streams, "checkStreamAccess").mockResolvedValue({ id: "chan_1" } as never)
  })

  afterEach(() => {
    mock.restore()
  })

  async function thread(sourceConversationId: string): Promise<void> {
    await conversationAssigner.assignInTransaction(CLIENT, {
      workspaceId: WORKSPACE_ID,
      message: makeReply(),
      directive: { intent: "threadFromMessage", sourceConversationId },
    })
  }

  test("mints the thread's conversation seeded with the reply, then empties + retires the lone source", async () => {
    findByIdForUpdate.mockResolvedValue(makeSource())

    await thread("conv_src")

    // Mint: a fresh conversation in the thread stream, seeded with the reply,
    // announced as created.
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0][1]).toMatchObject({ streamId: "thr_1", workspaceId: WORKSPACE_ID })
    expect(emitAssignmentEvents.mock.calls[0][1]).toMatchObject({
      message: expect.objectContaining({ id: "msg_reply" }),
      created: true,
    })

    // Retire: the source's sole message (the thread's parent) is removed so the
    // source empties and drops off the board; one retire event is emitted.
    expect(removePrimaryMessage).toHaveBeenCalledWith(CLIENT, WORKSPACE_ID, "conv_src", "msg_open")
    expect(resolveIfEmpty).toHaveBeenCalledWith(CLIENT, WORKSPACE_ID, "conv_src")
    expect(emitRetired).toHaveBeenCalledWith(CLIENT, {
      workspaceId: WORKSPACE_ID,
      conversationId: "conv_src",
      streamId: "chan_1",
    })
  })

  test("leaves a non-lone source intact (only empties a single-message source)", async () => {
    findByIdForUpdate.mockResolvedValue(makeSource({ messageIds: ["msg_open", "msg_other"] }))

    await thread("conv_src")

    expect(insert).toHaveBeenCalledTimes(1)
    expect(removePrimaryMessage).not.toHaveBeenCalled()
    expect(resolveIfEmpty).not.toHaveBeenCalled()
    expect(emitRetired).not.toHaveBeenCalled()
  })

  test("is idempotent on a missing/foreign source — no throw, no retire", async () => {
    findByIdForUpdate.mockResolvedValue(null)

    await thread("conv_gone")

    expect(removePrimaryMessage).not.toHaveBeenCalled()
    expect(emitRetired).not.toHaveBeenCalled()
  })

  test("does not gut a source that lives in the reply's own stream (sanity guard)", async () => {
    findByIdForUpdate.mockResolvedValue(makeSource({ streamId: "thr_1" }))

    await thread("conv_src")

    expect(removePrimaryMessage).not.toHaveBeenCalled()
    expect(emitRetired).not.toHaveBeenCalled()
  })

  test("does not retire a source the actor cannot access (crafted sourceConversationId)", async () => {
    findByIdForUpdate.mockResolvedValue(makeSource())
    checkStreamAccess.mockResolvedValue(null)

    await thread("conv_src")

    // The thread is still minted (the reply is the actor's own), but the source —
    // a lone conversation in a stream the actor can't see — is left untouched.
    expect(insert).toHaveBeenCalledTimes(1)
    expect(checkStreamAccess).toHaveBeenCalledWith(CLIENT, "chan_1", WORKSPACE_ID, "usr_1")
    expect(removePrimaryMessage).not.toHaveBeenCalled()
    expect(resolveIfEmpty).not.toHaveBeenCalled()
    expect(emitRetired).not.toHaveBeenCalled()
  })

  test("only retires the thread's actual parent — not an unrelated accessible lone source", async () => {
    // A crafted id pointing at a different lone conversation the actor CAN see:
    // it's in the parent stream and accessible, but its message isn't the thread's
    // parent (`msg_open`), so it must be left intact.
    findByIdForUpdate.mockResolvedValue(makeSource({ id: "conv_other", messageIds: ["msg_unrelated"] }))

    await thread("conv_other")

    expect(insert).toHaveBeenCalledTimes(1)
    expect(removePrimaryMessage).not.toHaveBeenCalled()
    expect(resolveIfEmpty).not.toHaveBeenCalled()
    expect(emitRetired).not.toHaveBeenCalled()
  })
})
