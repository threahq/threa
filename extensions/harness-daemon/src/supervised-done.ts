import type { CommandClaim } from "@threahq/harness-client"
import { CLAIM_TTL_SECONDS, claimCommandReporter, type CommandReporter } from "./command-reporter"
import { listLocalTmuxPanes, type LocalTmuxPane } from "./discovery"
import { defaultDoneDeps, doneAgent, type DoneRequest } from "./done"
import { output } from "./shell"
import { runtimeThreaTarget, type RuntimeTargetResolver } from "./spawners"
import { suspendPlaceholderNotice } from "./suspend"
import { failureExcerpt, postThrea, type ThreaTarget } from "./threa-http"
import type { ManagedAgent, RuntimeKind } from "./types"

/**
 * `/done` answered for a session that is suspended, so the operator never has
 * to wake an agent to finish with it.
 *
 * The claim is what makes this safe to run beside the runtime: whoever holds it
 * owns the command, and a suspended session holds nothing. It is taken by
 * invocation id — the id the availability hint named — because a claim cannot
 * be released, so claiming whatever FIFO offers would strand a command this
 * process has no way to run.
 */
export type SupervisedDoneOutcome =
  | { status: "done" }
  /** Nothing to answer: another runtime took it, or it is already gone. The caller resumes the session as usual. */
  | { status: "unclaimed"; reason: string }
  | { status: "failed"; reason: string }

export interface SupervisedDoneDeps {
  target: RuntimeTargetResolver
  post: typeof postThrea
  panes: () => LocalTmuxPane[]
  killPane: (paneId: string) => void
  reporter: (claim: CommandClaim) => CommandReporter
  done: (request: DoneRequest) => Promise<void>
  log: (message: string) => void
}

export function defaultSupervisedDoneDeps(): SupervisedDoneDeps {
  const doneDeps = defaultDoneDeps()
  return {
    target: runtimeThreaTarget,
    post: postThrea,
    panes: listLocalTmuxPanes,
    killPane: (paneId) => {
      output(["tmux", "kill-pane", "-t", paneId], { allowFailure: true })
    },
    reporter: (claim) => claimCommandReporter(runtimeThreaTarget(claim.runtime, "drive /done"), claim, "done"),
    done: (request) => doneAgent(request, doneDeps),
    log: (message) => console.log(message),
  }
}

interface ClaimedCommand {
  invocationId: string
  claimToken: string
  rootStreamId: string
  activeStreamId: string
  name: string
  args: string
}

function parseClaim(payload: unknown): ClaimedCommand | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const row = payload as Record<string, unknown>
  const command = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : {}
  const named =
    command.command && typeof command.command === "object" ? (command.command as Record<string, unknown>) : {}
  const fields = {
    invocationId: row.id,
    claimToken: row.claimToken,
    rootStreamId: row.rootStreamId,
    activeStreamId: row.activeStreamId,
    name: named.name,
    args: named.args ?? "",
  }
  if (Object.values(fields).some((value) => typeof value !== "string")) return undefined
  return fields as unknown as ClaimedCommand
}

/**
 * The placeholder `suspendAgent` left in the pane. Matched by its notice rather
 * than by the recorded pane id: the id survives the respawn, but a row that
 * outlived a tmux server restart points at whatever took the id since, and
 * killing a stranger's pane is worse than refusing the command.
 */
function findPlaceholderPane(agent: ManagedAgent, panes: LocalTmuxPane[]): LocalTmuxPane | undefined {
  const notice = suspendPlaceholderNotice(agent)
  const matches = panes.filter((pane) => pane.startCommand.includes(notice))
  return matches.length === 1 ? matches[0] : undefined
}

async function claimByInvocationId(
  target: ThreaTarget,
  identity: { runtime: RuntimeKind; instanceId: string; runtimeSessionId: string },
  invocationId: string,
  deps: SupervisedDoneDeps
): Promise<ClaimedCommand | { unclaimed: string }> {
  const response = await deps.post(target, "/bot-invocations/claim", {
    runtimeKind: identity.runtime === "pi" ? "pi-local" : "claude-code-channel",
    instanceId: identity.instanceId,
    runtimeSessionId: identity.runtimeSessionId,
    supportedCapabilities: ["session-control"],
    claimTtlSeconds: CLAIM_TTL_SECONDS,
    invocationId,
  })
  if (!response.ok) return { unclaimed: `claim failed: ${await failureExcerpt(response)}` }
  const body = (await response.json()) as { data?: unknown }
  if (!body.data) return { unclaimed: "already claimed elsewhere" }
  const claimed = parseClaim(body.data)
  if (!claimed) return { unclaimed: "claim response was not a session-control command" }
  return claimed
}

export async function supervisedDone(
  agent: ManagedAgent,
  invocationId: string,
  deps: SupervisedDoneDeps
): Promise<SupervisedDoneOutcome> {
  const { instanceId, runtimeSessionId } = agent
  if (!instanceId || !runtimeSessionId) return { status: "unclaimed", reason: "no runtime identity recorded" }
  const placeholder = findPlaceholderPane(agent, deps.panes())
  const target = deps.target(agent.runtime, "answer /done for a suspended session")

  const claimed = await claimByInvocationId(
    target,
    { runtime: agent.runtime, instanceId, runtimeSessionId },
    invocationId,
    deps
  )
  if ("unclaimed" in claimed) return { status: "unclaimed", reason: claimed.unclaimed }

  const claim: CommandClaim = {
    runtime: agent.runtime === "pi" ? "pi" : "claude",
    workspaceId: target.workspaceId,
    invocationId: claimed.invocationId,
    instanceId,
    claimToken: claimed.claimToken,
  }
  // Claim first, validate after: the checks the running session would have made
  // need the command's own arguments and the thread it was typed in, and those
  // arrive with the claim. A violation is reported into the command rather than
  // dropped, because there is no way to hand it back.
  const refusal = refuse(claimed, placeholder)
  if (refusal) {
    const reporter = deps.reporter(claim)
    try {
      await reporter.fail(refusal)
    } finally {
      reporter.stop()
    }
    return { status: "failed", reason: refusal }
  }

  // The placeholder is what makes the worktree look occupied to the wind-down's
  // vetoes. Killing the pane takes its window with it, leaving the empty
  // worktree `decideWindow` expects.
  if (placeholder) deps.killPane(placeholder.paneId)
  deps.log(`harnessd: answering /done for suspended ${agent.name} (${claimed.invocationId})`)
  try {
    await deps.done({ ref: agent.id, rootStreamId: claimed.rootStreamId, claim })
    return { status: "done" }
  } catch (error) {
    // `doneAgent` already failed the command through its own reporter; the row
    // stays suspended, and the next message revives it the ordinary way.
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) }
  }
}

function refuse(claimed: ClaimedCommand, placeholder: LocalTmuxPane | undefined): string | undefined {
  if (claimed.name !== "done") return `harnessd claimed /${claimed.name}, which it cannot run for a suspended session.`
  if (claimed.args !== "" && claimed.args !== "--force") return "Usage: `/done [--force]`."
  if (claimed.activeStreamId === claimed.rootStreamId) return "Done is only available inside a thread session."
  if (!placeholder) return "The suspended session's pane could not be identified; wake it and run /done there."
  return undefined
}
