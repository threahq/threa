import { readFileSync, unlinkSync } from "node:fs"
import { spawnAgent, threaTarget } from "./commands"
import { die } from "./errors"
import { postScratchpadNotice } from "./oom"
import { failureExcerpt, postThrea } from "./threa-http"
import type { SpawnOptions, SpawnResult } from "./types"

export interface StreamNoticeDeps {
  postNotice: (streamId: string, content: string) => Promise<void>
  log: (message: string) => void
}

export interface AttachedSpawnDeps extends StreamNoticeDeps {
  spawn: (options: SpawnOptions) => Promise<SpawnResult>
  readBrief: (path: string) => string
  unlinkBrief: (path: string) => void
  brief: (body: { instanceId: string; runtimeSessionId: string; content: string }) => Promise<void>
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Best-effort: a failure to report a failure must not mask the original error. */
export async function notifyStream(streamId: string, content: string, deps: StreamNoticeDeps) {
  try {
    await deps.postNotice(streamId, content)
  } catch (error) {
    deps.log(`harnessd: could not post to stream ${streamId}: ${reason(error)}`)
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

  // Claimed before the read, not after it: the file is this process's to remove
  // whichever way the spawn ends. Leaving it would strand the user's prompt in
  // tmpdir forever — the launcher unref'd and cannot clean up.
  let briefPath: string | undefined
  try {
    let content: string | undefined
    let result: SpawnResult
    try {
      // Read before spawning: an unreadable or blank brief must create nothing (INV-11).
      if (options.briefFile) {
        briefPath = options.briefFile
        content = deps.readBrief(briefPath)
        if (!content.trim()) die(`--brief-file ${briefPath} is empty`)
      }
      result = await deps.spawn(options)
    } catch (error) {
      await notifyStream(rootStreamId, `harnessd: spawn of \`${options.name}\` failed: ${reason(error)}`, deps)
      throw error
    }

    if (content !== undefined) {
      try {
        const instanceId = result.instanceId ?? die("spawned agent has no instanceId to brief")
        const runtimeSessionId = result.runtimeSessionId ?? die("spawned agent has no runtimeSessionId to brief")
        await deps.brief({ instanceId, runtimeSessionId, content })
      } catch (error) {
        await notifyStream(
          rootStreamId,
          `harnessd: \`${options.name}\` started in thread ${result.activeStreamId} but the brief was not delivered: ${reason(error)}`,
          deps
        )
        throw error
      }
    } else if (result.activeStreamId) {
      // The brief is what normally writes the thread's first message, and a thread with
      // no messages renders no card in the timeline. Without this a prompt-less spawn is
      // invisible and there is nowhere to type at it.
      await notifyStream(
        result.activeStreamId,
        `**${options.name}** is running in \`${result.worktree}\` (tmux \`${result.tmuxWindow}\`). No prompt came with \`/spawn\` — reply here to give it one.`,
        deps
      )
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
    postNotice: (streamId, content) =>
      postScratchpadNotice({ ...threaTarget("post a spawn notice"), streamId, content }),
    log: (message) => console.error(message),
  }
}
