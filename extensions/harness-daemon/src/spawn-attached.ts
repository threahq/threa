import { readFileSync, unlinkSync } from "node:fs"
import { spawnAgent, threaTarget } from "./commands"
import { die } from "./errors"
import { postScratchpadNotice } from "./oom"
import { failureExcerpt, postThrea } from "./threa-http"
import type { SpawnOptions, SpawnResult } from "./types"

export interface AttachedSpawnDeps {
  spawn: (options: SpawnOptions) => Promise<SpawnResult>
  readBrief: (path: string) => string
  unlinkBrief: (path: string) => void
  brief: (body: { instanceId: string; runtimeSessionId: string; content: string }) => Promise<void>
  postToRoot: (rootStreamId: string, content: string) => Promise<void>
  log: (message: string) => void
}

/** Best-effort: a failure to report a failure must not mask the original error. */
async function reportToRoot(
  rootStreamId: string,
  content: string,
  deps: Pick<AttachedSpawnDeps, "postToRoot" | "log">
) {
  try {
    await deps.postToRoot(rootStreamId, content)
  } catch (error) {
    deps.log(
      `harnessd: could not post to root stream ${rootStreamId}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * Spawns an attached agent and, when a brief file is given, hands it the caller's prompt
 * through the Threa brief endpoint. Any failure past this point is reported into the
 * scratchpad root stream (best-effort) before rethrowing, so a spawn that dies is never silent.
 */
export async function runAttachedSpawn(options: SpawnOptions, deps: AttachedSpawnDeps): Promise<SpawnResult> {
  if (!options.attach) die("runAttachedSpawn requires options.attach")
  const rootStreamId = options.attach.rootStreamId

  // Read before spawning: an unreadable or blank (including whitespace-only) brief must create nothing (INV-11).
  const pendingBrief: { path: string; content: string } | undefined = options.briefFile
    ? { path: options.briefFile, content: deps.readBrief(options.briefFile) }
    : undefined
  if (pendingBrief && !pendingBrief.content.trim()) die(`--brief-file ${pendingBrief.path} is empty`)

  let result: SpawnResult
  try {
    result = await deps.spawn(options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await reportToRoot(rootStreamId, `harnessd: spawn of \`${options.name}\` failed: ${message}`, deps)
    throw error
  }

  if (pendingBrief) {
    const instanceId = result.instanceId ?? die("spawned agent has no instanceId to brief")
    const runtimeSessionId = result.runtimeSessionId ?? die("spawned agent has no runtimeSessionId to brief")
    try {
      await deps.brief({ instanceId, runtimeSessionId, content: pendingBrief.content })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await reportToRoot(
        rootStreamId,
        `harnessd: \`${options.name}\` started in thread ${result.activeStreamId} but the brief was not delivered: ${message}`,
        deps
      )
      throw error
    }
    try {
      deps.unlinkBrief(pendingBrief.path)
    } catch (error) {
      // The brief already landed; a leftover file on disk is a cleanup nit, not a failure to report.
      deps.log(
        `harnessd: could not remove brief file ${pendingBrief.path}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  return result
}

export function defaultAttachedSpawnDeps(): AttachedSpawnDeps {
  return {
    spawn: spawnAgent,
    readBrief: (path) => readFileSync(path, "utf8"),
    unlinkBrief: (path) => unlinkSync(path),
    brief: async (body) => {
      const response = await postThrea(threaTarget("deliver a brief"), "/bot-runtime/sessions/brief", body)
      if (!response.ok) throw new Error(`harnessd: could not deliver the brief: ${await failureExcerpt(response)}`)
    },
    postToRoot: (rootStreamId, content) =>
      postScratchpadNotice({ ...threaTarget("report a spawn failure"), streamId: rootStreamId, content }),
    log: (message) => console.error(message),
  }
}
