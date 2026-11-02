import { describe, expect, it } from "vitest"
import { queryActiveWorkerReceiptVersion } from "./push-receipt-capability"
import { SW_MSG_QUERY_STATUS, SW_MSG_STATUS_REPLY } from "./sw-messages"

function workerReplying(reply: unknown | null): ServiceWorker {
  return {
    postMessage(message: { type?: string }, transfer: Transferable[]) {
      if (message.type !== SW_MSG_QUERY_STATUS || reply === null) return
      ;(transfer[0] as MessagePort).postMessage(reply)
    },
  } as unknown as ServiceWorker
}

function registration(active: ServiceWorker | null, waiting: ServiceWorker | null = null): ServiceWorkerRegistration {
  return { active, waiting } as unknown as ServiceWorkerRegistration
}

const statusReply = { type: SW_MSG_STATUS_REPLY, version: "1.0.0", buildId: "b1", ready: true }

describe("queryActiveWorkerReceiptVersion", () => {
  it("should return the version the active worker advertises", async () => {
    const reg = registration(workerReplying({ ...statusReply, pushReceiptVersion: 1 }))
    expect(await queryActiveWorkerReceiptVersion(reg)).toBe(1)
  })

  it("should treat an active worker that predates receipts as unknown even when a newer worker is waiting", async () => {
    const reg = registration(workerReplying(statusReply), workerReplying({ ...statusReply, pushReceiptVersion: 1 }))
    expect(await queryActiveWorkerReceiptVersion(reg)).toBeNull()
  })

  it("should treat a silent worker, no active worker, or a malformed version as unknown", async () => {
    const results = await Promise.all([
      queryActiveWorkerReceiptVersion(registration(workerReplying(null)), 20),
      queryActiveWorkerReceiptVersion(registration(null)),
      queryActiveWorkerReceiptVersion(registration(workerReplying({ ...statusReply, pushReceiptVersion: "1" }))),
      queryActiveWorkerReceiptVersion(registration(workerReplying({ ...statusReply, pushReceiptVersion: 0.5 }))),
    ])
    expect(results).toEqual([null, null, null, null])
  })
})
