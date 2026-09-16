import { readCommandClaim, type CommandClaim } from "@threahq/harness-client"
import { readFileSync, unlinkSync } from "node:fs"
import { spawnAgent } from "./commands"
import { claimCommandReporter, consoleCommandReporter, type CommandReporter } from "./command-reporter"
import { die } from "./errors"
import { runtimeThreaTarget, type RuntimeTargetResolver } from "./spawners"
import { failureExcerpt, postThrea } from "./threa-http"
import type { RuntimeKind, SpawnOptions, SpawnResult } from "./types"

export interface AttachedSpawnDeps {
  spawn: (options: SpawnOptions) => Promise<SpawnResult>
  readBrief: (path: string) => string
  unlinkBrief: (path: string) => void
  brief: (body: {
    runtime: RuntimeKind
    instanceId: string
    runtimeSessionId: string
    content: string
  }) => Promise<void>
  readClaim: (path: string) => CommandClaim
  commandReporter: (claim: CommandClaim) => CommandReporter
  log: (message: string) => void
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The brief that stands in for a missing `/spawn` prompt. Its reply is the
 * thread's first message, so the card opens on the agent introducing itself
 * rather than on a notice written about it.
 *
 * It says where the greeting goes because "say hello" alone reads as an
 * instruction to the terminal: a session briefed with the earlier wording
 * answered in its own pane and left the spawn request open until it timed out.
 */
function greetingBrief(options: SpawnOptions, result: SpawnResult): string {
  return [
    `You were just started as \`${options.name}\` and nobody has asked you for anything yet.`,
    `You are working in \`${result.worktree}\` on branch \`${result.branch}\` (tmux window \`${result.tmuxWindow}\`).`,
    "Say hello in a sentence or two, name where you are, and ask what they want done. Do not start any work yet.",
    "Send it with the channel `reply` tool, passing this event's `invocation_id`. Text you write in the terminal never reaches the person who spawned you, and this request stays open until you reply.",
  ].join("\n\n")
}

/**
 * Spawns an attached agent and hands it a brief through the Threa brief endpoint:
 * the caller's prompt when `--brief-file` carried one, a greeting otherwise.
 *
 * The `/spawn` command that asked for it is still open, and `--claim-file` hands
 * it to this process: provisioning and briefing are reported into it and it
 * closes completed or failed — no message is posted about the launch.
 */
export async function runAttachedSpawn(options: SpawnOptions, deps: AttachedSpawnDeps): Promise<SpawnResult> {
  if (!options.attach) die("runAttachedSpawn requires options.attach")
  const claim = options.claimFile ? deps.readClaim(options.claimFile) : undefined
  const reporter = claim ? deps.commandReporter(claim) : consoleCommandReporter("spawn")

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
      await reporter.progress(`Provisioning a worktree for \`${options.name}\``)
      result = await deps.spawn(options)
    } catch (error) {
      throw new Error(`spawn of \`${options.name}\` failed: ${reason(error)}`, { cause: error })
    }

    // The brief is what writes the thread's first message, and a thread with no
    // messages renders no card in the timeline. A prompt-less spawn gets a
    // greeting brief so the card opens on the agent's own words.
    const brief = content ?? (result.activeStreamId ? greetingBrief(options, result) : undefined)
    if (brief !== undefined) {
      try {
        await reporter.progress(`Briefing \`${options.name}\``)
        const instanceId = result.instanceId ?? die("spawned agent has no instanceId to brief")
        const runtimeSessionId = result.runtimeSessionId ?? die("spawned agent has no runtimeSessionId to brief")
        await deps.brief({ runtime: options.runtime, instanceId, runtimeSessionId, content: brief })
      } catch (error) {
        throw new Error(
          `\`${options.name}\` started in thread ${result.activeStreamId} but the brief was not delivered: ${reason(error)}`,
          { cause: error }
        )
      }
    }

    await reporter.complete()
    return result
  } catch (error) {
    await reporter.fail(reason(error))
    throw error
  } finally {
    reporter.stop()
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
    readClaim: readCommandClaim,
    commandReporter: (claim) => claimCommandReporter(targetForRuntime(claim.runtime, "drive /spawn"), claim, "spawn"),
    log: (message) => console.error(message),
  }
}
