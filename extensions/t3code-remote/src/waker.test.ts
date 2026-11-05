import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hibernation } from "./hibernation"
import { createWaker } from "./waker"

describe("createWaker", () => {
  function setup(archived: Record<string, boolean | Error>) {
    const dir = mkdtempSync(join(tmpdir(), "t3wake-"))
    const hibernation = new Hibernation(
      dir,
      () => {},
      () => {}
    )
    hibernation.hibernate({ unit: "threa-t3-a.service", runtimeSessionId: "t3s_a", rootStreamId: "stream_a" })
    hibernation.hibernate({ unit: "threa-t3-b.service", runtimeSessionId: "t3s_b", rootStreamId: "stream_b" })
    hibernation.hibernate({ unit: "threa-t3-c.service", runtimeSessionId: "t3s_c" })
    hibernation.hibernate({ unit: "threa-t3-d.service", runtimeSessionId: "t3s_d", rootStreamId: "stream_d" })
    writeFileSync(join(dir, "notes.txt"), "not a record")
    writeFileSync(join(dir, "threa-t3-e.service.json"), '{"unit": "threa-t3-e.serv')
    const started: string[] = []
    const waker = createWaker({
      hibernating: () => hibernation.list(),
      isArchived: async (rootStreamId) => {
        const verdict = archived[rootStreamId]
        if (verdict instanceof Error) throw verdict
        return verdict ?? true
      },
      start: (unit) => void started.push(unit),
      log: () => {},
    })
    return { waker, started, dir }
  }

  test("a push starts only the unit of the session it names", () => {
    const { waker, started } = setup({})

    waker.nudge("t3s_c")
    waker.nudge("t3s_live")

    expect(started).toEqual(["threa-t3-c.service"])
  })

  test("a reconnect starts restored units, leaves archived and rootless ones, and survives a failed check", async () => {
    const { waker, started, dir } = setup({ stream_a: false, stream_b: true, stream_d: new Error("offline") })

    await waker.sweep()

    expect({ started, kept: existsSync(join(dir, "threa-t3-a.service.json")) }).toEqual({
      started: ["threa-t3-a.service"],
      kept: true,
    })
  })
})
