import { readFileSync, unlinkSync } from "node:fs"
import { spawnAgent, threaTarget } from "./commands"
import { die } from "./errors"
import { postScratchpadNotice } from "./oom"
import { failureExcerpt, postThrea } from "./threa-http"
import type { SpawnOptions, SpawnResult } from "./types"

export interface RootReporterDeps {
  postToRoot: (rootStreamId: string, content: string) => Promise<void>
  log: (message: string) => void
}

export interface AttachedSpawnDeps extends RootReporterDeps {
  spawn: (options: SpawnOptions) => Promise<SpawnResult>
  readBrief: (path: string) => string
  unlinkBrief: (path: string) => void
  brief: (body: { instanceId: string; runtimeSessionId: string; content: string }) => Promise<void>
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Best-effort: a failure to report a failure must not mask the original error. */
export async function reportToRoot(rootStreamId: string, content: string, deps: RootReporterDeps) {
  try {
    await deps.postToRoot(rootStreamId, content)
  } catch (error) {
    deps.log(`harnessd: could not post to root stream ${rootStreamId}: ${reason(error)}`)
  }
}

/**
 * Spawns an attached agent and, when a brief file is given, hands it the caller's prompt
 * through the Threa brief endpoint. Every failure is reported into the scratchpad root
 * stream (best-effort) before rethrowing, so a spawn that dies is never silent.
 */
export async function runAttachedSpawn(options: SpawnOptions, deps: AttachedSpawnDeps): Promise<SpawnResult> {
  if (!options.attach) die("runAttachedSpawn requires options.attach")
  const rootStreamId = options.attach.rootStreamId

  // Set once the file is read: from there on the prompt is in memory and the file has no
  // second reader, so it goes whichever way this ends. Leaving it would strand the user's
  // prompt in tmpdir forever — the launcher unref'd and cannot clean up.
  let briefPath: string | undefined
  try {
    let content: string | undefined
    let result: SpawnResult
    try {
      // Read before spawning: an unreadable or blank brief must create nothing (INV-11).
      if (options.briefFile) {
        content = deps.readBrief(options.briefFile)
        briefPath = options.briefFile
        if (!content.trim()) die(`--brief-file ${briefPath} is empty`)
      }
      result = await deps.spawn(options)
    } catch (error) {
      await reportToRoot(rootStreamId, `harnessd: spawn of \`${options.name}\` failed: ${reason(error)}`, deps)
      throw error
    }

    if (content !== undefined) {
      const instanceId = result.instanceId ?? die("spawned agent has no instanceId to brief")
      const runtimeSessionId = result.runtimeSessionId ?? die("spawned agent has no runtimeSessionId to brief")
      try {
        await deps.brief({ instanceId, runtimeSessionId, content })
      } catch (error) {
        await reportToRoot(
          rootStreamId,
          `harnessd: \`${options.name}\` started in thread ${result.activeStreamId} but the brief was not delivered: ${reason(error)}`,
          deps
        )
        throw error
      }
    }

    return result
  } finally {
    if (briefPath) {
      try {
        deps.unlinkBrief(briefPath)
      } catch (error) {
        // A leftover file on disk is a cleanup nit, never the failure worth reporting.
        deps.log(`harnessd: could not remove brief file ${briefPath}: ${reason(error)}`)
      }
    }
  }
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
