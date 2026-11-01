// Proves a T3 Code release works with this connector before it joins TESTED_T3_VERSIONS: downloads the release, boots
// it on an empty T3 home, and drives the connector's own client through every T3 tool it calls except answering a
// pending question, which needs a provider to ask one. Runs short agent turns on the machine's provider credentials,
// so it is a local check, not a CI one.
//
// Usage (from extensions/t3code-remote): bun run compat <version> [--model instance::model]
import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { T3Auth } from "../src/auth"
import { thinkingLevels } from "../src/session-control"
import { TESTED_T3_VERSIONS, T3Client, T3ToolError, type ModelSelection } from "../src/t3-client"

const RELEASES = "https://github.com/pingdotgg/t3code/releases/download"
const TURN_TIMEOUT_MS = 180_000
const UNSETTLED = new Set(["preparing", "queued", "starting", "running"])
// A 1x1 transparent PNG.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
)

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { model: { type: "string", default: "claudeAgent::claude-haiku-5-5" } },
})
const [version] = positionals
if (!version) fail("usage: bun run compat <version> [--model instance::model]")
const [instanceId, model] = values.model.split("::")
if (!instanceId || !model) fail("--model takes instance::model, e.g. claudeAgent::claude-haiku-5-5")
const turnModel: ModelSelection = { instanceId, model }

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) fail(`GET ${url} answered ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env })
    let out = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (out += chunk))
    child.on("error", reject)
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} exited ${code}: ${out}`))))
  })
}

/** The release's `t3` binary, downloaded once per version and checked against the release's SHA256SUMS. */
async function installRelease(version: string): Promise<string> {
  const target = `${process.platform}-${process.arch}`
  const dir = join(homedir(), ".cache", "threa-t3code-compat", version)
  const binPath = join(`t3-${version}-${target}`, "t3")
  const bin = join(dir, binPath)
  if (existsSync(bin)) return bin
  const asset = `t3-${version}-${target}.tar.gz`
  const sums = new TextDecoder().decode(await download(`${RELEASES}/v${version}/SHA256SUMS`))
  const expected = sums
    .split("\n")
    .find((line) => line.trim().endsWith(asset))
    ?.split(/\s+/)[0]
  if (!expected) fail(`v${version} publishes no ${asset}`)
  const archive = await download(`${RELEASES}/v${version}/${asset}`)
  const actual = createHash("sha256").update(archive).digest("hex")
  if (actual !== expected) fail(`${asset} checksum mismatch: expected ${expected}, got ${actual}`)
  // Extract beside the cache and rename into place, so an interrupted run never leaves a partial binary to reuse.
  const parent = join(dir, "..")
  mkdirSync(parent, { recursive: true })
  const staging = mkdtempSync(join(parent, `.${version}-`))
  try {
    writeFileSync(join(staging, asset), archive)
    await run("tar", ["-xzf", join(staging, asset), "-C", staging])
    if (!existsSync(join(staging, binPath))) throw new Error(`${asset} has no ${binPath}`)
    rmSync(join(staging, asset))
    renameSync(staging, dir)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return bin
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))
      )
    })
  })
}

function running(server: ChildProcess): boolean {
  return server.exitCode === null && server.signalCode === null
}

async function waitForServer(url: string, server: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (!running(server))
      throw new Error(`T3 exited (${server.exitCode ?? server.signalCode}) before listening:\n${output()}`)
    const listening = await fetch(url).then(
      () => true,
      () => false
    )
    if (listening) return
    await Bun.sleep(500)
  }
  throw new Error(`T3 did not listen within 60s:\n${output()}`)
}

async function mintPairingCode(bin: string, home: string, env: NodeJS.ProcessEnv): Promise<string> {
  const stdout = await run(bin, ["auth", "pairing", "create", "--base-dir", home, "--label", "compat", "--json"], env)
  return (JSON.parse(stdout) as { credential: string }).credential
}

