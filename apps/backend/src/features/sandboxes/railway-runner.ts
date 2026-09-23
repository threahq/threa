import { randomUUID } from "node:crypto"
import { Sandbox, SandboxNotFoundError } from "railway"
import { logger } from "../../lib/logger"
import type { SandboxExecResult, SandboxFile, SandboxRunner } from "./runner"

/** Railway destroys a box nobody has run a command in for this long. */
const IDLE_TIMEOUT_MINUTES = 10
/** How long past the in-box deadline the client waits before giving up on the exec itself. */
const CLIENT_GRACE_SEC = 10
const STAGING_DIR = "/run/threa-in"
const COMMAND_ENV = "THREA_COMMAND"
const STOP_DIR = "/run/threa-stop"
const EXEC_ID_ENV = "THREA_EXEC_ID"
const KILL_USER = "pkill -KILL -u sandbox"
const USER_ENV = "PATH=/work/.local/bin:/usr/local/bin:/usr/bin:/bin HOME=/work LANG=C.UTF-8"

// Runs as root once per box. The image keeps python and node under root's
// home, so their installs are bind-mounted out rather than opening /root.
// Commands run as `sandbox`, which cannot change nftables or regain root
// (no_new_privs is set), so the egress rule holds against the command.
// Only the user's traffic is dropped: Railway's exec agent runs as root and
// needs the network, and dropping all egress breaks exec.
function setupScript(internet: boolean): string {
  const lines = [
    "set -e",
    "useradd -M -d /work -s /bin/sh sandbox",
    "mkdir -p /work /opt/runtimes",
    "chown sandbox:sandbox /work",
    `install -d -m 711 ${STAGING_DIR}`,
    `install -d -m 700 ${STOP_DIR}`,
    "mount --bind /root/.local/share/mise/installs /opt/runtimes",
    'for b in python3 python pip3 node npm npx; do p=$(mise which "$b"); ln -sf "/opt/runtimes/${p#/root/.local/share/mise/installs/}" "/usr/local/bin/$b"; done',
  ]
  if (!internet) {
    lines.push(
      "nft add table inet threa_sandbox",
      "nft add chain inet threa_sandbox out '{ type filter hook output priority 0; policy accept; }'",
      'nft add rule inet threa_sandbox out meta skuid sandbox oif != "lo" drop'
    )
  }
  return lines.join("\n")
}

// Root-side watchdog: past the deadline, or once the stop file for this exec
// exists, it kills everything the user runs, every 200ms until the command
// returns. `timeout` alone is not enough: the image's (uutils) kills only its
// direct child, and anything else the command started keeps the output open.
// Polling closes the race where a stop lands before the command has started.
function asSandboxUser(timeoutSec: number): string {
  return [
    `stop="${STOP_DIR}/$${EXEC_ID_ENV}"`,
    `deadline=$(( $(date +%s) + ${timeoutSec} ))`,
    `( while :; do if [ -e "$stop" ] || [ $(date +%s) -ge $deadline ]; then ${KILL_USER}; fi; sleep 0.2; done ) >/dev/null 2>&1 &`,
    "watchdog=$!",
    `runuser -u sandbox -- env -i ${USER_ENV} timeout -s KILL ${timeoutSec} sh -c "$${COMMAND_ENV}"`,
    "status=$?",
    'kill $watchdog; rm -f "$stop"',
    "exit $status",
  ].join("\n")
}

function capOutput(stdout: string, stderr: string, maxBytes: number): { stdout: string; stderr: string; cut: boolean } {
  const out = Buffer.from(stdout)
  const err = Buffer.from(stderr)
  if (out.length + err.length <= maxBytes) return { stdout, stderr, cut: false }
  const keptOut = out.subarray(0, maxBytes)
  const keptErr = err.subarray(0, maxBytes - keptOut.length)
  return { stdout: keptOut.toString("utf8"), stderr: keptErr.toString("utf8"), cut: true }
}

export interface RailwaySandboxRunnerOptions {
  /** A project token scoped to the environment the boxes live in. */
  token: string
  environmentId: string
}

/**
 * Sandboxes as Railway sandboxes: `ISOLATED`, so a box has public egress but
 * never joins the environment's private network. Railway reaps idle boxes on
 * its own timer.
 */
export class RailwaySandboxRunner implements SandboxRunner {
  readonly kind = "railway"
  private readonly auth: { token: string; authType: "project-token"; environmentId: string }

