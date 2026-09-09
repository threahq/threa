import { readFileSync, unlinkSync } from "node:fs"
import { spawnAgent, threaTarget } from "./commands"
import { die } from "./errors"
import { postScratchpadNotice } from "./oom"
import { runtimeThreaTarget, type RuntimeTargetResolver } from "./spawners"
import { failureExcerpt, postThrea } from "./threa-http"
import type { RuntimeKind, SpawnOptions, SpawnResult } from "./types"

export interface StreamNoticeDeps {
  postNotice: (streamId: string, content: string, runtime?: RuntimeKind) => Promise<void>
  log: (message: string) => void
}

export interface AttachedSpawnDeps extends StreamNoticeDeps {
  spawn: (options: SpawnOptions) => Promise<SpawnResult>
  readBrief: (path: string) => string
  unlinkBrief: (path: string) => void
  brief: (body: {
    runtime: RuntimeKind
    instanceId: string
    runtimeSessionId: string
    content: string
  }) => Promise<void>
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Best-effort: a failure to report a failure must not mask the original error. */
export async function notifyStream(streamId: string, content: string, deps: StreamNoticeDeps, runtime?: RuntimeKind) {
  try {
    await deps.postNotice(streamId, content, runtime)
  } catch (error) {
    deps.log(`harnessd: could not post to stream ${streamId}: ${reason(error)}`)
  }
}

/**
 * The brief that stands in for a missing `/spawn` prompt. Its reply is the
 * thread's first message, so the card opens on the agent introducing itself
 * rather than on a notice written about it.
 */
function greetingBrief(options: SpawnOptions, result: SpawnResult): string {
  return [
    `You were just started as \`${options.name}\` and nobody has asked you for anything yet.`,
    `You are working in \`${result.worktree}\` on branch \`${result.branch}\` (tmux window \`${result.tmuxWindow}\`).`,
    "Say hello in a sentence or two, name where you are, and ask what they want done. Do not start any work yet.",
  ].join("\n\n")
}

/**
 * Spawns an attached agent and hands it a brief through the Threa brief endpoint:
 * the caller's prompt when `--brief-file` carried one, a greeting otherwise. Every
 * failure is reported into the scratchpad root stream (best-effort) before
 * rethrowing, so a spawn that dies is never silent.
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

    // The brief is what writes the thread's first message, and a thread with no
    // messages renders no card in the timeline. A prompt-less spawn gets a
    // greeting brief so the card opens on the agent's own words.
    const brief = content ?? (result.activeStreamId ? greetingBrief(options, result) : undefined)
    if (brief !== undefined) {
      try {
        const instanceId = result.instanceId ?? die("spawned agent has no instanceId to brief")
        const runtimeSessionId = result.runtimeSessionId ?? die("spawned agent has no runtimeSessionId to brief")
        await deps.brief({ runtime: options.runtime, instanceId, runtimeSessionId, content: brief })
      } catch (error) {
        await notifyStream(
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

export function defaultAttachedSpawnDeps(
  targetForRuntime: RuntimeTargetResolver = runtimeThreaTarget
): AttachedSpawnDeps {
  return {
    spawn: spawnAgent,
    readBrief: (path) => readFileSync(path, "utf8"),
    unlinkBrief: (path) => unlinkSync(path),
    brief: async ({ runtime, ...body }) => {
      const response = await postThrea(
        targetForRuntime(runtime, "deliver a brief"),
        "/bot-runtime/sessions/brief",
        body
      )
      if (!response.ok) throw new Error(`harnessd: could not deliver the brief: ${await failureExcerpt(response)}`)
    },
    postNotice: (streamId, content, runtime) =>
      postScratchpadNotice({
        ...(runtime ? targetForRuntime(runtime, "post a spawn notice") : threaTarget("post a spawn notice")),
        streamId,
        content,
      }),
    log: (message) => console.error(message),
  }
}
