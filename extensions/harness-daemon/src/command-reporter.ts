import type { CommandClaim } from "@threahq/harness-client"
import { failureExcerpt, postThrea, type ThreaTarget } from "./threa-http"

/** Drives a slash command whose claim was handed to this process: keeps it alive, shows its steps, closes it. */
export interface CommandReporter {
  progress(step: string): Promise<void>
  complete(): Promise<void>
  fail(message: string): Promise<void>
  /** Stops renewing the claim; the command is closed by then, or abandoned on purpose. */
  stop(): void
}

/**
 * Well inside the 120 s lease: waiting for `resume-active.lock` can take
 * minutes, and a claim that lapses meanwhile gets re-dispatched to a runtime
 * that is about to be killed.
 */
export const CLAIM_RENEW_EVERY_MS = 30_000
export const CLAIM_TTL_SECONDS = 120

export function claimCommandReporter(
  target: ThreaTarget,
  claim: CommandClaim,
  post: typeof postThrea = postThrea
): CommandReporter {
  const base = `/bot-invocations/${claim.invocationId}`
  const fenced = { instanceId: claim.instanceId, claimToken: claim.claimToken }
  const report = async (path: string, body: Record<string, unknown>, what: string): Promise<boolean> => {
    try {
      const response = await post(target, `${base}${path}`, { ...fenced, ...body })
      if (response.ok) return true
      console.error(`harnessd: could not ${what}: ${await failureExcerpt(response)}`)
    } catch (error) {
      console.error(`harnessd: could not ${what}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return false
  }
  const renew = () => void report("/renew", { claimTtlSeconds: CLAIM_TTL_SECONDS }, "renew the /done claim")
  renew()
  const timer = setInterval(renew, CLAIM_RENEW_EVERY_MS)
  timer.unref()
  return {
    progress: async (step) => void (await report("/progress", { step }, `report "${step}"`)),
    complete: async () => {
      if (!(await report("/complete", { noResponse: true }, "close the /done command"))) {
        throw new Error("harnessd: /done finished but its command could not be closed")
      }
    },
    fail: async (message) =>
      void (await report("/fail", { errorMessage: message.slice(0, 1000) }, "fail the /done command")),
    stop: () => clearInterval(timer),
  }
}

/** A `done` typed at the terminal has no command to drive; its steps go to stdout. */
export function consoleCommandReporter(): CommandReporter {
  return {
    progress: async (step) => console.log(`done\t${step}`),
    complete: async () => undefined,
    fail: async () => undefined,
    stop: () => undefined,
  }
}
