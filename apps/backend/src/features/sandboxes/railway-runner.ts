import { randomUUID } from "node:crypto"
import { Sandbox, SandboxNotFoundError } from "railway"
import { logger } from "../../lib/logger"
import {
  BOX_API_BASE_URL,
  BOX_API_KEY_PLACEHOLDER,
  BOX_DIR,
  CLI_WRAPPER,
  buildBoxFiles,
  type BoxFiles,
} from "./box-files"
import type { SandboxExecOptions, SandboxExecResult, SandboxFile, SandboxRunner } from "./runner"

/** Railway destroys a box nobody has run a command in for this long. */
const IDLE_TIMEOUT_MINUTES = 10
/** How long past the in-box deadline the client waits: covers the lock wait and the broker start. */
const CLIENT_GRACE_SEC = 10
const EXEC_LOCK = "/run/threa-exec.lock"
const LOCK_WAIT_SEC = 5
const BROKER_START_SEC = 3
const STAGING_DIR = "/run/threa-in"
const COMMAND_ENV = "THREA_COMMAND"
const STOP_DIR = "/run/threa-stop"
const EXEC_ID_ENV = "THREA_EXEC_ID"
const KILL_USER = "pkill -KILL -u sandbox"
const USER_ENV = "PATH=/work/.local/bin:/usr/local/bin:/usr/bin:/bin HOME=/work LANG=C.UTF-8"
const API_ENV = `THREA_API_KEY=${BOX_API_KEY_PLACEHOLDER} THREA_WORKSPACE_ID="$THREA_WORKSPACE_ID" THREA_BASE_URL=${BOX_API_BASE_URL}`

// Runs as root once per box. The image keeps python and node under root's
// home, so their installs are bind-mounted out rather than opening /root.
// Commands run as `sandbox` under no_new_privs, so they cannot change nftables
// or regain root through a setuid binary, and the egress rule holds.
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
    `install -d -m 755 ${BOX_DIR}`,
    `printf '%s' '${CLI_WRAPPER}' > /usr/local/bin/threa`,
    "chmod 755 /usr/local/bin/threa",
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

// One command at a time: the lock, then every process the last command left
// behind is killed, so nothing from an earlier turn runs alongside this one or
// reaches the broker with this exec's token. The broker runs as root with the
// token in its environment only, which the sandbox user cannot read.
//
// Root-side watchdog: past the deadline, or once the stop file for this exec
// exists, it kills everything the user runs, every 200ms until the command
// returns. `timeout` alone is not enough: the image's (uutils) kills only its
// direct child, and anything else the command started keeps the output open.
// Polling closes the race where a stop lands before the command has started.
// Each stream is cut in the box and the rest drained, because the SDK buffers
// all output in backend memory before returning.
function execScript(timeoutSec: number, maxOutputBytes: number, api: boolean): string {
  const lines = [
    `exec 9>${EXEC_LOCK}`,
    `flock -w ${LOCK_WAIT_SEC} 9 || { echo "another command is still running in this sandbox" >&2; exit 125; }`,
    KILL_USER,
    `pkill -KILL -f "^node ${BOX_DIR}/broker.js"`,
  ]
  if (api) {
    lines.push(
      `exec 8< <(exec node ${BOX_DIR}/broker.js 9>&- 2>/dev/null)`,
      "broker=$!",
      `read -t ${BROKER_START_SEC} -u 8 ready || { echo "the Threa API is unavailable in this sandbox" >&2; kill -KILL $broker; exit 125; }`
    )
  }
  lines.push(
    `stop="${STOP_DIR}/$${EXEC_ID_ENV}"`,
    `deadline=$(( $(date +%s) + ${timeoutSec} ))`,
    `( while :; do if [ -e "$stop" ] || [ $(date +%s) -ge $deadline ]; then ${KILL_USER}; fi; sleep 0.2; done ) >/dev/null 2>&1 8<&- 9>&- &`,
    "watchdog=$!",
    `cap() { head -c ${maxOutputBytes + 1}; cat >/dev/null; }`,
    `{ runuser -u sandbox -- setpriv --no-new-privs env -i ${USER_ENV}${api ? ` ${API_ENV}` : ""} timeout -s KILL ${timeoutSec} sh -c "$${COMMAND_ENV}" 2>&1 1>&3 3>&- 8<&- 9>&- | cap >&2; exit \${PIPESTATUS[0]}; } 3>&1 | cap`,
    "status=${PIPESTATUS[0]}",
    `kill $watchdog; ${api ? "kill -KILL $broker; " : ""}${KILL_USER}; rm -f "$stop"`,
    "exit $status"
  )
  return lines.join("\n")
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
  /** Threa's public origin, which the broker in each box calls. */
  apiUrl: string
}

