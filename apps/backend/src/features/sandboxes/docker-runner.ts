import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BOX_API_BASE_URL, BOX_API_KEY_PLACEHOLDER, BOX_DIR, CLI_WRAPPER, buildBoxFiles } from "./box-files"
import type { SandboxApiAccess, SandboxExecOptions, SandboxExecResult, SandboxFile, SandboxRunner } from "./runner"

const IMAGE_DIR = join(import.meta.dir, "image")
const USE_MARKER = "/run/threa-used"
/** A box nobody has touched for this long exits, and `--rm` removes it. */
const IDLE_SECONDS = 10 * 60
/** How long past the in-box deadline the client waits before giving up on `docker exec` itself. */
const CLIENT_GRACE_MS = 10_000
const BROKER_START_MS = 5_000
/** Matches `useradd --uid` in image/Dockerfile. */
const SANDBOX_UID = 10001
const API_SOCKET_DIR = "/run/threa-api"

// PID 1 is a root shell polling the use marker's mtime. The reaping lives in
// the box, so it works whichever replica created it and survives a backend
// restart. Commands run as `sandbox` and cannot touch the root-owned marker.
const IDLE_LOOP = `touch ${USE_MARKER}; while [ $(( $(date +%s) - $(stat -c %Y ${USE_MARKER}) )) -lt ${IDLE_SECONDS} ]; do sleep 15; done`

interface DockerOutput {
  code: number
  stdout: Buffer
  stderr: Buffer
}

function docker(args: string[], stdin?: Uint8Array): Promise<DockerOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk))
    child.on("error", (error) => reject(new Error(`docker ${args[0]} could not start: ${error.message}`)))
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }))
    child.stdin.end(stdin)
  })
}

async function dockerOrThrow(args: string[], what: string, stdin?: Uint8Array): Promise<string> {
  const result = await docker(args, stdin)
  if (result.code !== 0) {
    const detail = (result.stderr.toString() || result.stdout.toString()).trim().slice(0, 400)
    throw new Error(`${what}: ${detail}`)
  }
  return result.stdout.toString().trim()
}

/**
 * Sandboxes as local Docker containers. For development: it needs a Docker
 * daemon next to the backend, which the hosted backend does not have.
 *
 * A box reaches the backend through a unix socket in a host directory only the
 * backend's uid can enter, relayed to the API port. The broker runs in the box
 * as that uid; commands run as `sandbox`, a different uid, and cannot open it.
 */
export class DockerSandboxRunner implements SandboxRunner {
  readonly kind = "docker"
  private readonly image: string
  private readonly apiPort: number
  private readonly hostUid: number
  private readonly hostDir: string
  private imageReady: Promise<void> | null = null
  private hostReady: Promise<void> | null = null
  /** Execs queue per box, so one never kills another's command. */
  private readonly running = new Map<string, Promise<void>>()

  constructor(options: { apiPort: number }) {
    const dockerfile = readFileSync(join(IMAGE_DIR, "Dockerfile"))
    this.image = `threa-sandbox:${createHash("sha256").update(dockerfile).digest("hex").slice(0, 12)}`
    this.apiPort = options.apiPort
    this.hostUid = process.getuid!()
    // As root the broker's cleanup would kill the box's idle timer; as the sandbox uid the command could reach the socket.
    if (this.hostUid === 0 || this.hostUid === SANDBOX_UID) {
      throw new Error(`the Docker sandbox runner cannot run as uid ${this.hostUid}`)
    }
    // Stable per backend, so boxes survive a backend restart with their mounts intact.
    this.hostDir = join(tmpdir(), `threa-sandbox-${this.hostUid}-${this.apiPort}`)
  }

  private ensureHost(): Promise<void> {
    this.hostReady ??= this.prepareHost().catch((error) => {
      this.hostReady = null
      throw error
    })
    return this.hostReady
  }

