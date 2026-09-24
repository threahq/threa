import type { Pool } from "pg"
import { logger } from "../../lib/logger"
import { StreamSandboxRepository, type StreamSandboxRow } from "./repository"
import type { SandboxExecResult, SandboxFile, SandboxRunner } from "./runner"
import { SANDBOX_MAX_OUTPUT_BYTES } from "./config"

/** Why a stream got a new sandbox in place of the one it had. Files from before are gone either way. */
export const SandboxReplacedReasons = {
  /** The old box is gone: idle past its limit, removed, or made by a runner this backend no longer uses. */
  EXPIRED: "expired",
  /** The workspace's sandbox internet setting changed since the old box was made. */
  NETWORK_CHANGED: "network_changed",
} as const
export type SandboxReplacedReason = (typeof SandboxReplacedReasons)[keyof typeof SandboxReplacedReasons]

export interface SandboxRunResult extends SandboxExecResult {
  replaced: SandboxReplacedReason | null
}

/** Two callers binding the same stream at once is the only reason to go round again. */
const MAX_BIND_ATTEMPTS = 3

export class SandboxService {
  private readonly pool: Pool
  private readonly runner: SandboxRunner

  constructor(deps: { pool: Pool; runner: SandboxRunner }) {
    this.pool = deps.pool
    this.runner = deps.runner
  }

  async run(params: {
    workspaceId: string
    streamId: string
    internet: boolean
    command: string
    files: SandboxFile[]
    timeoutSec: number
    signal?: AbortSignal
  }): Promise<SandboxRunResult> {
    const { sandboxId, replaced } = await this.acquire(params)
    params.signal?.throwIfAborted()
    if (params.files.length > 0) await this.runner.writeFiles(sandboxId, params.files)
    params.signal?.throwIfAborted()
    const result = await this.runner.exec(sandboxId, params.command, {
      timeoutSec: params.timeoutSec,
      maxOutputBytes: SANDBOX_MAX_OUTPUT_BYTES,
      signal: params.signal,
    })
    return { ...result, replaced }
  }

  private async acquire(params: {
    workspaceId: string
    streamId: string
    internet: boolean
  }): Promise<{ sandboxId: string; replaced: SandboxReplacedReason | null }> {
    // A caller that lost a replace race still had its files in the box it read.
    let lost: SandboxReplacedReason | null = null
    for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt++) {
      const current = await StreamSandboxRepository.find(this.pool, params.workspaceId, params.streamId)
      const reusable = current?.runner === this.runner.kind && current.internet === params.internet
      if (current && reusable && (await this.runner.alive(current.sandboxId))) {
        return { sandboxId: current.sandboxId, replaced: lost }
      }

      const sandboxId = await this.runner.create(params)
      logger.info(
        { sandboxId, workspaceId: params.workspaceId, streamId: params.streamId, runner: this.runner.kind },
        "Sandbox created"
      )
      const binding = { ...params, sandboxId, runner: this.runner.kind }
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
        if (current) lost ??= replacedReason(current, params.internet, this.runner.kind)
        continue
      }
      if (!current) return { sandboxId, replaced: lost }
      if (current.runner === this.runner.kind && !reusable) await this.discard(current.sandboxId)
      return { sandboxId, replaced: replacedReason(current, params.internet, this.runner.kind) }
    }
    throw new Error(`could not bind a sandbox to stream ${params.streamId} after ${MAX_BIND_ATTEMPTS} attempts`)
  }

  /** A box nobody points at; if removal fails, its idle timer ends it. */
  private async discard(sandboxId: string): Promise<void> {
    await this.runner.destroy(sandboxId).catch((err) => {
      logger.warn({ err, sandboxId }, "Unbound sandbox could not be removed; it will exit when idle")
    })
  }
}

function replacedReason(previous: StreamSandboxRow, internet: boolean, runnerKind: string): SandboxReplacedReason {
  if (previous.runner === runnerKind && previous.internet !== internet) return SandboxReplacedReasons.NETWORK_CHANGED
  return SandboxReplacedReasons.EXPIRED
}