/**
 * Sandboxes as Railway sandboxes: `ISOLATED`, so a box has public egress but
 * never joins the environment's private network. Railway reaps idle boxes on
 * its own timer.
 */
export class RailwaySandboxRunner implements SandboxRunner {
  readonly kind = "railway"
  private readonly auth: { token: string; authType: "project-token"; environmentId: string }
  private readonly apiUrl: string
  private boxFiles: Promise<BoxFiles> | null = null

  constructor(options: RailwaySandboxRunnerOptions) {
    this.auth = { token: options.token, authType: "project-token", environmentId: options.environmentId }
    this.apiUrl = options.apiUrl
  }

  private files(): Promise<BoxFiles> {
    this.boxFiles ??= buildBoxFiles().catch((error) => {
      this.boxFiles = null
      throw error
    })
    return this.boxFiles
  }

  private connect(sandboxId: string): Promise<Sandbox> {
    return Sandbox.connect(sandboxId, this.auth)
  }

  async create(params: { internet: boolean; workspaceId: string; streamId: string }): Promise<string> {
    const files = await this.files()
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
      await sandbox.files.write(`${BOX_DIR}/threa.js`, files.cli, { mode: 0o644 })
      await sandbox.files.write(`${BOX_DIR}/broker.js`, files.broker, { mode: 0o600 })
    } catch (error) {
      await sandbox
        .destroy()
        .catch((destroyError) => logger.warn({ destroyError }, "sandbox destroy after failed setup"))
      throw error
    }
    return sandbox.id
  }

  /** Runs a no-op command, because Railway counts only commands as use. */
  async alive(sandboxId: string): Promise<boolean> {
    try {
      const sandbox = await this.connect(sandboxId)
      if (sandbox.status !== "RUNNING") return false
      return (await sandbox.exec("true", { timeoutSec: 30 })).exitCode === 0
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

  async exec(sandboxId: string, command: string, options: SandboxExecOptions): Promise<SandboxExecResult> {
    const sandbox = await this.connect(sandboxId)
    const startedAt = Date.now()
    const execId = randomUUID()
    const apiEnv: Record<string, string> = options.api
      ? {
          THREA_SANDBOX_TOKEN: options.api.token,
          THREA_WORKSPACE_ID: options.api.workspaceId,
          THREA_API_UPSTREAM: this.apiUrl,
        }
      : {}
    const handle = sandbox.exec(execScript(options.timeoutSec, options.maxOutputBytes, Boolean(options.api)), {
      cwd: "/work",
      timeoutSec: options.timeoutSec + CLIENT_GRACE_SEC,
      env: { [COMMAND_ENV]: command, [EXEC_ID_ENV]: execId, ...apiEnv },
    })
    // Neither closing the exec session nor `handle.kill` reaches the command:
    // `timeout` puts it in its own process group. The watchdog kills by user.
    const onAbort = () =>
      void sandbox
        .exec(`touch "${STOP_DIR}/$${EXEC_ID_ENV}"`, { timeoutSec: 30, env: { [EXEC_ID_ENV]: execId } })
        .catch((error) => logger.warn({ error }, "sandbox stop failed"))
    options.signal?.addEventListener("abort", onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
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
