import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
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