  constructor(options: RailwaySandboxRunnerOptions) {
    this.auth = { token: options.token, authType: "project-token", environmentId: options.environmentId }
  }

  private connect(sandboxId: string): Promise<Sandbox> {
    return Sandbox.connect(sandboxId, this.auth)
  }

  async create(params: { internet: boolean; workspaceId: string; streamId: string }): Promise<string> {
    const sandbox = await Sandbox.create({
      ...this.auth,
      idleTimeoutMinutes: IDLE_TIMEOUT_MINUTES,
      networkIsolation: "ISOLATED",
    })
    try {
      const setup = await sandbox.exec(setupScript(params.internet), { timeoutSec: 60 })
      if (setup.exitCode !== 0) {
        throw new Error(`sandbox setup failed: ${(setup.stderr || setup.stdout).trim().slice(0, 400)}`)
      }
    } catch (error) {
      await sandbox
        .destroy()
        .catch((destroyError) => logger.warn({ destroyError }, "sandbox destroy after failed setup"))
      throw error
    }
    return sandbox.id
  }

  /** Railway counts only commands as use, so this does not push back the idle timer. */
  async alive(sandboxId: string): Promise<boolean> {
    try {
      return (await this.connect(sandboxId)).status === "RUNNING"
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return false
      throw error
    }
  }

  // The upload lands as root in a staging dir only root can list, then
  // `sandbox` copies it into place, so a symlink the command left under /work
  // cannot redirect a root write.
  async writeFiles(sandboxId: string, files: SandboxFile[]): Promise<void> {
    const sandbox = await this.connect(sandboxId)
    for (const file of files) {
      const staged = `${STAGING_DIR}/${randomUUID()}`
      await sandbox.files.write(staged, file.data, { mode: 0o644 })
      const copy = await sandbox.exec(
        `runuser -u sandbox -- sh -c 'mkdir -p "$(dirname "$2")" && cp "$1" "$2"' sh "$STAGED" "$TARGET"; status=$?; rm -f "$STAGED"; exit $status`,
        { timeoutSec: 60, env: { STAGED: staged, TARGET: file.path } }
      )
      if (copy.exitCode !== 0) {
        throw new Error(`writing ${file.path} failed: ${copy.stderr.trim().slice(0, 400)}`)
      }
    }
  }

  async exec(
    sandboxId: string,
    command: string,
    options: { timeoutSec: number; maxOutputBytes: number; signal?: AbortSignal }
  ): Promise<SandboxExecResult> {
    const sandbox = await this.connect(sandboxId)
    const startedAt = Date.now()
    const execId = randomUUID()
    const handle = sandbox.exec(asSandboxUser(options.timeoutSec), {
      cwd: "/work",
      timeoutSec: options.timeoutSec + CLIENT_GRACE_SEC,
      env: { [COMMAND_ENV]: command, [EXEC_ID_ENV]: execId },
    })
    // Neither closing the exec session nor `handle.kill` reaches the command:
    // `timeout` puts it in its own process group. The watchdog kills by user.
    const onAbort = () =>
      void sandbox
        .exec(`touch "${STOP_DIR}/$${EXEC_ID_ENV}"`, { timeoutSec: 30, env: { [EXEC_ID_ENV]: execId } })
        .catch((error) => logger.warn({ error }, "sandbox stop failed"))
    options.signal?.addEventListener("abort", onAbort, { once: true })
    try {
      const result = await handle
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted")
      if (result.timedOut) {
        await sandbox
          .exec(KILL_USER, { timeoutSec: 30 })
          .catch((error) => logger.warn({ error }, "sandbox kill failed"))
      }
      const exitCode = result.exitCode ?? -1
      const ranFullTime = Date.now() - startedAt >= options.timeoutSec * 1000
      const capped = capOutput(result.stdout, result.stderr, options.maxOutputBytes)
      return {
        // uutils `timeout` exits 124 and GNU's 137; a command can exit with either itself.
        timedOut: result.timedOut || ((exitCode === 124 || exitCode === 137) && ranFullTime),
        exitCode,
        stdout: capped.stdout,
        stderr: capped.stderr,
        truncated: result.truncated || capped.cut,
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort)
    }
  }

  async destroy(sandboxId: string): Promise<void> {
    try {
      await (await this.connect(sandboxId)).destroy()
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) throw error
    }
  }
}
