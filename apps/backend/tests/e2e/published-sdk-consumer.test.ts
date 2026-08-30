/**
 * The published bot-runtime packages, consumed from outside the repo.
 *
 * `@threahq/bot-runtime-client` and `@threahq/remote-session` are packed exactly as
 * they would be published, installed with npm into a temporary project that has
 * no path to this checkout, typechecked under `node16` resolution, and then the
 * shipped `echo-connector` example is run from that project against the test
 * server: link a scratchpad, answer a message with an interim and a final
 * reply, fold a `/steer` into the running turn, and `/stop` one. Everything the
 * README promises an external connector rides on this path.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { BotTraits, WORKSPACE_PERMISSION_SCOPES } from "@threa/types"
import {
  TestClient,
  createBot,
  createBotKey,
  createWorkspace,
  dispatchCommand,
  listEvents,
  listStreams,
  loginAs,
  sendMessage,
} from "../client"

setDefaultTimeout(300_000)

const repoRoot = resolve(import.meta.dir, "../../../..")
const packages = ["bot-runtime-client", "remote-session"] as const
const testRunId = Math.random().toString(36).substring(7)
// Longer than any claim → deliver → interim round trip, so a /steer or /stop
// dispatched after the interim lands always finds the turn still running.
const ECHO_DELAY_MS = 4_000

let consumerDir: string
let connector: ChildProcess | undefined
let connectorLog = ""
let edge: ReturnType<typeof Bun.serve> | undefined

/**
 * In production the edge worker answers `GET /api/workspaces/:id/config` with
 * the regional backend's socket URL and forwards `/api/v1/*` to it; the test
 * server is only the backend. Stand in for the edge so the connector takes the
 * same path it does live: socket first, HTTP as the fallback.
 */
