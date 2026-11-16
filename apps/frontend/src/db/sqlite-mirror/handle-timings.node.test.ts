import { describe, expect, it } from "vitest"
import { timeHandleAcquisition } from "./handle-timings"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeOpener(delays: number[]) {
  let next = 0
  return {
    createSyncAccessHandle(this: unknown): Promise<unknown> {
      const delay = delays[next++]!
      return wait(delay).then(() => ({ delay }))
    },
  }
}

describe("timeHandleAcquisition", () => {
  it("reports how long the handles acquired during an install took, then restores the opener", async () => {
    const opener = fakeOpener([5, 60])
    const original = opener.createSyncAccessHandle
    const { result, handles } = await timeHandleAcquisition(opener, () =>
      Promise.all([opener.createSyncAccessHandle(), opener.createSyncAccessHandle()])
    )

    expect(result).toEqual([{ delay: 5 }, { delay: 60 }])
    expect(handles.handleCount).toBe(2)
    expect(handles.handleMinMs).toBeLessThan(30)
    expect(handles.handleMaxMs).toBeGreaterThanOrEqual(55)
    expect(handles.handleSpanMs).toBeGreaterThanOrEqual(handles.handleMaxMs)
    expect(opener.createSyncAccessHandle).toBe(original)
  })

  it("restores the opener when the install fails", async () => {
    const opener = fakeOpener([1])
    const original = opener.createSyncAccessHandle
    await expect(
      timeHandleAcquisition(opener, async () => {
        await opener.createSyncAccessHandle()
        throw new Error("locked")
      })
    ).rejects.toThrow("locked")
    expect(opener.createSyncAccessHandle).toBe(original)
  })
})
