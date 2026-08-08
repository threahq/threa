import { describe, expect, it, mock } from "bun:test"
import { PolishScheduler } from "./polish-scheduler"
import type { PolishOutcome } from "./polish"

function deferred() {
  let resolve!: (value: PolishOutcome) => void
  const promise = new Promise<PolishOutcome>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const success = (markdown: string): PolishOutcome => ({ status: "success", markdown })

describe("PolishScheduler", () => {
  it("runs one active pass and only the newest pending snapshot", async () => {
    const first = deferred()
    const seen: number[] = []
    const onResult = mock((snapshot: { revision: number }) => seen.push(snapshot.revision))
    const scheduler = new PolishScheduler(onResult)
    scheduler.scheduleLive({ revision: 1, run: () => first.promise })
    scheduler.scheduleLive({ revision: 2, run: async () => success("two") })
    scheduler.scheduleLive({ revision: 3, run: async () => success("three") })
    first.resolve(success("one"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toEqual([1, 3])
  })

  it("ignores a late result after cancellation", async () => {
    const active = deferred()
    const onResult = mock(() => {})
    const scheduler = new PolishScheduler(onResult)
    scheduler.scheduleLive({ revision: 1, run: () => active.promise })
    scheduler.cancel()
    active.resolve(success("late"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onResult).not.toHaveBeenCalled()
  })

  it("cancellation releases an authoritative final even when its provider resolves late", async () => {
    const final = deferred()
    const scheduler = new PolishScheduler(mock(() => {}))
    const formatting = scheduler.formatFinal({ revision: 1, run: () => final.promise })
    scheduler.cancel()

    await expect(formatting).resolves.toEqual({ status: "canceled" })
    final.resolve(success("late"))
  })

  it("cancels live work and runs the authoritative final exactly once", async () => {
    const active = deferred()
    const onResult = mock(() => {})
    const finalRun = mock(async () => success("final"))
    const scheduler = new PolishScheduler(onResult)
    scheduler.scheduleLive({ revision: 1, run: () => active.promise })
    const outcome = await scheduler.formatFinal({ revision: 2, run: finalRun })
    active.resolve(success("late"))
    await Promise.resolve()
    expect(outcome).toEqual(success("final"))
    expect(finalRun).toHaveBeenCalledTimes(1)
    expect(onResult).not.toHaveBeenCalled()
  })
})
