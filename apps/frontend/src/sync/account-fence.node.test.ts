import { afterEach, describe, expect, it } from "vitest"
import { setAssertedAccount } from "@/api/account-assertion"
import { retireAccountWork, runAccountOwnedWork } from "./account-fence"

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("account fence", () => {
  afterEach(() => setAssertedAccount(null))

  it("should let work finish under its own account before the switch continues", async () => {
    const request = deferred<void>()
    const steps: string[] = []

    const work = runAccountOwnedWork(async (fence) => {
      await request.promise
      steps.push(fence.isRetired() ? "retired" : "own account")
    })

    const retire = retireAccountWork(1000).then(() => steps.push("switch continued"))
    request.resolve()
    await work
    await retire

    // The unit was told to stop, but the switch waited for it to settle, so its
    // last step still ran while its own credential and database were active.
    expect(steps).toEqual(["retired", "switch continued"])
  })

  it("should stop waiting for work that outruns the budget", async () => {
    const stuck = deferred<void>()
    const work = runAccountOwnedWork(() => stuck.promise)

    const startedAt = Date.now()
    await retireAccountWork(20)
    const waited = Date.now() - startedAt

    expect(waited).toBeLessThan(1000)
    stuck.resolve()
    await work
  })

  it("should not retire work started after the switch", async () => {
    await retireAccountWork(10)

    const verdicts = await runAccountOwnedWork(async (fence) => {
      await Promise.resolve()
      return fence.isRetired()
    })

    expect(verdicts).toBe(false)
  })

  it("should return immediately when the outgoing account had nothing in flight", async () => {
    const startedAt = Date.now()
    await retireAccountWork(5000)
    expect(Date.now() - startedAt).toBeLessThan(1000)
  })

  it("should retire captured work when identity moves without a switch", async () => {
    // Another tab switched and this one adopted it, or a revalidation found the
    // cookie on a different account. Neither calls `retireAccountWork`, and the
    // send that was already composed must not go out under the replacement.
    setAssertedAccount("workos_a")
    const request = deferred<void>()
    const verdicts: boolean[] = []

    const work = runAccountOwnedWork(async (fence) => {
      verdicts.push(fence.isRetired())
      await request.promise
      verdicts.push(fence.isRetired())
    })

    // Synchronous with the identity publication, as AuthProvider does it.
    setAssertedAccount("workos_b")
    request.resolve()
    await work

    expect(verdicts).toEqual([false, true])
  })

  it("should keep old work retired after a cross-tab account round trip", async () => {
    setAssertedAccount("workos_a")
    const request = deferred<void>()
    const work = runAccountOwnedWork(async (fence) => {
      await request.promise
      return fence.isRetired()
    })

    setAssertedAccount("workos_b")
    setAssertedAccount("workos_a")
    request.resolve()

    await expect(work).resolves.toBe(true)
  })

  it("should keep work owned by an account that is still active", async () => {
    setAssertedAccount("workos_a")
    const request = deferred<void>()
    const verdicts: boolean[] = []

    const work = runAccountOwnedWork(async (fence) => {
      await request.promise
      verdicts.push(fence.isRetired())
    })

    // A revalidation that republishes the same account is not a change.
    setAssertedAccount("workos_a")
    request.resolve()
    await work

    expect(verdicts).toEqual([false])
  })

  it("should retire captured work when the session ends", async () => {
    setAssertedAccount("workos_a")
    const request = deferred<void>()

    const work = runAccountOwnedWork(async (fence) => {
      await request.promise
      return fence.isRetired()
    })

    setAssertedAccount(null)
    request.resolve()

    // Without an asserted account the request carries no assertion and the
    // cookie alone decides who it runs as — exactly what the fence prevents.
    await expect(work).resolves.toBe(true)
  })
})
