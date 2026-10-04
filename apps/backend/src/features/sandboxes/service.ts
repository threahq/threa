import type { Pool } from "pg"
import { logger } from "../../lib/logger"
import { StreamSandboxRepository, type StreamSandboxRow } from "./repository"
import type { SandboxApiAccess, SandboxExecResult, SandboxFile, SandboxRunner } from "./runner"
import { SANDBOX_MAX_OUTPUT_BYTES } from "./config"

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
    const { workspaceId, streamId } = params
    const { sandboxId, replaced, contentStreamIds } = await this.acquire(params)
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
    // Reads during the command land on whichever box the stream holds now. A
    // replace that reset it loses them here; the token's own record covers that.
    const after = await StreamSandboxRepository.find(this.pool, workspaceId, streamId)
    return {
      ...result,
      replaced,
      contentStreamIds: [
        ...new Set([...contentStreamIds, ...params.contentStreamIds, ...(after?.contentStreamIds ?? [])]),
      ],
    }
  }

  private async acquire(params: {
    workspaceId: string
    streamId: string
    internet: boolean
    readableStreamIds: string[]
  }): Promise<{ sandboxId: string; replaced: SandboxReplacedReason | null; contentStreamIds: string[] }> {
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
        return { sandboxId: current.sandboxId, replaced: lost, contentStreamIds: current.contentStreamIds }
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
      if (!current) return { sandboxId, replaced: lost, contentStreamIds: [] }
      if (current.runner === this.runner.kind && !reusable) await this.discard(current.sandboxId)
      return {
        sandboxId,
        replaced: replacedReason(current, internet, readable, this.runner.kind),
        contentStreamIds: [],
      }
    }
    throw new Error(`could not bind a sandbox to stream ${streamId} after ${MAX_BIND_ATTEMPTS} attempts`)
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
