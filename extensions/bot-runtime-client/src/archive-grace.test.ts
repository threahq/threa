import { describe, expect, test } from "bun:test"
import { ArchiveGraceController, type ArchiveGraceHooks } from "./archive-grace"

interface Recorded {
  detached: string[]
  reattached: string[]
  woundDown: string[]
  logs: string[]
}

function makeController(
  overrides: Partial<ArchiveGraceHooks> = {},
  graceMs = 200
): { controller: ArchiveGraceController; recorded: Recorded } {
  const recorded: Recorded = { detached: [], reattached: [], woundDown: [], logs: [] }
  const controller = new ArchiveGraceController(
    {
      isArchived: async () => false,
      reattach: async () => false,
      onDetached: (rootStreamId) => void recorded.detached.push(rootStreamId),
      onReattached: (rootStreamId) => void recorded.reattached.push(rootStreamId),
      onWindDown: (rootStreamId) => void recorded.woundDown.push(rootStreamId),
      log: (message) => void recorded.logs.push(message),
      ...overrides,
    },
    { graceMs }
  )
  return { controller, recorded }
}

describe("ArchiveGraceController", () => {
  test("an archive detaches, holds the grace, then winds down", async () => {
    const { controller, recorded } = makeController({}, 120)

    await controller.archived("stream_root")
    expect({ detached: recorded.detached, woundDown: recorded.woundDown, isDetached: controller.detached }).toEqual({
      detached: ["stream_root"],
      woundDown: [],
      isDetached: true,
    })

    await Bun.sleep(220)
    expect({ woundDown: recorded.woundDown, isDetached: controller.detached }).toEqual({
      woundDown: ["stream_root"],
      isDetached: false,
    })
  })

  test("an unarchive inside the grace reattaches and cancels the wind-down", async () => {
    const { controller, recorded } = makeController({ reattach: async () => true }, 200)

    await controller.archived("stream_root")
    await controller.restored()

    expect({ reattached: recorded.reattached, isDetached: controller.detached }).toEqual({
      reattached: ["stream_root"],
      isDetached: false,
    })
    await Bun.sleep(260)
    expect(recorded.woundDown).toEqual([])
  })

  test("a reattach resolving after the wind-down already ran does not resurrect the session", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { controller, recorded } = makeController(
      {
        reattach: async () => {
          await gate
          return true
        },
      },
      100
    )

    await controller.archived("stream_root")
    const restoring = controller.restored()
    await Bun.sleep(200)
    expect(recorded.woundDown).toEqual(["stream_root"])

    release()
    await restoring

    // The wind-down is terminal: the late success must not re-attach a session
    // whose worktree is already gone.
    expect({ reattached: recorded.reattached, isDetached: controller.detached }).toEqual({
      reattached: [],
      isDetached: false,
    })
  })

  test("a restore push restarts the grace even when the relink fails", async () => {
    let attempts = 0
    const { controller, recorded } = makeController(
      {
        reattach: async () => {
          attempts += 1
          throw new Error("threa unreachable")
        },
      },
      160
    )

    await controller.archived("stream_root")
    await Bun.sleep(120)
    // Unarchived with the original grace nearly spent: winding down a second
    // later is exactly the mis-click recovery this window exists for.
    await controller.restored()
    await Bun.sleep(100)

    expect({ woundDown: recorded.woundDown, isDetached: controller.detached, attempts }).toEqual({
      woundDown: [],
      isDetached: true,
      attempts: 1,
    })
    controller.stop()
  })

  test("a reattach that throws keeps the session detached so the probe retries", async () => {
    const { controller, recorded } = makeController(
      {
        reattach: async () => {
          throw new Error("threa unreachable")
        },
      },
      10_000
    )

    await controller.archived("stream_root")
    await controller.restored()

    expect({ isDetached: controller.detached, reattached: recorded.reattached }).toEqual({
      isDetached: true,
      reattached: [],
    })
    controller.stop()
  })

  test("the probe detaches on server truth but never on an inconclusive answer", async () => {
    for (const [answer, shouldDetach] of [
      [true, true],
      [false, false],
      [undefined, false],
    ] as const) {
      const { controller } = makeController({ isArchived: async () => answer }, 10_000)
      await controller.probe("stream_root")
      expect(controller.detached).toBe(shouldDetach)
      controller.stop()
    }
  })

  test("a probe whose isArchived throws never detaches", async () => {
    const { controller, recorded } = makeController(
      {
        isArchived: async () => {
          throw new Error("threa unreachable")
        },
      },
      10_000
    )

    await controller.probe("stream_root")

    expect(controller.detached).toBe(false)
    expect(recorded.logs.some((line) => line.includes("archive probe failed"))).toBe(true)
    controller.stop()
  })

  test("while detached the probe drives reattach, not a second detach", async () => {
    const calls: string[] = []
    const { controller } = makeController(
      {
        isArchived: async () => {
          calls.push("isArchived")
          return true
        },
        reattach: async () => {
          calls.push("reattach")
          return false
        },
      },
      10_000
    )

    await controller.archived("stream_root")
    await controller.probe("stream_root")

    expect(calls).toEqual(["reattach"])
    expect(controller.detached).toBe(true)
    controller.stop()
  })

  test("concurrent probes do not overlap, and stop() disarms an armed deadline", async () => {
    let inFlight = 0
    let overlapped = false
    const { controller, recorded } = makeController(
      {
        isArchived: async () => {
          inFlight += 1
          if (inFlight > 1) overlapped = true
          await Bun.sleep(20)
          inFlight -= 1
          return true
        },
      },
      80
    )

    await Promise.all([controller.probe("stream_root"), controller.probe("stream_root")])
    expect(overlapped).toBe(false)
    expect(controller.detached).toBe(true)

    controller.stop()
    await Bun.sleep(150)
    expect(recorded.woundDown).toEqual([])
  })

  test("the probe cadence always fits several probes inside the grace", () => {
    const { controller } = makeController({}, 200)
    expect(controller.probeDelayMs).toBe(50)
    const { controller: production } = makeController({}, 5 * 60 * 1000)
    expect(production.probeDelayMs).toBe(45_000)
  })
})
