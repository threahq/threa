import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadT3Config, t3Install } from "./config"
import { createT3Connector, type T3Connector } from "./connector"
import { Hibernation } from "./hibernation"
import { until } from "./t3.test-support"

const UNIT = "threa-t3-demo.service"

const quietHibernation = (dir: string) =>
  new Hibernation(
    dir,
    () => {},
    () => {}
  )

function recordingSystemctl() {
  const calls: string[][] = []
  return { calls, systemctl: (args: string[]) => void calls.push(args) }
}

/**
 * A Threa that answers a session create with `link`, or refuses it as archived when `link` is undefined, and reports
 * every stream archived once `archived()` says so.
 */
function fakeThrea(link: () => Record<string, unknown> | undefined, archived: () => boolean, creates: unknown[]) {
  return Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.method === "GET" && /\/streams\/[^/]+$/.test(url.pathname)) {
        return Response.json({
          data: { archivedAt: archived() ? "2026-01-01T00:00:00.000Z" : null, e2eEnabled: false },
        })
      }
      if (request.method === "POST" && url.pathname.endsWith("/bot-runtime/sessions")) {
        creates.push(await request.json())
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

function startConnector(options: {
  unit?: string
  link: () => Record<string, unknown> | undefined
  archived?: () => boolean
  /** The root an earlier hibernation of this unit recorded. */
  hibernatedRoot?: string
}) {
  const home = mkdtempSync(join(tmpdir(), "t3hib-"))
  const install = t3Install(home)
  mkdirSync(install.workDir, { recursive: true })
  const creates: Array<Record<string, unknown>> = []
  const server = fakeThrea(options.link, options.archived ?? (() => false), creates)
  const loaded = loadT3Config({
    env: {
      THREA_WORKSPACE_ID: "ws_test",
      THREA_API_KEY: "threa_bk_test",
      THREA_BASE_URL: `http://127.0.0.1:${server.port}`,
      THREA_POLL_MS: "1000",
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
  if (options.hibernatedRoot) {
    quietHibernation(dir).hibernate({
      unit: UNIT,
      runtimeSessionId: loaded.config.runtimeSessionId,
      rootStreamId: options.hibernatedRoot,
    })
  }
  const hibernation = new Hibernation(dir, systemctl, () => {})
  const logs: string[] = []
  const connector = createT3Connector(loaded.config, {
    hibernation,
    archiveGraceMs: 200,
    fetch: async () => new Response("", { status: 503 }),
    log: (message) => logs.push(message),
  })
  running.push({ connector, server })
  return { connector, hibernation, calls, logs, creates, runtimeSessionId: loaded.config.runtimeSessionId }
}

describe("a connector run as a unit", () => {
  test("hibernates when its scratchpad is already archived at start, keeping the root an earlier hibernation knew", async () => {
    const { connector, hibernation, calls, runtimeSessionId } = startConnector({
      unit: UNIT,
      link: () => undefined,
      hibernatedRoot: "stream_root",
    })

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

  test("woken, it links only the scratchpad it hibernated on, then enables its unit and drops the record", async () => {
    const { connector, hibernation, calls, creates } = startConnector({
      unit: UNIT,
      hibernatedRoot: "stream_root",
      link: () => ({
        linkId: "brsl_1",
        rootStreamId: "stream_root",
        activeStreamId: "stream_root",
        runtimeSessionId: "ignored",
        streamUrlPath: "/w/ws_test/s/stream_root",
      }),
    })

    await connector.start()

    expect({
      records: hibernation.list(),
      calls,
      link: { ifArchived: creates[0]?.ifArchived, ifMissing: creates[0]?.ifMissing },
    }).toEqual({ records: [], calls: [["enable", UNIT]], link: { ifArchived: "wait", ifMissing: "error" } })
  })

  test("archived while linked, it hibernates on the linked root once the grace runs out", async () => {
    let archived = false
    const { connector, hibernation, calls, runtimeSessionId } = startConnector({
      unit: UNIT,
      archived: () => archived,
      link: () =>
        archived
          ? undefined
          : {
              linkId: "brsl_1",
              rootStreamId: "stream_live",
              activeStreamId: "stream_live",
              runtimeSessionId: "ignored",
              streamUrlPath: "/w/ws_test/s/stream_live",
            },
    })

    await connector.start()
    archived = true
    await until(() => calls.length > 1)

    expect({ records: hibernation.list(), calls }).toEqual({
      records: [{ unit: UNIT, runtimeSessionId, rootStreamId: "stream_live" }],
      calls: [
        ["disable", UNIT],
        ["stop", "--no-block", UNIT],
      ],
    })
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
