import type { Pool } from "pg"
import { logger } from "../../lib/logger"
import { sandboxLeaseId } from "../../lib/id"
import { StreamSandboxLeaseRepository, StreamSandboxRepository, type StreamSandboxRow } from "./repository"
import type { SandboxApiAccess, SandboxExecResult, SandboxFile, SandboxRunner } from "./runner"
import { SANDBOX_MAX_OUTPUT_BYTES, SANDBOX_MAX_TIMEOUT_SEC } from "./config"

/** Why a stream got a new sandbox in place of the one it had. Files from before are gone either way. */
export const SandboxReplacedReasons = {
  /** The old box is gone: idle past its limit, removed, or made by a runner this backend no longer uses. */
  EXPIRED: "expired",
  /** The workspace's sandbox internet setting changed since the old box was made. */
  NETWORK_CHANGED: "network_changed",
  /** The old box held content from a stream this turn cannot read. */
  ACCESS_CHANGED: "access_changed",
} as const
export type SandboxReplacedReason = (typeof SandboxReplacedReasons)[keyof typeof SandboxReplacedReasons]

export interface SandboxRunResult extends SandboxExecResult {
  replaced: SandboxReplacedReason | null
  /** Every stream the box's files may hold content from, as of the command's end. */
  contentStreamIds: string[]
}

/** Two callers binding the same stream at once is the only reason to go round again. */
const MAX_BIND_ATTEMPTS = 3

/** Renewed every third of its life, so only a holder that stopped running loses it. */
const LEASE_TTL_SEC = 60
const LEASE_RENEW_MS = (LEASE_TTL_SEC * 1000) / 3
const LEASE_POLL_MS = 250
/** Long enough to outwait one command at the longest timeout. */
const MAX_LEASE_WAIT_MS = (SANDBOX_MAX_TIMEOUT_SEC + LEASE_TTL_SEC) * 1000

export class SandboxService {
  private readonly pool: Pool
  private readonly runner: SandboxRunner

  constructor(deps: { pool: Pool; runner: SandboxRunner }) {
    this.pool = deps.pool
    this.runner = deps.runner
  }

  /**
   * `readableStreamIds` is what the calling turn may read: a box holding content
   * from any other stream is replaced, not reused. `contentStreamIds` are the
   * streams `files` came from; the box records them before the files land.
   */
  async run(params: {
    workspaceId: string
    streamId: string
    internet: boolean
    readableStreamIds: string[]
    command: string
    files: SandboxFile[]
    contentStreamIds: string[]
    timeoutSec: number
    signal?: AbortSignal
    api?: () => Promise<SandboxApiAccess>
  }): Promise<SandboxRunResult> {
    // The lease spans the reuse check through the command's end: a box another
    // turn could fill between the two would hand this command content its turn
    // cannot read.
    const release = await this.lease(params)
    try {
      return await this.runLeased(params)
    } finally {
      await release()
    }
  }

  private async runLeased(params: Parameters<SandboxService["run"]>[0]): Promise<SandboxRunResult> {
    const { workspaceId, streamId } = params
    const { sandboxId, replaced } = await this.acquire(params)
    params.signal?.throwIfAborted()
    if (params.contentStreamIds.length > 0) {
      const recorded = await StreamSandboxRepository.addContent(this.pool, {
        workspaceId,
        streamId,
        sandboxId,
        streamIds: params.contentStreamIds,
      })
      if (!recorded) throw new Error(`sandbox ${sandboxId} was replaced before its files were copied`)
    }
    if (params.files.length > 0) await this.runner.writeFiles(sandboxId, params.files)
    params.signal?.throwIfAborted()
    const result = await this.runner.exec(sandboxId, params.command, {
      timeoutSec: params.timeoutSec,
      maxOutputBytes: SANDBOX_MAX_OUTPUT_BYTES,
      signal: params.signal,
      api: params.api,
    })
    // Backstop for a lease lost mid-command. Content is recorded on the box
    // before it lands and a box's record only grows, so the record covers
    // everything the command could have seen; a replaced box took its record.
    const after = await StreamSandboxRepository.find(this.pool, workspaceId, streamId)
    if (after?.sandboxId !== sandboxId) {
      throw new Error(
        "this stream's sandbox was replaced while the command ran, so its output is withheld; run it again"
      )
    }
    return { ...result, replaced, contentStreamIds: after.contentStreamIds }
  }

