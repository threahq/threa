import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireProcessLock } from "./lock"

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), "harnessd-lock-")), "resume-active.lock")
}

describe("acquireProcessLock", () => {
  test("a second waiter does not delete the lock the first just took from a dead holder", async () => {
    // The interleaving that matters: 333 reads holder 111 and confirms it dead,
    // and 222 steals and takes the lock in that same window. An unconditional
    // unlink then removes 222's FRESH lock, leaving both convinced they hold
    // the mutex — which is how a manual `adopt` and an unattended `up` pass end
    // up launching the same session at once. Only a file still naming the dead
    // pid may be removed, so the staleness check has to re-read.
    const path = lockPath()
    writeFileSync(path, "111")

    let stolen = false
    const second = acquireProcessLock(path, {
      pid: 333,
      isAlive: (pid) => {
        if (pid === 111 && !stolen) {
          stolen = true
          writeFileSync(path, "222")
        }
        return pid !== 111
      },
      timeoutMs: 0,
      pollMs: 1,
    })

    await expect(second).rejects.toThrow("held by pid 222")
    expect(readFileSync(path, "utf8")).toBe("222")
  })

  test("a genuinely dead holder is still stolen", async () => {
    const path = lockPath()
    writeFileSync(path, "111")

    const release = await acquireProcessLock(path, { pid: 222, isAlive: () => false })
    expect(readFileSync(path, "utf8")).toBe("222")
    release()
  })

  test("release only removes a lock this pid still owns", async () => {
    const path = lockPath()
    const release = await acquireProcessLock(path, { pid: 222, isAlive: () => false })
    writeFileSync(path, "999")
    release()

    expect(readFileSync(path, "utf8")).toBe("999")
  })
})

const dir = mkdtempSync(join(tmpdir(), "harnessd-lock-race-"))

test("two waiters observing one dead holder cannot both take the lock", async () => {
  // The interleaving the old re-read did not prevent: both read the dead holder
  // and are authorised, the first unlinks and takes the lock, and the second's
  // already-authorised unlink deletes that fresh lock and takes its own.
  const path = join(dir, "contended.lock")
  writeFileSync(path, "111")
  const dead = (pid: number) => pid !== 111

  const first = await acquireProcessLock(path, { pid: 222, isAlive: dead, pollMs: 1, timeoutMs: 2_000 })

  // 333 arrives while 222 holds it. 222 is alive, so 333 must wait, not steal.
  let taken = false
  const second = acquireProcessLock(path, { pid: 333, isAlive: () => true, pollMs: 1, timeoutMs: 2_000 }).then(
    (release) => {
      taken = true
      return release
    }
  )
  await Bun.sleep(50)

  expect(taken).toBe(false)
  expect(readFileSync(path, "utf8")).toBe("222")

  first()
  ;(await second)()
  expect(existsSync(path)).toBe(false)
})

test("a stealer that died mid-steal does not wedge every later waiter", async () => {
  const path = join(dir, "wedged.lock")
  writeFileSync(path, "111")
  writeFileSync(`${path}.steal`, "222")

  const release = await acquireProcessLock(path, {
    pid: 333,
    isAlive: (pid) => pid === 333,
    pollMs: 1,
    timeoutMs: 2_000,
  })

  expect(readFileSync(path, "utf8")).toBe("333")
  expect(existsSync(`${path}.steal`)).toBe(false)
  release()
})

test("only one waiter at a time may remove a dead holder's lock", async () => {
  // The serialisation itself: with another stealer live, a waiter that has
  // already seen the dead holder must NOT reach the unlink — otherwise its
  // authorisation outlives the state it was granted for and it deletes the lock
  // the first stealer has since taken.
  const path = join(dir, "serialised.lock")
  writeFileSync(path, "111")
  writeFileSync(`${path}.steal`, "222")

  await expect(
    acquireProcessLock(path, { pid: 333, isAlive: (pid) => pid !== 111, pollMs: 1, timeoutMs: 150 })
  ).rejects.toThrow(/held by pid 111/)

  expect(readFileSync(path, "utf8")).toBe("111")
  expect(readFileSync(`${path}.steal`, "utf8")).toBe("222")
})
