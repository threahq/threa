import { describe, it, expect } from "vitest"
import { ContextIntents, ContextRefKinds } from "@threa/types"
import { buildDiscussWithAriadneBag } from "./discuss"

describe("buildDiscussWithAriadneBag", () => {
  it("builds a thread ref for a thread target, with the focal as originMessageId (never a slice)", () => {
    const bag = buildDiscussWithAriadneBag({ kind: "thread", sourceStreamId: "stream_1", sourceMessageId: "msg_9" })
    expect(bag).toEqual({
      intent: ContextIntents.DISCUSS_THREAD,
      refs: [{ kind: ContextRefKinds.THREAD, streamId: "stream_1", originMessageId: "msg_9" }],
    })
  })

  it("builds a conversation ref carrying the conversation id + its root stream", () => {
    const bag = buildDiscussWithAriadneBag({
      kind: "conversation",
      conversationId: "conv_1",
      rootStreamId: "stream_root",
      sourceMessageId: "msg_9",
    })
    expect(bag).toEqual({
      intent: ContextIntents.DISCUSS_THREAD,
      refs: [
        {
          kind: ContextRefKinds.CONVERSATION,
          conversationId: "conv_1",
          streamId: "stream_root",
          originMessageId: "msg_9",
        },
      ],
    })
  })

  it("omits originMessageId when there is no focal (slash-command entry point)", () => {
    const bag = buildDiscussWithAriadneBag({ kind: "thread", sourceStreamId: "stream_1" })
    expect(bag.refs[0]).toEqual({ kind: ContextRefKinds.THREAD, streamId: "stream_1" })
  })
})