  private async acquire(params: {
    workspaceId: string
    streamId: string
    internet: boolean
    readableStreamIds: string[]
  }): Promise<{ sandboxId: string; replaced: SandboxReplacedReason | null }> {
    const { workspaceId, streamId, internet } = params
    const readable = new Set(params.readableStreamIds)
    // A caller that lost a replace race still had its files in the box it read.
    let lost: SandboxReplacedReason | null = null
    for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt++) {
      const current = await StreamSandboxRepository.find(this.pool, workspaceId, streamId)
      const reusable =
        current?.runner === this.runner.kind &&
        current.internet === internet &&
        current.contentStreamIds.every((id) => readable.has(id))
      if (current && reusable && (await this.runner.alive(current.sandboxId))) {
        return { sandboxId: current.sandboxId, replaced: lost }
      }

      const sandboxId = await this.runner.create({ workspaceId, streamId, internet })
      logger.info({ sandboxId, workspaceId, streamId, runner: this.runner.kind }, "Sandbox created")
      const binding = { workspaceId, streamId, internet, sandboxId, runner: this.runner.kind }
      let bound: StreamSandboxRow | null
      try {
        bound = current
          ? await StreamSandboxRepository.replace(this.pool, { ...binding, expectedSandboxId: current.sandboxId })
          : await StreamSandboxRepository.insertIfAbsent(this.pool, binding)
      } catch (error) {
        await this.discard(sandboxId)
        throw error
      }

      if (!bound) {
        // Someone else bound a box first; theirs is as good as ours.
        await this.discard(sandboxId)
        if (current) lost ??= replacedReason(current, internet, readable, this.runner.kind)
        continue
      }
      if (!current) return { sandboxId, replaced: lost }
      if (current.runner === this.runner.kind && !reusable) await this.discard(current.sandboxId)
      return { sandboxId, replaced: replacedReason(current, internet, readable, this.runner.kind) }
    }
    throw new Error(`could not bind a sandbox to stream ${streamId} after ${MAX_BIND_ATTEMPTS} attempts`)
  }

  private async lease(params: { workspaceId: string; streamId: string; signal?: AbortSignal }) {
    const lease = { workspaceId: params.workspaceId, streamId: params.streamId, leaseId: sandboxLeaseId() }
    const giveUpAt = Date.now() + MAX_LEASE_WAIT_MS
    while (!(await StreamSandboxLeaseRepository.take(this.pool, { ...lease, ttlSec: LEASE_TTL_SEC }))) {
      if (Date.now() > giveUpAt)
        throw new Error("another command is still running in this stream's sandbox; run it again")
      await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS))
      params.signal?.throwIfAborted()
    }
    const renewal = setInterval(() => {
      StreamSandboxLeaseRepository.renew(this.pool, { ...lease, ttlSec: LEASE_TTL_SEC })
        .then((held) => {
          if (!held) logger.warn(lease, "Sandbox lease lost while its command ran")
        })
        .catch((err) => logger.warn({ err, ...lease }, "Sandbox lease not renewed"))
    }, LEASE_RENEW_MS)
    return async () => {
      clearInterval(renewal)
      await StreamSandboxLeaseRepository.release(this.pool, lease).catch((err) =>
        logger.warn({ err, ...lease }, "Sandbox lease not released; it frees itself when it expires")
      )
    }
  }

  /** A box nobody points at; if removal fails, its idle timer ends it. */
  private async discard(sandboxId: string): Promise<void> {
    await this.runner.destroy(sandboxId).catch((err) => {
      logger.warn({ err, sandboxId }, "Unbound sandbox could not be removed; it will exit when idle")
    })
  }
}

function replacedReason(
  previous: StreamSandboxRow,
  internet: boolean,
  readable: Set<string>,
  runnerKind: string
): SandboxReplacedReason {
  if (previous.runner !== runnerKind) return SandboxReplacedReasons.EXPIRED
  if (previous.internet !== internet) return SandboxReplacedReasons.NETWORK_CHANGED
  if (!previous.contentStreamIds.every((id) => readable.has(id))) return SandboxReplacedReasons.ACCESS_CHANGED
  return SandboxReplacedReasons.EXPIRED
}
