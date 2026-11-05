import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadT3Config, t3Install } from "./config"
import { createT3Connector, type T3Connector } from "./connector"
import { Hibernation } from "./hibernation"
import { until } from "./t3.test-support"
import { createWaker } from "./waker"

const UNIT = "threa-t3-demo.service"

function recordingSystemctl() {
  const calls: string[][] = []
  return { calls, systemctl: (args: string[]) => void calls.push(args) }
}

/** A Threa that answers a session create with `link`, or refuses it as archived when `link` is undefined. */
function fakeThrea(link: () => Record<string, unknown> | undefined) {
  return Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      if (request.method === "POST" && url.pathname.endsWith("/bot-runtime/sessions")) {
        const data = link()
        return data
          ? Response.json({ data })
          : Response.json(
              { code: "SCRATCHPAD_ARCHIVED", error: "The linked scratchpad is archived; unarchive it to reattach" },
              { status: 409 }
            )
      }
      return Response.json({ error: "not faked" }, { status: 404 })
    },
  })
}

const running: Array<{ connector: T3Connector; server: ReturnType<typeof Bun.serve> }> = []
afterEach(async () => {
  for (const { connector, server } of running.splice(0)) {
    await connector.shutdown()
    server.stop(true)
  }
})

function startConnector(options: { unit?: string; link: () => Record<string, unknown> | undefined }) {
  const home = mkdtempSync(join(tmpdir(), "t3hib-"))
  const install = t3Install(home)
  mkdirSync(install.workDir, { recursive: true })
  const server = fakeThrea(options.link)
  const loaded = loadT3Config({
    env: {
      THREA_WORKSPACE_ID: "ws_test",
      THREA_API_KEY: "threa_bk_test",
      THREA_BASE_URL: `http://127.0.0.1:${server.port}`,
      THREA_COLD_START_IF_ARCHIVED: "wait",
      ...(options.unit ? { THREA_T3CODE_UNIT: options.unit } : {}),
    },
    cwd: install.workDir,
    hostname: "host",
    install,
  })
  if ("error" in loaded) throw new Error(loaded.error)
  writeFileSync(
    install.tokenPath,
    JSON.stringify({ accessToken: "t3", access: "full-access", url: loaded.config.t3.url })
  )
  const dir = join(home, "hibernating")
  const { calls, systemctl } = recordingSystemctl()
  const hibernation = new Hibernation(dir, systemctl)
  const logs: string[] = []
  const connector = createT3Connector(loaded.config, {
    hibernation,
    fetch: async () => new Response("", { status: 503 }),
    log: (message) => logs.push(message),
  })
  running.push({ connector, server })
  return { connector, hibernation, calls, logs, dir, runtimeSessionId: loaded.config.runtimeSessionId }
}

describe("a connector run as a unit", () => {
  test("hibernates when its scratchpad is already archived at start, keeping the root an earlier hibernation knew", async () => {
    const { connector, hibernation, calls, runtimeSessionId } = startConnector({ unit: UNIT, link: () => undefined })
    hibernation.sleep({ unit: UNIT, runtimeSessionId, rootStreamId: "stream_root" })
    calls.length = 0

    await connector.start()
    await until(() => calls.length > 1)

    expect({ records: hibernation.list(), calls }).toEqual({
      records: [{ unit: UNIT, runtimeSessionId, rootStreamId: "stream_root" }],
      calls: [
        ["disable", UNIT],
        ["stop", "--no-block", UNIT],
      ],
    })
  })

  test("enables its unit again and drops the record once it links", async () => {
    const { connector, hibernation, calls, runtimeSessionId } = startConnector({
      unit: UNIT,
      link: () => ({
        linkId: "brsl_1",
        rootStreamId: "stream_root",
        activeStreamId: "stream_root",
        runtimeSessionId: "ignored",
        streamUrlPath: "/w/ws_test/s/stream_root",
      }),
    })
    hibernation.sleep({ unit: UNIT, runtimeSessionId, rootStreamId: "stream_root" })
    calls.length = 0

    await connector.start()

    expect({ records: hibernation.list(), calls }).toEqual({ records: [], calls: [["enable", UNIT]] })
  })

  test("without a unit, an archived scratchpad at start touches no systemd state", async () => {
    const { connector, hibernation, calls, logs } = startConnector({ link: () => undefined })

    await connector.start()

    expect({
      records: hibernation.list(),
      calls,
      refused: logs.some((line) => line.includes("SCRATCHPAD_ARCHIVED")),
    }).toEqual({
      records: [],
      calls: [],
      refused: true,
    })
  })
})

describe("createWaker", () => {
  function setup(archived: Record<string, boolean | Error>) {
    const dir = mkdtempSync(join(tmpdir(), "t3wake-"))
    const hibernation = new Hibernation(dir, () => {})
    hibernation.sleep({ unit: "threa-t3-a.service", runtimeSessionId: "t3s_a", rootStreamId: "stream_a" })
    hibernation.sleep({ unit: "threa-t3-b.service", runtimeSessionId: "t3s_b", rootStreamId: "stream_b" })
    hibernation.sleep({ unit: "threa-t3-c.service", runtimeSessionId: "t3s_c" })
    hibernation.sleep({ unit: "threa-t3-d.service", runtimeSessionId: "t3s_d", rootStreamId: "stream_d" })
    writeFileSync(join(dir, "notes.txt"), "not a record")
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