function serveEdge(backendUrl: string) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && /^\/api\/workspaces\/[^/]+\/config$/.test(url.pathname)) {
        return Response.json({ wsUrl: backendUrl })
      }
      // Ask for an identity encoding: fetch decodes the upstream body but would
      // forward the `content-encoding` header, and the connector would then
      // try to decode plain bytes.
      const headers = new Headers(request.headers)
      headers.set("accept-encoding", "identity")
      return fetch(`${backendUrl}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      })
    },
  })
}

function run(cmd: string, args: string[], cwd: string): void {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} in ${cwd} failed:\n${result.stdout}\n${result.stderr}`)
  }
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${what}\nconnector log:\n${connectorLog}`)
}

beforeAll(() => {
  // Pack from the in-repo sources exactly as a release would.
  for (const name of packages) {
    const dir = join(repoRoot, "extensions", name)
    run("bun", ["install"], dir)
    run("bun", ["run", "pack"], dir)
  }
  consumerDir = mkdtempSync(join(tmpdir(), "threa-sdk-consumer-"))
  const dependencies: Record<string, string> = {}
  for (const name of packages) {
    const dir = join(repoRoot, "extensions", name)
    const tarball = readdirSync(dir).find((file) => file.endsWith(".tgz"))
    if (!tarball) throw new Error(`no tarball packed for ${name}`)
    cpSync(join(dir, tarball), join(consumerDir, tarball))
    dependencies[`@threahq/${name}`] = `file:./${tarball}`
  }
  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify(
      {
        name: "threa-sdk-consumer",
        private: true,
        type: "module",
        dependencies,
        devDependencies: { typescript: "^5.9", "@types/node": "^24" },
      },
      null,
      2
    )
  )
  run("npm", ["install", "--no-audit", "--no-fund", "--silent"], consumerDir)
  // The examples come out of the installed package, not the repo: the README
  // links to them, so they have to be in the tarball.
  for (const example of ["echo-connector.ts", "mention-bot.ts"]) {
    cpSync(join(consumerDir, "node_modules/@threahq/remote-session/examples", example), join(consumerDir, example))
  }
})

afterAll(async () => {
  edge?.stop(true)
  if (connector && connector.exitCode === null) {
    connector.kill("SIGTERM")
    await new Promise((resolve) => connector!.once("exit", resolve))
  }
  if (consumerDir) rmSync(consumerDir, { recursive: true, force: true })
})

describe("published bot-runtime packages", () => {
  test("the shipped declarations resolve for a Node consumer", () => {
    writeFileSync(
      join(consumerDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "node16",
          moduleResolution: "node16",
          target: "ES2022",
          lib: ["ES2022"],
          types: ["node"],
          allowImportingTsExtensions: true,
        },
        files: ["echo-connector.ts", "mention-bot.ts", "probe.ts"],
      })
    )
    // A deliberate type error proves the declarations were read, not skipped.
    writeFileSync(
      join(consumerDir, "probe.ts"),
      [
        'import type { BotRuntimeHello } from "@threahq/bot-runtime-client"',
        'import type { ClaimedInvocation, RemoteSessionDelegate } from "@threahq/remote-session"',
        "export const delegate: RemoteSessionDelegate = { deliverTurn: async (turn) => void (turn.invocationId satisfies string) }",
        'export const hello: BotRuntimeHello = { instanceId: "x", runtimeKind: "custom", supportedCapabilities: ["mentionable"] }',
        "export const claimed: ClaimedInvocation | null = null",
        "// @ts-expect-error a status outside the runtime statuses is rejected",
        'export const rejected: BotRuntimeHello = { ...hello, status: "nope" }',
        "",
      ].join("\n")
    )
    run(join(consumerDir, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], consumerDir)
  })

  test("the echo connector links a scratchpad and serves a turn, a /steer, and a /stop", async () => {
    const client = new TestClient()
    await loginAs(client, `sdk-consumer-${testRunId}@test.com`, "SDK Consumer")
    const workspace = await createWorkspace(client, `SDK Consumer WS ${testRunId}`)
    const bot = await createBot(client, workspace.id, {
      type: "personal",
      name: `Echo ${testRunId}`,
      slug: `echo-${testRunId}`,
      traits: [BotTraits.ACTIVE_SCRATCHPAD, BotTraits.MENTIONABLE],
    })
    const apiKey = await createBotKey(client, workspace.id, bot.id, [
      WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE,
      WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE,
      WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE,
      WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ,
      WORKSPACE_PERMISSION_SCOPES.STREAMS_READ,
      WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_READ,
    ])

    edge = serveEdge(process.env.TEST_BASE_URL!)
    connector = spawn(process.execPath, ["echo-connector.ts"], {
      cwd: consumerDir,
      env: {
        ...process.env,
        THREA_BASE_URL: edge.url.origin,
        THREA_WORKSPACE_ID: workspace.id,
        THREA_API_KEY: apiKey,
        THREA_RUNTIME_KIND: "claude-code-channel",
        THREA_BIK_PATH: join(consumerDir, "bik.json"),
        ECHO_DELAY_MS: String(ECHO_DELAY_MS),
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    connector.stdout!.on("data", (chunk) => (connectorLog += chunk))
    connector.stderr!.on("data", (chunk) => (connectorLog += chunk))

    // The example prints the linked scratchpad URL from `onLinked`; that stream
    // must also be one the owner can list.
    const streamId = await waitFor("the linked scratchpad", async () => connectorLog.match(/\/s\/(stream_\w+)/)?.[1])
    const scratchpad = await waitFor("the scratchpad in the owner's list", async () =>
      (await listStreams(client, workspace.id)).find((stream) => stream.id === streamId)
    )
    expect(scratchpad.displayName).toEndWith(` - ${basename(consumerDir)}`)

    // The SDK stamps every message it posts, so count by metadata rather than
    // text: an echo reply embeds the scratchpad history, which would otherwise
    // re-match earlier interims and acks.
    interface Posted {
      contentMarkdown?: string
      metadata?: Record<string, string>
    }
    const posted = async (): Promise<Posted[]> =>
      (await listEvents(client, workspace.id, streamId)).map((event) => event.payload as Posted)
    const interims = (all: Posted[]) => all.filter((p) => p.metadata?.["remote.interim"] === "true")
    const replies = (all: Posted[]) =>
      all.filter((p) => p.metadata?.["remote.instanceId"] && !p.metadata?.["remote.sessionControl"])
    const acks = (all: Posted[]) => all.filter((p) => p.metadata?.["remote.sessionControl"] === "true")
    const whenCount = (what: string, select: (all: Posted[]) => Posted[], times: number) =>
      waitFor(`${times} ${what}`, async () => {
        const all = await posted()
        return select(all).length >= times ? all : undefined
      })

    await sendMessage(client, workspace.id, streamId, "hello there")
    const afterFirst = await whenCount("replies", replies, 1)
    expect(replies(afterFirst)[0]!.contentMarkdown).toStartWith("Echo: hello there")
    expect(interims(afterFirst).map((p) => p.contentMarkdown)).toEqual(["Working on it."])

    await sendMessage(client, workspace.id, streamId, "second")
    await whenCount("interims", interims, 2)
    await dispatchCommand(client, workspace.id, streamId, "/steer and more")
    const afterSteer = await whenCount("replies", replies, 2)
    const steered = replies(afterSteer)[1]!.contentMarkdown ?? ""
    expect(steered).toStartWith("Echo: second")
    expect(steered).toEndWith("and more")

    await sendMessage(client, workspace.id, streamId, "third")
    await whenCount("interims", interims, 3)
    await dispatchCommand(client, workspace.id, streamId, "/stop")
    const afterStop = await whenCount("session-control acks", acks, 1)
    expect(acks(afterStop)[0]!.contentMarkdown).toBe("Stopped the current turn.")
    // The stopped turn had already posted an interim, so it closes silently:
    // no echo, and no "Stopped by /stop." note either.
    await new Promise((resolve) => setTimeout(resolve, ECHO_DELAY_MS + 1_000))
    const final = await posted()
    expect(replies(final)).toHaveLength(2)
    expect(final.some((p) => p.contentMarkdown?.includes("Stopped by /stop."))).toBe(false)

    connector.kill("SIGTERM")
    const exitCode = await new Promise<number | null>((resolve) => connector!.once("exit", resolve))
    expect(exitCode).toBe(0)
    expect(connectorLog).toContain("shutting down (SIGTERM)")
  })
})
