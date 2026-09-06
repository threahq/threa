import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import { CursorLock } from "@threahq/backend-common"
import * as outbox from "../../../lib/outbox"
import { OutboxRepository } from "../../../lib/outbox"
import { E2eStreamActorsRepository, E2eStreamsRepository } from "../../e2e-streams"
import { StreamRepository } from "../../streams"
import { EnclaveInvocationsRepository } from "../invocations-repository"
import { EnclaveDispatchHandler } from "./enclave-dispatch-handler"

// The enclave only auto-replies when companion mode is ON. "Quiet" (off) keeps
// the encrypted scratchpad a silent dump — the enclave actor stays invited but
// no turn is dispatched. Threads inherit the root scratchpad's mode live.

const EVENT = { id: 1n, eventType: "message:created", payload: {} }

function arrange(streamById: Record<string, unknown>) {
  spyOn(CursorLock.prototype, "run").mockImplementation((async (
    processor: (c: bigint, p: bigint[]) => Promise<unknown>
  ) => {
    await processor(0n, [])
    return true
  }) as never)
  spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([EVENT] as never)
  spyOn(outbox, "parseMessagePayload").mockReturnValue({
    streamId: "stream_target",
    workspaceId: "ws_1",
    event: { actorType: "user", actorId: "usr_1", payload: { messageId: "msg_1" } },
  } as never)
  spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
  spyOn(E2eStreamActorsRepository, "listForStream").mockResolvedValue([
    { kind: "enclave", actorId: "enclave", keyId: null },
  ] as never)
  spyOn(StreamRepository, "findById").mockImplementation(((_db: unknown, id: string) =>
    Promise.resolve(streamById[id] ?? null)) as never)
  return spyOn(EnclaveInvocationsRepository, "insertPending").mockResolvedValue(true)
}

describe("EnclaveDispatchHandler companion-mode gate", () => {
  afterEach(() => mock.restore())

  const run = async () => {
    const handler = new EnclaveDispatchHandler({} as Pool)
    await (handler as unknown as { processEvents(): Promise<void> }).processEvents()
  }

  it("does NOT enqueue when the scratchpad's companion mode is OFF (Quiet)", async () => {
    const insert = arrange({
      stream_target: { id: "stream_target", type: "scratchpad", companionMode: "off", rootStreamId: null },
    })
    await run()
    expect(insert).not.toHaveBeenCalled()
  })

  it("enqueues a claimable invocation when companion mode is ON", async () => {
    const insert = arrange({
      stream_target: { id: "stream_target", type: "scratchpad", companionMode: "on", rootStreamId: null },
    })
    await run()
    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: "ws_1",
        streamId: "stream_target",
        rootStreamId: "stream_target",
        messageId: "msg_1",
        triggeredBy: "usr_1",
      })
    )
  })

  it("enqueues for a thread whose own mode is off but whose root scratchpad is ON, keyed to the root", async () => {
    const insert = arrange({
      stream_target: { id: "stream_target", type: "thread", companionMode: "off", rootStreamId: "stream_root" },
      stream_root: { id: "stream_root", type: "scratchpad", companionMode: "on", rootStreamId: null },
    })
    await run()
    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ streamId: "stream_target", rootStreamId: "stream_root" })
    )
  })
})
