import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import { BotInvocationOutboxHandler } from "./invocation-outbox-handler"
import { BotRuntimeService } from "./service"
import { StreamRepository } from "../streams"
import * as outbox from "../../lib/outbox"
import { E2E_PLACEHOLDER_CONTENT_MARKDOWN } from "@threa/types"

// E2EE-11: external bot invocations must never fire for E2E streams. The outbox
// payload carries the ciphertext placeholder (mentions ride sealed, not in the
// cleartext markdown), so dispatching would either silently no-op (@mention) or
// send an empty-prompt turn to an external bot whose plaintext reply would then
// violate INV-E1. The handler short-circuits the moment it sees an E2E stream.

afterEach(() => mock.restore())

describe("BotInvocationOutboxHandler E2E short-circuit", () => {
  it("does not create any invocation for a message in an E2E stream", async () => {
    spyOn(outbox, "parseMessagePayload").mockReturnValue({
      streamId: "stream_1",
      workspaceId: "ws_1",
      event: {
        actorId: "usr_1",
        actorType: "user",
        payload: { messageId: "msg_1", contentMarkdown: E2E_PLACEHOLDER_CONTENT_MARKDOWN },
      },
    } as never)
    const findById = spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "stream_1",
      workspaceId: "ws_1",
      archivedAt: null,
      rootStreamId: null,
      e2eEnabled: true,
    } as never)
    const createInvocation = spyOn(BotRuntimeService.prototype, "createInvocation").mockResolvedValue(undefined as never)

    const handler = new BotInvocationOutboxHandler({} as Pool)
    // processMessageCreated is private; exercise it directly with a parsed payload.
    await (handler as unknown as { processMessageCreated(p: unknown): Promise<void> }).processMessageCreated({})

    expect(createInvocation).not.toHaveBeenCalled()
    // Returned at the E2E gate — never resolved the root stream (the next lookup).
    expect(findById).toHaveBeenCalledTimes(1)
  })
})
