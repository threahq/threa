import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { SandboxExecResult, SandboxFile, SandboxRunner } from "./runner"

const IMAGE_DIR = join(import.meta.dir, "image")
const USE_MARKER = "/run/threa-used"
/** A box nobody has touched for this long exits, and `--rm` removes it. */
const IDLE_SECONDS = 10 * 60
/** How long past the in-box deadline the client waits before giving up on `docker exec` itself. */
const CLIENT_GRACE_MS = 10_000

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
 */
export class DockerSandboxRunner implements SandboxRunner {
  readonly kind = "docker"
  private readonly image: string
  private imageReady: Promise<void> | null = null

  constructor() {
    const dockerfile = readFileSync(join(IMAGE_DIR, "Dockerfile"))
    this.image = `threa-sandbox:${createHash("sha256").update(dockerfile).digest("hex").slice(0, 12)}`
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
    await this.ensureImage()
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

  exec(
    sandboxId: string,
    command: string,
    options: { timeoutSec: number; maxOutputBytes: number; signal?: AbortSignal }
  ): Promise<SandboxExecResult> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now()
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
        void docker(["exec", "--user", "sandbox", sandboxId, "sh", "-c", "kill -KILL -1"]).catch(() => {})
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