  // `box/` is mounted read-only at BOX_DIR; `api/` holds the relay socket and
  // is closed to every other uid.
  private async prepareHost(): Promise<void> {
    mkdirSync(this.hostDir, { recursive: true, mode: 0o711 })
    const owner = lstatSync(this.hostDir)
    if (!owner.isDirectory() || owner.uid !== this.hostUid) {
      throw new Error(`${this.hostDir} is not a directory this backend owns`)
    }
    chmodSync(this.hostDir, 0o711)
    const boxDir = join(this.hostDir, "box")
    const apiDir = join(this.hostDir, "api")
    mkdirSync(boxDir, { recursive: true, mode: 0o755 })
    mkdirSync(apiDir, { recursive: true, mode: 0o700 })
    chmodSync(apiDir, 0o700)

    const files = await buildBoxFiles()
    writeFileSync(join(boxDir, "threa.js"), files.cli, { mode: 0o644 })
    writeFileSync(join(boxDir, "broker.js"), files.broker, { mode: 0o644 })
    writeFileSync(join(boxDir, "threa"), CLI_WRAPPER, { mode: 0o755 })

    const socketPath = join(apiDir, "api.sock")
    rmSync(socketPath, { force: true })
    const relay = net.createServer((box) => {
      const backend = net.connect(this.apiPort, "127.0.0.1")
      box.pipe(backend).pipe(box)
      box.on("error", () => backend.destroy())
      backend.on("error", () => box.destroy())
    })
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject)
      relay.listen(socketPath, () => resolve())
    })
    relay.unref()
  }

  private ensureImage(): Promise<void> {
    this.imageReady ??= (async () => {
      if ((await docker(["image", "inspect", this.image])).code === 0) return
      await dockerOrThrow(["build", "-t", this.image, IMAGE_DIR], "sandbox image build failed")
    })().catch((error) => {
      this.imageReady = null
      throw error
    })
    return this.imageReady
  }

  async create(params: { internet: boolean; workspaceId: string; streamId: string }): Promise<string> {
    await Promise.all([this.ensureImage(), this.ensureHost()])
    return dockerOrThrow(
      [
        "run",
        "--detach",
        "--rm",
        "--init",
        "--label",
        "threa.sandbox=1",
        "--label",
        `threa.workspace=${params.workspaceId}`,
        "--label",
        `threa.stream=${params.streamId}`,
        "--network",
        params.internet ? "bridge" : "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "1g",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        "--volume",
        `${join(this.hostDir, "box")}:${BOX_DIR}:ro`,
        "--volume",
        `${join(this.hostDir, "api")}:${API_SOCKET_DIR}:ro`,
        this.image,
        "sh",
        "-c",
        IDLE_LOOP,
      ],
      "sandbox could not start"
    )
  }

  async alive(sandboxId: string): Promise<boolean> {
    return (await docker(["exec", "--user", "root", sandboxId, "touch", USE_MARKER])).code === 0
  }

  async writeFiles(sandboxId: string, files: SandboxFile[]): Promise<void> {
    for (const file of files) {
      await dockerOrThrow(
        [
          "exec",
          "--interactive",
          "--user",
          "sandbox",
          sandboxId,
          "sh",
          "-c",
          'mkdir -p "$(dirname "$1")" && cat > "$1"',
          "sh",
          file.path,
        ],
        `writing ${file.path} failed`,
        file.data
      )
    }
  }

  exec(sandboxId: string, command: string, options: SandboxExecOptions): Promise<SandboxExecResult> {
    const previous = this.running.get(sandboxId) ?? Promise.resolve()
    const result = previous.then(() => this.execAlone(sandboxId, command, options))
    const settled = result.then(
      () => {},
      () => {}
    )
    this.running.set(sandboxId, settled)
    void settled.then(() => {
      if (this.running.get(sandboxId) === settled) this.running.delete(sandboxId)
    })
    return result
  }

  // Whatever the last command left running dies first, and whatever this one
  // leaves dies after, so nothing outlives the exec that holds the token.
  private async execAlone(sandboxId: string, command: string, options: SandboxExecOptions): Promise<SandboxExecResult> {
    options.signal?.throwIfAborted()
    await this.ensureHost()
    await this.killAll(sandboxId, "sandbox")
    await this.killAll(sandboxId, String(this.hostUid))
    try {
      if (options.api) await this.startBroker(sandboxId, options.api)
      return await this.run(sandboxId, command, options)
    } finally {
      if (options.api) await this.killAll(sandboxId, String(this.hostUid))
      await this.killAll(sandboxId, "sandbox")
    }
  }

  private async killAll(sandboxId: string, user: string): Promise<void> {
    await docker(["exec", "--user", user, sandboxId, "sh", "-c", "kill -KILL -1"])
  }

  // Resolves once the broker listens. The token reaches it through the docker
  // client's environment, never an argument another process could list.
  private startBroker(sandboxId: string, api: SandboxApiAccess): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "docker",
        [
          "exec",
          "--user",
          String(this.hostUid),
          "--env",
          "THREA_SANDBOX_TOKEN",
          "--env",
          `THREA_WORKSPACE_ID=${api.workspaceId}`,
          "--env",
          `THREA_API_UPSTREAM=unix:${API_SOCKET_DIR}/api.sock`,
          sandboxId,
          "node",
          `${BOX_DIR}/broker.js`,
        ],
        { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, THREA_SANDBOX_TOKEN: api.token } }
      )
      const stderr: Buffer[] = []
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
      const fail = (reason: string) => {
        clearTimeout(timer)
        child.kill("SIGKILL")
        reject(new Error(`the Threa API broker did not start: ${reason}`))
      }
      const timer = setTimeout(() => fail("timed out"), BROKER_START_MS)
      child.stdout.once("data", () => {
        clearTimeout(timer)
        resolve()
      })
      child.on("error", (error) => fail(error.message))
      child.on("close", () => fail(Buffer.concat(stderr).toString().trim().slice(0, 400) || "exited"))
    })
  }

  private run(sandboxId: string, command: string, options: SandboxExecOptions): Promise<SandboxExecResult> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const apiEnv = options.api
        ? [
            "--env",
            `THREA_API_KEY=${BOX_API_KEY_PLACEHOLDER}`,
            "--env",
            `THREA_WORKSPACE_ID=${options.api.workspaceId}`,
            "--env",
            `THREA_BASE_URL=${BOX_API_BASE_URL}`,
          ]
        : []
      // `timeout` runs inside the box, so the command dies at the deadline.
      // Killing only the `docker exec` client would leave it running.
      const child = spawn(
        "docker",
        [
          "exec",
          "--user",
          "sandbox",
          "--workdir",
          "/work",
          ...apiEnv,
          sandboxId,
          "timeout",
          "-s",
          "KILL",
          String(options.timeoutSec),
          "sh",
          "-c",
          command,
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      )
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let kept = 0
      let truncated = false
      let clientKilled = false
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        const room = options.maxOutputBytes - kept
        if (chunk.length > room) truncated = true
        if (room <= 0) return
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk
        into.push(part)
        kept += part.length
      }
      child.stdout.on("data", collect(stdout))
      child.stderr.on("data", collect(stderr))

      const kill = () => {
        clientKilled = true
        child.kill("SIGKILL")
      }
      // Killing the client alone leaves the command running in the box until its deadline.
      const abort = () => {
        kill()
        void this.killAll(sandboxId, "sandbox").catch(() => {})
      }
      const timer = setTimeout(kill, options.timeoutSec * 1000 + CLIENT_GRACE_MS)
      options.signal?.addEventListener("abort", abort, { once: true })
      if (options.signal?.aborted) abort()
      const cleanup = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", abort)
      }

      child.on("error", (error) => {
        cleanup()
        reject(new Error(`docker exec could not start: ${error.message}`))
      })
      child.on("close", (code) => {
        cleanup()
        if (options.signal?.aborted) {
          reject(options.signal.reason ?? new Error("aborted"))
          return
        }
        const exitCode = code ?? -1
        const ranFullTime = Date.now() - startedAt >= options.timeoutSec * 1000
        resolve({
          // `timeout -s KILL` exits 137, which a command killed for memory also does.
          timedOut: clientKilled || (exitCode === 137 && ranFullTime),
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          truncated,
        })
      })
    })
  }

  async destroy(sandboxId: string): Promise<void> {
    const result = await docker(["rm", "--force", sandboxId])
    if (result.code !== 0 && !/No such container/i.test(result.stderr.toString())) {
      throw new Error(`sandbox could not be removed: ${result.stderr.toString().trim().slice(0, 400)}`)
    }
  }
}
