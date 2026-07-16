import type { Request, Response } from "express"
import { HttpError } from "../../lib/errors"
import { JobQueues, type QueueManager } from "../../lib/queue"
import { githubWebhookEventSchema } from "./config"

interface GithubWebhookHandlerDeps {
  jobQueue: QueueManager
}

/**
 * Sentinel workspace id for the fan-out job. A GitHub installation backs many
 * workspaces (installs are per org), so the job isn't workspace-scoped; the
 * worker resolves the real workspaces via `installation_id`. Matches the
 * convention system-wide cron jobs use for `extractWorkspaceId`.
 */
const SYSTEM_WORKSPACE_ID = "system"

export function createGithubWebhookHandlers(deps: GithubWebhookHandlerDeps) {
  return {
    /**
     * Internal endpoint hit by CP's outbox dispatcher, one call per verified
     * delivery per region. Thin (INV-34): validate the wire body, enqueue a
     * process job, 200. The enqueue keys the queue-message id on `deliveryGuid`
     * so an at-least-once redelivery is deduped at insert (INV-20).
     */
    async ingest(req: Request, res: Response) {
      const parsed = githubWebhookEventSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid GitHub webhook event body", { status: 400, code: "VALIDATION_ERROR" })
      }

      await deps.jobQueue.send(
        JobQueues.GITHUB_WEBHOOK_PROCESS,
        { workspaceId: SYSTEM_WORKSPACE_ID, ...parsed.data },
        { messageId: `ghwh_${parsed.data.deliveryGuid}` }
      )

      res.status(200).json({ ok: true })
    },
  }
}
