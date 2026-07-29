import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BackfillOutcome } from "./backfill"
import { defaultStartupReconciliationDeps, startupReconciliation } from "./commands"
import { resumeActiveLockPath } from "./lock"

let root: string
const previousIdentities = process.env.THREA_HARNESSD_IDENTITIES_DIR
const previousLinks = process.env.THREA_HARNESS_LINKS_DIR
const previousInventory = process.env.THREA_HARNESSD_INVENTORY

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnessd-startup-"))
  process.env.THREA_HARNESSD_IDENTITIES_DIR = join(root, "identities")
  process.env.THREA_HARNESS_LINKS_DIR = join(root, "links")
  process.env.THREA_HARNESSD_INVENTORY = join(root, "inventory.sqlite")
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  restore("THREA_HARNESSD_IDENTITIES_DIR", previousIdentities)
  restore("THREA_HARNESS_LINKS_DIR", previousLinks)
  restore("THREA_HARNESSD_INVENTORY", previousInventory)
})

const recorded: BackfillOutcome[] = [{ subject: "/repo/a", disposition: "recorded" }]

test("startupReconciliation backfills before the first revive sweep", async () => {
  const calls: string[] = []

  await startupReconciliation({
    backfill: () => {
      calls.push("backfill")
      return recorded
    },
    lock: async () => () => {},
    sweep: () => {
      calls.push("sweep")
    },
    log: (message) => calls.push(`log:${message}`),
  })

  expect(calls).toEqual(["backfill", "log:harnessd: identity backfill: 1 subject(s), 1 recorded", "sweep"])
})

test("a failing backfill logs and does not abort the startup pass", async () => {
  const calls: string[] = []

  await startupReconciliation({
    backfill: () => {
      throw new Error("inventory unreadable")
    },
    lock: async () => () => {},
    sweep: () => {
      calls.push("sweep")
    },
    log: (message) => calls.push(`log:${message}`),
  })

  expect(calls).toEqual(["log:harnessd: identity backfill failed: inventory unreadable", "sweep"])
})

test("a lock the startup pass cannot take is logged, and the sweep still runs", async () => {
  // acquireProcessLock spins to a 10-minute deadline and throws when the holder
  // is alive. Letting that escape exited the process, launchd restarted it, and
  // it took the lock again — a crash loop with no transports and no reap.
  const swept: string[] = []
  const logged: string[] = []

  await startupReconciliation({
    backfill: () => [],
    lock: async () => {
      throw new Error("lock /tmp/resume-active.lock held by pid 4242 for over 600s")
    },
    sweep: () => void swept.push("sweep"),
    log: (message) => void logged.push(message),
  })

  expect(swept).toEqual(["sweep"])
  expect(logged.join("\n")).toContain("held by pid 4242")
})

test("a dry-run startup pass does not take the lock the live daemon holds", async () => {
  // `resumeActive` and `reapArchived` both skip the lock for a dry run. A
  // preview that takes it blocks the live daemon's revive and reap for its
  // duration — and if the daemon holds it, the preview hangs ten minutes and
  // then exits instead of printing a preview.
  const path = resumeActiveLockPath()
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, String(process.pid))

  const release = await defaultStartupReconciliationDeps(() => {}, true).lock()
  release()

  expect(existsSync(path)).toBe(true)
  expect(readFileSync(path, "utf8")).toBe(String(process.pid))
})
