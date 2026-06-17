import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearAttachmentBytesCache,
  getCachedAttachmentBytes,
  requestAttachmentBytes,
  subscribeToAttachmentBytes,
} from "../attachment-cache"

function blob(text: string): Blob {
  return new Blob([text], { type: "text/plain" })
}

beforeEach(() => {
  clearAttachmentBytesCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("attachment-cache", () => {
  it("caches decrypted bytes after the first request", async () => {
    const fetchDecrypt = vi.fn().mockResolvedValue(blob("file-bytes"))
    const entry = await requestAttachmentBytes("att_1", fetchDecrypt)
    expect(entry.status).toBe("decrypted")
    expect(getCachedAttachmentBytes("att_1")?.value).toBe(entry.value)
    expect(fetchDecrypt).toHaveBeenCalledTimes(1)
  })

  it("coalesces concurrent requests for the same id into a single fetch", async () => {
    const fetchDecrypt = vi.fn().mockResolvedValue(blob("x"))
    await Promise.all([
      requestAttachmentBytes("att_dup", fetchDecrypt),
      requestAttachmentBytes("att_dup", fetchDecrypt),
      requestAttachmentBytes("att_dup", fetchDecrypt),
    ])
    expect(fetchDecrypt).toHaveBeenCalledTimes(1)
  })

  it("records a failed entry on a throw and retries on a later request (transient)", async () => {
    const fetchDecrypt = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(blob("recovered"))
    const failed = await requestAttachmentBytes("att_retry", fetchDecrypt)
    expect(failed.status).toBe("failed")
    expect(failed.value).toBeNull()

    const recovered = await requestAttachmentBytes("att_retry", fetchDecrypt)
    expect(recovered.status).toBe("decrypted")
    expect(fetchDecrypt).toHaveBeenCalledTimes(2)
  })

  it("notifies subscribers when a decrypt completes", async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToAttachmentBytes("att_sub", listener)
    await requestAttachmentBytes("att_sub", () => Promise.resolve(blob("x")))
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("drops everything on clear so plaintext bytes don't outlive the lock", async () => {
    await requestAttachmentBytes("att_clear", () => Promise.resolve(blob("secret")))
    expect(getCachedAttachmentBytes("att_clear")?.status).toBe("decrypted")
    clearAttachmentBytesCache()
    expect(getCachedAttachmentBytes("att_clear")).toBeUndefined()
  })
})
