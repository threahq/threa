import { describe, expect, it, vi } from "vitest"
import { createPushReceipt, trackNotificationCreation, type PushReceiptDeps } from "./sw-push-receipt"

const ORIGIN = "https://app.threa.test"
const TOKEN = "a".repeat(43)

function harness(fetchImpl: PushReceiptDeps["fetch"] = async () => new Response(null, { status: 204 })) {
  const held: Promise<void>[] = []
  const fetch = vi.fn(fetchImpl)
  const deps: PushReceiptDeps = { origin: ORIGIN, fetch, hold: (p) => held.push(p), timeoutMs: 50 }
  return {
    deps,
    fetch,
    held,
    sent: () => fetch.mock.calls.map(([url, init]) => ({ url, body: JSON.parse(init.body as string) })),
  }
}

describe("createPushReceipt", () => {
  it("should report nothing when the payload has no usable capability", () => {
    const h = harness()
    const receipts = [
      createPushReceipt({ workspaceId: "ws_1" }, h.deps),
      createPushReceipt({ workspaceId: "ws_1", receipt: { token: "short" } }, h.deps),
      createPushReceipt({ workspaceId: "ws_1", receipt: TOKEN }, h.deps),
      createPushReceipt({ receipt: { token: TOKEN } }, h.deps),
      createPushReceipt({ workspaceId: "../../evil", receipt: { token: TOKEN } }, h.deps),
      createPushReceipt({ workspaceId: "ws_1?x=1", receipt: { token: TOKEN } }, h.deps),
    ]
    expect(receipts).toEqual([null, null, null, null, null, null])
  })

  it("should post each stage to this origin's receipt route without credentials or redirects", async () => {
    const h = harness()
    const receipt = createPushReceipt({ workspaceId: "ws_1", receipt: { token: TOKEN } }, h.deps)!

    receipt.received()
    receipt.settle("suppressed", "presence")
    await Promise.all(h.held)

    expect(h.sent()).toEqual([
      { url: `${ORIGIN}/api/workspaces/ws_1/push/receipts`, body: { token: TOKEN, stage: "received" } },
      {
        url: `${ORIGIN}/api/workspaces/ws_1/push/receipts`,
        body: { token: TOKEN, stage: "suppressed", reason: "presence" },
      },
    ])
    expect(h.fetch.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    })
  })

  it("should send only the first terminal stage", async () => {
    const h = harness()
    const receipt = createPushReceipt({ workspaceId: "ws_1", receipt: { token: TOKEN } }, h.deps)!

    receipt.settle("notification_created")
    receipt.settle("creation_failed")
    await Promise.all(h.held)

    expect(h.sent().map((s) => s.body.stage)).toEqual(["notification_created"])
  })

  it("should resolve, not reject, when the report fails or never answers", async () => {
    const failing = harness(async () => {
      throw new TypeError("network")
    })
    const hanging = harness(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        })
    )
    createPushReceipt({ workspaceId: "ws_1", receipt: { token: TOKEN } }, failing.deps)!.received()
    createPushReceipt({ workspaceId: "ws_1", receipt: { token: TOKEN } }, hanging.deps)!.received()

    await expect(Promise.all([...failing.held, ...hanging.held])).resolves.toEqual([undefined, undefined])
    expect(hanging.fetch.mock.calls[0]![1].signal!.aborted).toBe(true)
  })
})

describe("trackNotificationCreation", () => {
  it("should report notification_created once the notification is created", async () => {
    const h = harness()
    const receipt = createPushReceipt({ workspaceId: "ws_1", receipt: { token: TOKEN } }, h.deps)

    await trackNotificationCreation(receipt, Promise.resolve())
    await Promise.all(h.held)

    expect(h.sent().map((s) => s.body.stage)).toEqual(["notification_created"])
  })

  it("should report creation_failed and rethrow the original error", async () => {
    const h = harness()
    const receipt = createPushReceipt({ workspaceId: "ws_1", receipt: { token: TOKEN } }, h.deps)
    const failure = new TypeError("No notification permission")

    await expect(trackNotificationCreation(receipt, Promise.reject(failure))).rejects.toBe(failure)
    await Promise.all(h.held)

    expect(h.sent().map((s) => s.body.stage)).toEqual(["creation_failed"])
  })

  it("should pass the show result through when there is no receipt", async () => {
    const failure = new Error("boom")
    await expect(trackNotificationCreation(null, Promise.resolve())).resolves.toBeUndefined()
    await expect(trackNotificationCreation(null, Promise.reject(failure))).rejects.toBe(failure)
  })
})
