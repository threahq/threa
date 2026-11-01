// Proves a T3 Code release works with this connector before it joins TESTED_T3_VERSIONS: downloads the release, boots
// it on an empty T3 home, and drives the connector's own client through a real turn. Runs a short agent turn on the
// machine's provider credentials, so it is a local check, not a CI one.
//
// Usage (from extensions/t3code-remote): bun run compat <version> [--model instance::model]
import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { T3Auth } from "../src/auth"
import { thinkingLevels } from "../src/session-control"
import { TESTED_T3_VERSIONS, T3Client, type ModelSelection } from "../src/t3-client"

const RELEASES = "https://github.com/pingdotgg/t3code/releases/download"
const TURN_TIMEOUT_MS = 180_000

const [version, ...flags] = process.argv.slice(2)
if (!version || version.startsWith("-")) fail("usage: bun run compat <version> [--model instance::model]")
const modelArg = flags.includes("--model") ? flags[flags.indexOf("--model") + 1] : "claudeAgent::claude-haiku-5-5"
const [instanceId, model] = (modelArg ?? "").split("::")
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
async function installRelease(): Promise<string> {
  const target = `${process.platform}-${process.arch}`
  const dir = join(homedir(), ".cache", "threa-t3code-compat", version!)
  const bin = join(dir, `t3-${version}-${target}`, "t3")
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
  writeFileSync(join(staging, asset), archive)
  await run("tar", ["-xzf", join(staging, asset), "-C", staging])
  rmSync(join(staging, asset))
  renameSync(staging, dir)
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

async function waitForServer(url: string, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`T3 exited ${server.exitCode} before listening`)
    if (
      await fetch(url).then(
        () => true,
        () => false
      )
    )
      return
    await Bun.sleep(500)
  }
  throw new Error("T3 did not listen within 60s")
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

async function settle(client: T3Client, threadId: string, runId: string): Promise<void> {
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let current = runId
  while (Date.now() < deadline) {
    const waited = await client.call("t3_thread_wait", { threadId, runId: current, timeoutMs: 20_000 })
    if (waited.runId) current = waited.runId
    if (!waited.timedOut && waited.status !== "running" && waited.status !== "starting" && waited.status !== "queued") {
      assert(waited.status === "completed", `run ${current} ended ${waited.status}`)
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

const bin = await installRelease()
const home = mkdtempSync(join(tmpdir(), "t3code-compat-"))
const port = await freePort()
const url = `http://127.0.0.1:${port}`
const env = { ...process.env, T3CODE_HOME: home }
const server = spawn(
  bin,
  ["--mode", "web", "--base-dir", home, "--host", "127.0.0.1", "--port", String(port), "--no-browser"],
  {
    env,
    detached: true,
    stdio: "ignore",
  }
)

try {
  await waitForServer(url, server)
  const mintCode = async () =>
    (
      JSON.parse(
        await run(bin, ["auth", "pairing", "create", "--base-dir", home, "--label", "compat", "--json"], env)
      ) as {
        credential: string
      }
    ).credential
  const auth = new T3Auth({
    url,
    access: "approval-required",
    tokenPath: join(home, "token.json"),
    autoLogin: true,
    mintCode,
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
  await check("reads and changes the thread's model", async () => {
    assert(threadId, "no thread to configure")
    const before = (await client.call("t3_thread_configure", { threadId })) as { modelSelection: ModelSelection }
    assert(before.modelSelection.model === turnModel.model, `thread runs ${JSON.stringify(before.modelSelection)}`)
    await client.call("t3_thread_configure", { threadId, modelSelection: turnModel })
  })
  await check("lists pending questions", async () => {
    assert(threadId, "no thread to read")
    const pending = (await client.call("t3_pending_request", { action: "list", threadId })) as { requestIds: unknown }
    assert(Array.isArray(pending.requestIds), `unexpected answer ${JSON.stringify(pending)}`)
  })
  await check("archives the thread", async () => {
    assert(threadId, "no thread to archive")
    await client.call("t3_thread_organize", { threadId, action: "archive" })
  })
} finally {
  // The group is already gone when T3 exited on its own.
  if (server.pid && server.exitCode === null) process.kill(-server.pid, "SIGTERM")
  rmSync(home, { recursive: true, force: true })
}

for (const { name, error } of checks) console.log(`${error ? "FAIL" : "ok  "} ${name}${error ? `: ${error}` : ""}`)
if (checks.some((entry) => entry.error)) fail(`T3 Code ${version} is not compatible with this connector.`)
console.log(
  TESTED_T3_VERSIONS.includes(version)
    ? `T3 Code ${version} passed and is already in TESTED_T3_VERSIONS.`
    : `T3 Code ${version} passed. Add "${version}" to TESTED_T3_VERSIONS in src/t3-client.ts and release the connector.`
)
