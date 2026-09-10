import { describe, expect, test } from "bun:test"
import type { ClaudeNativeSession } from "./claude-registry"
import { IDLE_SUSPEND_AFTER_MS, claudeIdleVerdict, idleSuspendEnabled, procChildren, suspendHeld } from "./idle"
import type { IdleProbeDeps } from "./idle"
import type { ManagedAgent } from "./types"

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0)

const session = (overrides: Partial<ClaudeNativeSession> = {}): ClaudeNativeSession => ({
  pid: 4242,
  sessionId: "11111111-2222-4333-8444-555555555555",
  cwd: "/repo/threa.feature",
  procStart: "900",
  status: "idle",
  statusUpdatedAt: NOW - IDLE_SUSPEND_AFTER_MS - 60_000,
  ...overrides,
})

const probe = (tree: Record<number, Array<[number, string]>> = {}): IdleProbeDeps => ({
  children: (pid) => (tree[pid] ?? []).map(([child]) => child),
  cmdline: (pid) =>
    Object.values(tree)
      .flat()
      .find(([child]) => child === pid)?.[1] ?? "",
  now: () => NOW,
})

const snapshotJob: [number, string] = [
  4300,
  "/bin/bash\0-c\0source /home/kris/.claude/shell-snapshots/snapshot-bash-1788988400771-npxotg.sh && bun run test",
]

describe("claudeIdleVerdict", () => {
  test("winds down a session that has been quiet past the threshold with nothing running", () => {
    const verdict = claudeIdleVerdict(
      session(),
      probe({ 4242: [[4299, "bun\0/repo/extensions/claude-code-remote/src/index.ts"]] })
    )

    expect(verdict).toEqual({ idle: true, idleForMs: IDLE_SUSPEND_AFTER_MS + 60_000 })
  })

  test("refuses on a busy runtime, a missing timestamp, a fresh turn, and a running Bash job", () => {
    expect({
      busy: claudeIdleVerdict(session({ status: "busy" }), probe()),
      untimed: claudeIdleVerdict(session({ statusUpdatedAt: undefined }), probe()),
      fresh: claudeIdleVerdict(session({ statusUpdatedAt: NOW - 3 * 60_000 }), probe()),
      working: claudeIdleVerdict(session(), probe({ 4242: [snapshotJob] })),
    }).toEqual({
      busy: { idle: false, reason: "runtime is busy" },
      untimed: { idle: false, reason: "runtime records no idle timestamp" },
      fresh: { idle: false, reason: "idle for 3m" },
      working: { idle: false, reason: "a Bash job is still running (pid 4300)" },
    })
  })
})

describe("procChildren", () => {
  test("reads the pids /proc lists and answers nothing for a process that is gone", () => {
    expect({
      live: procChildren(7, () => "11 12 13 \n"),
      gone: procChildren(7, () => {
        throw new Error("ENOENT")
      }),
      empty: procChildren(7, () => ""),
    }).toEqual({ live: [11, 12, 13], gone: [], empty: [] })
  })
})

describe("suspendHeld", () => {
  const agent = (suspendHoldUntil?: string) => ({ suspendHoldUntil }) as ManagedAgent

  test("holds only for a future instant it can parse", () => {
    expect({
      none: suspendHeld(agent(), NOW),
      future: suspendHeld(agent(new Date(NOW + 60_000).toISOString()), NOW),
      past: suspendHeld(agent(new Date(NOW - 60_000).toISOString()), NOW),
      garbage: suspendHeld(agent("whenever"), NOW),
    }).toEqual({ none: false, future: true, past: false, garbage: false })
  })
})

describe("idleSuspendEnabled", () => {
  test("is on unless the env says otherwise", () => {
    expect({
      unset: idleSuspendEnabled({}),
      blank: idleSuspendEnabled({ THREA_HARNESSD_IDLE_SUSPEND: "" }),
      off: idleSuspendEnabled({ THREA_HARNESSD_IDLE_SUSPEND: "0" }),
      spelled: idleSuspendEnabled({ THREA_HARNESSD_IDLE_SUSPEND: " Off " }),
      on: idleSuspendEnabled({ THREA_HARNESSD_IDLE_SUSPEND: "1" }),
    }).toEqual({ unset: true, blank: true, off: false, spelled: false, on: true })
  })
})