const checks: Array<{ name: string; error?: string }> = []
async function check(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
    checks.push({ name })
  } catch (error) {
    checks.push({ name, error: error instanceof Error ? error.message : String(error) })
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function settle(client: T3Client, threadId: string, runId: string, expected = ["completed"]): Promise<void> {
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let current = runId
  while (Date.now() < deadline) {
    const waited = await client.call("t3_thread_wait", { threadId, runId: current, timeoutMs: 20_000 })
    if (waited.runId) current = waited.runId
    if (!waited.timedOut && !UNSETTLED.has(waited.status)) {
      assert(
        expected.includes(waited.status),
        `run ${current} ended ${waited.status}, expected ${expected.join(" or ")}`
      )
      return
    }
  }
  throw new Error(`run ${current} did not settle within ${TURN_TIMEOUT_MS / 1000}s`)
}

async function replied(client: T3Client, threadId: string, expected: string): Promise<void> {
  const { items } = await client.call("t3_thread_read", { threadId, limit: 20 })
  const replies = items.filter((item) => item.type === "assistant_message").map((item) => item.text ?? "")
  assert(
    replies.some((text) => text.includes(expected)),
    `no assistant reply containing "${expected}": ${JSON.stringify(replies)}`
  )
}

const bin = await installRelease(version)
const home = mkdtempSync(join(tmpdir(), "t3code-compat-"))
const port = await freePort()
const url = `http://127.0.0.1:${port}`
const env = { ...process.env, T3CODE_HOME: home }
const server = spawn(
  bin,
  ["--mode", "web", "--base-dir", home, "--host", "127.0.0.1", "--port", String(port), "--no-browser"],
  { env, detached: true, stdio: ["ignore", "pipe", "pipe"] }
)
let serverOutput = ""
const keepOutput = (chunk: Buffer) => (serverOutput = (serverOutput + chunk.toString()).slice(-4000))
server.stdout?.on("data", keepOutput)
server.stderr?.on("data", keepOutput)

try {
  await waitForServer(url, server, () => serverOutput)
  const auth = new T3Auth({
    url,
    access: "approval-required",
    tokenPath: join(home, "token.json"),
    autoLogin: true,
    mintCode: () => mintPairingCode(bin, home, env),
  })
  const client = new T3Client(url, auth, undefined, [version])

  await check("reports its version on connect", async () => {
    await client.call("t3_environment_read", {})
  })
  await check("lists thinking levels in the format /thinking reads", async () => {
    const { providers } = await client.call("orchestrator_capabilities", {})
    const offered = providers.flatMap((provider) =>
      provider.models.filter(
        (candidate) =>
          thinkingLevels(providers, { instanceId: provider.providerInstanceId, model: candidate.id }).length > 0
      )
    )
    assert(offered.length > 0, "no listed model offers thinking levels")
  })
  let threadId: string | undefined
  await check("launches a thread and finishes its turn", async () => {
    const launched = await client.call("t3_thread_launch", {
      title: "connector compat check",
      message: "Reply with exactly: COMPAT-ONE",
      runtimeMode: "approval-required",
      scratch: true,
      modelSelection: turnModel,
    })
    threadId = launched.threadId
    assert(launched.runId, "the launch started no run")
    await settle(client, threadId, launched.runId)
    await replied(client, threadId, "COMPAT-ONE")
  })
  await check("sends a follow-up turn to the thread", async () => {
    assert(threadId, "no thread to send to")
    const sent = await client.call("t3_thread_send", {
      threadId,
      message: "Reply with exactly: COMPAT-TWO",
      mode: "queue",
    })
    await settle(client, threadId, sent.runId)
    await replied(client, threadId, "COMPAT-TWO")
  })
  await check("uploads an image and sends it with a turn", async () => {
    assert(threadId, "no thread to send to")
    const upload = { type: "image" as const, name: "pixel.png", mimeType: "image/png", sizeBytes: PIXEL.length }
    const prepared = await client.call("t3_attachment_prepare_upload", { upload })
    await client.upload(prepared.relativeUrl, PIXEL)
    const sent = await client.call("t3_thread_send_attachments", {
      threadId,
      message: "Reply with exactly: COMPAT-THREE",
      attachments: [{ ...upload, id: prepared.attachmentId }],
    })
    await settle(client, threadId, sent.runId)
    await replied(client, threadId, "COMPAT-THREE")
  })
  await check("steers a running turn and interrupts it", async () => {
    assert(threadId, "no thread to steer")
    const started = await client.call("t3_thread_send", {
      threadId,
      message: "Count from 1 to 2000, one number per line.",
      mode: "queue",
    })
    const deadline = Date.now() + 60_000
    while ((await client.call("t3_thread_read", { threadId, limit: 1 })).thread.status !== "running") {
      assert(Date.now() < deadline, "the turn never started running")
      await Bun.sleep(250)
    }
    // The connector falls back to queueing on thread_not_sendable, so that refusal passes too.
    const steer = await client.call("t3_thread_send", { threadId, message: "Keep counting.", mode: "steer" }).then(
      (sent) => sent.delivery,
      (error) => (error instanceof T3ToolError ? error.code : String(error))
    )
    assert(steer === "steered" || steer === "thread_not_sendable", `steer answered ${steer}`)
    await client.call("t3_thread_interrupt", { threadId, runId: started.runId, reason: "compat check" })
    await settle(client, threadId, started.runId, ["interrupted", "cancelled"])
  })
  await check("reads and changes the thread's model", async () => {
    assert(threadId, "no thread to configure")
    const before = await client.call("t3_thread_configure", { threadId })
    assert(before.modelSelection.model === turnModel.model, `thread runs ${JSON.stringify(before.modelSelection)}`)
    await client.call("t3_thread_configure", { threadId, modelSelection: turnModel })
  })
  await check("lists pending questions", async () => {
    assert(threadId, "no thread to read")
    // Widened on purpose: an untested release may answer in another shape.
    const pending = (await client.call("t3_pending_request", { action: "list", threadId })) as { requestIds: unknown }
    assert(Array.isArray(pending.requestIds), `unexpected answer ${JSON.stringify(pending)}`)
  })
  await check("forks the thread", async () => {
    assert(threadId, "no thread to fork")
    const { targetThreadId } = await client.call("t3_thread_transfer", {
      action: "fork",
      threadId,
      sourcePoint: { type: "latest_stable" },
      title: "connector compat fork",
    })
    const { thread } = await client.call("t3_thread_read", { threadId: targetThreadId, limit: 1 })
    assert(thread.threadId === targetThreadId, `fork reads as ${thread.threadId}`)
    await client.call("t3_thread_organize", { threadId: targetThreadId, action: "archive" })
  })
  await check("archives the thread", async () => {
    assert(threadId, "no thread to archive")
    await client.call("t3_thread_organize", { threadId, action: "archive" })
  })
} finally {
  // The group is already gone when T3 exited on its own.
  if (server.pid && running(server)) process.kill(-server.pid, "SIGTERM")
  rmSync(home, { recursive: true, force: true })
}

for (const { name, error } of checks) console.log(error ? `FAIL ${name}: ${error}` : `ok   ${name}`)
if (checks.some((entry) => entry.error)) fail(`T3 Code ${version} is not compatible with this connector.`)
console.log(
  TESTED_T3_VERSIONS.includes(version)
    ? `T3 Code ${version} passed and is already in TESTED_T3_VERSIONS.`
    : `T3 Code ${version} passed. Add "${version}" to TESTED_T3_VERSIONS in src/t3-client.ts and release the connector.`
)
